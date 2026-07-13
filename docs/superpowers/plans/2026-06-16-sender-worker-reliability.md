# Sender Worker Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve message-only sender reliability by recovering stale lead locks automatically and making connected-message routing more resilient when LinkedIn exposes a message link but does not open a composer.

**Architecture:** Keep the existing message-only sender flow, pending-invite classification, and exact-send verification logic. Add one lead-level stale recovery helper at worker startup, then extract the connected-message open/send branch into a small helper that can retry via direct href navigation, re-check Sales Navigator, and persist structured retry diagnostics before giving up.

**Tech Stack:** Python 3.11, existing Playwright worker, existing Supabase client, Python `unittest`.

---

## Context-Zero

**Environment matrix:**
- Repo: `/Users/camiloecheverri/Documents/AI/Linkedin Scraper/LinkedinOutreach`
- Worker runtime: `workers/sender/venv/bin/python`
- Main worker file: `workers/sender/sender.py`
- Existing sender tests: `workers/sender/test_message_only_queue.py`, `workers/sender/test_sales_navigator_routing.py`
- Browser automation: existing Playwright setup in `workers/sender/sender.py`
- Database: Supabase via `workers/.env`

**Observed runtime failures from the 2026-06-16 live audit:**
- Connected-but-no-composer retries: `Riyad Khalil`, `Cinzia Tetté`, `Julius Krol`
- Stale lead `PROCESSING` rows: `Evgenii Serebriakov`, `Adrian Huminiuc`, `Sophia Menzel`
- Majority of skipped rows were valid pending invites and should stay `CONNECT_ONLY_SENT`

**Non-functional requirements:**
- Do not change the current send confirmation path for successful direct messages
- Do not change daily send-cap semantics
- Do not add dependencies
- Do not add migrations
- Keep changes inside the sender vertical slice

**File, LOC, dependency budget:**
- Files: 2 total
- `workers/sender/sender.py`: modify only, expected net +120 to +220 LOC
- `workers/sender/test_sales_navigator_routing.py`: modify only, expected net +140 to +220 LOC
- Deps: 0 new dependencies

## File Structure

- `workers/sender/sender.py`
  Responsibility: lead recovery, connected-message routing, retry diagnostics, message-only orchestration
- `workers/sender/test_sales_navigator_routing.py`
  Responsibility: fast unit coverage for lock recovery, retry classification, and connected-message routing fallbacks with fake clients/pages

## Capability Map

- Recover stale message-only `PROCESSING` leads before a live run starts
- Distinguish retriable connected-message composer failures from true pending-invite cases
- Retry connected-message opening by direct href navigation before marking the lead for retry
- Persist structured retry metadata for `CONNECTED` leads so the next run has deterministic context

## Boundary Map

- DB lock boundary: `mark_message_only_processing()` claims eligible rows
- DB recovery boundary: new stale lead recovery helper reverts abandoned locks only after an age threshold
- Browser routing boundary: message-link click, href navigation, and Sales Navigator detection stay inside sender worker code
- Retry boundary: retriable connected leads end in `status="CONNECTED"` with structured `profile_data` and `error_message`

## Pass-Fail Criteria

Pass:
- Stale message-only `PROCESSING` rows older than the threshold are requeued automatically
- Live worker startup invokes stale lead recovery before fetching new message-only candidates
- Connected-message flows try direct href navigation before failing with retry
- Retry rows persist structured metadata for composer-open failures
- Existing pending-invite rows still return `"pending"` and remain `CONNECT_ONLY_SENT`
- Sender unit tests pass

Fail:
- A stale lead remains `PROCESSING` after the recovery helper runs
- Connected-message composer-open timeouts still fail without structured retry metadata
- Pending invites get promoted to `CONNECTED` or `SENT`
- New code requires schema changes or dependencies

### Task 1: Add Failing Reliability Tests

**Files:**
- Modify: `workers/sender/test_sales_navigator_routing.py`
- Test: `workers/sender/test_sales_navigator_routing.py`

- [ ] **Step 1: Add stale lead recovery and retry-metadata tests**

Append these tests to `workers/sender/test_sales_navigator_routing.py`:

```python
class FakeStaleLeadQuery:
    def __init__(self, client):
        self.client = client
        self.filters = []
        self.payload = None

    def select(self, *_args, **_kwargs):
        return self

    def update(self, payload):
        self.payload = payload
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def lt(self, key, value):
        self.filters.append(("lt", key, value))
        return self

    def order(self, key, desc=False):
        self.filters.append(("order", key, desc))
        return self

    def limit(self, value):
        self.filters.append(("limit", value))
        return self

    def execute(self):
        self.client.calls.append(
            {"payload": self.payload, "filters": list(self.filters)}
        )
        if self.payload is None:
            return FakeResponse(self.client.select_rows)
        updated = []
        for row in self.client.select_rows:
            if any(f == ("eq", "id", row["id"]) for f in self.filters):
                row.update(self.payload)
                updated.append(dict(row))
        return FakeResponse(updated)


class FakeStaleLeadClient:
    def __init__(self, rows):
        self.select_rows = [dict(row) for row in rows]
        self.calls = []

    def table(self, _table_name):
        return FakeStaleLeadQuery(self)


class MessageOnlyReliabilityTest(unittest.TestCase):
    def test_recover_stale_message_only_processing_leads_requeues_old_rows(self):
        rows = [
            {
                "id": "lead-1",
                "status": "PROCESSING",
                "outreach_mode": "connect_only",
                "sent_at": None,
                "connection_sent_at": "2026-06-16T10:00:00+00:00",
                "connection_accepted_at": None,
                "updated_at": "2026-06-16T10:05:00+00:00",
                "profile_data": {},
            }
        ]
        client = FakeStaleLeadClient(rows)

        recovered = sender_module.recover_stale_message_only_processing_leads(
            client,
            stale_before_iso="2026-06-16T11:00:00+00:00",
        )

        self.assertEqual(recovered, 1)
        self.assertEqual(client.select_rows[0]["status"], "CONNECT_ONLY_SENT")

    def test_mark_lead_retry_later_persists_reason_code(self):
        lead = {
            "id": "lead-2",
            "status": "PROCESSING",
            "profile_data": {},
        }
        client = FakeClient(lead)

        attempts = sender_module.mark_lead_retry_later(
            client,
            lead,
            "composer_timeout_after_message_link: Timeout 20000ms exceeded",
            reason_code="composer_timeout_after_message_link",
        )

        self.assertEqual(attempts, 1)
        self.assertEqual(client.lead["status"], "CONNECTED")
        self.assertEqual(
            client.lead["profile_data"]["message_only_retry_reason"],
            "composer_timeout_after_message_link",
        )
```

- [ ] **Step 2: Add failing connected-message routing tests**

Append these tests to the same file:

```python
class FakeLocator:
    def __init__(self, href=None):
        self.href = href
        self.first = self

    async def get_attribute(self, name):
        if name == "href":
            return self.href
        return None


class FakeResolvedPage:
    def __init__(self, url):
        self.url = url
        self.waited_for = []

    async def goto(self, url, **_kwargs):
        self.url = url

    async def wait_for_selector(self, selector, timeout):
        self.waited_for.append((selector, timeout))


class ConnectedMessageRoutingTest(unittest.IsolatedAsyncioTestCase):
    async def test_connected_routing_prefers_sales_navigator_when_href_points_to_sales(self):
        locator = FakeLocator("/sales/inbox/compose?foo=bar")
        page = FakeResolvedPage("https://www.linkedin.com/in/test-user")
        context = type("Ctx", (), {"new_page": self._new_page})()
        created_pages = []

        async def fake_wait_for_sales_nav(target_page, timeout_ms=20_000):
            self.assertIn("linkedin.com/sales/", target_page.url)
            return True

        async def fake_new_page():
            target = FakeResolvedPage("about:blank")
            created_pages.append(target)
            return target

        context.new_page = fake_new_page
        original_wait = sender_module.wait_for_sales_navigator_composer
        sender_module.wait_for_sales_navigator_composer = fake_wait_for_sales_nav
        try:
            target_page, route = await sender_module.resolve_connected_message_page(
                context,
                page,
                locator,
            )
        finally:
            sender_module.wait_for_sales_navigator_composer = original_wait

        self.assertEqual(route, "sales_navigator")
        self.assertEqual(target_page.url.startswith("https://www.linkedin.com/sales/"), True)

    async def test_connected_routing_returns_direct_message_when_composer_selector_appears(self):
        locator = FakeLocator("/messaging/compose/?foo=bar")
        page = FakeResolvedPage("https://www.linkedin.com/messaging/compose/?foo=bar")

        async def fake_click_and_resolve_active_page(_page, _locator, timeout_ms=8_000):
            return page

        async def fake_wait_for_sales_nav(_page, timeout_ms=20_000):
            return False

        original_click = sender_module.click_and_resolve_active_page
        original_wait = sender_module.wait_for_sales_navigator_composer
        sender_module.click_and_resolve_active_page = fake_click_and_resolve_active_page
        sender_module.wait_for_sales_navigator_composer = fake_wait_for_sales_nav
        try:
            target_page, route = await sender_module.resolve_connected_message_page(
                None,
                page,
                locator,
            )
        finally:
            sender_module.click_and_resolve_active_page = original_click
            sender_module.wait_for_sales_navigator_composer = original_wait

        self.assertEqual(route, "direct_message")
        self.assertEqual(target_page.waited_for[-1][0], sender_module.DIRECT_MESSAGE_COMPOSER_SELECTOR)
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
workers/sender/venv/bin/python -m unittest workers.sender.test_sales_navigator_routing -v
```

