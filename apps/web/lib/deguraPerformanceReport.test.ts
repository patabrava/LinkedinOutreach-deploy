import assert from "node:assert/strict";
import test from "node:test";

import { getDeguraPerformanceReport } from "./deguraPerformanceReport";

test("degura report exposes the required client-facing sections", () => {
  const report = getDeguraPerformanceReport();

  assert.equal(report.hero.title, "DEGURA OUTREACH PERFORMANCE");
  assert.equal(report.snapshotAt, "9. Juli 2026, 07:47 Uhr MESZ");
  assert.ok(report.kpis.length >= 8);
  assert.equal(report.kpis.find((item) => item.label === "Hauptsequenz")?.value, "3.184");
  assert.equal(report.kpis.find((item) => item.label === "Antwortsignale")?.value, "59");
  assert.equal(report.kpis.find((item) => item.label === "Positive Gespräche")?.value, "12");
  assert.ok(report.funnel.length >= 7);
  assert.ok(report.responseClusters.length >= 6);
  assert.ok(report.positiveSignals.length >= 5);
  assert.equal(report.callPotential.items.find((item) => item.label === "Explizite Terminbereitschaft")?.value, "1");
  assert.equal(report.callPotential.items.find((item) => item.label === "Qualifizierte Call-Kandidaten")?.value, "6");
  assert.ok(report.conversationHighlights.length >= 6);
  assert.ok(report.conversationHighlights.some((item) => item.name === "Dennis Proll"));
  assert.ok(report.copyLearnings.length >= 5);
  assert.ok(report.volumeScenarios.length >= 3);
  assert.ok(report.nextActions.length >= 4);
  assert.ok(report.methodology.length >= 4);
});

test("degura report snapshot does not expose raw lead identifiers", () => {
  const serialized = JSON.stringify(getDeguraPerformanceReport());

  assert.doesNotMatch(serialized, new RegExp("linkedin\\.com/in/", "i"));
  assert.doesNotMatch(serialized, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(serialized, /lead_id|linkedin_url|first_name|last_name/i);
});
