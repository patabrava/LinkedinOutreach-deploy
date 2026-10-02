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

test("analytics reports are public and use campaign-scoped analytics", () => {
  assert.doesNotMatch(analyticsIndex, /requireServerSession/);
  assert.doesNotMatch(campaignPage, /requireServerSession/);
  assert.match(campaignPage, /fetchCampaignAnalytics\(campaign, validDays\)/);
  assert.match(campaignPage, /Sends are reconciled from persisted lead timestamps/);
  assert.doesNotMatch(campaignPage, /infer/i);
});

test("campaign pages show sender breakdowns and combined totals", () => {
  assert.match(campaignPage, /ACCOUNT PERFORMANCE/);
  assert.match(campaignPage, /analytics\.accounts\.map/);
  assert.match(campaignPage, /TOTAL · ALL SENDERS/);
  assert.match(campaignPage, /MESSAGES TOTAL/);
});
