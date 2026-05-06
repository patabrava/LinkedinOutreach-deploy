import test from "node:test";
import assert from "node:assert/strict";

import { detectConnectOnlyLimitPause, hasConnectOnlyLimitMarker } from "./pause";
import { getConnectOnlyLimitWindowStart } from "./window";

test("hasConnectOnlyLimitMarker reads the explicit connect-only pause flag", () => {
  assert.equal(
    hasConnectOnlyLimitMarker({
      meta: {
        connect_only_limit_reached: true,
        connect_only_limit_reason: "LinkedIn weekly invite limit reached",
      },
    }),
    true,
  );
});

test("detectConnectOnlyLimitPause prefers the explicit pause flag over message wording", () => {
  assert.equal(
    detectConnectOnlyLimitPause([
      {
        error_message: "LinkedIn changed the wording again",
        profile_data: { meta: { connect_only_limit_reached: true } },
      },
    ]),
    true,
  );
});

test("detectConnectOnlyLimitPause still falls back to invite-limit wording", () => {
  assert.equal(
    detectConnectOnlyLimitPause([
      {
        error_message: "Too many invitations sent this week",
        profile_data: {},
      },
    ]),
    true,
  );
});

test("detectConnectOnlyLimitPause stays false when no pause marker exists", () => {
  assert.equal(
    detectConnectOnlyLimitPause([
      {
        error_message: "invite_send_failed",
        profile_data: { meta: { connect_only_limit_reached: false } },
      },
    ]),
    false,
  );
});

test("getConnectOnlyLimitWindowStart uses a 7-day lookback", () => {
  const now = new Date("2026-05-06T12:00:00.000Z");
  assert.equal(getConnectOnlyLimitWindowStart(now), "2026-04-29T12:00:00.000Z");
});
