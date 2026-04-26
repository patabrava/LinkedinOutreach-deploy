import test from "node:test";
import assert from "node:assert/strict";

import { parseSenderMessageOnlyTail } from "./senderMessageOnlyHealth";

test("parses Operation Complete as ok with timestamp", () => {
  const tail = [
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Start: sender-message_only [operation=sender-message_only]",
    "[2026-04-25T10:01:00.000000Z] INFO: Operation Complete: sender-message-only [operation=sender-message-only]",
    "  Data: {",
    "    \"sent\": 0",
    "  }",
  ].join("\n");
  const result = parseSenderMessageOnlyTail(tail);
  assert.equal(result.lastIterationOutcome, "ok");
  assert.equal(result.lastIterationAt, "2026-04-25T10:01:00.000000Z");
  assert.equal(result.lastError, null);
});

test("parses Operation Error as error and surfaces the line as lastError", () => {
  const tail = [
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Start: sender-message_only [operation=sender-message_only]",
    "[2026-04-25T10:00:30.000000Z] ERROR: Operation Error: sender-message_only [operation=sender-message_only]",
    "  Error: auth.json missing",
  ].join("\n");
  const result = parseSenderMessageOnlyTail(tail);
  assert.equal(result.lastIterationOutcome, "error");
  assert.equal(result.lastIterationAt, "2026-04-25T10:00:30.000000Z");
  assert.ok(result.lastError && result.lastError.includes("Operation Error: sender-message_only"));
});

test("only Operation Start present → unknown outcome", () => {
  const tail = "[2026-04-25T10:00:00.000000Z] INFO: Operation Start: sender-message_only";
  const result = parseSenderMessageOnlyTail(tail);
  assert.equal(result.lastIterationOutcome, "unknown");
  assert.equal(result.lastIterationAt, null);
});

test("clean Operation Complete after earlier error still surfaces last ERROR line", () => {
  const tail = [
    "[2026-04-25T09:00:00.000000Z] ERROR: connection timeout [op=foo]",
    "[2026-04-25T09:30:00.000000Z] ERROR: Operation Error: sender-message_only",
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Complete: sender-message-only",
  ].join("\n");
  const result = parseSenderMessageOnlyTail(tail);
  assert.equal(result.lastIterationOutcome, "ok");
  assert.equal(result.lastIterationAt, "2026-04-25T10:00:00.000000Z");
  assert.ok(result.lastError && result.lastError.includes("Operation Error: sender-message_only"));
});

test("empty input returns unknown nulls", () => {
  const result = parseSenderMessageOnlyTail("");
  assert.equal(result.lastIterationOutcome, "unknown");
  assert.equal(result.lastIterationAt, null);
  assert.equal(result.lastError, null);
});

test("hyphen-vs-underscore variants of the marker are both recognized", () => {
  const okHyphen = parseSenderMessageOnlyTail(
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Complete: sender-message-only",
  );
  const okUnderscore = parseSenderMessageOnlyTail(
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Complete: sender-message_only",
  );
  assert.equal(okHyphen.lastIterationOutcome, "ok");
  assert.equal(okUnderscore.lastIterationOutcome, "ok");
});

test("lastError is truncated to 240 chars", () => {
  const long = "x".repeat(500);
  const tail = `[2026-04-25T10:00:00.000000Z] ERROR: ${long}`;
  const result = parseSenderMessageOnlyTail(tail);
  assert.ok(result.lastError);
  assert.equal(result.lastError!.length, 240);
});

test("indented Data lines are ignored when scanning for ERROR", () => {
  const tail = [
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Complete: sender-message-only",
    "  Data: {",
    "    \"error_field\": \"this should not be matched as ERROR\"",
    "  }",
  ].join("\n");
  const result = parseSenderMessageOnlyTail(tail);
  assert.equal(result.lastError, null);
});
