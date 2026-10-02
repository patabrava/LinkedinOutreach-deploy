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
    lead_batches: [30, 31, 32].map((id) => ({ id, sequence_id: id - 23, linkedin_account_id: "owner" })),
    outreach_sequences: [7, 8, 9].map((id) => ({ id, linkedin_account_id: "owner", delivery_mode: "standard_connect_message" })),
    leads: ["owner", "second"].map((account) => ({ id: account, batch_id: 30, sequence_id: 7, linkedin_account_id: account, status: "SENT" })),
    outreach_events: ["owner", "second"].map((account) => ({ lead_id: account, sequence_id: 7, linkedin_account_id: account, event_type: "touch_sent", touch_number: 1, occurred_at: now })).concat([
      { lead_id: "owner", sequence_id: 7, linkedin_account_id: "second", event_type: "reply_received", occurred_at: now },
      { lead_id: "outside", sequence_id: 7, linkedin_account_id: "second", event_type: "reply_received", occurred_at: now },
    ]),
  };
  const client = { from(table) {
    let data = rows[table];
    const query = {
      select() { return query; },
      eq(key, value) { data = data.filter((row) => row[key] === value); return query; },
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
  assert.equal(result.repliesReceived, 0);
});
