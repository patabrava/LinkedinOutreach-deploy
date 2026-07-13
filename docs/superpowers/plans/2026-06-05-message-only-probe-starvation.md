# Message-Only Probe Starvation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop accepted post-invite contacts from being starved behind pending invites while preserving the daily message send limit.

**Architecture:** Keep the existing message-only worker and LinkedIn acceptance checks. Add a separate message-only profile probe budget so pending profiles do not consume the actual message quota, and hard-stop only when real messages sent reaches the remaining daily quota. Avoid schema changes and avoid changing LinkedIn send behavior.

**Tech Stack:** Python 3.11, existing Playwright worker, existing Supabase client, Python `unittest`.

---

## Context-Zero

**Environment matrix:**
- OS: macOS local development, repo at `/Users/camiloecheverri/Documents/AI/Linkedin Scraper/LinkedinOutreach`.
- Runtime: `workers/sender/venv/bin/python` using Python 3.11.
- Browser: existing Playwright worker setup, with local Chrome fallback already present in `workers/sender/sender.py`.
- Database: Supabase project configured through `apps/web/.env`.
- Existing state observed on 2026-06-05: 196 invite-sent/no-message contacts, 50 browser-audited accepted/unmessaged, 145 pending, 1 unknown.

**Non-functional requirements:**
- Do not send beyond `DAILY_SEND_LIMIT`.
- Do not introduce new dependencies.
- Do not add migrations.
- Keep changes localized to the sender vertical slice.
- Make the fix testable without opening LinkedIn.

**File, LOC, dependency budget:**
- Files: 2 total.
- `workers/sender/sender.py`: modify only; expected net +35 to +60 LOC inside existing large file.
- `workers/sender/test_message_only_queue.py`: create; expected 70 to 120 LOC.
- Deps: 0 new dependencies; use standard-library `unittest`.

## Capability Map

- `resolve_message_only_probe_limit(send_quota_remaining)`: computes how many profiles may be checked during a run.
- `--message-only` execution path: fetches probe-sized queue, sends only until actual sent count reaches remaining daily send quota.
- Existing `process_message_only_one()`: unchanged acceptance/send behavior.
- Existing `mark_message_only_pending()`: unchanged; database trigger still updates `updated_at`, but starvation is handled by scanning more than the send quota.

## Boundary Map

- Database candidate boundary: `fetch_message_only_leads(client, limit, batch_id)` continues to return eligible invite-sent/no-message rows.
- Quota boundary: `sent_today_count()` and `DAILY_SEND_LIMIT` continue to control actual sends.
- Probe boundary: new helper controls how many rows can be inspected to find accepted contacts.
- Browser boundary: no change to LinkedIn selectors or send confirmation logic.

## Pass-Fail Criteria

Pass:
- Unit tests prove the probe budget is independent from send quota.
- Message-only run fetches `probe_limit` contacts, not `remaining`.
- Message-only loop stops sending when `sent_count >= remaining`.
- Pending contacts can be checked without reducing the actual message send budget.
- Existing sequence and nudge tests still pass.

Fail:
- Worker can send more than `DAILY_SEND_LIMIT`.
- Worker still fetches only `remaining` contacts for message-only probing.
- New code requires a migration or dependency.
- Existing follow-up or invite sending modes are touched.

## Task 1: Add Queue Budget Tests

**Files:**
- Create: `workers/sender/test_message_only_queue.py`
- Modify: none
- Test: `workers/sender/test_message_only_queue.py`

- [ ] **Step 1: Write failing tests for a separate probe budget**

Create `workers/sender/test_message_only_queue.py`:

