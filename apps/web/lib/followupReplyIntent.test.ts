import assert from "node:assert/strict";
import test from "node:test";

import { getReplyIntentView } from "./followupReplyIntent";

test("shows positive intent for reply rows", () => {
  const view = getReplyIntentView("REPLY", "positive");
  assert.equal(view?.label, "POSITIVE");
  assert.equal(view?.className, "status-approved");
});

test("shows negative intent for reply rows", () => {
  const view = getReplyIntentView("REPLY", "negative");
  assert.equal(view?.label, "NEGATIVE");
  assert.equal(view?.className, "status-pending");
});

test("does not show intent for nudge rows", () => {
  assert.equal(getReplyIntentView("NUDGE", "positive"), null);
});

test("does not show intent before drafting", () => {
  assert.equal(getReplyIntentView("REPLY", null), null);
});
