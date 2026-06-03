import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const customWorkspace = readFileSync(new URL("../components/CustomOutreachWorkspace.tsx", import.meta.url), "utf8");
const draftFeed = readFileSync(new URL("../components/DraftFeed.tsx", import.meta.url), "utf8");
const startButton = readFileSync(new URL("../components/StartEnrichmentButton.tsx", import.meta.url), "utf8");

const refreshCalls = [...customWorkspace.matchAll(/router\.refresh\(\)/g)].length;
assert.equal(refreshCalls, 0, "CustomOutreachWorkspace should not force full route refresh after local draft actions");

assert.match(
  customWorkspace,
  /fetchCustomOutreachBatchSummaries/,
  "CustomOutreachWorkspace should refresh custom batch summaries locally after draft actions"
);

assert.match(
  customWorkspace,
  /document\.visibilityState !== "visible"/,
  "CustomOutreachWorkspace polling should pause on hidden tabs"
);

assert.match(
  draftFeed,
  /document\.visibilityState !== "visible"/,
  "DraftFeed polling should pause on hidden tabs"
);

assert.match(
  startButton,
  /document\.visibilityState !== "visible"/,
  "StartEnrichmentButton fallback polling should pause on hidden tabs"
);

console.log("pollingRefreshGuards regression checks passed");