```python
import importlib
import os
import sys
import unittest
from pathlib import Path


SENDER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SENDER_DIR))


class MessageOnlyQueueBudgetTest(unittest.TestCase):
    def setUp(self):
        os.environ.pop("MESSAGE_ONLY_PROBE_LIMIT", None)
        if "sender" in sys.modules:
            self.sender = importlib.reload(sys.modules["sender"])
        else:
            self.sender = importlib.import_module("sender")

    def tearDown(self):
        os.environ.pop("MESSAGE_ONLY_PROBE_LIMIT", None)

    def test_default_probe_limit_is_larger_than_remaining_send_quota(self):
        self.assertEqual(self.sender.resolve_message_only_probe_limit(39), 200)

    def test_probe_limit_never_drops_below_remaining_send_quota(self):
        os.environ["MESSAGE_ONLY_PROBE_LIMIT"] = "25"
        self.assertEqual(self.sender.resolve_message_only_probe_limit(39), 39)

    def test_probe_limit_can_be_raised_with_env(self):
        os.environ["MESSAGE_ONLY_PROBE_LIMIT"] = "250"
        self.assertEqual(self.sender.resolve_message_only_probe_limit(39), 250)

    def test_invalid_probe_limit_uses_default(self):
        os.environ["MESSAGE_ONLY_PROBE_LIMIT"] = "not-a-number"
        self.assertEqual(self.sender.resolve_message_only_probe_limit(1), 200)

    def test_zero_remaining_quota_fetches_nothing(self):
        self.assertEqual(self.sender.resolve_message_only_probe_limit(0), 0)

    def test_loop_stop_helper_preserves_daily_send_limit(self):
        self.assertFalse(self.sender.message_only_send_quota_reached(38, 39))
        self.assertTrue(self.sender.message_only_send_quota_reached(39, 39))
        self.assertTrue(self.sender.message_only_send_quota_reached(40, 39))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
workers/sender/venv/bin/python -m unittest workers.sender.test_message_only_queue -v
```

Expected: FAIL because `resolve_message_only_probe_limit` and `message_only_send_quota_reached` do not exist yet.

## Task 2: Implement Minimal Queue Budget Helpers

**Files:**
- Modify: `workers/sender/sender.py`
- Test: `workers/sender/test_message_only_queue.py`

- [ ] **Step 1: Add constants and helpers near the existing daily-limit helpers**

In `workers/sender/sender.py`, near `DAILY_SEND_DEFAULT` and `resolve_daily_send_limit()`, add:

```python
MESSAGE_ONLY_PROBE_LIMIT_DEFAULT = 200


def resolve_message_only_probe_limit(send_quota_remaining: int) -> int:
    if send_quota_remaining <= 0:
        return 0

    env_limit = os.getenv("MESSAGE_ONLY_PROBE_LIMIT")
    try:
        parsed_limit = int(env_limit) if env_limit else MESSAGE_ONLY_PROBE_LIMIT_DEFAULT
    except Exception:
        parsed_limit = MESSAGE_ONLY_PROBE_LIMIT_DEFAULT

    return max(send_quota_remaining, parsed_limit)


def message_only_send_quota_reached(sent_count: int, send_quota_remaining: int) -> bool:
    return send_quota_remaining <= 0 or sent_count >= send_quota_remaining
```

- [ ] **Step 2: Run the new queue tests**

Run:

```bash
workers/sender/venv/bin/python -m unittest workers.sender.test_message_only_queue -v
```

Expected: PASS.

## Task 3: Use Probe Budget In Message-Only Mode

**Files:**
- Modify: `workers/sender/sender.py`
- Test: `workers/sender/test_message_only_queue.py`

- [ ] **Step 1: Replace the message-only fetch limit**

In the `if args.message_only:` branch, replace:

```python
leads_to_process = fetch_message_only_leads(client, remaining, args.batch_id)
```

with:

```python
probe_limit = resolve_message_only_probe_limit(remaining)
logger.info(
    "Message-only probe budget computed",
    data={
        "send_quota_remaining": remaining,
        "probe_limit": probe_limit,
        "env": os.getenv("MESSAGE_ONLY_PROBE_LIMIT"),
        "default": MESSAGE_ONLY_PROBE_LIMIT_DEFAULT,
    },
)
leads_to_process = fetch_message_only_leads(client, probe_limit, args.batch_id)
```

- [ ] **Step 2: Hard-stop actual sends inside the processing loop**

In the same branch, inside `for lead in leads_to_process:` and before `mark_message_only_processing(...)`, add:

