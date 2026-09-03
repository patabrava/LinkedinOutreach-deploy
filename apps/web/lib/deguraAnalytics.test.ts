import test from "node:test";
import assert from "node:assert/strict";

import { aggregateDeguraEvents } from "./deguraAnalytics";

test("keeps account and variant dimensions separate without inferred outcomes", () => {
  const rows = aggregateDeguraEvents([
    { linkedin_account_id: "a", sequence_variant_id: 1, event_type: "invite_sent" },
    { linkedin_account_id: "a", sequence_variant_id: 1, event_type: "reply_received" },
    { linkedin_account_id: "b", sequence_variant_id: 1, event_type: "invite_sent" },
  ]);
  assert.equal(rows.length, 2);
  const counts: Record<string, number> = rows[0].counts;
  assert.deepEqual(counts, { invite_sent: 1, reply_received: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(counts, "appointment_showed"), false);
});
