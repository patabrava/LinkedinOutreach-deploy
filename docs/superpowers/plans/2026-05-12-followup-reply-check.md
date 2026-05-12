# Followup Reply-Check (Option 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before the followup sender transmits any APPROVED `NUDGE`, inspect the live thread on LinkedIn and abort the send if the lead's most recent message is from the lead, recording the reply on the lead row so future polls short-circuit.

**Architecture:** Extract a tiny shared module (`workers/thread_reader.py`) with two functions: a Playwright DOM reader (`extract_last_bubble`, ported verbatim from the scraper) and a pure classifier (`classify_last_sender`). The scraper's `inbox_scan` switches to call the shared classifier (behavior-preserving). The sender's `process_followup_one` calls both, between `open_followup_message_surface` and `send_message`, and short-circuits when the lead replied.

**Tech Stack:** Python 3.10+, Playwright (already in the workers' venvs), Supabase python client (already used), pytest (already used). No new runtime dependencies.

---

## File structure

| Path | Status | Responsibility |
|---|---|---|
| `workers/thread_reader.py` | **NEW** | Single source of truth for "what does the latest thread bubble say" — DOM reader + pure sender classifier. Lives at the flat `workers/` level next to `shared_logger.py` and `credential_crypto.py`, which is the existing convention. |
| `workers/test_thread_reader.py` | **NEW** | pytest unit tests for `classify_last_sender` (pure function, no DOM). |
| `workers/scraper/scraper.py` | **EDIT** | Replace the inline classifier block (lines 2293–2330) with a call to `classify_last_sender`. Optionally collapse `extract_last_message_from_conversation` to a thin wrapper around `extract_last_bubble`. Behavior unchanged. |
| `workers/sender/sender.py` | **EDIT** | Inside `process_followup_one`: after `open_followup_message_surface` and before `send_message`, call the reader, classify, and skip the send when verdict is `"lead"`. Add a new return code `"skipped"` and a small `_record_reply_at_send_time` helper. Update the polling loop to count skipped rows. |

**LOC budget (AGENTS.md §0):** 2 new files (~150 + ~90 LOC), 2 edits (`scraper.py` net **−50**, `sender.py` net **+60**). New runtime deps: **0**. Schema changes: **0** (`followups.status='SKIPPED'`, `followups.last_error`, `leads.last_reply_at` all already exist).

**Policy revision vs the brainstorming spec:** the "unknown" classification path **does not** create RETRY_LATER rows. Unknown means "bubble sender doesn't match the lead and isn't a recognized outbound marker" — in practice this is the same edge case the scraper already silently treats as outbound. Doing anything else creates operational toil for an impossible scenario. We log at WARN and proceed with the send. Only `"lead"` triggers the skip. This is the surgical-changes principle (CLAUDE.md §3) applied to the policy table.

---

## Task 1: Pure classifier (TDD)

**Files:**
- Create: `workers/thread_reader.py`
- Test: `workers/test_thread_reader.py`

- [ ] **Step 1: Write the failing tests**

Create `workers/test_thread_reader.py`:

```python
"""Unit tests for thread_reader.classify_last_sender (pure logic, no DOM)."""

import sys
from pathlib import Path

# Match the import pattern used by scraper.py / sender.py.
sys.path.insert(0, str(Path(__file__).parent))

from thread_reader import classify_last_sender


def _bubble(sender: str, is_outbound: bool = False, text: str = "hi"):
    return {"sender": sender, "text": text, "is_outbound": is_outbound}


def test_outbound_flag_wins_even_with_lead_name_sender():
    # Scraper DOM hint trumps everything else — preserves existing behavior.
    assert classify_last_sender(_bubble("Alice Schmidt", is_outbound=True), "Alice Schmidt", "Alice") == "us"


def test_sender_sie_is_us():
    assert classify_last_sender(_bubble("Sie"), "Alice Schmidt", "Alice") == "us"


def test_sender_you_is_us():
    assert classify_last_sender(_bubble("You"), "Alice Schmidt", "Alice") == "us"


def test_sender_ich_is_us():
    assert classify_last_sender(_bubble("Ich"), "Alice Schmidt", "Alice") == "us"


def test_empty_sender_is_us():
    assert classify_last_sender(_bubble(""), "Alice Schmidt", "Alice") == "us"


def test_sender_full_name_match_is_lead():
    assert classify_last_sender(_bubble("Alice Schmidt"), "Alice Schmidt", "Alice") == "lead"


def test_sender_first_name_only_is_lead():
    assert classify_last_sender(_bubble("Alice"), "Alice Schmidt", "Alice") == "lead"


def test_sender_first_name_substring_is_lead():
    # Scraper accepts "Dr. Alice Schmidt" because "alice" is in the sender string.
    assert classify_last_sender(_bubble("Dr. Alice Schmidt"), "Alice Schmidt", "Alice") == "lead"


def test_sender_case_insensitive():
    assert classify_last_sender(_bubble("ALICE schmidt"), "Alice Schmidt", "Alice") == "lead"


def test_third_party_sender_is_unknown():
    # Sender doesn't match lead name and isn't a known "us" marker. Scraper
    # currently treats this as outbound; the sender will log a warning and proceed.
    assert classify_last_sender(_bubble("Bob Other"), "Alice Schmidt", "Alice") == "unknown"


def test_empty_first_name_falls_through_to_unknown():
    # Defensive: don't match arbitrary senders when we have no first name to compare.
    assert classify_last_sender(_bubble("Anything"), "Alice Schmidt", "") == "unknown"


def test_whitespace_only_sender_is_us():
    assert classify_last_sender(_bubble("   "), "Alice Schmidt", "Alice") == "us"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd workers && python -m pytest test_thread_reader.py -v
```

Expected: `ModuleNotFoundError: No module named 'thread_reader'` (or all tests fail at collection).

- [ ] **Step 3: Implement the classifier**

Create `workers/thread_reader.py`:

```python
"""Shared helpers for reading the latest message bubble in a LinkedIn thread.

Two responsibilities:

1. `extract_last_bubble(page)` — Playwright DOM reader. Ported verbatim from
   the scraper so both scraper.inbox_scan and sender.process_followup_one
   read bubbles the same way.

2. `classify_last_sender(bubble, lead_full_name, lead_first_name)` — pure
   function that decides whether the last bubble is ours, the lead's, or
   unknown. Unit-tested.

The classifier returns three states. The scraper's existing inline logic
coerced anything-not-clearly-lead to "us"; we surface "unknown" explicitly
so the sender can log/escalate on it without changing scraper behavior.
"""

from __future__ import annotations

from typing import Optional, TypedDict


class Bubble(TypedDict):
    sender: str       # Raw sender text scraped from DOM. May be "Sie", "Alice", "" etc.
    text: str         # Message body text.
    is_outbound: bool # DOM-derived hint (CSS class / style / alignment).


SenderClass = str  # one of "us" | "lead" | "unknown"

_US_MARKERS = {"sie", "you", "ich", ""}


def classify_last_sender(bubble: Bubble, lead_full_name: str, lead_first_name: str) -> SenderClass:
    """Decide whether the last bubble is ours, the lead's, or unknown.

    Logic ported from workers/scraper/scraper.py:2302-2330:
      1. If the DOM marked the bubble as outbound → "us".
      2. If the sender label is one of {"sie", "you", "ich", ""} (case-insensitive) → "us".
      3. If the sender matches the lead's full or first name (incl. substring
         containment in either direction, case-insensitive) → "lead".
      4. Otherwise → "unknown".

    The scraper currently treats branch 4 as outbound. To preserve that
    behavior, scraper callers should check `== "lead"` rather than `!= "us"`.
    """
    if bubble.get("is_outbound"):
        return "us"

    sender_lower = (bubble.get("sender") or "").lower().strip()
    if sender_lower in _US_MARKERS:
        return "us"

    full_lower = (lead_full_name or "").lower().strip()
    first_lower = (lead_first_name or "").lower().strip()
    if first_lower and (
        sender_lower == full_lower
        or sender_lower == first_lower
        or first_lower in sender_lower
        or (full_lower and sender_lower in full_lower)
    ):
        return "lead"

    return "unknown"
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd workers && python -m pytest test_thread_reader.py -v
```

Expected: `12 passed`.

- [ ] **Step 5: Commit**

```bash
git add workers/thread_reader.py workers/test_thread_reader.py
git commit -m "Add shared thread_reader classifier for last-message detection"
```

---

## Task 2: Port the DOM reader into the shared module

**Files:**
- Modify: `workers/thread_reader.py`

No unit tests in this task — the function is pure Playwright DOM glue and is exercised end-to-end by the scraper's existing inbox-scan integration. Behavioral preservation will be verified in Task 3 when we swap the scraper to call it.

- [ ] **Step 1: Append the DOM reader to `workers/thread_reader.py`**

Add these imports near the top of `workers/thread_reader.py` (next to the existing imports):

```python
from playwright.async_api import Page
```

And helper for safe text extraction (the scraper has one called `safe_text`; we duplicate the trivial version here to keep `thread_reader.py` self-contained):

```python
def _safe_text(value: Optional[str]) -> str:
    if not value:
        return ""
    return " ".join(value.split()).strip()
```

Then append the reader function (port of `workers/scraper/scraper.py:1881-2002` verbatim, with the only change being it returns the `Bubble` TypedDict and uses `_safe_text` instead of `safe_text`):

```python
async def extract_last_bubble(page: Page) -> Optional[Bubble]:
    """Read the most recent message bubble from an open LinkedIn message surface.

    Returns a Bubble dict or None if no bubbles are visible (e.g., empty
    thread, surface still loading, unrecognized DOM).

    Ported from workers/scraper/scraper.py::extract_last_message_from_conversation
    — same selector lists, same outbound-hint heuristics, same fallbacks.
    """
    try:
        await page.wait_for_timeout(800)

        message_selectors = [
            "li.msg-s-message-list__event",
            "div.msg-s-event-listitem",
            "div.msg-s-message-group",
            "li[class*='message']",
        ]

        messages = None
        for selector in message_selectors:
            items = page.locator(selector)
            count = await items.count()
            if count > 0:
                messages = items
                break

        if not messages or await messages.count() == 0:
            return None

        last_msg = messages.last

        sender = ""
        sender_selectors = [
            "span.msg-s-message-group__name",
            "span.msg-s-event-listitem__sender-name",
            "a.msg-s-message-group__profile-link",
            "span[class*='sender']",
            "span[class*='name']",
        ]
        for sel in sender_selectors:
            try:
                sender_el = last_msg.locator(sel).first
                if await sender_el.count():
                    sender = _safe_text(await sender_el.text_content(timeout=2_000))
                    if sender:
                        break
            except Exception:
                continue

        text = ""
        text_selectors = [
            "p.msg-s-event-listitem__body",
            "div.msg-s-event-listitem__body",
            "p.msg-s-message-group__body",
            "span.msg-s-event-listitem__message-body",
            "p[class*='body']",
        ]
        for sel in text_selectors:
            try:
                text_el = last_msg.locator(sel).first
                if await text_el.count():
                    text = _safe_text(await text_el.text_content(timeout=2_000))
                    if text:
                        break
            except Exception:
                continue

        if not text:
            try:
                text = _safe_text(await last_msg.inner_text(timeout=3_000))[:500]
            except Exception:
                pass

        is_outbound = False
        try:
            msg_classes = await last_msg.get_attribute("class") or ""
            if "outbound" in msg_classes.lower() or "sent" in msg_classes.lower():
                is_outbound = True

            try:
                parent = last_msg.locator("xpath=..")
                parent_classes = await parent.get_attribute("class") or ""
                if "outbound" in parent_classes.lower() or "from-me" in parent_classes.lower():
                    is_outbound = True
            except Exception:
                pass

            if sender.lower() in {"sie", "you", "ich"}:
                is_outbound = True

            try:
                style = await last_msg.get_attribute("style") or ""
                if "right" in style.lower() or "flex-end" in style.lower():
                    is_outbound = True
            except Exception:
                pass
        except Exception:
            pass

        return {
            "sender": sender,
            "text": text,
            "is_outbound": is_outbound,
        }

    except Exception:
        return None
```

- [ ] **Step 2: Smoke-import the module**

```bash
cd workers && python -c "from thread_reader import extract_last_bubble, classify_last_sender; print('ok')"
```

Expected: `ok`. (Catches syntax errors and bad imports.)

- [ ] **Step 3: Re-run the classifier unit tests**

```bash
cd workers && python -m pytest test_thread_reader.py -v
```

Expected: `12 passed` (still green — the new function does not affect them).

- [ ] **Step 4: Commit**

```bash
git add workers/thread_reader.py
git commit -m "Add extract_last_bubble Playwright reader to thread_reader"
```

---

## Task 3: Refactor scraper to use the shared classifier

**Files:**
- Modify: `workers/scraper/scraper.py` (replace lines 2293–2330 inline block)

We **leave `extract_last_message_from_conversation` untouched** in this task to keep blast radius minimal — it works, it has no other in-tree callers, and re-routing it adds risk. (If a later task wants single-source-of-truth on the reader too, that's an easy follow-up.)

- [ ] **Step 1: Add the import**

Open `workers/scraper/scraper.py`. The file already does:

```python
# scraper.py:24-25
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))
```

So `workers/` is already on `sys.path`. Add this import next to `from shared_logger import get_logger` (around line 40):

```python
from thread_reader import classify_last_sender
```

- [ ] **Step 2: Replace the inline classifier**

At `workers/scraper/scraper.py:2302-2330`, the current block is:

```python
            # Additional check: if sender name matches lead name, it's their reply
            sender_lower = sender.lower().strip()
            is_their_reply = False

            if is_outbound:
                # Last message is from us
                is_their_reply = False
            elif sender_lower in ["sie", "you", "ich", ""]:
                # Ambiguous sender that looks like us
                is_their_reply = False
                is_outbound = True
            elif (
                sender_lower == lead_full_name.lower() or
                sender_lower == first_name.lower() or
                first_name.lower() in sender_lower or
                sender_lower in lead_full_name.lower()
            ):
                # Sender matches lead name - this is their reply
                is_their_reply = True
            else:
                # Sender doesn't match lead name and isn't a standard "you" indicator.
                # Since we opened this conversation from the lead's profile, if the sender
                # is NOT the lead, it must be US (the logged-in user, e.g. "Simon Vestner").
                # This means the last message is outbound; the sender worker owns nudge scheduling.
                logger.debug(
                    f"Sender '{sender}' doesn't match lead '{lead_full_name}' - treating as our outbound message",
                    {"leadId": lead_id, "sender": sender, "leadName": lead_full_name}
                )
                is_outbound = True
```

Replace it with:

```python
            # Classify the latest bubble via the shared helper.
            verdict = classify_last_sender(
                {"sender": sender, "text": text, "is_outbound": is_outbound},
                lead_full_name,
                first_name,
            )
            is_their_reply = verdict == "lead"
            if verdict == "unknown":
                logger.debug(
                    f"Sender '{sender}' doesn't match lead '{lead_full_name}' - treating as our outbound message",
                    {"leadId": lead_id, "sender": sender, "leadName": lead_full_name}
                )
                is_outbound = True
            elif verdict == "us":
                is_outbound = True
```

This preserves the scraper's current behavior exactly:
- `"lead"` → `is_their_reply = True` (same as before).
- `"us"` and `"unknown"` → `is_their_reply = False`, `is_outbound = True` (same as before).
- The debug log fires on `"unknown"` only, matching the old `else:` branch.

- [ ] **Step 3: Static-check the change**

```bash
cd workers/scraper && python -c "import ast, sys; ast.parse(open('scraper.py').read()); print('ok')"
```

Expected: `ok`.

- [ ] **Step 4: Smoke import**

```bash
cd workers/scraper && python -c "import scraper; print('ok')"
```

Expected: `ok` (and no missing-import errors).

- [ ] **Step 5: Manual regression check (operator-driven, requires LinkedIn auth)**

Pick **one** SENT lead with whom you have a thread where the last message is from the lead. Run:

```bash
cd workers/scraper && source venv/bin/activate && python -u scraper.py --inbox --run
```

Verify in Supabase:
- A new row in `followups` with `lead_id` matching, `followup_type='REPLY'`, `status='PENDING_REVIEW'`.
- The `leads.last_reply_at` column for that lead is set to roughly now.

If both are present, the scraper still detects replies correctly. If you can't run live LinkedIn during this task, skip this step and defer to the Task 6 integration suite — but the unit tests + smoke import are the bare minimum gate to commit.

- [ ] **Step 6: Commit**

```bash
git add workers/scraper/scraper.py
git commit -m "Route scraper inbox-scan through shared thread_reader classifier"
```

---

## Task 4: Add the `_record_reply_at_send_time` helper to the sender

**Files:**
- Modify: `workers/sender/sender.py` (add helper near other `mark_followup_*` functions)

- [ ] **Step 1: Add the import**

Open `workers/sender/sender.py`. The file already does `sys.path.insert(0, str(Path(__file__).parent.parent))` at line 19. Add this import next to the existing `from shared_logger import get_logger` (around line 21):

```python
from thread_reader import extract_last_bubble, classify_last_sender
```

- [ ] **Step 2: Add the helper**

Insert immediately after `revert_followup_to_approved` (currently ending at `workers/sender/sender.py:2534`), so the helper sits with the other followup-state helpers:

```python
def _record_reply_at_send_time(
    client: Client,
    lead_id: Optional[str],
    followup_id: str,
    bubble_text: str,
) -> None:
    """Persist the reply detected at send-time on the lead row.

    Sets `leads.last_reply_at` so that fetch_approved_followups short-circuits
    on subsequent polls (see workers/sender/sender.py around line 2291). The
    followup itself is moved to SKIPPED by the caller; this helper only writes
    the lead-level state.
    """
    if not lead_id:
        return
    now_iso = _utc_now().isoformat()
    try:
        client.table("leads").update({
            "last_reply_at": now_iso,
            "updated_at": now_iso,
        }).eq("id", lead_id).execute()
        logger.info(
            "Recorded last_reply_at from send-time reply check",
            {"leadId": lead_id, "followupId": followup_id, "preview": (bubble_text or "")[:80]},
        )
    except Exception as exc:
        # Non-fatal: the followup is already going to be marked SKIPPED. The
        # worst case is the next inbox-scan re-detects the reply and writes
        # last_reply_at then.
        logger.warn(
            "Failed to write last_reply_at after send-time reply detection",
            {"leadId": lead_id, "followupId": followup_id},
            error=exc,
        )
```

- [ ] **Step 3: Smoke-import the sender**

```bash
cd workers/sender && python -c "import sender; print('ok')"
```

Expected: `ok`. Catches the new import path and any typo in the helper.

- [ ] **Step 4: Commit**

```bash
git add workers/sender/sender.py
git commit -m "Add _record_reply_at_send_time helper in sender"
```

---

## Task 5: Wire the reply check into `process_followup_one`

**Files:**
- Modify: `workers/sender/sender.py` (`process_followup_one` at line 2628, polling loop at line 3654)

- [ ] **Step 1: Insert the reply-check block**

Open `workers/sender/sender.py`. Find this block at `process_followup_one` (around lines 2666–2680):

```python
        message_page, surface = await open_followup_message_surface(page)

        if surface == SURFACE_SALES_NAVIGATOR:
            logger.info(
                "Followup routing through Sales Navigator composer",
                {"followupId": followup_id, "leadId": lead_id},
            )
            await send_sales_navigator_message(
                message_page,
                build_sales_navigator_subject(lead, message),
                build_sales_navigator_body(message),
            )
        else:
            await send_message(message_page, message, surface)
```

Replace it with:

```python
        message_page, surface = await open_followup_message_surface(page)

        # --- Just-in-time reply check (Sales Navigator surface deliberately skipped) ---
        if surface != SURFACE_SALES_NAVIGATOR:
            try:
                bubble = await extract_last_bubble(message_page)
            except Exception as bubble_exc:
                logger.warn(
                    "Reply check raised; proceeding with send (fail-open)",
                    {"followupId": followup_id, "leadId": lead_id},
                    error=bubble_exc,
                )
                bubble = None

            if bubble is not None:
                lead_full = " ".join(
                    p for p in [(lead.get("first_name") or ""), (lead.get("last_name") or "")] if p
                ).strip()
                verdict = classify_last_sender(bubble, lead_full, (lead.get("first_name") or ""))
                if verdict == "lead":
                    logger.info(
                        "Lead replied since nudge was scheduled; skipping send",
                        {
                            "followupId": followup_id,
                            "leadId": lead_id,
                            "sender": (bubble.get("sender") or "")[:80],
                            "preview": (bubble.get("text") or "")[:120],
                        },
                    )
                    _record_reply_at_send_time(client, lead_id, followup_id, bubble.get("text") or "")
                    mark_followup_skipped(client, followup_id, "reply_detected_at_send_time")
                    return "skipped"
                if verdict == "unknown":
                    logger.warn(
                        "Reply check inconclusive; proceeding with send",
                        {
                            "followupId": followup_id,
                            "leadId": lead_id,
                            "sender": (bubble.get("sender") or "")[:80],
                        },
                    )
            # bubble is None → fresh thread / loader hadn't finished → fall through to send (fail-open).
        else:
            logger.debug(
                "Reply check skipped: Sales Navigator surface",
                {"followupId": followup_id, "leadId": lead_id},
            )

        if surface == SURFACE_SALES_NAVIGATOR:
            logger.info(
                "Followup routing through Sales Navigator composer",
                {"followupId": followup_id, "leadId": lead_id},
            )
            await send_sales_navigator_message(
                message_page,
                build_sales_navigator_subject(lead, message),
                build_sales_navigator_body(message),
            )
        else:
            await send_message(message_page, message, surface)
```

- [ ] **Step 2: Update the polling loop to handle the new `"skipped"` return value**

Find this block at `workers/sender/sender.py:3648-3669`:

```python
                sent_count = 0
                failed_count = 0
                retry_count = 0

                for fu in items:
                    try:
                        result = await process_followup_one(context, client, fu)
                        if result == "sent":
                            sent_count += 1
                        elif result == "failed":
                            failed_count += 1
                        else:  # retry
                            retry_count += 1
                    except Exception as exc:
                        logger.error(f"Failed to send followup", {"followupId": fu.get('id')}, error=exc)
                        # Unexpected exception - mark as retry
                        try:
                            mark_followup_failed(client, fu.get('id'), str(exc), permanent=False)
                        except Exception:
                            pass
                        retry_count += 1
                    await random_pause(2, 4)

                logger.operation_complete("sender-followup", result={
                    "sent": sent_count,
                    "failed": failed_count,
                    "retry": retry_count,
                    "total": len(items),
                })
```

Replace it with:

```python
                sent_count = 0
                failed_count = 0
                retry_count = 0
                skipped_count = 0

                for fu in items:
                    try:
                        result = await process_followup_one(context, client, fu)
                        if result == "sent":
                            sent_count += 1
                        elif result == "skipped":
                            skipped_count += 1
                        elif result == "failed":
                            failed_count += 1
                        else:  # retry
                            retry_count += 1
                    except Exception as exc:
                        logger.error(f"Failed to send followup", {"followupId": fu.get('id')}, error=exc)
                        # Unexpected exception - mark as retry
                        try:
                            mark_followup_failed(client, fu.get('id'), str(exc), permanent=False)
                        except Exception:
                            pass
                        retry_count += 1
                    await random_pause(2, 4)

                logger.operation_complete("sender-followup", result={
                    "sent": sent_count,
                    "skipped": skipped_count,
                    "failed": failed_count,
                    "retry": retry_count,
                    "total": len(items),
                })
```

- [ ] **Step 3: Update the docstring on `process_followup_one`**

At `workers/sender/sender.py:2628-2632`, change:

```python
async def process_followup_one(context: BrowserContext, client: Client, followup: Dict[str, Any]) -> str:
    """Process a single followup. Returns 'sent', 'failed', or 'retry'.
    
    The followup should already be marked as PROCESSING before calling this.
    """
```

To:

```python
async def process_followup_one(context: BrowserContext, client: Client, followup: Dict[str, Any]) -> str:
    """Process a single followup. Returns 'sent', 'skipped', 'failed', or 'retry'.

    'skipped' is returned when the live thread inspection detected that the
    lead replied since the nudge was scheduled — in that case the followup
    row is marked SKIPPED and `leads.last_reply_at` is updated, but no
    outbound DOM action is taken.

    The followup should already be marked as PROCESSING before calling this.
    """
```

- [ ] **Step 4: Smoke-import the sender**

```bash
cd workers/sender && python -c "import sender; print('ok')"
```

Expected: `ok`.

- [ ] **Step 5: Static-check the polling loop change**

```bash
cd workers/sender && python -c "import ast, sys; ast.parse(open('sender.py').read()); print('ok')"
```

Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add workers/sender/sender.py
git commit -m "Skip nudge send when live thread shows lead has replied"
```

---

## Task 6: Manual integration verification

No code changes in this task. This is the end-to-end verification gate against staging Supabase + a live LinkedIn account. Run it before declaring the work done; if any step fails, file the failure as a bug and do not merge.

Prereqs:
- Staging or shadow Supabase with a SENT lead you control.
- Sender venv activated, `auth.json` present.
- A "you-as-lead" LinkedIn account or a trusted collaborator who can post replies on demand.

- [ ] **Step 1: Reply-detected path**

1. In Supabase, pick a SENT lead. Capture its `id` and current `last_reply_at` (should be NULL or stale).
2. Insert a row directly:
   ```sql
   insert into followups (lead_id, status, followup_type, attempt, draft_text, next_send_at, last_message_from)
   values ('<LEAD_ID>', 'APPROVED', 'NUDGE', 1, 'Test nudge — do not send', now() - interval '1 minute', 'us');
   ```
3. From the lead's account, post a fresh reply to the thread on LinkedIn so the last bubble is from the lead.
4. Run the sender once:
   ```bash
   cd workers/sender && source venv/bin/activate && python -u sender.py --followup
   ```
5. Verify in Supabase:
   ```sql
   select status, last_error from followups where lead_id='<LEAD_ID>' order by created_at desc limit 1;
   -- expect: status='SKIPPED', last_error='reply_detected_at_send_time'
   select last_reply_at from leads where id='<LEAD_ID>';
   -- expect: timestamp within the last few minutes
   ```
6. Verify in LinkedIn UI: the thread shows **no new outbound** message from us — only the lead's reply.

- [ ] **Step 2: Happy-path send (no regression)**

1. Pick a different SENT lead. Confirm the last bubble in the thread is from **us** (don't reply from their side).
2. Insert another APPROVED NUDGE row for that lead (same SQL as Step 1, different `lead_id`).
3. Run `python -u sender.py --followup`.
4. Verify in Supabase: `status='SENT'`, `sent_text` populated, `sent_at` recent.
5. Verify in LinkedIn UI: the nudge message appears as the latest outbound bubble.

- [ ] **Step 3: Sales Navigator path (unchanged behavior)**

1. Pick a SENT lead routed through Sales Navigator (i.e., `open_followup_message_surface` returns `SURFACE_SALES_NAVIGATOR`).
2. Insert an APPROVED NUDGE row as in Step 1.
3. Run `python -u sender.py --followup`.
4. Verify the sender logs contain `Reply check skipped: Sales Navigator surface` at debug level.
5. Verify the nudge sends normally (current behavior preserved).

- [ ] **Step 4: Scraper inbox-scan regression**

1. Pick a SENT lead **without** any pending followup. Reply from their side.
2. Trigger the inbox scan via the Followups tab in the web UI (or `python scraper.py --inbox --run`).
3. Verify: a new `followups` row with `followup_type='REPLY'`, `status='PENDING_REVIEW'`, and `leads.last_reply_at` is set.

If all four steps pass, the change is verified end-to-end.

---

## Out of scope (do not implement)

- Automatic inbox-scan in `run_all.sh`. Layer-2 fix from the root-cause analysis; separate spec.
- Reply *handling* / draft generation. Owned by the future "answering" module.
- Splitting `sender.py` into submodules. Address after this lands, against actual pain points.
- Sales Navigator reply detection. Logged limitation; revisit when SN traffic warrants.
- Updating `followups.last_message_text` / `last_message_from` on the SKIPPED row. The answering module will define what schema it needs.
- Refactoring `extract_last_message_from_conversation` in the scraper to delegate to `extract_last_bubble`. Possible follow-up; not load-bearing.

## Verification summary (AGENTS.md §0 testscript)

| Behavior | Verification |
|---|---|
| Classifier returns "lead" for lead-name sender | `pytest workers/test_thread_reader.py -v` |
| Classifier returns "us" for outbound flag / Sie/You/Ich | `pytest workers/test_thread_reader.py -v` |
| Classifier returns "unknown" for unrelated sender | `pytest workers/test_thread_reader.py -v` |
| Scraper inbox-scan still detects replies | Task 3 Step 5 + Task 6 Step 4 |
| Sender skips nudge when lead replied | Task 6 Step 1 |
| Sender sends nudge when no reply | Task 6 Step 2 |
| Sales Nav path unchanged | Task 6 Step 3 |
| No new runtime deps | `git diff workers/sender/pyproject.toml workers/scraper/pyproject.toml` is empty |
| LOC budget respected | `git diff --stat main..HEAD` shows ~+150 in `thread_reader.py`, ~+90 in `test_thread_reader.py`, ~−50 in `scraper.py`, ~+60 in `sender.py` |
