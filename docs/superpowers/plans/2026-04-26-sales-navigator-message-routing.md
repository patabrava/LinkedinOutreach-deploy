# Sales Navigator Message Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sender route that uses normal LinkedIn direct messages for 1st-degree connections and falls back to Sales Navigator/InMail-style messaging when the normal message surface is unavailable.

**Architecture:** Keep the feature local to the existing sender worker. Add a small routing layer that returns an explicit opened surface (`message`, `sales_navigator_message`, `connect_note`, `connect`) and a dedicated Sales Navigator composer sender that fills subject and body fields before clicking send.

**Tech Stack:** Python 3.11, Playwright async API, Supabase Python client, `unittest`.

---

## Context-Zero

**Environment matrix**
- OS: macOS local development, Linux in production containers.
- Runtime: Python 3.11 in `workers/sender/venv`.
- Browser automation: Playwright Chromium.
- App data: Supabase tables `leads`, `outreach_sequences`, `followups`.
- Current sender entry point: `workers/sender/sender.py`.

**Non-functional requirements**
- Do not add dependencies.
- Keep browser automation deterministic enough to debug with screenshots and structured logs.
- Prevent duplicate first-message sends when multiple message-only sender runs overlap.
- Never send a Sales Navigator message unless the normal message button is unavailable or fails before typing.
- Do not send through `connect_note` for full first sequence messages.
- If the Sales Navigator composer cannot be verified, mark the lead retryable or failed without typing into an unknown surface.

**Locality budget**
- Files: 3 total.
- LOC/file: `workers/sender/sender.py` target +220 LOC, max existing file growth acceptable because the worker is already monolithic; `workers/sender/test_sales_navigator_routing.py` target 260 LOC; `AGENTS.md` target +1 dense repo rule only if implementation fixes a confirmed bug.
- Deps: 0 new dependencies.

## File Structure

- Modify `workers/sender/sender.py`
  - Add explicit surface constants.
  - Add URL/profile helpers for Sales Navigator route attempts.
  - Add popup-aware click helper.
  - Add `open_sales_navigator_message_surface()`.
  - Add `send_sales_navigator_message()`.
  - Add message-only processing lock before each send.
  - Route `process_message_only_one()` through normal message first, then Sales Navigator fallback.

- Create `workers/sender/test_sales_navigator_routing.py`
  - Unit-test pure helper behavior and fake-client lock behavior.
  - Avoid real LinkedIn calls.
  - Keep Playwright live validation as a manual testscript command, not a unit test.

- Modify `AGENTS.md`
  - Add a one-line prevention rule only after implementation confirms and fixes the duplicate/incorrect-surface behavior.

## Capability Map

- Direct message path: existing `Nachricht` / `Message` behavior remains first choice.
- Sales Navigator path: fallback only when the normal message surface is unavailable before typing.
- Sales Navigator composer: fill subject and body separately, verify both fields, then send.
- Duplicate protection: mark message-only leads `PROCESSING` with a conditional status update before opening LinkedIn.
- Observability: log selected surface, popup/page URL, subject/body field selectors, and screenshot path on failure.

## Pass-Fail Criteria

- `python -m unittest workers/sender/test_sequence_messages.py workers/sender/test_sales_navigator_routing.py` passes.
- A lead already marked `SENT` is not processed again by `--message-only`.
- A lead that cannot be conditionally moved into `PROCESSING` is skipped.
- The normal message path still sends through the current DM composer when available.
- The Sales Navigator path fills a subject and a body, never only the body.
- A Sales Navigator popup/new tab is handled by switching to the popup page before field lookup.
- If neither direct message nor Sales Navigator composer is available, no message is typed.

## Task 1: Add Sender Routing Helper Tests

**Files:**
- Create: `workers/sender/test_sales_navigator_routing.py`
- Modify: none
- Test: `workers/sender/test_sales_navigator_routing.py`

- [ ] **Step 1: Write the failing tests**

Create `workers/sender/test_sales_navigator_routing.py` with:

