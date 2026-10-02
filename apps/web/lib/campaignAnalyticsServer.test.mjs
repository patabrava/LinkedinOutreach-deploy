import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(name, imports) {
  const filename = fileURLToPath(new URL(name, import.meta.url));
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => {
    assert.ok(id in imports, `Unexpected import ${id}`);
    return imports[id];
  }, Date, Map, Set }, { filename });
  return module.exports;
}

test("shared campaign queries include both senders while rejecting mismatched event ownership", async () => {
  const now = new Date().toISOString();
  const rows = {
    linkedin_accounts: ["owner", "second", "empty"].map((id) => ({ id, display_name: id === "owner" ? "Katharina" : id === "second" ? "Sandra" : "Empty sender", is_active: true })),
    lead_batches: [30, 31, 32].map((id) => ({ id, sequence_id: id - 23, linkedin_account_id: "owner" })),
    outreach_sequences: [7, 8, 9].map((id) => ({ id, linkedin_account_id: "owner", delivery_mode: "standard_connect_message" })),
    leads: ["owner", "second"].map((account) => ({ id: account, batch_id: 30, sequence_id: 7, linkedin_account_id: account, status: "SENT", connection_sent_at: now, sent_at: now })),
    followups: [{ id: "fu-second", lead_id: "second", linkedin_account_id: "second", status: "SENT", sent_at: now, attempt: 1, leads: { batch_id: 30, sequence_id: 7 } }],
    outreach_events: ["owner", "second"].map((account) => ({ lead_id: account, sequence_id: 7, linkedin_account_id: account, event_type: "touch_sent", touch_number: 1, occurred_at: now })).concat([
      { lead_id: "owner", sequence_id: 7, linkedin_account_id: "second", event_type: "reply_received", occurred_at: now },
      { lead_id: "outside", sequence_id: 7, linkedin_account_id: "second", event_type: "reply_received", occurred_at: now },
      { lead_id: "second", sequence_id: 7, linkedin_account_id: "second", event_type: "touch_sent", touch_number: 2, occurred_at: now, metadata: { followup_id: "fu-second" } },
    ]),
  };
  const client = { from(table) {
    let data = rows[table];
    const query = {
      select() { return query; },
      eq(key, value) { data = data.filter((row) => key.split(".").reduce((part, field) => part?.[field], row) === value); return query; },
      in(key, values) { data = data.filter((row) => values.includes(row[key])); return query; },
      gte(key, value) { data = data.filter((row) => row[key] >= value); return query; },
      lt(key, value) { data = data.filter((row) => row[key] < value); return query; },
      order() { return query; },
      range(from, to) { return Promise.resolve({ data: data.slice(from, to + 1), error: null }); },
      then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject); },
    };
    return query;
  } };
  const aggregation = load("./campaignAnalytics.ts", {});
  const { fetchCampaignAnalytics } = load("./campaignAnalyticsServer.ts", {
    "server-only": {}, "./supabaseAdmin": { supabaseAdmin: () => client }, "./campaignAnalytics": aggregation,
  });
  const result = await fetchCampaignAnalytics("regular", 30);
  assert.equal(result.leadCount, 2);
  assert.equal(result.firstTouchesSent, 2);
  assert.equal(result.invitesSent, 2);
  assert.equal(result.followupTouchesSent, 1);
  assert.equal(result.repliesReceived, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.accounts.map((row) => [row.label, row.leadCount, row.invitesSent, row.firstTouchesSent, row.followupTouchesSent, row.messagesSent]))), [
    ["Empty sender", 0, 0, 0, 0, 0], ["Katharina", 1, 1, 1, 0, 1], ["Sandra", 1, 1, 1, 1, 2],
  ]);
  for (const metric of ["leadCount", "invitesSent", "firstTouchesSent", "followupTouchesSent", "repliesReceived"]) {
    assert.equal(result.accounts.reduce((sum, row) => sum + row[metric], 0), result[metric]);
  }
});
