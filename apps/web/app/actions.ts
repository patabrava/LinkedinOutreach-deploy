"use server";

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
};

export async function fetchLeadList(limit = 120): Promise<LeadListRow[]> {
  const client = supabaseAdmin();
  const { data, error } = await client
    .from("leads")
    .select("id, linkedin_url, first_name, last_name, company_name, status, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("fetchLeadList error", error);
    return [];
  }

  return (data || []).map((lead) => ({
    id: lead.id,
    linkedin_url: lead.linkedin_url,
    first_name: lead.first_name || null,
    last_name: lead.last_name || null,
    company_name: lead.company_name || null,
    status: lead.status || "NEW",
    created_at: lead.created_at,
    updated_at: lead.updated_at,
  }));
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
