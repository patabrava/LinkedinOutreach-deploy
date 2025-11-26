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
  try {
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const agentDir = path.resolve(repoRoot, "mcp-server");
    const agentPath = path.join(agentDir, "run_agent.py");
    // Prefer agent venv python if present; else PYTHON_BIN; else python3
    const venvPython = path.join(agentDir, "venv", "bin", "python");
    const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;
    const execToUse = pythonExec;
    const args = [agentPath];
    const proc = spawn(execToUse, args, {
      cwd: repoRoot,
      stdio: "ignore",
      detached: true,
      env: { ...process.env },
    });
    proc.unref();
  } catch (err) {
    console.error("triggerDraftGeneration error", err);
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
        stdio: "ignore",
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
  const client = supabaseAdmin();
  const { error: draftErr } = await client.from("drafts").delete().eq("lead_id", leadId);
  if (draftErr) {
    console.error("regenerateDraft delete error", draftErr);
    throw draftErr;
  }
  const { error: leadErr } = await client.from("leads").update({ status: "ENRICHED" }).eq("id", leadId);
  if (leadErr) {
    console.error("regenerateDraft lead error", leadErr);
    throw leadErr;
  }
  revalidatePath("/");
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