```python
#!/usr/bin/env python3
"""Tests for Sales Navigator sender routing helpers."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from sender import (
    MESSAGE_ONLY_PROCESSING_STATUSES,
    build_sales_navigator_subject,
    mark_message_only_processing,
    normalize_linkedin_profile_url,
)


class FakeResponse:
    def __init__(self, data=None, count=None):
        self.data = data or []
        self.count = count

    def execute(self):
        return self


class FakeQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.filters = []
        self.payload = None

    def update(self, payload):
        self.payload = payload
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def in_(self, key, values):
        self.filters.append(("in", key, list(values)))
        return self

    def execute(self):
        self.client.calls.append(
            {
                "table": self.table_name,
                "payload": self.payload,
                "filters": self.filters,
            }
        )
        lead = self.client.lead
        id_filter = next((f for f in self.filters if f[:2] == ("eq", "id")), None)
        status_filter = next((f for f in self.filters if f[:2] == ("in", "status")), None)
        if not id_filter or id_filter[2] != lead["id"]:
            return FakeResponse([])
        if status_filter and lead["status"] not in status_filter[2]:
            return FakeResponse([])
        lead.update(self.payload or {})
        return FakeResponse([dict(lead)])


class FakeClient:
    def __init__(self, lead):
        self.lead = dict(lead)
        self.calls = []

    def table(self, table_name):
        return FakeQuery(self, table_name)


class SalesNavigatorRoutingTest(unittest.TestCase):
    def test_normalize_linkedin_profile_url_removes_query_and_trailing_slash(self):
        result = normalize_linkedin_profile_url(
            "http://www.linkedin.com/in/marcel-ohlendorf-42335a197/?miniProfileUrn=abc"
        )

        self.assertEqual(result, "https://www.linkedin.com/in/marcel-ohlendorf-42335a197")

    def test_build_sales_navigator_subject_uses_name_when_available(self):
        subject = build_sales_navigator_subject(
            {
                "first_name": "Marcel",
                "last_name": "Ohlendorf",
                "company_name": "Degura",
            }
        )

        self.assertEqual(subject, "Kurzer Austausch, Marcel")

    def test_build_sales_navigator_subject_falls_back_without_name(self):
        subject = build_sales_navigator_subject({"company_name": "Degura"})

        self.assertEqual(subject, "Kurzer Austausch")

    def test_mark_message_only_processing_locks_only_eligible_status(self):
        lead = {"id": "lead-1", "status": "CONNECTED"}
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertTrue(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls[0]["filters"][1], ("in", "status", list(MESSAGE_ONLY_PROCESSING_STATUSES)))

    def test_mark_message_only_processing_skips_sent_lead(self):
        lead = {"id": "lead-1", "status": "SENT"}
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertFalse(result)
        self.assertEqual(client.lead["status"], "SENT")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach
workers/sender/venv/bin/python -m unittest workers/sender/test_sales_navigator_routing.py -v
```

Expected: FAIL with import errors for `MESSAGE_ONLY_PROCESSING_STATUSES`, `build_sales_navigator_subject`, `mark_message_only_processing`, and `normalize_linkedin_profile_url`.

- [ ] **Step 3: Commit tests**

Do not commit yet if following strict TDD red-green commits. Keep the failing test unstaged until Task 2 passes.

## Task 2: Add Pure Helpers And Message-Only Lock

**Files:**
- Modify: `workers/sender/sender.py`
- Test: `workers/sender/test_sales_navigator_routing.py`

- [ ] **Step 1: Add helper constants and pure functions**

In `workers/sender/sender.py`, after `MESSAGE_ONLY_PIPELINE_STATUSES`, add:

```python
MESSAGE_ONLY_PROCESSING_STATUSES = tuple(MESSAGE_ONLY_PIPELINE_STATUSES)
SURFACE_MESSAGE = "message"
SURFACE_CONNECT_NOTE = "connect_note"
SURFACE_CONNECT = "connect"
SURFACE_SALES_NAVIGATOR = "sales_navigator_message"


def normalize_linkedin_profile_url(url: str) -> str:
    normalized = (url or "").strip().replace("http://", "https://").split("?")[0].rstrip("/")
    if normalized.startswith("linkedin.com/"):
        normalized = f"https://www.{normalized}"
    if normalized.startswith("www.linkedin.com/"):
        normalized = f"https://{normalized}"
    return normalized


def build_sales_navigator_subject(lead: Dict[str, Any]) -> str:
    first_name = (lead.get("first_name") or "").strip()
    if first_name:
        return f"Kurzer Austausch, {first_name}"
    return "Kurzer Austausch"
```

- [ ] **Step 2: Add conditional message-only processing lock**

In `workers/sender/sender.py`, after `mark_processing()`, add:

```python
def mark_message_only_processing(client: Client, lead: Dict[str, Any]) -> bool:
    lead_id = str(lead.get("id") or "")
    if not lead_id:
        return False

    logger.db_query(
        "update",
        "leads",
        {"leadId": lead_id},
        {"status": "PROCESSING", "from": list(MESSAGE_ONLY_PROCESSING_STATUSES)},
    )
    try:
        resp = (
            client.table("leads")
            .update({"status": "PROCESSING", "updated_at": datetime.utcnow().isoformat()})
            .eq("id", lead_id)
            .in_("status", list(MESSAGE_ONLY_PROCESSING_STATUSES))
            .execute()
        )
    except Exception as exc:
        logger.warn("Failed to lock message-only lead", {"leadId": lead_id}, error=exc)
        return False

    rows = getattr(resp, "data", None) or []
    locked = len(rows) > 0
    logger.db_result("update", "leads", {"leadId": lead_id}, len(rows))
    if locked:
        lead["status"] = "PROCESSING"
        logger.debug("Lead marked as PROCESSING for message-only send", {"leadId": lead_id})
    else:
        logger.info("Message-only lead was already claimed or no longer eligible", {"leadId": lead_id})
    return locked
```

- [ ] **Step 3: Use normalized URL in message-only send**

In `process_message_only_one()`, replace:

```python
url = str(lead["linkedin_url"]).replace("http://", "https://")
```

with:

```python
url = normalize_linkedin_profile_url(str(lead["linkedin_url"]))
```

- [ ] **Step 4: Lock each message-only lead before processing**

In the `for lead in leads_to_process:` loop inside `main()` under `if args.message_only:`, replace:

```python
try:
    result = await process_message_only_one(context, client, lead)
```

with:

```python
try:
    if not mark_message_only_processing(client, lead):
        continue
    result = await process_message_only_one(context, client, lead)
```

- [ ] **Step 5: Run helper tests**

Run:

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach
workers/sender/venv/bin/python -m unittest workers/sender/test_sales_navigator_routing.py -v
```

Expected: PASS.

- [ ] **Step 6: Run existing sequence tests**

Run:

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach
workers/sender/venv/bin/python -m unittest workers/sender/test_sequence_messages.py -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/sender/sender.py workers/sender/test_sales_navigator_routing.py
git commit -m "fix: lock message-only leads before sending"
```

## Task 3: Add Popup-Aware Sales Navigator Surface Opening

**Files:**
- Modify: `workers/sender/sender.py`
- Test: manual Playwright smoke script from this task

- [ ] **Step 1: Add popup-aware click helper**

In `workers/sender/sender.py`, before `open_message_surface()`, add:

```python
async def click_and_resolve_active_page(page: Page, locator, timeout_ms: int = 8_000) -> Page:
    context = page.context
    before_pages = set(context.pages)
    popup_task = asyncio.create_task(page.wait_for_event("popup", timeout=timeout_ms))
    try:
        await locator.click(timeout=timeout_ms)
        try:
            popup = await popup_task
            await popup.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
            logger.info("Popup page opened for message surface", data={"url": popup.url})
            return popup
        except Exception:
            await page.wait_for_timeout(500)
            after_pages = [candidate for candidate in context.pages if candidate not in before_pages]
            if after_pages:
                candidate = after_pages[-1]
                await candidate.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
                logger.info("New page opened for message surface", data={"url": candidate.url})
                return candidate
            return page
    finally:
        if not popup_task.done():
            popup_task.cancel()
```

