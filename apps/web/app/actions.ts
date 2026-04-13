"use server";

import { spawn } from "child_process";
import path from "path";

import { revalidatePath } from "next/cache";

import { logger } from "../lib/logger";
import type { OutreachMode } from "../lib/outreachModes";
import { OUTREACH_MODE_TO_DB } from "../lib/outreachModes";
import type { PromptType } from "../lib/promptTypes";
import { supabaseAdmin } from "../lib/supabaseAdmin";

type DraftInput = {
  leadId: string;
  draftId?: number;
  opener: string;
  body: string;
  cta: string;
  ctaType?: string;
  outreachMode?: OutreachMode;
};

const CONNECT_MESSAGE_FEED_STATUSES = ["DRAFT_READY", "APPROVED"] as const;
const MESSAGE_ONLY_FEED_STATUSES = [
  "CONNECT_ONLY_SENT",
  "MESSAGE_ONLY_READY",
  "MESSAGE_ONLY_APPROVED",
] as const;

export type LinkedinCredentialSummary = {
  email?: string;
  hasPassword: boolean;
};

export type LinkedinCredentialState = {
  success: boolean;
  error?: string;
};

function startDraftAgent(
  correlationId: string | undefined,
  promptType: PromptType = 1,
  outreachMode: OutreachMode = "connect_message"
) {
  try {
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const agentDir = path.resolve(repoRoot, "mcp-server");
    const agentPath = path.join(agentDir, "run_agent.py");
    const venvPython = path.join(agentDir, "venv", "bin", "python");
    const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;
    const execToUse = pythonExec;
    const args = [
      agentPath,
      "--prompt-type",
      String(promptType),
      "--mode",
      outreachMode === "message_only" ? "connect_only" : "message",
    ];

    logger.workerSpawn(
      "draft-agent",
      args,
      correlationId ? { correlationId, promptType, outreachMode } : { promptType, outreachMode }
    );

    const proc = spawn(execToUse, args, {
      cwd: repoRoot,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, ...(correlationId ? { CORRELATION_ID: correlationId } : {}) },
    });
    proc.unref();
  } catch (err) {
    logger.error("startDraftAgent error", correlationId ? { correlationId } : {}, err as Error);
  }
}

