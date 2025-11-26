"use server";

import { spawn } from "child_process";
import path from "path";

import { revalidatePath } from "next/cache";

import { logger } from "../lib/logger";
import { supabaseAdmin } from "../lib/supabaseAdmin";

type DraftInput = {
  leadId: string;
  draftId?: number;
  opener: string;
  body: string;
  cta: string;
  ctaType?: string;
};

export type LinkedinCredentialSummary = {
  email?: string;
  hasPassword: boolean;
};

export type LinkedinCredentialState = {
  success: boolean;
  error?: string;
};

function startDraftAgent(correlationId?: string) {
  try {
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const agentDir = path.resolve(repoRoot, "mcp-server");
    const agentPath = path.join(agentDir, "run_agent.py");
    const venvPython = path.join(agentDir, "venv", "bin", "python");
    const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;
    const execToUse = pythonExec;
    const args = [agentPath];

    logger.workerSpawn("draft-agent", args, correlationId ? { correlationId } : undefined);

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

export async function fetchDraftFeed() {
  const correlationId = logger.actionStart("fetchDraftFeed");
  
  try {
    const client = supabaseAdmin();
    
    logger.dbQuery("select", "leads", { correlationId }, { status: "DRAFT_READY", limit: 25 });
    
    const { data, error } = await client
      .from("leads")
      .select("id, linkedin_url, first_name, last_name, company_name, profile_data, recent_activity, drafts(*)")
      .eq("status", "DRAFT_READY")
      .order("updated_at", { ascending: false })
      .limit(25);

    if (error) {
      logger.error("Failed to fetch draft feed", { correlationId }, error);
      return [];
    }
    
    logger.dbResult("select", "leads", { correlationId }, data);
    
    const result = (data || []).flatMap((lead) =>
      (lead.drafts || []).map((draft: any) => ({
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
      }))
    );
    
    logger.actionComplete("fetchDraftFeed", { correlationId }, { count: result.length });
    return result;
  } catch (error: any) {
    logger.actionError("fetchDraftFeed", { correlationId }, error);
    return [];
  }
}

const buildFinalMessage = (opener: string, body: string, cta: string) =>
  [opener, body, cta].filter(Boolean).join("\n\n");

export type LeadListRow = {
  id: string;
  linkedin_url: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  status: string | null;
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
        "id, linkedin_url, first_name, last_name, company_name, status, followup_count, last_reply_at, created_at, updated_at, profile_data, recent_activity",
        { count: "exact" }
      )
      .order("created_at", { ascending: false });

    // Apply optional filters
    if (filters) {
      const { status, company, name, linkedin } = filters;
      if (status) {
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

// Follow-ups data model
export type FollowupRow = {
  id: string;
  lead_id: string;
  status: "PENDING_REVIEW" | "APPROVED" | "SENT" | "SKIPPED";
  reply_id?: string | null;
  reply_snippet?: string | null;
  reply_timestamp?: string | null;
  draft_text?: string | null;
  sent_text?: string | null;
  sent_at?: string | null;
  attempt: number;
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
  };
};

export async function fetchFollowups(statuses: Array<FollowupRow["status"]> = ["PENDING_REVIEW", "APPROVED"], limit = 50) {
  const correlationId = logger.actionStart("fetchFollowups", {}, { statuses, limit });
  
  try {
    const client = supabaseAdmin();
    
    logger.dbQuery("select", "followups", { correlationId }, { statuses, limit });
    
    let query = client
      .from("followups")
      .select("*, lead:leads(id, first_name, last_name, company_name, linkedin_url, last_reply_at, followup_count)")
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
    const proc = spawn(execToUse, args, {
      cwd: repoRoot,
      stdio: "ignore",
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
 */
export async function triggerDraftGeneration() {
  startDraftAgent();
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

export async function approveDraft(input: DraftInput) {
  const correlationId = logger.actionStart("approveDraft", { leadId: input.leadId, draftId: input.draftId?.toString() }, input);
  
  try {
    const client = supabaseAdmin();
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
    logger.dbQuery("update", "leads", { correlationId, leadId: input.leadId }, { status: "APPROVED" });

    const { error: leadErr } = await client
      .from("leads")
      .update({ status: "APPROVED" })
      .eq("id", input.leadId);
      
    if (leadErr) {
      logger.error("Failed to update lead status", { correlationId, leadId: input.leadId }, leadErr);
      throw leadErr;
    }
    
    logger.dbResult("update", "leads", { correlationId, leadId: input.leadId });

    // Fire-and-forget: trigger the sender worker to send this lead right away.
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
        stdio: ["ignore", "inherit", "inherit"], // inherit stdout/stderr for debugging
        detached: true,
        env: { ...process.env, CORRELATION_ID: correlationId },
      });
      proc.unref();
      
      logger.info("Sender worker triggered", { correlationId, leadId: input.leadId, pid: proc.pid });
    } catch (err: any) {
      logger.error("Failed to trigger sender worker", { correlationId, leadId: input.leadId }, err);
    }

    revalidatePath("/");
    logger.actionComplete("approveDraft", { correlationId, leadId: input.leadId });
  } catch (error: any) {
    logger.actionError("approveDraft", { correlationId, leadId: input.leadId }, error, input);
    throw error;
  }
}

export async function approveAndSendAllDrafts() {
  const correlationId = logger.actionStart("approveAndSendAllDrafts");

  try {
    const client = supabaseAdmin();
    logger.dbQuery("select", "leads", { correlationId }, { status: "DRAFT_READY" });

    const { data, error } = await client
      .from("leads")
      .select(
        "id, drafts(id, opener, body_text, cta_text, cta_type, created_at)"
      )
      .eq("status", "DRAFT_READY");

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

      const { error: leadErr } = await client.from("leads").update({ status: "APPROVED" }).eq("id", lead.id);
      if (leadErr) {
        const msg = `Lead status update failed for ${lead.id}: ${leadErr.message || "unknown error"}`;
        logger.error("Bulk lead update failed", { correlationId, leadId: lead.id }, leadErr);
        errors.push(msg);
        continue;
      }

      approvedCount += 1;
      logger.dbResult("update", "leads", { correlationId, leadId: lead.id }, { status: "APPROVED" });
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
        const args = [senderPath];

        logger.workerSpawn("sender", args, { correlationId, approvedCount });

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
    logger.actionComplete("approveAndSendAllDrafts", { correlationId }, { approvedCount, attempted: leads.length, senderTriggered });

    return {
      approvedCount,
      attempted: leads.length,
      errors,
      senderTriggered,
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

export async function regenerateDraft(leadId: string) {
  const correlationId = logger.actionStart("regenerateDraft", { leadId });
  const client = supabaseAdmin();
  const { error: draftErr } = await client.from("drafts").delete().eq("lead_id", leadId);
  if (draftErr) {
    logger.error("regenerateDraft delete error", { correlationId, leadId }, draftErr);
    throw draftErr;
  }
  const { error: leadErr } = await client.from("leads").update({ status: "ENRICHED" }).eq("id", leadId);
  if (leadErr) {
    logger.error("regenerateDraft lead error", { correlationId, leadId }, leadErr);
    throw leadErr;
  }

  startDraftAgent(correlationId);
  revalidatePath("/");
  logger.actionComplete("regenerateDraft", { correlationId, leadId });
}

type LeadCsvRow = {
  linkedin_url: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
};

export async function importLeads(rows: LeadCsvRow[]) {
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

  const client = supabaseAdmin();
  const { error, count } = await client.from("leads").upsert(sanitized, {
    onConflict: "linkedin_url",
    ignoreDuplicates: true,
    count: "exact",
  });
  if (error) {
    console.error("importLeads error", error);
    throw error;
  }
  revalidatePath("/");
  revalidatePath("/leads");
  return { inserted: count || sanitized.length };
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
