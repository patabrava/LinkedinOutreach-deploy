import assert from "node:assert/strict";
import test from "node:test";

import { hasFirstMessageBeenSent, isVisibleFollowup } from "./followupVisibility";

test("hides nudge followups until the lead has first-message state", () => {
  const row = {
    followup_type: "NUDGE",
    lead: {
      status: "CONNECT_ONLY_SENT",
      sent_at: null,
      connection_accepted_at: null,
      sequence_step: 0,
      sequence_last_sent_at: null,
    },
  };

  assert.equal(isVisibleFollowup(row), false);
  assert.equal(hasFirstMessageBeenSent(row.lead), false);
});

test("shows nudge followups once the lead is marked sent", () => {
  const row = {
    followup_type: "NUDGE",
    lead: {
      status: "SENT",
      sent_at: "2026-04-28T12:00:00Z",
      connection_accepted_at: "2026-04-28T12:00:00Z",
      sequence_step: 1,
      sequence_last_sent_at: "2026-04-28T12:00:00Z",
    },
  };

  assert.equal(isVisibleFollowup(row), true);
  assert.equal(hasFirstMessageBeenSent(row.lead), true);
});

test("always shows reply followups", () => {
  assert.equal(
    isVisibleFollowup({
      followup_type: "REPLY",
      lead: {
        status: "CONNECTED",
      },
    }),
    true,
  );
});