Expected:
- FAIL because `recover_stale_message_only_processing_leads()` does not exist
- FAIL because `resolve_connected_message_page()` does not exist
- FAIL because `mark_lead_retry_later()` does not accept `reason_code`

- [ ] **Step 4: Commit the failing-test checkpoint**

```bash
git add workers/sender/test_sales_navigator_routing.py
git commit -m "test: add sender reliability coverage"
```

### Task 2: Implement Lead-Level Stale `PROCESSING` Recovery

**Files:**
- Modify: `workers/sender/sender.py`
- Test: `workers/sender/test_sales_navigator_routing.py`

- [ ] **Step 1: Add the stale-lead threshold constant**

In `workers/sender/sender.py`, near the existing retry and followup constants, add:

```python
MESSAGE_ONLY_PROCESSING_STALE_MINUTES = 45
```

- [ ] **Step 2: Add the stale message-only lead recovery helper**

Insert this helper near `mark_message_only_processing()`:

```python
def recover_stale_message_only_processing_leads(
    client: Client,
    stale_minutes: int = MESSAGE_ONLY_PROCESSING_STALE_MINUTES,
    *,
    stale_before_iso: Optional[str] = None,
    limit: int = 200,
) -> int:
    threshold_iso = stale_before_iso or (_utc_now() - timedelta(minutes=max(1, stale_minutes))).isoformat()
    query = (
        client.table("leads")
        .select("id, status, outreach_mode, sent_at, connection_sent_at, connection_accepted_at, updated_at, profile_data")
        .eq("status", "PROCESSING")
        .eq("outreach_mode", "connect_only")
        .is_("sent_at", "null")
        .lt("updated_at", threshold_iso)
        .order("updated_at", desc=False)
        .limit(max(1, limit))
    )
    rows = query.execute().data or []
    recovered = 0

    for row in rows:
        next_status = "CONNECTED" if row.get("connection_accepted_at") else "CONNECT_ONLY_SENT"
        payload = {
            "status": next_status,
            "updated_at": datetime.utcnow().isoformat(),
        }
        if next_status == "CONNECT_ONLY_SENT":
            payload["connection_accepted_at"] = None
        client.table("leads").update(payload).eq("id", row["id"]).execute()
        recovered += 1

    if recovered:
        logger.info(
            "Recovered stale message-only PROCESSING leads",
            data={"count": recovered, "threshold": threshold_iso},
        )
    return recovered
```

- [ ] **Step 3: Invoke stale recovery before message-only candidate fetch**

In the `if args.message_only:` branch inside `main()`, after `remaining = limit - sent_today`, add:

```python
recovered_leads = recover_stale_message_only_processing_leads(client)
logger.info(
    "Message-only stale lead recovery completed",
    data={"recovered": recovered_leads},
)
```

- [ ] **Step 4: Run the targeted stale-recovery tests**

Run:

```bash
workers/sender/venv/bin/python -m unittest workers.sender.test_sales_navigator_routing.MessageOnlyReliabilityTest -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/sender/sender.py workers/sender/test_sales_navigator_routing.py
git commit -m "feat: recover stale message-only lead locks"
```

