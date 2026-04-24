import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../../lib/apiGuard";
import { logger } from "../../../../lib/logger";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { listActiveWorkers } from "../../../../lib/workerControl";

// Force dynamic rendering - disable all caching
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_DAILY_ENRICHMENT_CAP = 20;

const getDailyEnrichmentCap = () => {
  const parsedCap = parseInt(process.env.DAILY_ENRICHMENT_CAP || "", 10);
  if (Number.isFinite(parsedCap) && parsedCap > 0) return parsedCap;
  return DEFAULT_DAILY_ENRICHMENT_CAP;
};

const STATUSES = [
  "NEW",
  "PROCESSING",
  "ENRICHED",
  "ENRICH_FAILED",
  "DRAFT_READY",
  "APPROVED",
  "SENT",
  "CONNECT_ONLY_SENT",
  "CONNECTED",
  "REPLIED",
  "REJECTED",
  "FAILED",
] as const;

type StatusKey = (typeof STATUSES)[number];

type StatusCounts = Record<StatusKey, number>;

const createInitialCounts = (): StatusCounts => {
  return STATUSES.reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {} as StatusCounts);
};

const MODE_CONFIG = {
  message: {
    outreachMode: "message",
    completedStatuses: ["ENRICHED", "ENRICH_FAILED"] as StatusKey[],
  },
  connect_only: {
    outreachMode: "connect_only",
    completedStatuses: ["CONNECT_ONLY_SENT"] as StatusKey[],
  },
} as const;

const WEEKLY_LIMIT_PATTERNS = [
  "weekly limit",
  "weekly invitation limit",
  "invitation limit",
  "contact request limit",
  "contact requests",
  "wöchentliche limit",
  "wöchentliche kontaktanfragen",
  "kontaktanfragen",
  "nächste woche",
  "next week",
];

