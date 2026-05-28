import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const pageSource = readFileSync(join(process.cwd(), "app/analytics/page.tsx"), "utf8");

test("analytics page passes the selected days range to all analytics queries", () => {
  assert.match(pageSource, /fetchOutreachAnalytics\(validDays\)/);
  assert.match(pageSource, /fetchDailyMetrics\(validDays\)/);
  assert.match(pageSource, /buildConversionFunnel\(analytics\)/);
  assert.doesNotMatch(pageSource, /fetchConversionFunnel/);
});