```python
if message_only_send_quota_reached(sent_count, remaining):
    logger.info(
        "Message-only send quota reached during probe batch",
        data={
            "sent": sent_count,
            "send_quota_remaining": remaining,
            "probed": sent_count + pending_count + retry_count + failed_count,
            "candidate_count": len(leads_to_process),
        },
    )
    break
```

- [ ] **Step 3: Leave pending handling unchanged**

Do not remove the pending status update in `mark_message_only_pending()`. The Supabase schema has a `touch_updated_at` trigger for `leads`, so removing the explicit `updated_at` field would not reliably stop `updated_at` from changing. The fix is the larger probe budget plus send hard-stop.

- [ ] **Step 4: Run the queue tests**

Run:

```bash
workers/sender/venv/bin/python -m unittest workers.sender.test_message_only_queue -v
```

Expected: PASS.

## Task 4: Verify Existing Sender Tests

**Files:**
- Modify: none
- Test: existing sender tests

- [ ] **Step 1: Run existing focused sender tests**

Run:

```bash
workers/sender/venv/bin/python -m unittest workers.sender.test_sequence_messages -v
workers/sender/venv/bin/python -m unittest workers.sender.test_nudge_gate -v
workers/sender/venv/bin/python -m unittest workers.sender.test_message_only_queue -v
```

Expected: all tests PASS.

- [ ] **Step 2: Run a read-only live queue simulation**

Run:

```bash
SUPABASE_URL=$(grep '^SUPABASE_URL=' apps/web/.env | cut -d= -f2-) \
SUPABASE_SERVICE_ROLE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' apps/web/.env | cut -d= -f2-) \
workers/sender/venv/bin/python - <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, str(Path("workers/sender").resolve()))
import sender

client = sender.get_supabase_client()
daily = sender.resolve_daily_send_limit()
already = sender.sent_today_count(client)
remaining = max(0, daily - already)
probe_limit = sender.resolve_message_only_probe_limit(remaining)
rows = sender.fetch_message_only_leads(client, probe_limit, None)
print({"daily": daily, "already": already, "remaining": remaining, "probe_limit": probe_limit, "fetched": len(rows)})
PY
```

Expected: `probe_limit` is greater than `remaining` when `remaining` is less than 200, and the read-only fetch returns more than the old remaining-sized batch when enough candidates exist.

## Task 5: Optional One-Run Production Check

**Files:**
- Modify: none
- Test: real worker behavior

- [ ] **Step 1: Run one controlled message-only pass if the operator approves live sending**

Run only after confirming that sending live LinkedIn messages is intended:

```bash
SUPABASE_URL=$(grep '^SUPABASE_URL=' apps/web/.env | cut -d= -f2-) \
SUPABASE_SERVICE_ROLE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' apps/web/.env | cut -d= -f2-) \
MESSAGE_ONLY_PROBE_LIMIT=200 \
CORRELATION_ID=message_only_probe_fix_20260605 \
workers/sender/venv/bin/python -u workers/sender/sender.py --message-only
```

Expected:
- Logs include `Message-only probe budget computed`.
- Logs show `probe_limit` larger than `send_quota_remaining`.
- Pending profiles may still be skipped.
- Accepted profiles should receive first messages until `send_quota_remaining` is reached.
- Operation complete total may exceed sent count because pending probes do not consume send quota.

## Debug Scopes

- If tests fail importing `sender`: run from repo root and use `workers/sender/venv/bin/python`.
- If read-only Supabase simulation fails on `csv_batch_id`: do not change schema; `fetch_message_only_leads()` already falls back to core fields.
- If live run sends too few despite large probe limit: inspect latest sender log for `Generic message surface is Sales Navigator/InMail while More menu still shows pending invite` versus actual send errors.
- If live run is too slow: lower `MESSAGE_ONLY_PROBE_LIMIT` temporarily, but keep it larger than `DAILY_SEND_LIMIT`.

## Self-Review

- Spec coverage: fixes the exact starvation root cause by separating profile probes from actual send quota.
- Placeholder scan: no deferred implementation placeholders.
- Type consistency: helper names used in tests match helper names planned for implementation.
- File budget respected: 2 files, no new dependencies.
