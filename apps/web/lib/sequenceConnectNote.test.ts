import test from "node:test";
import assert from "node:assert/strict";

import { validateConnectNote, CONNECT_NOTE_MAX } from "./sequenceConnectNote";

test("empty string is valid (no note will be sent)", () => {
  const result = validateConnectNote("");
  assert.deepEqual(result, { ok: true });
});

test("string under 300 chars is valid", () => {
  const result = validateConnectNote("Hi {{first_name}}, quick question.");
  assert.deepEqual(result, { ok: true });
});

test("exactly 300 chars is valid", () => {
  const text = "x".repeat(300);
  const result = validateConnectNote(text);
  assert.deepEqual(result, { ok: true });
});

test("301 chars is invalid", () => {
  const text = "x".repeat(301);
  const result = validateConnectNote(text);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /300/);
});

test("CONNECT_NOTE_MAX is exported as 300", () => {
  assert.equal(CONNECT_NOTE_MAX, 300);
});

test("rejects any token outside the canonical four", () => {
  const result = validateConnectNote("Hi {{recent_post}}!");
  assert.equal(result.ok, false);
});

test("accepts {single_curly} and [bracket] token forms", () => {
  assert.equal(validateConnectNote("Hi {first_name}").ok, true);
  assert.equal(validateConnectNote("Hi [first_name]").ok, true);
});
