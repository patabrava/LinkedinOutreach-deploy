import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const analyticsIndex = readFileSync(join(process.cwd(), "app/analytics/page.tsx"), "utf8");
const campaignPage = readFileSync(join(process.cwd(), "app/analytics/[campaign]/page.tsx"), "utf8");

test("analytics overview links to both isolated campaign pages", () => {
  assert.match(analyticsIndex, /\/analytics\/regular/);
  assert.match(analyticsIndex, /\/analytics\/sales-navigator/);
});

test("campaign pages are server-authenticated and use campaign-scoped analytics", () => {
  assert.match(campaignPage, /requireServerSession/);
  assert.match(campaignPage, /fetchCampaignAnalytics\(campaign, validDays\)/);
  assert.match(campaignPage, /Only persisted campaign events/);
  assert.doesNotMatch(campaignPage, /infer/i);
});