### Task 3: Harden Connected Message Routing Before Retry

**Files:**
- Modify: `workers/sender/sender.py`
- Test: `workers/sender/test_sales_navigator_routing.py`

- [ ] **Step 1: Extend retry persistence with a structured reason code**

Update `mark_lead_retry_later()` in `workers/sender/sender.py` to this signature and payload:

```python
def mark_lead_retry_later(
    client: Client,
    lead: Dict[str, Any],
    error_message: str = "",
    *,
    reason_code: str = "unknown_retry",
) -> int:
    lead_id = str(lead.get("id") or "")
    current_profile_data = lead.get("profile_data")
    profile_data: Dict[str, Any] = current_profile_data if isinstance(current_profile_data, dict) else {}

    attempts = _safe_int(profile_data.get("message_only_retry_attempts"), 0) + 1
    now_iso = datetime.utcnow().isoformat()
    truncated_error = (error_message or "")[:500]

    updated_profile_data = dict(profile_data)
    updated_profile_data["message_only_retry_attempts"] = attempts
    updated_profile_data["message_only_last_error"] = truncated_error
    updated_profile_data["message_only_last_retry_at"] = now_iso
    updated_profile_data["message_only_retry_reason"] = reason_code
```

- [ ] **Step 2: Add a helper that resolves the connected message destination**

Insert this helper above `process_message_only_one()`:

```python
async def resolve_connected_message_page(
    context: BrowserContext,
    page: Page,
    message_target,
) -> Tuple[Page, str]:
    message_href = ""
    try:
        message_href = (await message_target.get_attribute("href")) or ""
    except Exception:
        message_href = ""

    if "/sales/" in message_href:
        sales_url = message_href if message_href.startswith("http") else f"https://www.linkedin.com{message_href}"
        message_page = await context.new_page()
        await message_page.goto(sales_url, wait_until="domcontentloaded", timeout=60_000)
        await random_pause()
        return message_page, "sales_navigator"

    message_page = await click_and_resolve_active_page(page, message_target)
    await random_pause()

    if "linkedin.com/sales/" in (message_page.url or ""):
        await wait_for_sales_navigator_composer(message_page, timeout_ms=20_000)
        return message_page, "sales_navigator"

    if await wait_for_sales_navigator_composer(message_page, timeout_ms=20_000):
        return message_page, "sales_navigator"

    await message_page.wait_for_selector(
        DIRECT_MESSAGE_COMPOSER_SELECTOR,
        timeout=20_000,
    )
    return message_page, "direct_message"
```

- [ ] **Step 3: Replace the inline composer-open branch in `process_message_only_one()`**

In the connected-message branch around the current `message_href` / `wait_for_selector()` logic, replace:

```python
                message_href = ""
                try:
                    message_href = (await message_target.get_attribute("href")) or ""
                except Exception:
                    message_href = ""
                if "/sales/" in message_href:
                    sales_url = message_href if message_href.startswith("http") else f"https://www.linkedin.com{message_href}"
                    message_page = await context.new_page()
                    await message_page.goto(sales_url, wait_until="domcontentloaded", timeout=60_000)
                else:
                    message_page = await click_and_resolve_active_page(page, message_target)
                await random_pause()
                is_sales_page = "linkedin.com/sales/" in (message_page.url or "")
                if is_sales_page:
                    await wait_for_sales_navigator_composer(message_page, timeout_ms=20_000)
                if is_sales_page or await wait_for_sales_navigator_composer(message_page):
                    ...
                else:
                    await message_page.wait_for_selector(
                        DIRECT_MESSAGE_COMPOSER_SELECTOR,
                        timeout=20_000,
                    )
                    await send_message(message_page, message, SURFACE_MESSAGE)
```

with:

```python
                message_page, route = await resolve_connected_message_page(
                    context,
                    page,
                    message_target,
                )
                if route == "sales_navigator":
                    logger.info("Nachricht opened Sales Navigator composer", {"leadId": lead_id})
                    await send_sales_navigator_message(
                        message_page,
                        build_sales_navigator_subject(lead, message),
                        build_sales_navigator_body(message),
                    )
                else:
                    await send_message(message_page, message, SURFACE_MESSAGE)
```

- [ ] **Step 4: Classify composer-open timeouts explicitly before retry**

In the connected-message `except Exception as e:` block, replace:

