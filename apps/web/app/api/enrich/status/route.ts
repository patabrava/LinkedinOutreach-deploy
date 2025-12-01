import { NextResponse } from "next/server";

import { logger } from "../../../../lib/logger";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";

// Force dynamic rendering - disable all caching
export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
    completedStatuses: ["CONNECT_ONLY_SENT", "ENRICH_FAILED", "ENRICHED"] as StatusKey[],
  },
} as const;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestedMode = url.searchParams.get("mode") === "connect_only" ? "connect_only" : "message";
  const modeConfig = MODE_CONFIG[requestedMode];
  const correlationId = logger.apiRequest("GET", "/api/enrich/status");
  
  try {
    const client = supabaseAdmin();
    // Temporary environment sanity check (masked)
    const envUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    logger.debug(
      "Supabase env check",
      { correlationId },
      {
        urlPrefix: envUrl.slice(0, 32),
        serviceRoleKeyPrefix: envKey.slice(0, 8),
      }
    );
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

    // Compute progress strictly from the enrichment pipeline:
    // remaining = NEW + PROCESSING
    // completed = ENRICHED + ENRICH_FAILED (both are terminal states for enrichment)
    const remaining = (counts.NEW || 0) + (counts.PROCESSING || 0);
    const completed = modeConfig.completedStatuses.reduce((sum, status) => sum + (counts[status] || 0), 0);

    // Explicit ground-truth log of counts and computed values
    logger.debug(
      "Enrichment status snapshot",
      { correlationId },
      { counts, remaining, completed, mode: requestedMode }
    );

    const response = {
      ok: true,
      mode: requestedMode,
      counts,
      remaining,
      completed,
      nextLead: nextLead || null,
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
