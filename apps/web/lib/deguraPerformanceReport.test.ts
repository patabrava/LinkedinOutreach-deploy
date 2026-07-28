import assert from "node:assert/strict";
import test from "node:test";

import { getDeguraPerformanceReport } from "./deguraPerformanceReport";

test("degura report exposes a simple tracking-focused snapshot", () => {
  const report = getDeguraPerformanceReport();

  assert.equal(report.hero.title, "DEGURA OUTREACH");
  assert.equal(report.snapshotAt, "28. Juli 2026, 14:41 Uhr MESZ");
  assert.equal(report.kpis.find((item) => item.label === "Kontaktanfragen")?.value, "1.095");
  assert.equal(report.kpis.find((item) => item.label === "Antwortsignale")?.value, "81");
  assert.equal(report.kpis.find((item) => item.label === "Interessierte Replies")?.value, "15");
  assert.equal(report.kpis.find((item) => item.label === "Interessierte Replies")?.detail, "18,1% der 83 lesbaren Replies");
  assert.equal(report.kpis.find((item) => item.label === "Follow-ups gesendet")?.value, "563");
  assert.equal(report.periodFilters.daily.label, "28. Juli");
  assert.equal(report.periodFilters.daily.readableReplies, 20);
  assert.equal(report.periodFilters.daily.positiveReplies, 2);
  assert.equal(report.periodFilters.daily.followupsSent, 31);
  assert.equal(report.periodFilters.weekly.label, "KW 31");
  assert.equal(report.periodFilters.weekly.acceptedContacts, 8);
  assert.equal(report.periodFilters.monthly.label, "Juli MTD");
  assert.equal(report.periodFilters.monthly.followupsSent, 223);
  assert.equal(report.periodFilters.monthly.replyFollowupsSent, 78);
  assert.ok(report.funnel.length >= 6);
  assert.ok(report.keyLearnings.length >= 5);
  assert.ok(report.methodology.length >= 4);
  assert.ok(report.conversationHighlights.some((item) => item.name === "Elias Constantino Gil Morel" && item.emphasis));
  assert.ok(report.conversationHighlights.some((item) => item.name === "Disha Devidas" && item.emphasis));
  assert.ok(!report.conversationHighlights.some((item) => item.name === "Dennis Proll"));
  assert.ok(!report.conversationHighlights.some((item) => item.name === "Gal Schkolnik"));
});

test("degura report snapshot does not expose raw lead identifiers", () => {
  const serialized = JSON.stringify(getDeguraPerformanceReport());

  assert.doesNotMatch(serialized, new RegExp("linkedin\\.com/in/", "i"));
  assert.doesNotMatch(serialized, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(serialized, /lead_id|linkedin_url|first_name|last_name/i);
});