export async function fetchDraftFeed(outreachMode: OutreachMode = "connect_message") {
  const correlationId = logger.actionStart("fetchDraftFeed", {}, { outreachMode });

  // Message-only mode surfaces pending connections plus message-only draft stages
  // Connect+message mode shows standard DRAFT_READY/APPROVED leads
  const statusList = outreachMode === "message_only"
    ? [...MESSAGE_ONLY_FEED_STATUSES]
    : [...CONNECT_MESSAGE_FEED_STATUSES];

  const dbOutreachMode = OUTREACH_MODE_TO_DB[outreachMode];

  try {
    const client = supabaseAdmin();

    logger.dbQuery("select", "leads", { correlationId }, { status: statusList, outreachMode: dbOutreachMode, limit: 50 });

    let query = client
      .from("leads")
      .select("id, linkedin_url, first_name, last_name, company_name, status, sent_at, profile_data, recent_activity, drafts(*)")
      .in("status", statusList)
      .order("updated_at", { ascending: false })
      .limit(50)
      .eq("outreach_mode", dbOutreachMode);

    const { data, error } = await query;

    if (error) {
      logger.error("Failed to fetch draft feed", { correlationId }, error);
      return [];
    }

    logger.dbResult("select", "leads", { correlationId }, data);
    logger.debug("Raw leads data", { correlationId }, { count: data?.length, sample: data?.[0] });

    const result = (data || []).flatMap((lead) => {
      const drafts = lead.drafts || [];
      logger.debug("Processing lead", { correlationId, leadId: lead.id }, {
        status: lead.status,
        draftCount: drafts.length,
        hasDrafts: Array.isArray(drafts),
      });

      if (drafts.length) {
        return drafts.map((draft: any) => ({
          leadId: lead.id,
          draftId: draft.id,
          opener: draft.opener || "",
          body: draft.body_text || "",
          cta: draft.cta_text || "",
          finalMessage: draft.final_message || "",
          ctaType: draft.cta_type || "",
          profile: lead.profile_data || {},
          activity: lead.recent_activity || [],
          name: [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim(),
          headline: lead.profile_data?.headline || "",
          company: lead.company_name || lead.profile_data?.current_company || "",
          linkedinUrl: lead.linkedin_url,
          status: lead.status || "DRAFT_READY",
          sentAt: lead.sent_at || null,
        }));
      }

      if (outreachMode === "message_only") {
        // Message-only mode surfaces CONNECT_ONLY_SENT leads even without draft rows.
        return [{
          leadId: lead.id,
          draftId: undefined,
          opener: "",
          body: "",
          cta: "",
          finalMessage: "",
          ctaType: "",
          profile: lead.profile_data || {},
          activity: lead.recent_activity || [],
          name: [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim(),
          headline: lead.profile_data?.headline || "",
          company: lead.company_name || lead.profile_data?.current_company || "",
          linkedinUrl: lead.linkedin_url,
          status: lead.status || "CONNECT_ONLY_SENT",
          sentAt: lead.sent_at || null,
        }];
      }

      return [];
    });

    logger.actionComplete("fetchDraftFeed", { correlationId }, { count: result.length });
    return result;
  } catch (error: any) {
    logger.actionError("fetchDraftFeed", { correlationId }, error);
    return [];
  }
}

const normalizeSegment = (segment: string) => segment.replace(/[\n\r]+/g, " ").replace(/\s{2,}/g, " ").trim();

const buildFinalMessage = (opener: string, body: string, cta: string) =>
  [opener, body, cta]
    .map((part) => normalizeSegment(part || ""))
    .filter(Boolean)
    .join(" ");

export type LeadListRow = {
  id: string;
  linkedin_url: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  status: string | null;
  batch_id?: number | null;
  batch_name?: string | null;
  sequence_id?: number | null;
  sequence_name?: string | null;
  sequence_step?: number | null;
  followup_count?: number | null;
  last_reply_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  profile_data?: any;
  recent_activity?: any;
};

export type LeadListResult = {
  leads: LeadListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type LeadFilters = {
  status?: string;
  statuses?: string[];
  company?: string;
  name?: string;
  linkedin?: string;
};

export async function fetchLeadList(
  page = 1,
  pageSize = 50,
  filters?: LeadFilters
): Promise<LeadListResult> {
  const correlationId = logger.actionStart("fetchLeadList", {}, { page, pageSize, filters });

  try {
    const client = supabaseAdmin();
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    logger.dbQuery("select", "leads", { correlationId }, { page, pageSize, filters, range: `${from}-${to}` });

    let query = client
      .from("leads")
      .select(
        "id, linkedin_url, first_name, last_name, company_name, status, batch_id, sequence_id, sequence_step, followup_count, last_reply_at, created_at, updated_at, profile_data, recent_activity, batch:lead_batches(id, name), sequence:outreach_sequences(id, name)",
        { count: "exact" }
      )
      .order("created_at", { ascending: false });

    // Apply optional filters
    if (filters) {
      const { status, statuses, company, name, linkedin } = filters;
      if (Array.isArray(statuses) && statuses.length) {
        query = query.in("status", statuses);
      } else if (status) {
        query = query.eq("status", status);
      }
      if (company) {
        query = query.ilike("company_name", `%${company}%`);
      }
      if (linkedin) {
        query = query.ilike("linkedin_url", `%${linkedin}%`);
      }
      if (name) {
        // Match either first_name or last_name
        query = query.or(
          `ilike.first_name.%${name}%,ilike.last_name.%${name}%`
        );
      }
    }

    const { data, error, count } = await query.range(from, to);

    if (error) {
      logger.error("Failed to fetch lead list", { correlationId }, error, { page, pageSize, filters });
      return { leads: [], total: 0, page, pageSize, totalPages: 0 };
    }

    logger.dbResult("select", "leads", { correlationId }, data);

    const leads = (data || []).map((lead) => ({
      id: lead.id,
      linkedin_url: lead.linkedin_url,
      first_name: lead.first_name || null,
      last_name: lead.last_name || null,
      company_name: lead.company_name || null,
      status: lead.status || "NEW",
      batch_id: lead.batch_id ?? lead.batch?.id ?? null,
      batch_name: lead.batch?.name || null,
      sequence_id: lead.sequence_id ?? lead.sequence?.id ?? null,
      sequence_name: lead.sequence?.name || null,
      sequence_step: lead.sequence_step ?? 0,
      followup_count: lead.followup_count ?? 0,
      last_reply_at: lead.last_reply_at || null,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
      profile_data: lead.profile_data || null,
      recent_activity: lead.recent_activity || null,
    }));

    const total = count || 0;
    const totalPages = total ? Math.max(1, Math.ceil(total / pageSize)) : 1;

    logger.actionComplete("fetchLeadList", { correlationId }, { count: leads.length, total, totalPages });
    return { leads, total: total || 0, page, pageSize, totalPages };
  } catch (error: any) {
    logger.actionError("fetchLeadList", { correlationId }, error, { page, pageSize, filters });
    return { leads: [], total: 0, page, pageSize, totalPages: 0 };
  }
}

export type OutreachSequenceRow = {
  id: number;
  name: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type LeadBatchRow = {
  id: number;
  name: string;
  source: string;
  sequence_id: number | null;
  created_at: string;
  updated_at: string;
};

export async function fetchOutreachSequences(): Promise<OutreachSequenceRow[]> {
  const client = supabaseAdmin();
  const { data, error } = await client
    .from("outreach_sequences")
    .select("id, name, first_message, second_message, third_message, followup_interval_days, is_active, created_at, updated_at")
    .order("created_at", { ascending: true });
  if (error) {
    throw error;
  }
  return (data || []) as OutreachSequenceRow[];
}

export async function fetchLeadBatches(): Promise<LeadBatchRow[]> {
  const client = supabaseAdmin();
  const { data, error } = await client
    .from("lead_batches")
    .select("id, name, source, sequence_id, created_at, updated_at")
    .order("created_at", { ascending: true });
  if (error) {
    throw error;
  }
  return (data || []) as LeadBatchRow[];
}

export async function saveOutreachSequence(input: {
  id?: number;
  name: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
}) {
  const client = supabaseAdmin();
  const payload = {
    name: input.name.trim(),
    first_message: input.first_message.trim(),
    second_message: input.second_message.trim(),
    third_message: input.third_message.trim(),
    followup_interval_days: input.followup_interval_days,
  };
  const { data, error } = await client
    .from("outreach_sequences")
    .upsert(input.id ? { id: input.id, ...payload } : payload)
    .select("id, name, first_message, second_message, third_message, followup_interval_days, is_active, created_at, updated_at")
    .single();
  if (error) throw error;
  revalidatePath("/");
  revalidatePath("/leads");
  return data as OutreachSequenceRow;
}

export async function assignBatchToSequence(batchId: number, sequenceId: number) {
  const client = supabaseAdmin();
  const { data, error } = await client
    .from("lead_batches")
    .update({ sequence_id: sequenceId })
    .eq("id", batchId)
    .select("id, name, source, sequence_id, created_at, updated_at")
    .single();
  if (error) throw error;

  await client
    .from("leads")
    .update({ sequence_id: sequenceId })
    .eq("batch_id", batchId);

  revalidatePath("/");
  revalidatePath("/leads");
  return data as LeadBatchRow;
}

// Follow-ups data model
export type FollowupStatus = "PENDING_REVIEW" | "APPROVED" | "PROCESSING" | "SENT" | "SKIPPED" | "FAILED" | "RETRY_LATER";
export type FollowupType = "REPLY" | "NUDGE";

export type FollowupRow = {
  id: string;
  lead_id: string;
  status: FollowupStatus;
  followup_type?: FollowupType | null;  // REPLY = lead responded, NUDGE = no response yet
  reply_id?: string | null;
  reply_snippet?: string | null;
  reply_timestamp?: string | null;
  draft_text?: string | null;
  sent_text?: string | null;
  sent_at?: string | null;
  attempt: number;
  last_error?: string | null;
  next_send_at?: string | null;
  processing_started_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  lead?: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    linkedin_url: string;
    last_reply_at?: string | null;
    followup_count?: number | null;
    profile_data?: any;
  };
  // History of previous messages for context
  previous_sent_text?: string | null;
  // Last message tracking for sender attribution
  last_message_text?: string | null;
  last_message_from?: "us" | "lead" | null;
};

export async function fetchFollowups(statuses: Array<FollowupRow["status"]> = ["PENDING_REVIEW", "APPROVED"], limit = 50) {
  const correlationId = logger.actionStart("fetchFollowups", {}, { statuses, limit });

  try {
    const client = supabaseAdmin();

    logger.dbQuery("select", "followups", { correlationId }, { statuses, limit });

    let query = client
      .from("followups")
      .select("*, lead:leads(id, first_name, last_name, company_name, linkedin_url, last_reply_at, followup_count, profile_data)")
      .in("status", statuses)
      .order("updated_at", { ascending: false })
      .limit(limit);

    const { data, error } = await query;
    if (error) {
      logger.error("Failed to fetch followups", { correlationId }, error, { statuses, limit });
      return [] as FollowupRow[];
    }

    logger.dbResult("select", "followups", { correlationId }, data);
    logger.actionComplete("fetchFollowups", { correlationId }, { count: data?.length || 0 });

    return (data || []) as FollowupRow[];
  } catch (error: any) {
    logger.actionError("fetchFollowups", { correlationId }, error, { statuses, limit });
    return [] as FollowupRow[];
  }
}

export async function approveFollowup(followupId: string, draftText: string) {
  const client = supabaseAdmin();
  // Set draft text and mark APPROVED
  const { error } = await client
    .from("followups")
    .update({ status: "APPROVED", draft_text: draftText })
    .eq("id", followupId);
  if (error) {
    console.error("approveFollowup error", error);
    throw error;
  }
  // Optionally trigger sender in follow-up mode (fire-and-forget)
  try {
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const senderDir = path.resolve(repoRoot, "workers", "sender");
    const senderPath = path.join(senderDir, "sender.py");
    const venvPython = path.join(senderDir, "venv", "bin", "python");
    const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;
    const execToUse = pythonExec;
    const args = [senderPath, "--followup"];
    const proc = spawn(execToUse, args, {
      cwd: repoRoot,
      stdio: "ignore",
      detached: true,
      env: { ...process.env },
    });
    proc.unref();
  } catch (err) {
    console.error("approveFollowup trigger sender error", err);
  }
  revalidatePath("/followups");
}

export async function skipFollowup(followupId: string) {
  const client = supabaseAdmin();
  const { error } = await client
    .from("followups")
    .update({ status: "SKIPPED" })
    .eq("id", followupId);
  if (error) {
    console.error("skipFollowup error", error);
    throw error;
  }
  revalidatePath("/followups");
}

export async function generateFollowupDraft(followupId: string): Promise<{ success: boolean; draft?: string; error?: string }> {
  const correlationId = logger.actionStart("generateFollowupDraft", { followupId });

  try {
    const client = supabaseAdmin();

    // Fetch followup with lead data
    const { data: followup, error: fetchError } = await client
      .from("followups")
      .select("*, lead:leads(id, first_name, last_name, company_name, linkedin_url, profile_data)")
      .eq("id", followupId)
      .single();

    if (fetchError || !followup) {
      logger.error("Failed to fetch followup for draft generation", { correlationId, followupId }, fetchError || undefined);
      return { success: false, error: "Followup not found" };
    }

    // Get previous sent messages for context
    const { data: previousFollowups } = await client
      .from("followups")
      .select("sent_text, sent_at")
      .eq("lead_id", followup.lead_id)
      .eq("status", "SENT")
      .order("sent_at", { ascending: false })
      .limit(3);

    // Get the original draft sent to this lead
    const { data: originalDraft } = await client
      .from("drafts")
      .select("final_message, opener, body_text, cta_text")
      .eq("lead_id", followup.lead_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // Spawn the followup agent
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const agentDir = path.resolve(repoRoot, "mcp-server");
    const agentPath = path.join(agentDir, "run_followup_agent.py");
    const venvPython = path.join(agentDir, "venv", "bin", "python");
    const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;

    // Prepare context JSON for the agent
    const context = {
      followup_id: followupId,
      lead_id: followup.lead_id,
      first_name: followup.lead?.first_name || "",
      last_name: followup.lead?.last_name || "",
      company_name: followup.lead?.company_name || "",
      reply_snippet: followup.reply_snippet || null,
      attempt: followup.attempt || 1,
      profile_data: followup.lead?.profile_data || {},
      previous_messages: previousFollowups?.map(f => f.sent_text).filter(Boolean) || [],
      original_message: originalDraft?.final_message || "",
      // New: last message tracking for proper sender attribution
      last_message_text: followup.last_message_text || null,
      last_message_from: followup.last_message_from || null,
    };

    // Write context to temp file for the agent to read
    const fs = await import("fs/promises");
    const os = await import("os");
    const contextPath = path.join(os.tmpdir(), `followup_context_${followupId}.json`);
    await fs.writeFile(contextPath, JSON.stringify(context, null, 2));

    logger.workerSpawn("followup-agent", [agentPath, "--context", contextPath], { correlationId, followupId });

    const { execSync } = await import("child_process");

    try {
      // Run synchronously to get the result
      const result = execSync(`${pythonExec} ${agentPath} --context "${contextPath}"`, {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 60000, // 60 second timeout
        env: { ...process.env, CORRELATION_ID: correlationId },
      });

      // Parse the result (expected JSON with "message" field)
      const parsed = JSON.parse(result.trim());
      const draft = parsed.message || "";

      if (draft) {
        // Update the followup with the generated draft
        await client
          .from("followups")
          .update({ draft_text: draft })
          .eq("id", followupId);

        logger.actionComplete("generateFollowupDraft", { correlationId, followupId }, { draftLength: draft.length });
        revalidatePath("/followups");
        return { success: true, draft };
      }

      return { success: false, error: "No draft generated" };
    } catch (execError: any) {
      logger.error("Followup agent execution failed", { correlationId, followupId }, execError);
      return { success: false, error: execError.message || "Agent execution failed" };
    } finally {
      // Clean up temp file
      try {
        await fs.unlink(contextPath);
      } catch { }
    }
  } catch (error: any) {
    logger.actionError("generateFollowupDraft", { correlationId, followupId }, error);
    return { success: false, error: error.message || "Unknown error" };
  }
}

/**
 * Generate drafts for all PENDING_REVIEW followups that don't have a draft yet.
 * Runs generation in parallel for better performance.
 */
export async function generateAllFollowupDrafts(): Promise<{
  total: number;
  generated: number;
  failed: number;
  errors: string[];
}> {
  const correlationId = logger.actionStart("generateAllFollowupDrafts", {});

  try {
    const client = supabaseAdmin();

    // Fetch all PENDING_REVIEW followups without a draft
    const { data: followups, error: fetchError } = await client
      .from("followups")
      .select("id, draft_text")
      .eq("status", "PENDING_REVIEW");

    if (fetchError) {
      logger.error("Failed to fetch followups for bulk draft generation", { correlationId }, fetchError);
      throw fetchError;
    }

    // Filter to only those without a draft
    const needsDraft = (followups || []).filter(f => !f.draft_text || f.draft_text.trim() === "");

    if (needsDraft.length === 0) {
      logger.actionComplete("generateAllFollowupDrafts", { correlationId }, { total: 0, generated: 0, failed: 0 });
      return { total: 0, generated: 0, failed: 0, errors: [] };
    }

    logger.info(`Starting bulk draft generation for ${needsDraft.length} followups`, { correlationId });

    // Run all generations in parallel
    const results = await Promise.allSettled(
      needsDraft.map(f => generateFollowupDraft(f.id))
    );

    const errors: string[] = [];
    let generated = 0;
    let failed = 0;

    results.forEach((result, index) => {
      const followupId = needsDraft[index].id;
      if (result.status === "fulfilled" && result.value.success) {
        generated++;
      } else {
        failed++;
        const errorMsg = result.status === "rejected"
          ? result.reason?.message || "Unknown error"
          : result.value.error || "Failed to generate";
        errors.push(`Followup ${followupId}: ${errorMsg}`);
      }
    });

    logger.actionComplete("generateAllFollowupDrafts", { correlationId }, {
      total: needsDraft.length,
      generated,
      failed,
    });

    revalidatePath("/followups");

    return {
      total: needsDraft.length,
      generated,
      failed,
      errors,
    };
  } catch (error: any) {
    logger.actionError("generateAllFollowupDrafts", { correlationId }, error);
    throw error;
  }
}

export async function stopFollowups(leadId: string) {
  const client = supabaseAdmin();
  // Mark all pending/approved followups for this lead as SKIPPED
  const { error } = await client
    .from("followups")
    .update({ status: "SKIPPED" })
    .eq("lead_id", leadId)
    .in("status", ["PENDING_REVIEW", "APPROVED"]);
  if (error) {
    console.error("stopFollowups error", error);
    throw error;
  }
  revalidatePath("/followups");
}

export async function retryFollowup(followupId: string) {
  const client = supabaseAdmin();
  // Reset a FAILED or RETRY_LATER followup back to PENDING_REVIEW
  const { error } = await client
    .from("followups")
    .update({ status: "PENDING_REVIEW", last_error: null, processing_started_at: null })
    .eq("id", followupId);
  if (error) {
    console.error("retryFollowup error", error);
    throw error;
  }
  revalidatePath("/followups");
}

export async function triggerInboxScan() {
  // Fire-and-forget execution of scraper in inbox mode
  try {
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const scraperDir = path.resolve(repoRoot, "workers", "scraper");
    const scraperPath = path.join(scraperDir, "scraper.py");
    const venvPython = path.join(scraperDir, "venv", "bin", "python");
    const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;
    const execToUse = pythonExec;
    const args = [scraperPath, "--inbox", "--run"]; // reuse --run gate

    // Minimal logging so we can see what is being spawned from the Followups tab
    console.log("triggerInboxScan: spawning inbox scraper", { execToUse, args, cwd: repoRoot });

    const proc = spawn(execToUse, args, {
      cwd: repoRoot,
      // Pipe stdout/stderr through to the dev process so logs are visible
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
      env: { ...process.env },
    });
    proc.unref();
  } catch (err) {
    console.error("triggerInboxScan error", err);
  }
}

/**
 * Manually trigger the draft generation agent.
 *
 * This spawns the MCP agent runner which converts ENRICHED leads into drafts
 * and moves them to DRAFT_READY. It runs detached and returns immediately.
 *
 * @param promptType - The type of prompt to use:
 *   1 = Standard Outreach (default)
 *   2 = Vernetzung Thank-You
 *   3 = Process Optimization
 */
export async function triggerDraftGeneration(promptType: PromptType = 1, outreachMode: OutreachMode = "connect_message") {
  startDraftAgent(undefined, promptType, outreachMode);
}

/**
 * Bulk approve all PENDING_REVIEW followups that have a draft.
 * Then triggers the sender worker.
 */
export async function approveAndSendAllFollowups() {
  const correlationId = logger.actionStart("approveAndSendAllFollowups", {});

  try {
    const client = supabaseAdmin();

    // 1. Fetch all pending followups that HAVE draft text
    const { data: pending, error: fetchError } = await client
      .from("followups")
      .select("id")
      .eq("status", "PENDING_REVIEW")
      .not("draft_text", "is", null)
      .neq("draft_text", ""); // Ensure not empty string

    if (fetchError) {
      logger.error("Failed to fetch pending followups", { correlationId }, fetchError);
      throw fetchError;
    }

    if (!pending || pending.length === 0) {
      return { approved: 0, triggered: false };
    }

    const ids = pending.map(p => p.id);

    // 2. Update status to APPROVED
    const { data: updatedData, error: updateError } = await client
      .from("followups")
      .update({ status: "APPROVED" })
      .in("id", ids)
      .select("id");

    if (updateError) {
      logger.error("Failed to bulk approve followups", { correlationId }, updateError);
      throw updateError;
    }

    const approvedCount = updatedData?.length || 0;

    // 3. Trigger sender worker
    let triggered = false;
    if (approvedCount > 0) {
      await triggerFollowupSender();
      triggered = true;
    }

    revalidatePath("/followups");
    logger.actionComplete("approveAndSendAllFollowups", { correlationId }, { approved: approvedCount, triggered });

    return { approved: approvedCount, triggered };

  } catch (error: any) {
    logger.actionError("approveAndSendAllFollowups", { correlationId }, error);
    throw error;
  }
}

export async function triggerFollowupSender() {
  try {
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const senderDir = path.resolve(repoRoot, "workers", "sender");
    const senderPath = path.join(senderDir, "sender.py");
    const venvPython = path.join(senderDir, "venv", "bin", "python");
    const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;
    const execToUse = pythonExec;
    const args = [senderPath, "--followup"]; // process approved followups
    const proc = spawn(execToUse, args, {
      cwd: repoRoot,
      stdio: "ignore",
      detached: true,
      env: { ...process.env },
    });
    proc.unref();
  } catch (err) {
    console.error("triggerFollowupSender error", err);
  }
}

export async function sendLeadNow(leadId: string, outreachMode: OutreachMode = "connect_message") {
  const correlationId = logger.actionStart("sendLeadNow", { leadId }, { outreachMode });
  try {
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const senderDir = path.resolve(repoRoot, "workers", "sender");
    const senderPath = path.join(senderDir, "sender.py");
    const venvPython = path.join(senderDir, "venv", "bin", "python");
    const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;
    const execToUse = pythonExec;
    const args = [senderPath, "--lead-id", leadId];
    if (outreachMode === "message_only") {
      args.push("--message-only");
    }

    logger.workerSpawn("sender", args, { correlationId, leadId, outreachMode });

    const proc = spawn(execToUse, args, {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
      env: { ...process.env, CORRELATION_ID: correlationId },
    });
    proc.unref();
    logger.info("Sender worker triggered for single lead", { correlationId, leadId, pid: proc.pid, outreachMode });
  } catch (err: any) {
    logger.error("sendLeadNow error", { correlationId, leadId }, err);
    throw err;
  } finally {
    revalidatePath("/");
  }
}

export async function sendAllApproved(outreachMode: OutreachMode = "connect_message") {
  const correlationId = logger.actionStart("sendAllApproved", {}, { outreachMode });
  let senderTriggered = false;
  try {
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const senderDir = path.resolve(repoRoot, "workers", "sender");
    const senderPath = path.join(senderDir, "sender.py");
    const venvPython = path.join(senderDir, "venv", "bin", "python");
    const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;
    const execToUse = pythonExec;

    // For message_only mode, pass --message-only flag to sender
    const args = outreachMode === "message_only"
      ? [senderPath, "--message-only"]
      : [senderPath];

    logger.workerSpawn("sender", args, { correlationId, mode: outreachMode });

    const proc = spawn(execToUse, args, {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
      env: { ...process.env, CORRELATION_ID: correlationId },
    });
    proc.unref();
    senderTriggered = true;
    logger.info("Sender worker triggered for all approved", { correlationId, pid: proc.pid, outreachMode });
  } catch (err: any) {
    logger.error("sendAllApproved error", { correlationId }, err);
  } finally {
    revalidatePath("/");
  }
  return { senderTriggered };
}

export async function approveDraft(input: DraftInput) {
  const correlationId = logger.actionStart("approveDraft", { leadId: input.leadId, draftId: input.draftId?.toString() }, input);
  const mode: OutreachMode = input.outreachMode ?? "connect_message";
  const approvedStatus = mode === "message_only" ? "MESSAGE_ONLY_APPROVED" : "APPROVED";

  try {
    const client = supabaseAdmin();

    // Check daily send limit (enforce minimum of 100 even if env is set lower)
    const parsedEnvLimit = parseInt(process.env.DAILY_SEND_LIMIT || "", 10);
    const dailyLimit = Number.isFinite(parsedEnvLimit) && parsedEnvLimit > 0 ? Math.max(parsedEnvLimit, 100) : 100;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const { count } = await client
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("status", "SENT")
      .gte("sent_at", today.toISOString());
    logger.info("Daily limit check", { correlationId, count: count || 0, dailyLimit });

    if ((count || 0) >= dailyLimit) {
      const error = new Error(`Daily send limit reached (${count}/${dailyLimit}). No more messages can be sent today.`);
      logger.actionError("approveDraft", { correlationId, leadId: input.leadId }, error, input);
      throw error;
    }
    const finalMessage = buildFinalMessage(input.opener, input.body, input.cta);

    logger.dbQuery("update", "drafts", { correlationId, draftId: input.draftId?.toString() }, { finalMessage });

    const { error: draftErr } = await client
      .from("drafts")
      .update({
        opener: input.opener,
        body_text: input.body,
        cta_text: input.cta,
        cta_type: input.ctaType || "",
        final_message: finalMessage,
      })
      .eq("id", input.draftId);

    if (draftErr) {
      logger.error("Failed to update draft", { correlationId, draftId: input.draftId?.toString() }, draftErr);
      throw draftErr;
    }

    logger.dbResult("update", "drafts", { correlationId, draftId: input.draftId?.toString() });
    logger.dbQuery("update", "leads", { correlationId, leadId: input.leadId }, { status: approvedStatus });

    const { error: leadErr } = await client
      .from("leads")
      .update({ status: approvedStatus })
      .eq("id", input.leadId);

    if (leadErr) {
      logger.error("Failed to update lead status", { correlationId, leadId: input.leadId }, leadErr);
      throw leadErr;
    }

    logger.dbResult("update", "leads", { correlationId, leadId: input.leadId });

    // Fire-and-forget: trigger the sender worker for connect+message approvals only.
    if (mode === "connect_message") {
      try {
        const repoRoot = path.resolve(process.cwd(), "..", "..");
        const senderDir = path.resolve(repoRoot, "workers", "sender");
        const senderPath = path.join(senderDir, "sender.py");
        const venvPython = path.join(senderDir, "venv", "bin", "python");
        const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
        const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;
        const execToUse = pythonExec;
        const args = [senderPath, "--lead-id", input.leadId];

        logger.workerSpawn("sender", args, { correlationId, leadId: input.leadId });

        const proc = spawn(execToUse, args, {
          cwd: repoRoot,
          stdio: ["ignore", "inherit", "inherit"],
          detached: true,
          env: { ...process.env, CORRELATION_ID: correlationId },
        });
        proc.unref();

        logger.info("Sender worker triggered", { correlationId, leadId: input.leadId, pid: proc.pid });
      } catch (err: any) {
        logger.error("Failed to trigger sender worker", { correlationId, leadId: input.leadId }, err);
      }
    } else {
      logger.info("Message-only draft approved; awaiting message-only sender run", { correlationId, leadId: input.leadId });
    }

    revalidatePath("/");
    logger.actionComplete("approveDraft", { correlationId, leadId: input.leadId });
  } catch (error: any) {
    logger.actionError("approveDraft", { correlationId, leadId: input.leadId }, error, input);
    throw error;
  }
}

export async function approveAndSendAllDrafts(outreachMode: OutreachMode = "connect_message") {
  const correlationId = logger.actionStart("approveAndSendAllDrafts", {}, { outreachMode });
  const isMessageOnly = outreachMode === "message_only";
  const dbOutreachMode = OUTREACH_MODE_TO_DB[outreachMode];
  const draftingStatus = isMessageOnly ? "MESSAGE_ONLY_READY" : "DRAFT_READY";
  const approvedStatus = isMessageOnly ? "MESSAGE_ONLY_APPROVED" : "APPROVED";

  try {
    const client = supabaseAdmin();

    logger.dbQuery("select", "leads", { correlationId }, { status: draftingStatus, outreachMode: dbOutreachMode });

    const { data, error } = await client
      .from("leads")
      .select(
        "id, drafts(id, opener, body_text, cta_text, cta_type, created_at)"
      )
      .eq("status", draftingStatus)
      .eq("outreach_mode", dbOutreachMode);

    if (error) {
      logger.error("Failed to load drafts for bulk approval", { correlationId }, error);
      throw error;
    }

    const leads = data || [];
    const errors: string[] = [];
    let approvedCount = 0;

    type BulkDraft = {
      id: number;
      opener?: string | null;
      body_text?: string | null;
      cta_text?: string | null;
      cta_type?: string | null;
      created_at?: string | null;
    };

    for (const lead of leads) {
      const drafts = Array.isArray((lead as any).drafts) ? ((lead as any).drafts as BulkDraft[]) : [];
      if (!drafts.length) {
        logger.warn("Lead has no drafts during bulk approval", { correlationId, leadId: lead.id });
        continue;
      }

      // Use the latest draft by created_at (fallback to first)
      const draft = drafts
        .slice()
        .sort(
          (a: BulkDraft, b: BulkDraft) =>
            new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
        )[0];

      const finalMessage = buildFinalMessage(draft.opener || "", draft.body_text || "", draft.cta_text || "");

      const { error: draftErr } = await client
        .from("drafts")
        .update({
          final_message: finalMessage,
          opener: draft.opener || "",
          body_text: draft.body_text || "",
          cta_text: draft.cta_text || "",
          cta_type: draft.cta_type || "",
        })
        .eq("id", draft.id);

      if (draftErr) {
        const msg = `Draft update failed for lead ${lead.id}: ${draftErr.message || "unknown error"}`;
        logger.error(
          "Bulk draft update failed",
          { correlationId, leadId: lead.id, draftId: draft.id?.toString() },
          draftErr
        );
        errors.push(msg);
        continue;
      }

      const { error: leadErr } = await client.from("leads").update({ status: approvedStatus }).eq("id", lead.id);
      if (leadErr) {
        const msg = `Lead status update failed for ${lead.id}: ${leadErr.message || "unknown error"}`;
        logger.error("Bulk lead update failed", { correlationId, leadId: lead.id }, leadErr);
        errors.push(msg);
        continue;
      }

      approvedCount += 1;
      logger.dbResult("update", "leads", { correlationId, leadId: lead.id }, { status: approvedStatus });
    }

    let senderTriggered = false;
    if (approvedCount > 0) {
      try {
        const repoRoot = path.resolve(process.cwd(), "..", "..");
        const senderDir = path.resolve(repoRoot, "workers", "sender");
        const senderPath = path.join(senderDir, "sender.py");
        const venvPython = path.join(senderDir, "venv", "bin", "python");
        const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
        const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;
        const execToUse = pythonExec;
        const args = outreachMode === "message_only" ? [senderPath, "--message-only"] : [senderPath];

        logger.workerSpawn("sender", args, { correlationId, approvedCount, outreachMode });

        const proc = spawn(execToUse, args, {
          cwd: repoRoot,
          stdio: ["ignore", "inherit", "inherit"],
          detached: true,
          env: { ...process.env, CORRELATION_ID: correlationId },
        });
        proc.unref();
        senderTriggered = true;
        logger.info("Sender worker triggered for bulk approval", { correlationId, pid: proc.pid });
      } catch (spawnErr: any) {
        logger.error("Failed to trigger sender worker after bulk approval", { correlationId }, spawnErr);
      }
    }

    revalidatePath("/");
    logger.actionComplete("approveAndSendAllDrafts", { correlationId }, {
      approvedCount,
      attempted: leads.length,
      senderTriggered,
      outreachMode,
    });

    return {
      approvedCount,
      attempted: leads.length,
      errors,
      senderTriggered,
      outreachMode,
    };
  } catch (error: any) {
    logger.actionError("approveAndSendAllDrafts", { correlationId }, error);
    throw error;
  }
}

export async function rejectDraft(leadId: string) {
  const client = supabaseAdmin();
  const { error } = await client.from("leads").update({ status: "REJECTED" }).eq("id", leadId);
  if (error) {
    console.error("rejectDraft error", error);
    throw error;
  }
  revalidatePath("/");
}

export async function regenerateDraft(leadId: string, outreachMode: OutreachMode = "connect_message") {
  const correlationId = logger.actionStart("regenerateDraft", { leadId });
  const client = supabaseAdmin();
  const { error: draftErr } = await client.from("drafts").delete().eq("lead_id", leadId);
  if (draftErr) {
    logger.error("regenerateDraft delete error", { correlationId, leadId }, draftErr);
    throw draftErr;
  }
  const nextStatus = outreachMode === "message_only" ? "CONNECT_ONLY_SENT" : "ENRICHED";
  const nextOutreachMode = outreachMode === "message_only" ? "connect_only" : "message";
  const { error: leadErr } = await client
    .from("leads")
    .update({ status: nextStatus, outreach_mode: nextOutreachMode })
    .eq("id", leadId);
  if (leadErr) {
    logger.error("regenerateDraft lead error", { correlationId, leadId }, leadErr);
    throw leadErr;
  }

  startDraftAgent(correlationId, 1, outreachMode);
  revalidatePath("/");
  logger.actionComplete("regenerateDraft", { correlationId, leadId });
}

type LeadCsvRow = {
  linkedin_url: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
};

export async function importLeads(rows: LeadCsvRow[], fileName?: string) {
  if (!rows?.length) return { inserted: 0 };
  const sanitized = rows
    .map((row) => ({
      linkedin_url: row.linkedin_url?.trim(),
      first_name: row.first_name?.trim() || null,
      last_name: row.last_name?.trim() || null,
      company_name: row.company_name?.trim() || null,
      status: "NEW",
    }))
    .filter((row) => row.linkedin_url);
  if (!sanitized.length) return { inserted: 0 };

  const client = supabaseAdmin();
  const batchName = fileName?.trim() || `CSV batch ${new Date().toISOString()}`;
  const { data: defaultSequence, error: defaultSequenceError } = await client
    .from("outreach_sequences")
    .select("id")
    .eq("name", "Default Sequence")
    .maybeSingle();

  if (defaultSequenceError) {
    console.error("importLeads default sequence error", defaultSequenceError);
    throw defaultSequenceError;
  }
  if (!defaultSequence?.id) {
    throw new Error("Default Sequence not found.");
  }

  const { data: batchData, error: batchError } = await client
    .from("lead_batches")
    .insert({ name: batchName, source: "csv_upload", sequence_id: defaultSequence.id })
    .select("id")
    .single();

  if (batchError || !batchData) {
    console.error("importLeads batch error", batchError);
    throw batchError || new Error("Could not create lead batch.");
  }

  const batchId = batchData.id;
  const batched = sanitized.map((row) => ({
    ...row,
    batch_id: batchId,
    sequence_id: defaultSequence.id,
  }));

  const { error, count } = await client.from("leads").upsert(batched, {
    onConflict: "linkedin_url",
    ignoreDuplicates: true,
    count: "exact",
  });
  if (error) {
    console.error("importLeads error", error);
    throw error;
  }
  await client.from("leads").update({ batch_id: batchId, sequence_id: defaultSequence.id }).in(
    "linkedin_url",
    sanitized.map((row) => row.linkedin_url)
  );
  try {
    revalidatePath("/");
    revalidatePath("/leads");
  } catch (error) {
    console.warn("importLeads revalidate skipped", error);
  }
  return { inserted: count || sanitized.length, batchId };
}

export async function fetchLinkedinCredentials(): Promise<LinkedinCredentialSummary> {
  const client = supabaseAdmin();
  const { data, error } = await client
    .from("settings")
    .select("value")
    .eq("key", "linkedin_credentials")
    .maybeSingle();

  if (error) {
    console.error("fetchLinkedinCredentials error", error);
    return { hasPassword: false };
  }

  const value = (data as any)?.value || {};
  return {
    email: value.email || "",
    hasPassword: Boolean(value.password),
  };
}

export async function saveLinkedinCredentials(
  _prev: LinkedinCredentialState,
  formData: FormData
): Promise<LinkedinCredentialState> {
  const email = (formData.get("email") as string)?.trim();
  const password = (formData.get("password") as string)?.trim();

  if (!email || !password) {
    return { success: false, error: "Email and password are required." };
  }

  const client = supabaseAdmin();
  const { error } = await client
    .from("settings")
    .upsert({ key: "linkedin_credentials", value: { email, password } }, { onConflict: "key" });

  if (error) {
    console.error("saveLinkedinCredentials error", error);
    return { success: false, error: "Could not save credentials." };
  }

  revalidatePath("/");
  revalidatePath("/settings");
  return { success: true };
}

// ==================== ANALYTICS ====================

export type OutreachAnalytics = {
  totalLeads: number;
  connectionRequestsSent: number;
  connectionsAccepted: number;
  messagesSent: number;
  repliesReceived: number;
  followupsSent: number;
  followupReplies: number;
  connectionAcceptanceRate: number;
  messageResponseRate: number;
  overallConversionRate: number;
  statusCounts: Record<string, number>;
};

export type DailyMetrics = {
  date: string;
  connectionsSent: number;
  connectionsAccepted: number;
  messagesSent: number;
  replies: number;
  followupsSent: number;
};

export type FunnelStage = {
  name: string;
  count: number;
  percentage: number;
};

export type FunnelStats = {
  stages: FunnelStage[];
};

const LEAD_STATUSES = [
  "NEW",
  "ENRICHED",
  "PROCESSING",
  "ENRICH_FAILED",
  "DRAFT_READY",
  "APPROVED",
  "MESSAGE_ONLY_READY",
  "MESSAGE_ONLY_APPROVED",
  "SENT",
  "CONNECT_ONLY_SENT",
  "CONNECTED",
  "REPLIED",
  "REJECTED",
  "FAILED",
] as const;

/**
 * Fetch aggregate outreach analytics.
 */
export async function fetchOutreachAnalytics(): Promise<OutreachAnalytics> {
  const correlationId = logger.actionStart("fetchOutreachAnalytics", {});

  try {
    const client = supabaseAdmin();

    // Get status counts
    const statusCounts: Record<string, number> = {};
    await Promise.all(
      LEAD_STATUSES.map(async (status) => {
        const { count, error } = await client
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("status", status);
        if (error) {
          logger.error(`Failed to count status ${status}`, { correlationId }, error);
        }
        statusCounts[status] = count ?? 0;
      })
    );

    const totalLeads = Object.values(statusCounts).reduce((sum, c) => sum + c, 0);

    // Connection requests sent (anyone who has connection_sent_at set)
    const { count: connectionRequestsSent } = await client
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("connection_sent_at", "is", null);

    // Connections accepted (connection_accepted_at is set)
    const { count: connectionsAccepted } = await client
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("connection_accepted_at", "is", null);

    // Messages sent (sent_at is set)
    const { count: messagesSent } = await client
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("sent_at", "is", null);

    // Replies received - leads who have replied at least once (last_reply_at is set)
    // This is more accurate than counting status = 'REPLIED' which may not always be set
    const { count: repliesReceivedCount } = await client
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("last_reply_at", "is", null);

    const repliesReceived = repliesReceivedCount ?? 0;

    // Follow-ups sent
    const { count: followupsSent } = await client
      .from("followups")
      .select("id", { count: "exact", head: true })
      .eq("status", "SENT");

    // Follow-ups responding to replies - SENT followups that were created to respond to a lead's reply
    // (followup_type = 'REPLY' AND status = 'SENT' means we actually sent a response to their reply)
    const { count: followupReplies } = await client
      .from("followups")
      .select("id", { count: "exact", head: true })
      .eq("followup_type", "REPLY")
      .eq("status", "SENT");

    // Calculate rates
    const connReqSent = connectionRequestsSent ?? 0;
    const connAccepted = connectionsAccepted ?? 0;
    const msgSent = messagesSent ?? 0;
    const fuSent = followupsSent ?? 0;
    const fuReplies = followupReplies ?? 0;

    const connectionAcceptanceRate = connReqSent > 0 ? (connAccepted / connReqSent) * 100 : 0;
    const messageResponseRate = msgSent > 0 ? (repliesReceived / msgSent) * 100 : 0;
    const overallConversionRate = totalLeads > 0 ? (repliesReceived / totalLeads) * 100 : 0;

    const result: OutreachAnalytics = {
      totalLeads,
      connectionRequestsSent: connReqSent,
      connectionsAccepted: connAccepted,
      messagesSent: msgSent,
      repliesReceived,
      followupsSent: fuSent,
      followupReplies: fuReplies,
      connectionAcceptanceRate: Math.round(connectionAcceptanceRate * 10) / 10,
      messageResponseRate: Math.round(messageResponseRate * 10) / 10,
      overallConversionRate: Math.round(overallConversionRate * 10) / 10,
      statusCounts,
    };

    logger.actionComplete("fetchOutreachAnalytics", { correlationId }, result);
    return result;
  } catch (error: any) {
    logger.actionError("fetchOutreachAnalytics", { correlationId }, error);
    throw error;
  }
}

/**
 * Fetch daily metrics for time series visualization.
 * @param days Number of days to look back (default 7)
 */
export async function fetchDailyMetrics(days: number = 7): Promise<DailyMetrics[]> {
  const correlationId = logger.actionStart("fetchDailyMetrics", {}, { days });

  try {
    const client = supabaseAdmin();
    const results: DailyMetrics[] = [];

    // Generate array of dates from today back to N days ago
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      date.setUTCHours(0, 0, 0, 0);
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);

      const startIso = date.toISOString();
      const endIso = nextDate.toISOString();
      const dateStr = date.toISOString().split("T")[0];

      // Connections sent
      const { count: connectionsSent } = await client
        .from("leads")
        .select("id", { count: "exact", head: true })
        .gte("connection_sent_at", startIso)
        .lt("connection_sent_at", endIso);

      // Connections accepted
      const { count: connectionsAccepted } = await client
        .from("leads")
        .select("id", { count: "exact", head: true })
        .gte("connection_accepted_at", startIso)
        .lt("connection_accepted_at", endIso);

      // Messages sent
      const { count: messagesSent } = await client
        .from("leads")
        .select("id", { count: "exact", head: true })
        .gte("sent_at", startIso)
        .lt("sent_at", endIso);

      // Replies (leads that became REPLIED on this date)
      const { count: replies } = await client
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("status", "REPLIED")
        .gte("updated_at", startIso)
        .lt("updated_at", endIso);

      // Follow-ups sent
      const { count: followupsSent } = await client
        .from("followups")
        .select("id", { count: "exact", head: true })
        .eq("status", "SENT")
        .gte("sent_at", startIso)
        .lt("sent_at", endIso);

      results.push({
        date: dateStr,
        connectionsSent: connectionsSent ?? 0,
        connectionsAccepted: connectionsAccepted ?? 0,
        messagesSent: messagesSent ?? 0,
        replies: replies ?? 0,
        followupsSent: followupsSent ?? 0,
      });
    }

    logger.actionComplete("fetchDailyMetrics", { correlationId }, { count: results.length });
    return results;
  } catch (error: any) {
    logger.actionError("fetchDailyMetrics", { correlationId }, error);
    throw error;
  }
}

/**
 * Fetch conversion funnel stats.
 */
export async function fetchConversionFunnel(): Promise<FunnelStats> {
  const correlationId = logger.actionStart("fetchConversionFunnel", {});

  try {
    const client = supabaseAdmin();

    // Total leads
    const { count: totalLeads } = await client
      .from("leads")
      .select("id", { count: "exact", head: true });

    // Connection requests sent
    const { count: connectionsSent } = await client
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("connection_sent_at", "is", null);

    // Connections accepted
    const { count: connectionsAccepted } = await client
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("connection_accepted_at", "is", null);

    // Messages sent
    const { count: messagesSent } = await client
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("sent_at", "is", null);

    // Replies
    const { count: replies } = await client
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("status", "REPLIED");

    const total = totalLeads ?? 0;
    const connSent = connectionsSent ?? 0;
    const connAccepted = connectionsAccepted ?? 0;
    const msgSent = messagesSent ?? 0;

    // Get replies using last_reply_at for accuracy (matches the main analytics)
    const { count: repliesCount } = await client
      .from("leads")
      .select("id", { count: "exact", head: true })
      .not("last_reply_at", "is", null);

    const replyCount = repliesCount ?? 0;

    // Build funnel with cumulative percentages from total leads
    // Each stage shows what % of total leads reached this milestone
    const stages: FunnelStage[] = [
      {
        name: "Leads Added",
        count: total,
        percentage: 100,
      },
      {
        name: "Outreach Sent",
        count: msgSent,
        percentage: total > 0 ? Math.round((msgSent / total) * 1000) / 10 : 0,
      },
      {
        name: "Connection Requests",
        count: connSent,
        percentage: total > 0 ? Math.round((connSent / total) * 1000) / 10 : 0,
      },
      {
        name: "Connections Accepted",
        count: connAccepted,
        percentage: connSent > 0 ? Math.round((connAccepted / connSent) * 1000) / 10 : 0,
      },
      {
        name: "Replied",
        count: replyCount,
        percentage: msgSent > 0 ? Math.round((replyCount / msgSent) * 1000) / 10 : 0,
      },
    ];

    logger.actionComplete("fetchConversionFunnel", { correlationId }, { stages: stages.length });
    return { stages };
  } catch (error: any) {
    logger.actionError("fetchConversionFunnel", { correlationId }, error);
    throw error;
  }
}
