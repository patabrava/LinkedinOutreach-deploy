import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const actionsSource = readFileSync(join(process.cwd(), "app/actions.ts"), "utf8");
const followupsPageSource = readFileSync(join(process.cwd(), "app/followups/page.tsx"), "utf8");

test("approveFollowup starts the sender in targeted followup-id mode", () => {
  const approveFollowupBody = actionsSource.match(
    /export async function approveFollowup[\s\S]*?\n}\n\nexport async function skipFollowup/
  )?.[0];

  assert.ok(approveFollowupBody, "approveFollowup body should be present");
  assert.match(approveFollowupBody, /const args = \[senderPath, "--followup", "--followup-id", followupId\]/);
  assert.doesNotMatch(approveFollowupBody, /const args = \[senderPath, "--followup"\];/);
});

test("bulk trigger keeps the queue-wide followup sender mode", () => {
  const triggerFollowupSenderBody = actionsSource.match(
    /export async function triggerFollowupSender[\s\S]*?\n}\n\nexport async function sendLeadNow/
  )?.[0];

  assert.ok(triggerFollowupSenderBody, "triggerFollowupSender body should be present");
  assert.match(triggerFollowupSenderBody, /const args = \[senderPath, "--followup"\]/);
});

test("followups page fetches retryable failure statuses", () => {
  assert.match(
    followupsPageSource,
    /fetchFollowups\(\["PENDING_REVIEW", "APPROVED", "FAILED", "RETRY_LATER"\], 100\)/
  );
});
