"use server";

import { spawn } from "child_process";
import path from "path";

import { revalidatePath } from "next/cache";

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
  const client = supabaseAdmin();
  const { data, error } = await client
    .from("leads")
    .select("id, linkedin_url, first_name, last_name, company_name, profile_data, recent_activity, drafts(*)")
    .eq("status", "DRAFT_READY")
    .order("updated_at", { ascending: false })
    .limit(25);

  if (error) {
    console.error("fetchDraftFeed error", error);
    return [];
  }
  return (data || []).flatMap((lead) =>
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

export async function fetchLeadList(page = 1, pageSize = 50): Promise<LeadListResult> {
  const client = supabaseAdmin();
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await client
    .from("leads")
    .select(
      "id, linkedin_url, first_name, last_name, company_name, status, created_at, updated_at, profile_data, recent_activity",
      {
        count: "exact",
      }
    )
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    console.error("fetchLeadList error", error);
    return { leads: [], total: 0, page, pageSize, totalPages: 0 };
  }

  const leads = (data || []).map((lead) => ({
    id: lead.id,
    linkedin_url: lead.linkedin_url,
    first_name: lead.first_name || null,
    last_name: lead.last_name || null,
    company_name: lead.company_name || null,
    status: lead.status || "NEW",
    created_at: lead.created_at,
    updated_at: lead.updated_at,
    profile_data: lead.profile_data || null,
    recent_activity: lead.recent_activity || null,
  }));

  const total = count || 0;
  const totalPages = total ? Math.max(1, Math.ceil(total / pageSize)) : 1;

  return { leads, total: total || 0, page, pageSize, totalPages };
}

export async function approveDraft(input: DraftInput) {
  const client = supabaseAdmin();
  const finalMessage = buildFinalMessage(input.opener, input.body, input.cta);

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
    console.error("approveDraft update draft error", draftErr);
    throw draftErr;
  }

  const { error: leadErr } = await client
    .from("leads")
    .update({ status: "APPROVED" })
    .eq("id", input.leadId);
  if (leadErr) {
    console.error("approveDraft update lead error", leadErr);
    throw leadErr;
  }

  // Fire-and-forget: trigger the sender worker to send this lead right away.
  try {
    // Compute repo root (this file runs under apps/web). Go up two levels.
    const repoRoot = path.resolve(process.cwd(), "..", "..");
    const senderDir = path.resolve(repoRoot, "workers", "sender");
    const senderPath = path.join(senderDir, "sender.py");
    // Prefer sender venv python if present; else PYTHON_BIN; else python3
    const venvPython = path.join(senderDir, "venv", "bin", "python");
    const pythonBin = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const pythonExec = process.env.FORCE_SYSTEM_PY === "1" ? pythonBin : venvPython;
    const execToUse = pythonExec;
    const args = [senderPath, "--lead-id", input.leadId];
    const proc = spawn(execToUse, args, {
      cwd: repoRoot,
      stdio: "ignore",
      detached: true,
      env: { ...process.env },
    });
    proc.unref();
  } catch (err) {
    console.error("approveDraft trigger sender error", err);
  }

  revalidatePath("/");
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
