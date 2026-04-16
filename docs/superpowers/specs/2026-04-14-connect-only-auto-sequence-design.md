# Connect-Only Auto Sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect when a `CONNECT_ONLY_SENT` lead accepts a connection request, send the batch-assigned sequence `first_message` immediately, and auto-schedule the remaining sequence followups without human approval.

**Architecture:** Keep the acceptance-to-message handoff inside the existing sender worker so there is one polling path, one browser session model, and one place for LinkedIn UI handling. The web app enforces a hard batch launch gate: a connect-only batch cannot enter the active queue until a sequence is assigned and the sequence has a non-empty first message. Once accepted, the sender transitions the lead into the normal message lifecycle, records acceptance timestamps, and creates the followup queue entries from the assigned sequence.

**Tech Stack:** Python 3, Playwright, Supabase client, existing Next.js admin UI, existing lead/followup tables and status model.

---

### Task 1: Lock the batch launch gate

**Files:**
- Modify: `apps/web/app/actions.ts`
- Modify: `apps/web/components/SequenceEditor.tsx`
- Modify: `apps/web/app/leads/page.tsx`

- [ ] **Step 1: Define the launch contract**

```ts
type BatchLaunchCheck = {
  batchId: number;
  outreachMode: "connect_only" | "connect_message";
  sequenceId: number | null;
  sequenceName: string | null;
  firstMessage: string | null;
};
```

- [ ] **Step 2: Block connect-only start when the batch has no sequence**

```ts
if (outreachMode === "connect_only" && !sequenceId) {
  return {
    ok: false,
    status: 409,
    code: "BATCH_SEQUENCE_REQUIRED",
    message: "Assign a sequence before starting connect-only automation.",
  };
}
```

- [ ] **Step 3: Block connect-only start when the assigned sequence has no first message**

```ts
if (outreachMode === "connect_only" && sequenceId && !firstMessage?.trim()) {
  return {
    ok: false,
    status: 409,
    code: "SEQUENCE_FIRST_MESSAGE_REQUIRED",
    message: "The assigned sequence must include a first message before launch.",
  };
}
```

- [ ] **Step 4: Keep the UI in standby until the backend accepts the launch**

```ts
const canLaunch = Boolean(selectedBatch?.sequence_id && selectedSequence?.first_message?.trim());
const launchLabel = canLaunch ? "Start Connect-Only Automation" : "Assign Sequence First";
```

- [ ] **Step 5: Verify the gate with a focused UI/server test**

Run: `npm test -- --runInBand` or the repo's existing targeted test command for `apps/web/app/actions.ts`
Expected: connect-only launch is rejected without a sequence and accepted when a valid sequence is assigned.

### Task 2: Make acceptance detection send sequence step 1

**Files:**
- Modify: `workers/sender/sender.py`

- [ ] **Step 1: Resolve the assigned sequence before sending the first accepted message**

```python
sequence_messages = load_sequence_messages(client, lead)
first_message = (sequence_messages.get("first_message") or "").strip()
if not first_message:
    mark_followup_failed(client, lead_id, "Missing first message for assigned sequence", permanent=True)
    return "failed"
```

- [ ] **Step 2: Render the first message from the assigned sequence instead of the generic fallback**

```python
message = _render_template_message(first_message, lead)
```

- [ ] **Step 3: Update the accepted-lead success path to record acceptance and active send timestamps**

```python
client.table("leads").update({
    "status": "SENT",
    "sent_at": datetime.utcnow().isoformat(),
    "connection_accepted_at": datetime.utcnow().isoformat(),
}).eq("id", lead_id).execute()
```

- [ ] **Step 4: Create or refresh the followup queue from the same sequence**

```python
schedule_nudge_followup(client, lead_id, sequence_messages, attempt=1, next_send_at=...)
schedule_nudge_followup(client, lead_id, sequence_messages, attempt=2, next_send_at=...)
```

- [ ] **Step 5: Keep retry behavior explicit**

```python
if transient_failure:
    mark_lead_retry_later(client, lead_id, "Acceptance detected but first message send failed", attempts=attempts)
    return "retry"
```

- [ ] **Step 6: Verify acceptance send behavior with the existing message-only worker path**

Run: `cd workers/sender && source venv/bin/activate && python sender.py --message-only`
Expected: accepted leads send sequence step 1, pending leads stay pending, failures move to retry handling.

### Task 3: Align lead states, retry policy, and visibility

**Files:**
- Modify: `workers/sender/sender.py`
- Modify: `apps/web/components/LeadList.tsx`
- Modify: `apps/web/components/DraftFeed.tsx`
- Modify: `apps/web/app/actions.ts`

- [ ] **Step 1: Add a dedicated retry helper for accepted-but-not-yet-sent leads**