- [ ] **Step 2: Add Sales Navigator opener**

In `workers/sender/sender.py`, before `send_message()`, add:

```python
async def open_sales_navigator_message_surface(page: Page) -> Optional[Page]:
    sales_nav_selectors = [
        ("sales nav message button", lambda: page.get_by_role("button", name=re.compile(r"(Nachricht|Message|InMail)", re.I))),
        ("sales nav message link", lambda: page.get_by_role("link", name=re.compile(r"(Nachricht|Message|InMail)", re.I))),
        ("sales nav compose button", lambda: page.locator("button:has-text('Nachricht'), button:has-text('Message'), button:has-text('InMail')")),
        ("sales nav compose link", lambda: page.locator("a:has-text('Nachricht'), a:has-text('Message'), a:has-text('InMail')")),
    ]

    for selector_name, builder in sales_nav_selectors:
        try:
            candidate = builder()
            count = await candidate.count()
            logger.element_search(selector_name, count, context={"surface": SURFACE_SALES_NAVIGATOR})
            if count <= 0:
                continue
            target_page = await click_and_resolve_active_page(page, candidate.first)
            await target_page.wait_for_timeout(1_000)
            subject_count = await target_page.locator(
                "input[name='subject'], input[placeholder*='Subject'], input[aria-label*='Subject'], "
                "input[placeholder*='Betreff'], input[aria-label*='Betreff']"
            ).count()
            body_count = await target_page.locator(
                "textarea[name='message'], textarea[placeholder*='Message'], textarea[aria-label*='Message'], "
                "div[role='textbox'][contenteditable='true']"
            ).count()
            if subject_count > 0 and body_count > 0:
                logger.path_attempt("Sales Navigator message surface", 1, success=True)
                return target_page
            logger.path_attempt("Sales Navigator message surface missing fields", 1, success=False)
        except Exception as exc:
            logger.path_attempt("Sales Navigator message surface", 1, success=False)
            logger.warn("Sales Navigator surface attempt failed", error=exc)
    return None
```

- [ ] **Step 3: Run syntax check**

Run:

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach
workers/sender/venv/bin/python -m py_compile workers/sender/sender.py
```

Expected: no output and exit code 0.

- [ ] **Step 4: Commit**

```bash
git add workers/sender/sender.py
git commit -m "feat: detect sales navigator message surface"
```

## Task 4: Add Sales Navigator Subject And Body Sender

**Files:**
- Modify: `workers/sender/sender.py`
- Test: manual Playwright smoke script from Task 6

- [ ] **Step 1: Add field-fill helper**

In `workers/sender/sender.py`, before `send_message()`, add:

```python
async def fill_text_field(page: Page, selector_name: str, locator, value: str) -> None:
    await locator.wait_for(state="visible", timeout=10_000)
    await locator.click()
    try:
        await page.keyboard.press("Meta+A")
        await page.keyboard.press("Backspace")
    except Exception:
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Backspace")
    await human_type(page, value)
    await page.wait_for_timeout(500)
    actual_text = await locator.evaluate("el => el.value || el.textContent || el.innerText || ''") or ""
    if len(actual_text.strip()) < max(1, len(value.strip()) - 2):
        raise RuntimeError(f"{selector_name} verification failed after typing.")
    logger.element_type(selector_name, len(value), text_preview=value[:40])