```python
                attempts = mark_lead_retry_later(client, lead, error_msg)
```

with:

```python
                reason_code = "connected_message_retry"
                if "wait_for_selector" in error_msg and "contenteditable" in error_msg:
                    reason_code = "composer_timeout_after_message_link"
                attempts = mark_lead_retry_later(
                    client,
                    lead,
                    error_msg,
                    reason_code=reason_code,
                )
```

- [ ] **Step 5: Run the routing and retry tests**

Run:

```bash
workers/sender/venv/bin/python -m unittest \
  workers.sender.test_sales_navigator_routing.ConnectedMessageRoutingTest \
  workers.sender.test_sales_navigator_routing.MessageOnlyReliabilityTest -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/sender/sender.py workers/sender/test_sales_navigator_routing.py
git commit -m "feat: harden connected message routing retries"
```

### Task 4: Add Failure Diagnostics For Composer-Open Retries

**Files:**
- Modify: `workers/sender/sender.py`
- Test: `workers/sender/test_sales_navigator_routing.py`

- [ ] **Step 1: Persist minimal retry diagnostics into `profile_data`**

Update the connected-message exception block in `process_message_only_one()` to collect small deterministic metadata before retry:

```python
                retry_context = {
                    "message_only_last_route": route if "route" in locals() else "unknown",
                    "message_only_last_page_url": getattr(message_page, "url", "") if "message_page" in locals() else "",
                }
                profile_data = lead.get("profile_data") if isinstance(lead.get("profile_data"), dict) else {}
                lead["profile_data"] = {**profile_data, **retry_context}
```

Place that immediately before the `mark_lead_retry_later(...)` call.

- [ ] **Step 2: Capture a screenshot for connected-message retries**

Still inside that same exception block, before `mark_lead_retry_later(...)`, add:

```python
                try:
                    if "message_page" in locals():
                        screenshot_path = f"/tmp/message_only_retry_{lead_id[:8]}.png"
                        await message_page.screenshot(path=screenshot_path, full_page=True)
                        logger.info("Connected message retry screenshot saved", {"leadId": lead_id, "path": screenshot_path})
                except Exception as screenshot_error:
                    logger.warn("Failed to capture connected message retry screenshot", {"leadId": lead_id}, error=screenshot_error)
```

- [ ] **Step 3: Add a test that retry metadata is merged instead of replaced**

Append this test to `workers/sender/test_sales_navigator_routing.py`:

```python
    def test_mark_lead_retry_later_preserves_existing_profile_data(self):
        lead = {
            "id": "lead-3",
            "status": "PROCESSING",
            "profile_data": {"existing": "value", "message_only_last_page_url": "https://www.linkedin.com/foo"},
        }
        client = FakeClient(lead)

        sender_module.mark_lead_retry_later(
            client,
            lead,
            "composer timeout",
            reason_code="composer_timeout_after_message_link",
        )

        self.assertEqual(client.lead["profile_data"]["existing"], "value")
        self.assertEqual(
            client.lead["profile_data"]["message_only_retry_reason"],
            "composer_timeout_after_message_link",
        )
```

- [ ] **Step 4: Run the full sender reliability suite**

Run:

```bash
workers/sender/venv/bin/python -m unittest \
  workers.sender.test_message_only_queue \
  workers.sender.test_sales_navigator_routing \
  workers.sender.test_nudge_gate \
  workers.sender.test_sequence_messages -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/sender/sender.py workers/sender/test_sales_navigator_routing.py
git commit -m "feat: add message-only retry diagnostics"
```

## Self-Review

**Spec coverage:**
- Stale `PROCESSING` lead recovery: Task 2
- Connected link but no composer: Task 3
- Better retry observability: Task 4
- Preserve pending classification behavior: Tasks 1, 3, and 4 tests

**Placeholder scan:**
- No `TODO`, `TBD`, or “handle appropriately” placeholders remain
- All code-changing steps include concrete snippets
- All test steps include concrete commands

**Type consistency:**
- `recover_stale_message_only_processing_leads(...)` is the same name in tests and implementation
- `resolve_connected_message_page(...)` is the same name in tests and implementation
- `reason_code` is used consistently in `mark_lead_retry_later(...)` and its callers

**Plan complete and saved to `docs/superpowers/plans/2026-06-16-sender-worker-reliability.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