```python
def mark_lead_retry_later(client: Client, lead_id: str, reason: str, attempts: int) -> None:
    client.table("leads").update({
        "status": "RETRY_LATER",
        "error_message": reason[:240],
    }).eq("id", lead_id).execute()
```

- [ ] **Step 2: Treat `RETRY_LATER` as a visible operational state in the dashboard**

```ts
const statusLabels = {
  CONNECT_ONLY_SENT: "Waiting Acceptance",
  RETRY_LATER: "Retry Later",
  FAILED: "Failed",
  SENT: "Sent",
};
```

- [ ] **Step 3: Count accepted leads from the acceptance timestamp rather than only from the final send status**

```ts
const accepted = leads.filter((lead) => Boolean(lead.connection_accepted_at)).length;
```

- [ ] **Step 4: Keep the post-acceptance queue fully automatic**

```ts
const MESSAGE_ONLY_PIPELINE_STATUSES = [
  "CONNECT_ONLY_SENT",
  "MESSAGE_ONLY_READY",
  "MESSAGE_ONLY_APPROVED",
  "RETRY_LATER",
];
```

- [ ] **Step 5: Verify dashboard labels and counters match the new lifecycle**

Run: `npm test -- --runInBand` or the repo's existing targeted component test command
Expected: accepted, retry-later, and failed states are visible and not collapsed into generic sent/pending buckets.

### Task 4: Add the production polling mechanic

**Files:**
- Modify: `run_all.sh`
- Add: `workers/sender/README.md`

- [ ] **Step 1: Document the production poll loop**

```bash
cd workers/sender
source venv/bin/activate
while true; do python sender.py --message-only; sleep 900; done
```

- [ ] **Step 2: Add an optional run-all flag for the message-only loop**

```bash
if [ "$START_MESSAGE_ONLY" -eq 1 ]; then
  run_service "sender_message_only" "cd '$ROOT_DIR/workers/sender' && source venv/bin/activate && while true; do python -u sender.py --message-only; sleep 900; done"
fi
```

- [ ] **Step 3: Keep the current web and sender defaults unchanged**

```bash
./run_all.sh --web --sender
```

- [ ] **Step 4: Verify the loop is one-process-at-a-time**

Run: `lsof -tiTCP:3000 -sTCP:LISTEN` and `ps` checks for the sender worker
Expected: only one sender message-only loop runs at a time, no duplicate acceptance pollers.

### Task 5: Prove the full lifecycle

**Files:**
- Modify: `workers/sender/sender.py`
- Modify: `apps/web/app/actions.ts`
- Add: `workers/sender/tests/test_message_only_flow.py`

- [ ] **Step 1: Test the connect-only happy path**

```python
def test_acceptance_sends_first_sequence_message():
    lead = {"status": "CONNECT_ONLY_SENT", "sequence_id": 1, "linkedin_url": "https://www.linkedin.com/in/example"}
    # assert accepted -> sent -> followups scheduled
```

- [ ] **Step 2: Test the missing-sequence gate**

```python
def test_launch_rejected_without_sequence():
    # assert 409 when connect-only batch has no sequence assignment
```

- [ ] **Step 3: Test retry behavior**

```python
def test_transient_failure_moves_to_retry_later():
    # assert RETRY_LATER after acceptance send failure
```

- [ ] **Step 4: Run the full targeted test set**

Run: `pytest workers/sender/tests/test_message_only_flow.py -v`
Expected: all acceptance, retry, and gating cases pass.

### Task 6: Update the operator docs

**Files:**
- Modify: `README.md`
- Modify: `workers/sender/README.md`
- Modify: `apps/web/app/leads/page.tsx`

- [ ] **Step 1: Describe the approved user journey in one paragraph**

```md
Connect-only batches start in standby. After a sequence is assigned, the batch can be launched. The sender worker polls every 15 minutes, detects acceptance, sends the assigned sequence's first message automatically, and schedules followups without human approval.
```

- [ ] **Step 2: Document the failure modes**

```md
- Missing sequence at launch: hard-blocked
- Accepted but no first message: retry later
- LinkedIn send failure: retry later up to the retry cap
- Permanent restriction: failed
```

- [ ] **Step 3: Keep the run instructions to one deterministic command path**

```bash
./run_all.sh --web --sender
```

## Self-Review Notes

- Spec coverage check: the plan covers launch gating, acceptance detection, sequence dispatch, retry handling, dashboard visibility, polling cadence, and operator docs.
- Placeholder check: no TBD/TODO markers remain.
- Scope check: this is one connected feature slice. It should not be split unless we decide to introduce a separate scheduler service.
- Ambiguity resolved: accepted leads do not wait for human approval; they transition directly into automatic sequence delivery.