```

- [ ] **Step 2: Add Sales Navigator sender**

In `workers/sender/sender.py`, before `send_message()`, add:

```python
async def send_sales_navigator_message(page: Page, subject: str, body: str) -> None:
    safe_subject = _hard_cap_text((subject or "").strip(), 80)
    safe_body = (body or "").strip()
    if not safe_subject:
        raise RuntimeError("Sales Navigator subject is empty.")
    if not safe_body:
        raise RuntimeError("Sales Navigator body is empty.")

    subject_candidates = [
        ("subject input:name", "input[name='subject']"),
        ("subject input:placeholder", "input[placeholder*='Subject'], input[placeholder*='Betreff']"),
        ("subject input:aria", "input[aria-label*='Subject'], input[aria-label*='Betreff']"),
    ]
    body_candidates = [
        ("body textarea:name", "textarea[name='message']"),
        ("body textarea:placeholder", "textarea[placeholder*='Message'], textarea[placeholder*='Nachricht']"),
        ("body textarea:aria", "textarea[aria-label*='Message'], textarea[aria-label*='Nachricht']"),
        ("body contenteditable", "div[role='textbox'][contenteditable='true']"),
    ]

    subject_locator = None
    subject_selector = ""
    for name, selector in subject_candidates:
        candidate = page.locator(selector).first
        if await candidate.count() > 0:
            subject_locator = candidate
            subject_selector = name
            break
    if subject_locator is None:
        raise RuntimeError("Could not find Sales Navigator subject field.")

    body_locator = None
    body_selector = ""
    for name, selector in body_candidates:
        candidate = page.locator(selector).first
        if await candidate.count() > 0:
            body_locator = candidate
            body_selector = name
            break
    if body_locator is None:
        raise RuntimeError("Could not find Sales Navigator body field.")

    await fill_text_field(page, subject_selector, subject_locator, safe_subject)
    await fill_text_field(page, body_selector, body_locator, safe_body)

    send_btn = page.locator(
        "button:has-text('Send'):visible, "
        "button:has-text('Senden'):visible, "
        "button[aria-label*='Send']:visible, "
        "button[aria-label*='Senden']:visible"
    ).first
    await send_btn.wait_for(state="visible", timeout=10_000)
    if not await send_btn.is_enabled():
        raise RuntimeError("Sales Navigator send button is disabled.")
    await page.wait_for_timeout(800)
    await send_btn.click()
    logger.element_click("Sales Navigator send button", success=True)
    await random_pause()
```

- [ ] **Step 3: Run syntax check**

Run:

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach
workers/sender/venv/bin/python -m py_compile workers/sender/sender.py
```

Expected: no output and exit code 0.

- [ ] **Step 4: Commit**

```bash
git add workers/sender/sender.py
git commit -m "feat: send sales navigator subject and body"
```

## Task 5: Route Message-Only Flow Through Normal Message Then Sales Navigator

**Files:**
- Modify: `workers/sender/sender.py`
- Test: `workers/sender/test_sales_navigator_routing.py`

- [ ] **Step 1: Replace direct message-only click branch with explicit fallback**

In `process_message_only_one()`, replace the body of the `if message_link_count > 0:` branch from:

```python
logger.debug("Found Message link - user is connected", {"leadId": lead_id})
try:
    await message_link.first.click(timeout=8_000)
    await page.wait_for_selector(
        "div.msg-overlay-conversation-bubble, section[role='dialog'] div[role='textbox'][contenteditable='true'], div.msg-form__contenteditable[contenteditable='true']",
        timeout=10_000,
    )
    await random_pause()

    # Send the message
    await send_message(page, message, "message")
```

with:

```python
logger.debug("Found Message link - user is connected", {"leadId": lead_id})
try:
    message_page = await click_and_resolve_active_page(page, message_link.first)
    await message_page.wait_for_selector(
        "div.msg-overlay-conversation-bubble, section[role='dialog'] div[role='textbox'][contenteditable='true'], div.msg-form__contenteditable[contenteditable='true']",
        timeout=10_000,
    )
    await random_pause()
    await send_message(message_page, message, SURFACE_MESSAGE)
```

Keep the rest of the existing success update block unchanged.

- [ ] **Step 2: Replace no-message-button return with Sales Navigator attempt**

In `process_message_only_one()`, replace:

```python
else:
    # No message button found - might still be pending or profile restricted
    logger.info("No Message button found, connection may still be pending", {"leadId": lead_id})
    await page.close()
    return "pending"
```

with:

```python
else:
    logger.info("No normal Message button found; trying Sales Navigator fallback", {"leadId": lead_id})
    sales_page = await open_sales_navigator_message_surface(page)
    if sales_page is None:
        logger.info("No Sales Navigator message surface found, connection may still be pending", {"leadId": lead_id})
        await page.close()
        return "pending"

    try:
        await send_sales_navigator_message(sales_page, build_sales_navigator_subject(lead), message)
        accepted_at = datetime.utcnow().isoformat()
        sequence_started_at = lead.get("sequence_started_at") or accepted_at
        lead_update = {
            "status": "SENT",
            "sent_at": accepted_at,
            "connection_accepted_at": lead.get("connection_accepted_at") or accepted_at,
            "sequence_step": 1,
            "sequence_started_at": sequence_started_at,
            "sequence_last_sent_at": accepted_at,
            "error_message": None,
        }
        try:
            client.table("leads").update(lead_update).eq("id", lead_id).execute()
        except Exception:
            fallback_update = {
                "status": "SENT",
                "sent_at": accepted_at,
                "connection_accepted_at": lead.get("connection_accepted_at") or accepted_at,
                "error_message": None,
            }
            client.table("leads").update(fallback_update).eq("id", lead_id).execute()

        accepted_base = _parse_iso_datetime(accepted_at) or _utc_now()
        try:
            schedule_nudge_followup(client, lead, 1, sequence_messages, accepted_base, message)
            interval_days = _safe_int(sequence_messages.get("followup_interval_days"), SEQUENCE_INTERVAL_DEFAULT_DAYS)
            if interval_days < 1:
                interval_days = SEQUENCE_INTERVAL_DEFAULT_DAYS
            second_message = (sequence_messages.get("second_message") or "").strip()
            schedule_nudge_followup(
                client,
                lead,
                2,
                sequence_messages,
                accepted_base + timedelta(days=interval_days),
                second_message or message,
            )
        except Exception as schedule_error:
            logger.warn(
                "Failed to schedule followups after Sales Navigator first message; keeping lead as SENT",
                {"leadId": lead_id},
                error=schedule_error,
            )
        logger.message_send_complete(lead_id)
        logger.info("Sales Navigator message sent to lead", {"leadId": lead_id})
        await sales_page.close()
        if page != sales_page:
            await page.close()
        return "sent"
    except Exception as exc:
        logger.error("Failed to send Sales Navigator message", {"leadId": lead_id}, error=exc)
        try:
            screenshot_path = f"/tmp/sales_nav_error_{lead_id[:8]}.png"
            await sales_page.screenshot(path=screenshot_path, full_page=True)
            logger.info(f"Sales Navigator screenshot saved to {screenshot_path}")
        except Exception:
            pass
        attempts = mark_lead_retry_later(client, lead, str(exc))
        if attempts >= LEAD_MESSAGE_ONLY_MAX_RETRIES:
            mark_failed(client, lead_id, f"Retry limit reached: {str(exc)}")
            return "failed"
        return "retry"
```

- [ ] **Step 3: Run all sender unit tests**

Run:

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach
workers/sender/venv/bin/python -m unittest workers/sender/test_sequence_messages.py workers/sender/test_sales_navigator_routing.py -v
```

Expected: PASS.

- [ ] **Step 4: Run syntax check**

Run:

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach
workers/sender/venv/bin/python -m py_compile workers/sender/sender.py
```

Expected: no output and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add workers/sender/sender.py workers/sender/test_sales_navigator_routing.py
git commit -m "feat: route first messages through sales navigator fallback"
```

## Task 6: Live Sales Navigator Verification

**Files:**
- Modify: none unless verification reveals selector drift
- Artifact: screenshot path logged under `/tmp/sales_nav_error_<lead>.png` or successful sender logs in `.logs/sender.log`

- [ ] **Step 1: Select one safe test lead**

Use a lead that is not a 1st-degree connection and has Sales Navigator messaging available. Record its `id` and `linkedin_url` from Supabase before running:

```sql
select id, linkedin_url, first_name, last_name, status, outreach_mode
from leads
where outreach_mode = 'connect_only'
  and status in ('CONNECTED', 'CONNECT_ONLY_SENT', 'MESSAGE_ONLY_READY', 'MESSAGE_ONLY_APPROVED')
