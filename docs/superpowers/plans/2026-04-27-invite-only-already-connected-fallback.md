# Invite-Only Already-Connected Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When invite-only processing hits a profile that is already connected, classify it explicitly as `CONNECTED` instead of treating it as a failed invite, so the existing message-only pipeline can pick it up later.

**Architecture:** Keep invite delivery and first-message delivery separate. The invite worker should do one extra read-only probe before it attempts the connection request: if the profile already exposes a clear message surface, write `CONNECTED` and exit cleanly; otherwise keep the current invite-send and failure behavior unchanged. No new worker process, no schema change, and no UI change.

**Tech Stack:** Python 3.9 + Playwright worker code, Supabase client, existing `unittest`/`pytest` test layout. **Deps: 0 new dependencies.**

**Context-Zero**
- Environment: macOS 14.6.1 arm64, Node `v20.19.6`, Python `3.9.6`, npm `10.8.2`
- Repo state at planning time: branch `main`, commit `ae2607a`
- Non-functional constraints: preserve full-page screenshots for true invite failures, keep invite-only behavior deterministic, and do not broaden the change into connect+message or schema work

**Locality envelope**
- Modified file: `workers/sender/sender.py` (~80-110 LOC)
- Modified file: `workers/sender/test_sales_navigator_routing.py` (~50-80 LOC)
- New files: 0
- Dependencies: 0

---

### Task 1: Add a connect-only "already connected" probe and status promotion

**Files:**
- Modify: `workers/sender/sender.py`

- [ ] **Step 1: Write the failing test first**

Add tests to `workers/sender/test_sales_navigator_routing.py` that pin the new behavior:

```python
def test_classify_connect_only_surface_prefers_message_surface(self):
    self.assertEqual(
        classify_connect_only_surface(
            message_button_count=1,
            message_link_count=0,
            invite_link_count=0,
            connect_button_count=0,
            more_button_count=0,
        ),
        "already_connected",
    )

def test_classify_connect_only_surface_keeps_invite_flow_when_message_surface_is_absent(self):
    self.assertEqual(
        classify_connect_only_surface(
            message_button_count=0,
            message_link_count=0,
            invite_link_count=1,
            connect_button_count=0,
            more_button_count=0,
        ),
        "invite_available",
    )

def test_promote_connect_only_to_connected_updates_lead_status(self):
    lead = {"id": "lead-1", "status": "NEW"}
    client = FakeClient(lead)

    result = promote_connect_only_to_connected(client, lead)

    self.assertEqual(result, "connected")
    self.assertEqual(client.lead["status"], "CONNECTED")
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run:

```bash
python -m pytest workers/sender/test_sales_navigator_routing.py -v
```

Expected: fail because `classify_connect_only_surface` and `promote_connect_only_to_connected` do not exist yet.

- [ ] **Step 3: Implement the smallest worker-side change**

Add two small helpers in `workers/sender/sender.py` and use them inside `process_invite_one()`:

```python
def classify_connect_only_surface(
    *,
    message_button_count: int,
    message_link_count: int,
    invite_link_count: int,
    connect_button_count: int,
    more_button_count: int,
) -> str:
    if message_button_count > 0 or message_link_count > 0:
        return "already_connected"
    if invite_link_count > 0 or connect_button_count > 0 or more_button_count > 0:
        return "invite_available"
    return "surface_exhausted"


def promote_connect_only_to_connected(client: Client, lead: Dict[str, Any]) -> str:
    lead_id = str(lead.get("id") or "")
    client.table("leads").update({
        "status": "CONNECTED",
        "error_message": None,
        "updated_at": datetime.utcnow().isoformat(),
    }).eq("id", lead_id).execute()
    return "connected"
```

Then, in `process_invite_one()`, apply the probe only for `outreach_mode == "connect_only"`:

```python
if outreach_mode == "connect_only":
    surface = classify_connect_only_surface(...)
    if surface == "already_connected":
        promote_connect_only_to_connected(client, lead)
        logger.info("Lead is already connected; deferring first message to message-only worker", {"leadId": lead_id})
        return "connected"
```

Keep the current invite-send path and the current screenshot/`FAILED` handling untouched for real invite failures.

- [ ] **Step 4: Run the targeted test again**

Run:

```bash
python -m pytest workers/sender/test_sales_navigator_routing.py -v
```

Expected: PASS, with the existing invite-limit and message-only tests still green.

- [ ] **Step 5: Commit**

```bash
git add workers/sender/sender.py workers/sender/test_sales_navigator_routing.py
git commit -m "fix(sender): mark already-connected invite-only leads"
```

### Task 2: Verify the invite failure path still fails closed

**Files:**
- Modify: `workers/sender/test_sales_navigator_routing.py`

- [ ] **Step 1: Add one regression test for a true invite failure**

```python
def test_connect_only_surface_classifier_returns_surface_exhausted_when_no_actions_exist(self):
    self.assertEqual(
        classify_connect_only_surface(
            message_button_count=0,
            message_link_count=0,
            invite_link_count=0,
            connect_button_count=0,
            more_button_count=0,
        ),
        "surface_exhausted",
    )
```

- [ ] **Step 2: Run the same pytest file**

Run:

```bash
python -m pytest workers/sender/test_sales_navigator_routing.py -v
```

Expected: PASS, and the invite-only path still routes true no-button cases to the existing failure flow instead of auto-sending a message.

- [ ] **Step 3: Stop there**

No database migration, no web action changes, and no new worker mode are needed for this addition because `CONNECTED` is already part of the existing message-only eligibility set.
