# Connect-Only Auto Sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a connect-only lead accepts the invite, automatically send the batch-assigned first sequence message from the first sequence in `outreach_degura.txt`, then auto-schedule and auto-send the remaining followups without human approval.

**Architecture:** Keep the acceptance check and first-message dispatch in the existing sender worker so one Playwright browser session owns the full accept-and-send path. Make the batch launch gate strict in the web backend: connect-only batches cannot start until a sequence is assigned and that sequence has a non-empty first message. Use the existing `outreach_sequences` model and `followups` queue for step 2 and step 3, and keep the production mechanic as a 15-minute polling loop that runs `sender.py --message-only` on the VPS.

**Tech Stack:** Python 3, Playwright, Supabase client, Next.js app router/actions, existing Postgres tables, existing shell-based service runner.

---

### Task 1: Pin the first sequence source and launch contract

**Files:**
- Modify: `outreach_degura.txt`
- Modify: `apps/web/app/actions.ts`
- Modify: `apps/web/components/SequenceEditor.tsx`

- [ ] **Step 1: Extract the first sequence as the canonical connect-only source**

```text
Message 1 (Tag 1 nach Annahme):

Hi {{VORNAME}},

freut mich, dass wir uns hier vernetzen.

Ich bin Katharina von Degura, du hattest deine betriebliche Altersvorsorge damals über uns eingerichtet.

Ich melde mich kurz, weil wir bei vielen ehemaligen Degura Kunden sehen, dass nach einem Arbeitgeberwechsel staatliche Förderung und Arbeitgeberzuschüsse nicht mehr genutzt werden, obwohl sie einem weiterhin zustehen.

Wie ist es bei dir mit der bAV weitergegangen? Läuft der Vertrag noch?

Falls du magst, können wir uns das auch gerne kurz gemeinsam anschauen, dauert nur ein paar Minuten.

Viele Grüße,
Katharina
```

- [ ] **Step 2: Add a hard launch gate for connect-only batches**

```ts
type BatchLaunchCheck = {
  batchId: number;
  outreachMode: "connect_only" | "connect_message";
  sequenceId: number | null;
  sequenceName: string | null;
  firstMessage: string | null;
};

if (outreachMode === "connect_only" && !sequenceId) {
  return {
    ok: false,
    status: 409,
    code: "BATCH_SEQUENCE_REQUIRED",
    message: "Assign a sequence before starting connect-only automation.",
  };
}

if (outreachMode === "connect_only" && sequenceId && !firstMessage?.trim()) {
  return {
    ok: false,
    status: 409,
    code: "SEQUENCE_FIRST_MESSAGE_REQUIRED",
    message: "The assigned sequence must include a first message before launch.",
  };
}
```

- [ ] **Step 3: Keep the UI in standby until the backend accepts launch**

```ts
const canLaunch = Boolean(selectedBatch?.sequence_id && selectedSequence?.first_message?.trim());
const launchLabel = canLaunch ? "Start Connect-Only Automation" : "Assign Sequence First";
```

- [ ] **Step 4: Run the launch-gate test against the existing actions path**

Run: `npm test -- --runInBand` or the repo’s targeted test command for `apps/web/app/actions.ts`
Expected: connect-only launch is rejected without a sequence and accepted once a valid sequence is assigned.

### Task 2: Make the sender worker own acceptance-to-message dispatch

**Files:**
- Modify: `workers/sender/sender.py`

- [ ] **Step 1: Resolve the assigned sequence before sending the first accepted message**

```python
sequence_messages = load_sequence_messages(client, lead)
first_message = (sequence_messages.get("first_message") or "").strip()
if not first_message:
    mark_lead_retry_later(client, lead_id, "Missing first message for assigned sequence", attempts=attempts)
    return "retry"
```

- [ ] **Step 2: Render the first sequence message from the canonical Degura template**

```python
message = _render_template_message(first_message, lead)
```

- [ ] **Step 3: Update the success path to mark acceptance and active send timestamps**

```python
client.table("leads").update({
    "status": "SENT",
    "sent_at": datetime.utcnow().isoformat(),
    "connection_accepted_at": datetime.utcnow().isoformat(),
}).eq("id", lead_id).execute()
```

- [ ] **Step 4: Keep the accepted lead tied to the assigned sequence for later followups**

```python
client.table("leads").update({
    "sequence_step": 1,
    "sequence_started_at": sequence_started_at,
    "sequence_last_sent_at": datetime.utcnow().isoformat(),
}).eq("id", lead_id).execute()
```

- [ ] **Step 5: Verify the sender path in message-only mode with a real lead stub**

Run: `cd workers/sender && source venv/bin/activate && python sender.py --message-only`
Expected: accepted leads send the first sequence message, pending leads stay pending, transient send failures return retry handling.

### Task 3: Schedule step 2 and step 3 automatically

**Files:**
- Modify: `workers/sender/sender.py`
- Modify: `workers/sender/README.md`
- Modify: `apps/web/components/DraftFeed.tsx`
- Modify: `apps/web/components/FollowupsList.tsx`

- [ ] **Step 1: Use the assigned sequence interval when scheduling followups**