order by updated_at desc
limit 10;
```

Expected: choose exactly one lead and avoid batch sends for this verification.

- [ ] **Step 2: Run one lead only**

Run:

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach/workers/sender
CORRELATION_ID=sales_nav_live_test venv/bin/python sender.py --message-only --lead-id <LEAD_ID>
```

If running from repo root instead, use:

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach
CORRELATION_ID=sales_nav_live_test workers/sender/venv/bin/python workers/sender/sender.py --message-only --lead-id <LEAD_ID>
```

Expected: sender logs either `Sales Navigator message sent to lead` or a screenshot path with the exact missing selector reason.

- [ ] **Step 3: Inspect logs**

Run:

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach
rg -n "sales_nav_live_test|Sales Navigator|sales navigator|message surface|screenshot" .logs/sender.log
```

Expected on success: `Sales Navigator message sent to lead`.

Expected on selector failure: a `/tmp/sales_nav_error_*.png` path and an error naming the missing field.

- [ ] **Step 4: Verify LinkedIn conversation manually**

Open the selected lead conversation and verify:

```text
Subject: Kurzer Austausch, <first_name>
Body: the rendered first_message for that lead
Recipient: the selected lead, not a previous profile tab
```

Expected: one message was sent to the selected lead and no unrelated conversation received the body.

- [ ] **Step 5: Commit selector fix only if needed**

If Step 3 identifies a missing selector and Step 4 did not send a message, update only the selector arrays in `open_sales_navigator_message_surface()` or `send_sales_navigator_message()`, rerun Task 5 tests, and commit:

```bash
git add workers/sender/sender.py
git commit -m "fix: update sales navigator composer selectors"
```

## Task 7: Add Repo Rule After Confirmed Fix

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add one dense prevention rule**

Append this one-line rule under `2) Specific repo rules` in `AGENTS.md`:

```markdown
- Message-only first-message sends must claim eligible leads with a conditional `PROCESSING` update before opening LinkedIn, prefer normal direct-message surfaces, and use Sales Navigator/InMail fallback only through a verified subject+body composer, including popup/new-tab handling.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: capture sales navigator sender rule"
```

## Regression Testscript

Run the full sender regression set:

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach
workers/sender/venv/bin/python -m unittest workers/sender/test_sequence_messages.py workers/sender/test_sales_navigator_routing.py -v
workers/sender/venv/bin/python -m py_compile workers/sender/sender.py
```

Expected:

```text
OK
```

and:

```text
no py_compile output
```

## Rollback Plan

If Sales Navigator selectors are unstable in production:

```bash
git revert <commit-that-added-sales-navigator-fallback>
```

Keep the conditional `PROCESSING` lock commit unless it causes a verified regression, because it protects against duplicate message-only sends independently of Sales Navigator routing.

## Self-Review

**Spec coverage**
- Normal message first: Task 5.
- Sales Navigator fallback for non-connections: Tasks 3, 4, 5, 6.
- Subject and body fields: Task 4.
- New tab/popup handling: Task 3.
- Duplicate send prevention: Task 2.
- Live verification: Task 6.

**Placeholder scan**
- No placeholder markers or deferred implementation language remain.
- Selector drift is handled by a concrete live verification and exact selector edit location.

**Type consistency**
- Surface constants are strings used by existing `send_message()` behavior.
- `mark_message_only_processing()` accepts the same `Client` and lead dict shape used by `process_message_only_one()`.
- `build_sales_navigator_subject()` uses the existing lead dict fields `first_name`, `last_name`, and `company_name`.
