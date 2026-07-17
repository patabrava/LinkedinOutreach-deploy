import assert from "node:assert/strict";
import test from "node:test";

import { getDeguraPerformanceReport } from "./deguraPerformanceReport";

test("degura report exposes a simple tracking-focused snapshot", () => {
  const report = getDeguraPerformanceReport();

  assert.equal(report.hero.title, "DEGURA OUTREACH");
  assert.equal(report.snapshotAt, "17. Juli 2026, 14:02 Uhr MESZ");
  assert.equal(report.kpis.find((item) => item.label === "Kontaktanfragen")?.value, "1.077");
  assert.equal(report.kpis.find((item) => item.label === "Antwortsignale")?.value, "61");
  assert.equal(report.kpis.find((item) => item.label === "Follow-ups gesendet")?.value, "532");
  assert.equal(report.todayMetrics.find((item) => item.label === "Follow-ups heute")?.value, "48");
  assert.equal(report.todayMetrics.find((item) => item.label === "Davon Nudges")?.value, "48");
  assert.equal(report.weeklyTracking.length, 4);
  assert.equal(report.monthlyTracking.length, 4);
  assert.equal(report.weeklyTracking.find((item) => item.label === "KW 29")?.followupsSent, 48);
  assert.equal(report.weeklyTracking.find((item) => item.label === "KW 29")?.nudgeFollowupsSent, 48);
  assert.equal(report.monthlyTracking.find((item) => item.label === "Juli MTD")?.followupsSent, 192);
  assert.equal(report.monthlyTracking.find((item) => item.label === "Juli MTD")?.replyFollowupsSent, 47);
  assert.ok(report.funnel.length >= 6);
  assert.ok(report.keyLearnings.length >= 5);
  assert.ok(report.methodology.length >= 4);
  assert.ok(report.conversationHighlights.some((item) => item.name === "Dennis Proll" && item.emphasis));
  assert.ok(report.conversationHighlights.some((item) => item.name === "Gal Schkolnik"));
});

test("degura report snapshot does not expose raw lead identifiers", () => {
  const serialized = JSON.stringify(getDeguraPerformanceReport());

  assert.doesNotMatch(serialized, new RegExp("linkedin\\.com/in/", "i"));
  assert.doesNotMatch(serialized, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(serialized, /lead_id|linkedin_url|first_name|last_name/i);
});
