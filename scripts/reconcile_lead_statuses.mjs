#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const staleMinutes = Number(process.env.PROCESSING_STALE_MINUTES || "45");

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error("Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const parseIso = (value) => {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? null : ts;
};

const nowIso = () => new Date().toISOString();

async function main() {
  const { data, error } = await client
    .from("leads")
    .select("id,status,updated_at,sent_at,connection_sent_at,connection_accepted_at,outreach_mode,linkedin_url,error_message")
    .neq("status", "NEW")
    .order("updated_at", { ascending: false });

  if (error) throw error;

  const cutoffMs = Date.now() - staleMinutes * 60 * 1000;
  const staleProcessing = (data || []).filter((row) => {
    if (row.status !== "PROCESSING") return false;
    const updatedAt = parseIso(row.updated_at);
    return updatedAt !== null && updatedAt < cutoffMs;
  });

  const report = {
    totalNonNew: data?.length || 0,
    staleProcessing: staleProcessing.map((row) => ({
      id: row.id,
      status: row.status,
      updated_at: row.updated_at,
      linkedin_url: row.linkedin_url,
      outreach_mode: row.outreach_mode,
    })),
  };

  console.log(JSON.stringify({ apply, staleMinutes, report }, null, 2));

  if (!apply) return;

  const updates = [];
  for (const row of staleProcessing) {
    const reason = `Recovered stale PROCESSING lead after ${staleMinutes} minutes without completion.`;
    const payload = {
      status: "FAILED",
      updated_at: nowIso(),
      error_message: reason,
    };
    const { error: updateError } = await client.from("leads").update(payload).eq("id", row.id);
    if (updateError) {
      updates.push({ id: row.id, ok: false, error: updateError.message || String(updateError) });
      continue;
    }
    updates.push({ id: row.id, ok: true, nextStatus: "FAILED" });
  }

  console.log(JSON.stringify({ apply, updates }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