const detectWeeklyLimit = (text: string | null | undefined) => {
  const normalized = (text || "").toLowerCase();
  return WEEKLY_LIMIT_PATTERNS.some((pattern) => normalized.includes(pattern));
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestedMode = url.searchParams.get("mode") === "connect_only" ? "connect_only" : "message";
  const modeConfig = MODE_CONFIG[requestedMode];
  const correlationId = logger.apiRequest("GET", "/api/enrich/status");
  const guardResponse = await requireOperatorAccess(request, "/api/enrich/status", correlationId);
  if (guardResponse) return guardResponse;
  const dailyCap = getDailyEnrichmentCap();
  
  try {
    const client = supabaseAdmin();
    const counts = createInitialCounts();

    logger.debug("Fetching status counts for all lead statuses", { correlationId });

    await Promise.all(
      STATUSES.map(async (status) => {
        logger.dbQuery("select-count", "leads", { correlationId, status, outreachMode: modeConfig.outreachMode });
        
        const { count, error } = await client
          .from("leads")
          .select("id", { count: "exact" })
          .eq("status", status)
          .eq("outreach_mode", modeConfig.outreachMode)
          .limit(0);

        if (error) {
          logger.error(`Failed to count leads with status ${status}`, { correlationId }, error);
          throw error;
        }

        counts[status] = count ?? 0;
        logger.dbResult("select-count", "leads", { correlationId, status }, count);
      })
    );

    logger.dbQuery("select", "leads", { correlationId }, { filter: "NEW or PROCESSING" });
    
    const { data: nextLead, error: nextLeadError } = await client
      .from("leads")
      .select("id, linkedin_url, first_name, last_name, company_name")
      .in("status", ["NEW", "PROCESSING"])
      .eq("outreach_mode", modeConfig.outreachMode)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (nextLeadError) {
      logger.error("Failed to fetch next lead", { correlationId }, nextLeadError);
      throw nextLeadError;
    }

    logger.dbResult("select", "leads", { correlationId }, nextLead);

    const isConnectOnly = requestedMode === "connect_only";
    let remaining = (counts.NEW || 0) + (counts.PROCESSING || 0);
    let completed = modeConfig.completedStatuses.reduce((sum, status) => sum + (counts[status] || 0), 0);

    // Track what actually happened today so we can cap the status bar to the daily quota
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startIso = startOfDay.toISOString();

    let completedToday = 0;
    let completedTodayError: any = null;
    let limitReached = false;
    let limitMessage: string | null = null;

    if (isConnectOnly) {
      logger.dbQuery(
        "select-count",
        "leads",
        { correlationId, metric: "connect_only_sent_total", outreachMode: modeConfig.outreachMode },
      );

      const { count: sentTotal, error: sentTotalError } = await client
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("outreach_mode", modeConfig.outreachMode)
        .not("connection_sent_at", "is", null);

      if (sentTotalError) {
        logger.error("Failed to count connect-only sent total", { correlationId }, sentTotalError);
        throw sentTotalError;
      }

      completed = sentTotal || 0;

      logger.dbQuery(
        "select-count",
        "leads",
        { correlationId, metric: "connect_only_sent_today", outreachMode: modeConfig.outreachMode },
        { since: startIso }
      );

      const sentTodayResp = await client
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("outreach_mode", modeConfig.outreachMode)
        .not("connection_sent_at", "is", null)
        .gte("connection_sent_at", startIso);

      completedToday = sentTodayResp.count || 0;
      completedTodayError = sentTodayResp.error;

      // Queue for connect_only means unsent leads that still can be processed.
      remaining = (counts.NEW || 0) + (counts.PROCESSING || 0) + (counts.ENRICHED || 0);

      const { data: recentFailed, error: recentFailedError } = await client
        .from("leads")
        .select("id, error_message, updated_at")
        .eq("outreach_mode", modeConfig.outreachMode)
        .eq("status", "FAILED")
        .gte("updated_at", startIso)
        .order("updated_at", { ascending: false })
        .limit(10);

      if (recentFailedError) {
        logger.error("Failed to inspect recent connect-only failures", { correlationId }, recentFailedError);
        throw recentFailedError;
      }

      const limitHit = (recentFailed || []).find((row) => detectWeeklyLimit(row.error_message));
      if (limitHit) {
        limitReached = true;
        limitMessage = "LinkedIn weekly invite limit reached. Stop until next week.";
      }

      if (!limitReached) {
        const { data: pausedLeads, error: pausedLeadsError } = await client
          .from("leads")
          .select("id, profile_data, updated_at")
          .eq("outreach_mode", modeConfig.outreachMode)
          .eq("status", "NEW")
          .contains("profile_data", { meta: { connect_only_limit_reached: true } })
          .limit(1);

        if (pausedLeadsError) {
          logger.error("Failed to inspect requeued connect-only leads", { correlationId }, pausedLeadsError);
          throw pausedLeadsError;
        }

        if ((pausedLeads || []).length > 0) {
          limitReached = true;
          limitMessage = "LinkedIn weekly invite limit reached. Some leads were requeued into NEW for later retry.";
        }
      }
    } else {
      logger.dbQuery(
        "select-count",
        "leads",
        { correlationId, status: modeConfig.completedStatuses, outreachMode: modeConfig.outreachMode },
        { since: startIso }
      );

      const messageCompletedResp = await client
        .from("leads")
        .select("id", { count: "exact", head: true })
        .in("status", modeConfig.completedStatuses)
        .eq("outreach_mode", modeConfig.outreachMode)
        .gte("updated_at", startIso);

      completedToday = messageCompletedResp.count || 0;
      completedTodayError = messageCompletedResp.error;
    }

    if (completedTodayError) {
      logger.error("Failed to count today's completions", { correlationId }, completedTodayError);
      throw completedTodayError;
    }

    logger.dbResult(
      "select-count",
      "leads",
      { correlationId, status: modeConfig.completedStatuses },
      completedToday || 0
    );

    // Remaining for today is driven purely by the daily cap; queue/backlog is reported separately
    const remainingToday = Math.max(0, dailyCap - completedToday);

    // Explicit ground-truth log of counts and computed values
    logger.debug(
      "Enrichment status snapshot",
      { correlationId },
      {
        counts,
        remaining,
        completed,
        mode: requestedMode,
        dailyCap,
        completedToday,
        remainingToday,
        queueRemaining: remaining,
      }
    );

    const response = {
      ok: true,
      mode: requestedMode,
      workerActive: listActiveWorkers({ kinds: ["scraper_outreach"] }).length > 0,
      counts,
      remaining,
      completed,
      dailyCap,
      completedToday,
      remainingToday,
      queueRemaining: remaining,
      nextLead: nextLead || null,
      limitReached,
      limitMessage,
    };

    logger.info("Status fetched successfully", { correlationId }, { remaining, completed, nextLeadId: nextLead?.id });
    logger.apiResponse("GET", "/api/enrich/status", 200, { correlationId });

    return NextResponse.json(response);
  } catch (error: any) {
    logger.error("Failed to fetch enrichment status", { correlationId }, error);
    logger.apiResponse("GET", "/api/enrich/status", 500, { correlationId });
    
    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "Failed to fetch enrichment status.",
      },
      { status: 500 }
    );
  }
}
