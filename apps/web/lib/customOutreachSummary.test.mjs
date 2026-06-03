import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app/actions.ts", import.meta.url), "utf8");

assert.match(
  source,
  /function buildCustomOutreachBatchSummaries\(/,
  "actions.ts should expose a pure summary builder for batch status aggregation"
);

assert.match(
  source,
  /\.from\("leads"\)[\s\S]*\.in\("batch_id", batchIds\)/,
  "fetchCustomOutreachBatchSummaries should fetch lead statuses for all custom batches in one batched query"
);

assert.match(
  source,
  /\.range\(offset, offset \+ CUSTOM_OUTREACH_STATUS_PAGE_SIZE - 1\)/,
  "fetchCustomOutreachBatchSummaries should page through all matching lead statuses instead of relying on Supabase's default row cap"
);

const functionBody = source.match(/export async function fetchCustomOutreachBatchSummaries[\s\S]*?\n}\n/)?.[0] || "";
assert.doesNotMatch(
  functionBody,
  /Promise\.all\(\s*\(\s*batches\s*\|\|\s*\[\]\s*\)\.map/,
  "fetchCustomOutreachBatchSummaries should not run one status query per batch"
);

console.log("customOutreachSummary regression checks passed");