```python
sequence_messages = load_sequence_messages(client, lead)
schedule_nudge_followup(client, lead_id, sequence_messages, attempt=1, next_send_at=next_send_at_for_tag_5)
schedule_nudge_followup(client, lead_id, sequence_messages, attempt=2, next_send_at=next_send_at_for_tag_12)
```

- [ ] **Step 2: Keep followups fully automatic**

```python
# Followup rows should be created as APPROVED with next_send_at filled.
# The sender loop sends them when due without human review.
```

- [ ] **Step 3: Make retry state visible and bounded**

```python
def mark_lead_retry_later(client: Client, lead_id: str, reason: str, attempts: int) -> None:
    client.table("leads").update({
        "status": "RETRY_LATER",
        "error_message": reason[:240],
    }).eq("id", lead_id).execute()
```

- [ ] **Step 4: Surface accepted/retry/failed states in the dashboards**

```ts
const statusLabels = {
  CONNECT_ONLY_SENT: "Waiting Acceptance",
  RETRY_LATER: "Retry Later",
  FAILED: "Failed",
  SENT: "Sent",
};
```

- [ ] **Step 5: Verify the followup queue still works after step 1 is auto-sent**

Run: the repo’s followup list and sender worker checks against a lead with `connection_accepted_at` populated.
Expected: step 2 and step 3 are queued automatically and remain visible in the followup UI until they are sent.

### Task 4: Add the production polling mechanic

**Files:**
- Modify: `run_all.sh`
- Modify: `workers/sender/README.md`

- [ ] **Step 1: Document the production loop as the recommended VPS runtime**

```bash
cd workers/sender
source venv/bin/activate
while true; do python sender.py --message-only; sleep 900; done
```

- [ ] **Step 2: Add an optional run-all flag for the message-only poller**

```bash
if [ "$START_MESSAGE_ONLY" -eq 1 ]; then
  run_service "sender_message_only" "cd '$ROOT_DIR/workers/sender' && source venv/bin/activate && while true; do python -u sender.py --message-only; sleep 900; done"
fi
```

- [ ] **Step 3: Keep the current default behavior unchanged for web and regular sender**

```bash
./run_all.sh --web --sender
```

- [ ] **Step 4: Verify only one poller runs at a time**

Run: `lsof -tiTCP:3000 -sTCP:LISTEN` and `ps` checks for the sender worker
Expected: one sender message-only loop, no duplicate acceptance pollers.

### Task 5: Prove the live end-to-end flow

**Files:**
- Modify: `workers/sender/sender.py`
- Modify: `apps/web/app/actions.ts`
- Add: `workers/sender/tests/test_message_only_flow.py`

- [ ] **Step 1: Add a live browser test for the acceptance-to-send path**

```python
def test_acceptance_sends_first_sequence_message():
    lead = {
        "status": "CONNECT_ONLY_SENT",
        "sequence_id": 1,
        "linkedin_url": "https://www.linkedin.com/in/example",
        "first_name": "Max",
        "last_name": "Mustermann",
    }
    # assert accepted -> first message sent -> followups scheduled
```

- [ ] **Step 2: Add a gate test for batch launch without a sequence**

```python
def test_launch_rejected_without_sequence():
    # assert 409 when connect-only batch has no sequence assignment
```

- [ ] **Step 3: Add a retry test for acceptance send failures**

```python
def test_transient_failure_moves_to_retry_later():
    # assert RETRY_LATER after acceptance send failure
```

- [ ] **Step 4: Run the live end-to-end test with the real worker and browser**

Run:
```bash
cd workers/sender
source venv/bin/activate
python -m pytest workers/sender/tests/test_message_only_flow.py -v
```
Then run the real browser worker against a test lead or a controlled QA lead:
```bash
python sender.py --message-only
```
Expected: the lead accepts, the first Degura sequence message is sent, `connection_accepted_at` is set, and the next followups are scheduled automatically.

### Task 6: Update operator docs

**Files:**
- Modify: `README.md`
- Modify: `workers/sender/README.md`
- Modify: `apps/web/app/leads/page.tsx`

- [ ] **Step 1: Document the user journey in one paragraph**

```md
Connect-only batches start in standby. After a sequence is assigned, the batch can be launched. The sender worker polls every 15 minutes, detects acceptance, sends the assigned first sequence message automatically, and schedules followups without human approval.
```

- [ ] **Step 2: Document the failure modes**

```md
- Missing sequence at launch: hard-blocked
- Missing first message: retry later
- LinkedIn send failure: retry later up to the retry cap
- Permanent restriction: failed
```

- [ ] **Step 3: Keep the run instructions deterministic**

```bash
./run_all.sh --web --sender
```

## Self-Review Notes

- Spec coverage check: the plan covers the launch gate, sequence source, acceptance dispatch, automatic followups, polling cadence, live browser validation, and operator docs.
- Placeholder check: no TBD/TODO markers remain.
- Scope check: this is one feature slice, centered on the connect-only auto-sequence path.
- Ambiguity resolved: the first sequence message comes from the first sequence defined in `outreach_degura.txt`, and accepted leads skip any human approval gate.
