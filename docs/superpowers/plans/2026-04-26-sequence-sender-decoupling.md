# Sequence Sender Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sender.py` the sole worker that handles connection-invite delivery for sequence-driven leads (`batch_intent IN ('connect_message','connect_only')`), reading the connect note from `outreach_sequences.connect_note` rendered against CSV tokens. Decouple enrichment from sending entirely for these modes; the scraper no longer touches sequence-driven leads.

**Architecture:** A new `sender.py --send-invites` mode polls eligible NEW leads, renders the sequence's connect_note (CSV-only tokens), and drives the LinkedIn invite UI to send the connect (with note for `connect_message`, blank for `connect_only`). On success, status flips to `CONNECT_ONLY_SENT` and `connection_sent_at` is set — the same terminal state the scraper produced before. The two `/api/enrich/*` routes spawn `sender.py --send-invites` instead of `scraper.py --run`. The scraper's `--mode connect_only` lead-processing branch is deleted.

**Tech Stack:** Next.js 14 app router (TS), Python 3 + Playwright workers, Supabase Postgres. Zero new dependencies.

**Locality envelope (per AGENTS.md §0):**
- New files: `apps/web/lib/sequenceConnectNote.ts` (~40 LOC), `apps/web/lib/sequenceRender.ts` (~70 LOC), `apps/web/lib/sequenceConnectNote.test.ts` (~50 LOC), `apps/web/lib/sequenceRender.test.ts` (~80 LOC), `workers/sender/sequence_render.py` (~70 LOC), `workers/sender/test_sequence_render.py` (~90 LOC).
- Modified files: `apps/web/components/SequenceEditor.tsx` (+~10 LOC), `workers/sender/sender.py` (+~200 LOC), `apps/web/app/api/enrich/route.ts` (~±15 LOC), `apps/web/app/api/enrich/connect-only/route.ts` (~±15 LOC), `workers/scraper/scraper.py` (−~180 LOC).
- All files <1000 LOC each. **0 new deps.**

**AGENTS.md §2 rules to preserve through this refactor:**
- Connect-only invite failure capture: on `all_paths EXHAUSTED` / send-button `NOT_FOUND`/`CLICK_FAILED`, capture full-page screenshot with absolute path logged.
- Weekly invite-limit popup is a hard stop: capture message, mark lead `FAILED` with limit-reached reason, abort the run.
- Connect-only worker failures must persist `FAILED` (never leave `PROCESSING`).
- Production browser workers force headless when `DISPLAY`/`WAYLAND_DISPLAY` absent.
- Single active worker per `enrichment.pid`; `/api/enrich*` returns 409 on double-spawn.
- Live worker spawns mirror stdout/stderr to container logs *and* `.logs/`.
- Sequence placeholders are `{{first_name}}, {{last_name}}, {{full_name}}, {{company_name}}` only (across `{{...}}`, `{...}`, `[...]` token classes); sender runtime keeps legacy aliases (`{{VORNAME}}`, `{{NACHNAME}}`) for already-stored rows.
- Direct-message sanitization never applies 300-char invite-note truncation. Conversely, invite-note rendering MUST cap at 300 chars.

---

## File Structure

### New files

- `apps/web/lib/sequenceConnectNote.ts` — pure 300-char validator returning `{ ok: true } | { ok: false, error: string }`. Shared by `SequenceEditor` save handler and the server `saveOutreachSequence` action.
- `apps/web/lib/sequenceRender.ts` — pure render: takes a template string + a `{ first_name?, last_name?, full_name?, company_name? }` lead object, returns the rendered string. Honors all three token classes (`{{...}}`, `{...}`, `[...]`).
- `apps/web/lib/sequenceConnectNote.test.ts` — unit tests using `node:test`.
- `apps/web/lib/sequenceRender.test.ts` — unit tests using `node:test`.
- `workers/sender/sequence_render.py` — Python mirror of `sequenceRender.ts`. Single function `render(template: str, lead: dict) -> str`. Same token class coverage as the TS side, plus the legacy `{{VORNAME}}/{{NACHNAME}}` aliases (per AGENTS.md §2 sender-runtime rule).
- `workers/sender/test_sequence_render.py` — pytest, mirrors the TS test cases plus the legacy-alias case.

### Modified files

- `apps/web/components/SequenceEditor.tsx` — import `validateConnectNote` from `sequenceConnectNote.ts`; surface validation error in the existing 300-char counter UI; block save on `!ok`.
- `workers/sender/sender.py` — add `--send-invites` mode. Adds: `fetch_invite_queue()`, `process_invite_one()`, dispatch in `main()`. Reuses or imports the LinkedIn invite-click logic currently in `workers/scraper/scraper.py`. The migration path is: import-then-extract (Task 7), keep scraper code intact during Task 5/6 verification, delete scraper code in Task 9.
- `apps/web/app/api/enrich/route.ts` — change spawn target from `scraper.py --run --mode <mode>` to `sender.py --send-invites`. Keep all existing logging, child-tracking, and `assertScraperLockFree`/`persistScraperPid` semantics (rename later if needed; out of scope).
- `apps/web/app/api/enrich/connect-only/route.ts` — same swap. Both routes serve sequence-driven batches identically going forward.
- `workers/scraper/scraper.py` — delete the `--mode connect_only` lead-processing branch (the parts of `parse_args` `--mode` handling, the `connect_only` branch in the main loop, and the `enriched + NEW unsent` priority query block at lines ~220-260). Keep `--inbox`, `--login-only`, `--sync-remote-session`, `--reset-remote-session`, and `--mode enrich` (Plan B re-scopes that). Per AGENTS.md §2 the `connect_only` scraper mode "must skip enrich_one() entirely and go straight to send_connection_request()" — that whole branch goes away.

### Dead code scheduled for removal in this plan

- `workers/scraper/scraper.py`: `--mode connect_only` lead-processing branch and any helpers used only by it. Identify these only after Task 5/6 are green so we don't strand the new sender mode on unmoved logic.

---

## Conventions

- Placeholder syntax uses double-curly `{{token}}` with single-curly `{token}` and bracket `[token]` accepted as alternates (matches existing app-side accept-list per AGENTS.md §2). Canonical tokens: `{{first_name}}, {{last_name}}, {{full_name}}, {{company_name}}`.
- Tests use `node:test` (TS) and `pytest` (Python) — the patterns already in `apps/web/lib/workerControl.test.ts` and `workers/sender/test_sender.py`. **Do not introduce vitest/jest/playwright-test.**
- TS test invocation: `node --experimental-strip-types --test apps/web/lib/<file>.test.ts` from the repo root or `apps/web/`. If the existing test command differs, match it.
- Python test invocation: `pytest workers/sender/test_<file>.py -v`.
- Each task ends in a green test (or a smoke verification when no unit test applies) and a single-purpose commit.

---

## Task 1: Connect-note validator (TS)

**Files:**
- Create: `apps/web/lib/sequenceConnectNote.ts`
- Create: `apps/web/lib/sequenceConnectNote.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/sequenceConnectNote.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```
node --experimental-strip-types --test apps/web/lib/sequenceConnectNote.test.ts
```
Expected: FAIL with module-not-found for `./sequenceConnectNote`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/lib/sequenceConnectNote.ts`:

```ts
export const CONNECT_NOTE_MAX = 300;

const CANONICAL_TOKENS = new Set([
  "first_name",
  "last_name",
  "full_name",
  "company_name",
]);

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}|\[\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\]/g;

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateConnectNote(text: string): ValidationResult {
  if (text.length > CONNECT_NOTE_MAX) {
    return { ok: false, error: `Connect note exceeds ${CONNECT_NOTE_MAX} chars (got ${text.length}).` };
  }
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (!name) continue;
    if (!CANONICAL_TOKENS.has(name)) {
      return { ok: false, error: `Unknown token "${name}". Allowed: first_name, last_name, full_name, company_name.` };
    }
    seen.add(name);
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
node --experimental-strip-types --test apps/web/lib/sequenceConnectNote.test.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```
git add apps/web/lib/sequenceConnectNote.ts apps/web/lib/sequenceConnectNote.test.ts
git commit -m "feat(sequences): add connect-note 300-char + canonical-token validator"
```

---

## Task 2: Render helper (TS)

**Files:**
- Create: `apps/web/lib/sequenceRender.ts`
- Create: `apps/web/lib/sequenceRender.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/sequenceRender.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { renderSequence } from "./sequenceRender";

const lead = {
  first_name: "Sven",
  last_name: "Müller",
  company_name: "Acme GmbH",
};

test("substitutes double-curly tokens", () => {
  assert.equal(
    renderSequence("Hi {{first_name}} at {{company_name}}", lead),
    "Hi Sven at Acme GmbH",
  );
});

test("substitutes single-curly tokens", () => {
  assert.equal(renderSequence("Hi {first_name}", lead), "Hi Sven");
});

test("substitutes bracket tokens", () => {
  assert.equal(renderSequence("Hi [first_name]", lead), "Hi Sven");
});

test("derives full_name from first + last when not provided", () => {
  assert.equal(renderSequence("{{full_name}}", lead), "Sven Müller");
});

test("missing fields render as empty string", () => {
  assert.equal(renderSequence("Hi {{first_name}}", { last_name: "X" }), "Hi ");
});

test("preserves text around tokens verbatim", () => {
  assert.equal(
    renderSequence("Greetings, {{first_name}}!  See you.", lead),
    "Greetings, Sven!  See you.",
  );
});

test("leaves unknown tokens untouched (validator's job to reject)", () => {
  assert.equal(renderSequence("Hi {{recent_post}}", lead), "Hi {{recent_post}}");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --experimental-strip-types --test apps/web/lib/sequenceRender.test.ts
```
Expected: FAIL with module-not-found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/lib/sequenceRender.ts`:

```ts
type LeadFields = {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  company_name?: string | null;
};

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}|\[\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\]/g;

const CANONICAL = new Set(["first_name", "last_name", "full_name", "company_name"]);

function resolve(name: string, lead: LeadFields): string | null {
  if (!CANONICAL.has(name)) return null;
  if (name === "full_name") {
    const explicit = (lead.full_name ?? "").trim();
    if (explicit) return explicit;
    const first = (lead.first_name ?? "").trim();
    const last = (lead.last_name ?? "").trim();
    return [first, last].filter(Boolean).join(" ");
  }
  const value = (lead as Record<string, string | null | undefined>)[name];
  return (value ?? "").toString();
}

export function renderSequence(template: string, lead: LeadFields): string {
  return template.replace(TOKEN_RE, (match, dbl, sgl, brk) => {
    const name = dbl ?? sgl ?? brk;
    const resolved = resolve(name, lead);
    return resolved === null ? match : resolved;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```
node --experimental-strip-types --test apps/web/lib/sequenceRender.test.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```
git add apps/web/lib/sequenceRender.ts apps/web/lib/sequenceRender.test.ts
git commit -m "feat(sequences): add pure TS sequence-render helper"
```

---

## Task 3: Wire validator into SequenceEditor

**Files:**
- Modify: `apps/web/components/SequenceEditor.tsx`

- [ ] **Step 1: Read the current `connect_note` field handling**

Read `apps/web/components/SequenceEditor.tsx`. Locate:
1. The form-state setter for `connect_note`.
2. The submit handler that calls `saveOutreachSequence`.
3. The existing 300-char counter UI for `connect_note` (introduced by migration 011).

- [ ] **Step 2: Import the validator**

At the top of the file, add:

```tsx
import { validateConnectNote, CONNECT_NOTE_MAX } from "../lib/sequenceConnectNote";
```

- [ ] **Step 3: Block save on validation failure**

In the submit handler, before the `saveOutreachSequence` call, add:

```tsx
const connectNoteCheck = validateConnectNote(form.connect_note ?? "");
if (!connectNoteCheck.ok) {
  setError(connectNoteCheck.error);
  return;
}
```

(`setError` and the `error` state already exist in the component; reuse them. If the local state is named differently, match the existing pattern — do not introduce a new error state.)

- [ ] **Step 4: Surface live counter using the exported constant**

Replace any hard-coded `300` in the JSX counter with `CONNECT_NOTE_MAX` so the source of truth lives in one file.

- [ ] **Step 5: Verify the dev build still type-checks**

```
cd apps/web && npx tsc --noEmit
```
Expected: PASS (no new errors).

- [ ] **Step 6: Smoke-verify in the dev UI**

Run `./run_all.sh --web` and open the sequence editor. Paste 301 chars into connect_note → save should be blocked with the validator's error. Paste a known-bad token like `{{foo}}` → save blocked with the unknown-token error.

- [ ] **Step 7: Commit**

```
git add apps/web/components/SequenceEditor.tsx
git commit -m "feat(sequences): block save on invalid connect_note via shared validator"
```

---

## Task 4: Render helper (Python)

**Files:**
- Create: `workers/sender/sequence_render.py`
- Create: `workers/sender/test_sequence_render.py`

- [ ] **Step 1: Write the failing test**

Create `workers/sender/test_sequence_render.py`:

```python
import pytest

from sequence_render import render


LEAD = {
    "first_name": "Sven",
    "last_name": "Müller",
    "company_name": "Acme GmbH",
}


def test_double_curly():
    assert render("Hi {{first_name}}", LEAD) == "Hi Sven"


def test_single_curly():
    assert render("Hi {first_name}", LEAD) == "Hi Sven"


def test_bracket():
    assert render("Hi [first_name]", LEAD) == "Hi Sven"


def test_full_name_derived():
    assert render("{{full_name}}", LEAD) == "Sven Müller"


def test_missing_field_renders_empty():
    assert render("Hi {{first_name}}", {"last_name": "X"}) == "Hi "


def test_unknown_token_left_untouched():
    assert render("Hi {{recent_post}}", LEAD) == "Hi {{recent_post}}"


def test_legacy_aliases_VORNAME_NACHNAME():
    # Sender runtime must keep these aliases for already-stored rows (AGENTS.md §2).
    assert render("Hallo {{VORNAME}} {{NACHNAME}}", LEAD) == "Hallo Sven Müller"


def test_company_name():
    assert render("at {{company_name}}", LEAD) == "at Acme GmbH"
```

- [ ] **Step 2: Run test to verify it fails**

```
cd workers/sender && pytest test_sequence_render.py -v
```
Expected: FAIL with `ModuleNotFoundError: No module named 'sequence_render'`.

- [ ] **Step 3: Write minimal implementation**

Create `workers/sender/sequence_render.py`:

```python
"""Pure render helper used by sender for sequence-driven outreach.

Token classes accepted: {{name}}, {name}, [name].
Canonical names: first_name, last_name, full_name, company_name.
Legacy sender-runtime aliases: VORNAME -> first_name, NACHNAME -> last_name.
"""
from __future__ import annotations

import re
from typing import Any, Dict

_TOKEN_RE = re.compile(
    r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}"
    r"|\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}"
    r"|\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]"
)

_CANONICAL = {"first_name", "last_name", "full_name", "company_name"}
_ALIASES = {"VORNAME": "first_name", "NACHNAME": "last_name"}


def _resolve(name: str, lead: Dict[str, Any]) -> str | None:
    canonical = _ALIASES.get(name, name)
    if canonical not in _CANONICAL:
        return None
    if canonical == "full_name":
        explicit = (lead.get("full_name") or "").strip()
        if explicit:
            return explicit
        first = (lead.get("first_name") or "").strip()
        last = (lead.get("last_name") or "").strip()
        return " ".join(p for p in (first, last) if p)
    return str(lead.get(canonical) or "")


def render(template: str, lead: Dict[str, Any]) -> str:
    def _sub(match: re.Match) -> str:
        name = match.group(1) or match.group(2) or match.group(3)
        resolved = _resolve(name, lead)
        return match.group(0) if resolved is None else resolved
    return _TOKEN_RE.sub(_sub, template)
```

- [ ] **Step 4: Run test to verify it passes**

```
cd workers/sender && pytest test_sequence_render.py -v
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```
git add workers/sender/sequence_render.py workers/sender/test_sequence_render.py
git commit -m "feat(sender): add pure Python sequence-render helper"
```

---

## Task 5: Sender `--send-invites` mode — queue selection

This task adds the queue-fetch + dispatch shell. The actual LinkedIn invite-click logic is wired in Task 6/7. For now, the new mode logs each lead it would send and returns without touching the browser, so we can verify the queue selection in isolation.

**Files:**
- Modify: `workers/sender/sender.py`

- [ ] **Step 1: Add `--send-invites` flag to `parse_args`**

In `workers/sender/sender.py`'s `main()` arg parser, add (immediately after the existing `--message-only` line):

```python
parser.add_argument(
    "--send-invites",
    action="store_true",
    help="Process NEW sequence-driven leads (connect_message/connect_only) and send LinkedIn connection invites.",
)
```

- [ ] **Step 2: Add a `fetch_invite_queue` helper near the other fetch helpers**

Place this with the other queue-fetch helpers (search for `fetch_message_only_leads` and put it adjacent):

```python
def fetch_invite_queue(client: Client, limit: int, batch_id: Optional[int] = None) -> list[Dict[str, Any]]:
    """Fetch NEW sequence-driven leads eligible for connect-invite send.

    Joins through lead_batches to filter by batch_intent so we never grab
    custom_outreach leads (those go through the draft-review path).
    """
    logger.db_query("select", "leads", {"status": "NEW", "batch_intent": ["connect_message", "connect_only"], "limit": limit})
    query = (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, company_name, sequence_id, outreach_mode, batch_id, lead_batches!inner(batch_intent)")
        .eq("status", "NEW")
        .is_("connection_sent_at", "null")
        .in_("lead_batches.batch_intent", ["connect_message", "connect_only"])
        .limit(limit)
    )
    if batch_id is not None:
        query = query.eq("batch_id", batch_id)
    response = query.execute()
    rows = response.data or []
    logger.db_result("select", "leads", {"limit": limit}, len(rows))
    return rows
```

- [ ] **Step 3: Add the dispatch branch in `main()`**

In `main()`'s if/elif chain (the existing chain handles `args.followup`, `args.message_only`), insert a new branch **before** the existing fall-through to the default `connect_message` flow:

```python
if args.send_invites:
    leads_to_process = fetch_invite_queue(client, remaining, args.batch_id)
    if not leads_to_process:
        logger.info("No NEW sequence-driven leads to invite", {"batchId": args.batch_id})
        return

    logger.info(
        f"send-invites: would process {len(leads_to_process)} leads",
        data={"leadIds": [l.get("id") for l in leads_to_process]},
    )
    # Browser send wired in Task 6/7. For now, return after logging.
    logger.operation_complete(
        "sender-send-invites",
        result={"queued": len(leads_to_process), "sent": 0, "failed": 0, "skipped": len(leads_to_process)},
    )
    return
```

- [ ] **Step 4: Verify by syntax + dry run**

```
python -c "import ast; ast.parse(open('workers/sender/sender.py').read())"
python workers/sender/sender.py --send-invites --batch-id 999999
```
The first must produce no output (parse OK). The second must log "No NEW sequence-driven leads to invite" (or "queued: 0") and exit 0 — it confirms the branch wires up and the join compiles. **Do not run with a real batch_id yet.**

- [ ] **Step 5: Commit**

```
git add workers/sender/sender.py
git commit -m "feat(sender): add --send-invites queue-selection (no browser yet)"
```

---

## Task 6: Sender `--send-invites` mode — wire the LinkedIn invite send

This task connects the new mode to LinkedIn. Per the AGENTS.md §2 rules listed in the plan header, the invite-send must:
- Skip enrichment entirely (no `enrich_one()` call).
- Capture full-page screenshot on `all_paths EXHAUSTED` / `NOT_FOUND` / `CLICK_FAILED`.
- Treat the weekly invite-limit popup as a hard stop (mark FAILED with reason, abort).
- Persist `FAILED` (never leave `PROCESSING`).
- Force headless on Linux when `DISPLAY`/`WAYLAND_DISPLAY` absent.

**Files:**
- Modify: `workers/sender/sender.py`

- [ ] **Step 1: Identify the existing scraper invite functions to call**

Read `workers/scraper/scraper.py` and locate (search for `send_connection_request`, `send_invite`, `_send_connect`, the selectors for `Mehr`/`More`, `Ohne Notiz senden`/`Send without note`, and the weekly-limit detection). Note the function name(s) and their signatures. The cleanest reuse is:
- `send_connection_request(page, lead, *, note_text: str | None) -> Result` — or whatever the existing entrypoint is.

Do not refactor scraper.py yet. We are only **calling** its functions from sender.py for this task.

- [ ] **Step 2: Import the scraper helpers**

At the top of `workers/sender/sender.py`, add (with the other path-based imports):

```python
sys.path.insert(0, str(Path(__file__).parent.parent / "scraper"))
from scraper import send_connection_request  # noqa: E402  -- adjust name to match Step 1 finding
```

If the scraper exposes a different surface, import what's needed. **Stop and report** if the scraper's invite logic is not callable as a function (i.e., is inlined into the main loop). In that case, complete Task 7 (extraction) before this task.

- [ ] **Step 3: Add `process_invite_one`**

Place it next to `process_message_only_one` in `sender.py`:

```python
async def process_invite_one(
    context: BrowserContext,
    client: Client,
    lead: Dict[str, Any],
) -> str:
    """Render connect_note from sequence and send the LinkedIn invite.
    Returns one of: 'sent', 'failed', 'limit_reached'.
    """
    from sequence_render import render  # local import keeps top-level cheap

    lead_id = lead.get("id")
    sequence_id = lead.get("sequence_id")
    outreach_mode = lead.get("outreach_mode")  # "message" | "connect_only"

    note_text: str | None = None
    if outreach_mode == "message":
        sequence = (
            client.table("outreach_sequences")
            .select("connect_note")
            .eq("id", sequence_id)
            .single()
            .execute()
        ).data or {}
        template = sequence.get("connect_note") or ""
        rendered = render(template, lead).strip()
        note_text = rendered or None  # empty -> send no-note

    page = await context.new_page()
    try:
        result = await send_connection_request(page, lead, note_text=note_text)  # match real signature
    finally:
        await page.close()

    if result.status == "sent":
        client.table("leads").update({
            "status": "CONNECT_ONLY_SENT",
            "connection_sent_at": "now()",
        }).eq("id", lead_id).execute()
        logger.message_send_complete(lead_id, {"mode": "send-invites"})
        return "sent"

    if result.status == "limit_reached":
        client.table("leads").update({
            "status": "FAILED",
            "error_message": "LinkedIn weekly invite limit reached",
        }).eq("id", lead_id).execute()
        logger.warn("Weekly invite limit reached - aborting run", {"leadId": lead_id})
        return "limit_reached"

    # any other failure -> FAILED, never PROCESSING
    client.table("leads").update({
        "status": "FAILED",
        "error_message": (result.error or "invite_send_failed")[:240],
    }).eq("id", lead_id).execute()
    return "failed"
```

(If the scraper's `send_connection_request` returns a different shape, adapt accordingly. The status names — `sent` / `limit_reached` / other — are the contract this code expects.)

- [ ] **Step 4: Replace the dry-run branch from Task 5 with real send**

Replace the `# Browser send wired in Task 6/7` block in `main()` with:

```python
playwright, browser, context = await open_browser(headless=False)
try:
    logger.info("Browser opened, authenticating...")
    await ensure_linkedin_auth(context, client)

    sent_count = 0
    failed_count = 0
    limit_reached = False

    for lead in leads_to_process:
        try:
            result = await process_invite_one(context, client, lead)
            if result == "sent":
                sent_count += 1
            elif result == "limit_reached":
                limit_reached = True
                break
            else:
                failed_count += 1
        except Exception as exc:
            logger.error("Failed to process invite lead", {"leadId": lead.get("id")}, error=exc)
            failed_count += 1
            try:
                client.table("leads").update({
                    "status": "FAILED",
                    "error_message": f"unexpected: {exc}"[:240],
                }).eq("id", lead.get("id")).execute()
            except Exception:
                pass
        await random_pause(2, 4)

    logger.operation_complete(
        "sender-send-invites",
        result={
            "sent": sent_count,
            "failed": failed_count,
            "limit_reached": limit_reached,
            "total": len(leads_to_process),
        },
    )
finally:
    await shutdown(playwright, browser)
    logger.info("Browser closed")
```

- [ ] **Step 5: Verify by syntax check**

```
python -c "import ast; ast.parse(open('workers/sender/sender.py').read())"
```
Expected: clean parse.

- [ ] **Step 6: Smoke test against a single test lead**

Create one test lead in a non-production batch. Run:
```
python workers/sender/sender.py --send-invites --batch-id <test-batch-id>
```
Watch logs for: `Browser opened`, the rendered note text, `sent: 1`. Verify in DB the lead flipped to `CONNECT_ONLY_SENT` with `connection_sent_at` set.

If the LinkedIn UI throws and the lead lands as `FAILED` with a screenshot path in logs — that's also success (the error path works).

- [ ] **Step 7: Commit**

```
git add workers/sender/sender.py
git commit -m "feat(sender): wire --send-invites to LinkedIn invite send via scraper helpers"
```

---

## Task 7: Extract scraper invite helpers into a shared module

This task moves the LinkedIn invite-click logic out of `scraper.py` so we can delete the scraper's connect_only mode (Task 9) without breaking sender. Skip this task if Task 6 was able to import the helpers cleanly *and* `scraper.py`'s connect_only branch is small enough that deleting it just leaves the still-imported helpers as dead-code-only-used-by-sender (in which case keep them in scraper.py and document that with a comment).

**Files:**
- Create: `workers/linkedin_actions/__init__.py` (empty file)
- Create: `workers/linkedin_actions/invite.py`
- Modify: `workers/scraper/scraper.py` — replace the function body with `from workers.linkedin_actions.invite import send_connection_request` (re-export shim) so the scraper still imports cleanly during Task 9's deletion sweep.
- Modify: `workers/sender/sender.py` — switch the import to `from workers.linkedin_actions.invite import send_connection_request`.

- [ ] **Step 1: Verify reuse footprint before extracting**

Search:
```
grep -rn "send_connection_request\|send_invite\b" workers/ apps/
```
Document the call sites. If the only callers post-Task-6 are sender.py and scraper.py's own connect_only branch (which Task 9 deletes), extraction is justified. If there are more, list them and reconsider — the rule of three applies.

- [ ] **Step 2: Move the function and its private helpers**

Cut `send_connection_request` and any helpers it uniquely depends on (selector lists, modal-handling, weekly-limit detection, screenshot capture) from `workers/scraper/scraper.py` into `workers/linkedin_actions/invite.py`. Preserve the function signatures and behavior exactly. Re-export from `scraper.py` if any other code in scraper still uses them; remove the re-export in Task 9 if not.

- [ ] **Step 3: Update sender.py import**

Change Task 6's import line to:
```python
sys.path.insert(0, str(Path(__file__).parent.parent))
from linkedin_actions.invite import send_connection_request
```

- [ ] **Step 4: Sanity smoke**

Re-run the Task 6 Step 6 smoke test against the test lead. It must behave identically.

- [ ] **Step 5: Commit**

```
git add workers/linkedin_actions/__init__.py workers/linkedin_actions/invite.py workers/scraper/scraper.py workers/sender/sender.py
git commit -m "refactor(workers): extract LinkedIn invite logic into shared module"
```

---

## Task 8: Wire `/api/enrich` and `/api/enrich/connect-only` to sender.py

**Files:**
- Modify: `apps/web/app/api/enrich/route.ts`
- Modify: `apps/web/app/api/enrich/connect-only/route.ts`

- [ ] **Step 1: Update `/api/enrich/route.ts`**

In `apps/web/app/api/enrich/route.ts`, find the `args` array currently set to `["scraper.py", "--run", ...sequenceArg, ...limitArg]` (around line 75) and the `pythonCmd` setup. Replace the spawn target with `sender.py --send-invites` while keeping all logging, child-tracking, and lock semantics:

```ts
const senderDir = path.join(repoRoot, "workers", "sender");
const args = ["sender.py", "--send-invites", ...batchArg];
const logPath = path.join(repoRoot, ".logs", "sender-spawn.log");
const child = spawn(pythonCmd, args, {
  cwd: senderDir,
  // ...rest stays the same
});
```

Where `batchArg` is `[]` if no batch is selected, or `["--batch-id", String(batchId)]`. Drop `sequenceArg` (the new mode reads sequence_id from each lead row, not from a CLI flag) and `limitArg` (sender uses `DAILY_SEND_LIMIT` env per existing behavior; AGENTS.md §2 says "omitted --limit means use remaining daily quota").

- [ ] **Step 2: Update `/api/enrich/connect-only/route.ts` identically**

Same swap, same behavior. After this, both endpoints spawn the same sender invocation. (The two routes can be consolidated in a follow-up; out of scope here.)

- [ ] **Step 3: Type-check**

```
cd apps/web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 4: Smoke verify via the running app**

```
./run_all.sh --web
```

In the UI, on a sequence-driven batch click `SEND INVITES`. Watch `.logs/sender-spawn.log` and the container logs (per AGENTS.md §2 the spawn must mirror stdout/stderr to both). Verify a `sender-send-invites` operation_start/operation_complete log line.

- [ ] **Step 5: Commit**

```
git add apps/web/app/api/enrich/route.ts apps/web/app/api/enrich/connect-only/route.ts
git commit -m "feat(api): route SEND INVITES to sender.py --send-invites"
```

---

## Task 9: Delete `--mode connect_only` lead-processing from scraper.py

**Files:**
- Modify: `workers/scraper/scraper.py`

- [ ] **Step 1: Identify what to delete**

Search `workers/scraper/scraper.py` for:
1. The `--mode` argparse choice list — drop `connect_only`. Keep `enrich`. Default stays `enrich`.
2. The branch in `parse_args`/main that dispatches when `args.mode == "connect_only"`.
3. The `connect_only` priority-query block (the `outreach_mode == "connect_only"` branch in the lead-fetch helper around lines ~220-260).
4. Any helpers used **only** by the connect_only path (do not delete shared helpers — Task 7 already moved the cross-shared ones to `linkedin_actions`).

- [ ] **Step 2: Confirm callers are gone**

```
grep -rn "scraper.py.*connect_only\|--mode.*connect_only" apps/ workers/ run_all.sh
```
Expected: no hits. (Tasks 6/8 should have removed all of them.)

- [ ] **Step 3: Delete and verify the file still parses**

After deletion:
```
python -c "import ast; ast.parse(open('workers/scraper/scraper.py').read())"
python workers/scraper/scraper.py --help
```
The help output should no longer list `connect_only` as a `--mode` choice.

- [ ] **Step 4: Smoke test the remaining scraper modes**

Quick run-through to confirm nothing else regressed:
```
python workers/scraper/scraper.py --login-only      # should bootstrap LinkedIn auth
python workers/scraper/scraper.py --inbox --limit 0 # should scan inbox
```

- [ ] **Step 5: Commit**

```
git add workers/scraper/scraper.py
git commit -m "refactor(scraper): remove dead connect_only lead-processing mode"
```

---

## Task 10: End-to-end smoke + plan close-out

- [ ] **Step 1: Full path verification**

With a fresh test batch (10 leads, sequence-driven `connect_message` intent):

1. CSV upload via UI → leads land as `NEW` under `lead_batches.batch_intent='connect_message'`.
2. Click `SEND INVITES` → `/api/enrich` route spawns `sender.py --send-invites`.
3. Watch logs: see `sender-send-invites` operation_start, per-lead `message_send_complete` lines, operation_complete with sent count.
4. DB check: leads flipped from `NEW` to `CONNECT_ONLY_SENT` with non-null `connection_sent_at`.
5. Check sequence's `connect_note` was rendered with the lead's `first_name`/`last_name`/`company_name` (sample-check one lead's outbound message in LinkedIn).
6. Repeat with a `connect_only` batch — verify invites send with **no** note.

- [ ] **Step 2: Negative path verification**

Force a known LinkedIn-side failure (use a closed/restricted profile URL). Verify:
- Lead lands as `FAILED` (never `PROCESSING`).
- Screenshot path appears in `.logs/sender-spawn.log`.
- Run continues to the next lead (no crash).

- [ ] **Step 3: Final commit (only if any cleanup edits)**

If smoke uncovered last-mile fixes, commit them as a single follow-up:
```
git commit -m "fix(sender): smoke-test fixups for --send-invites"
```

- [ ] **Step 4: Finishing-a-development-branch handoff**

Invoke the superpowers:finishing-a-development-branch skill to choose merge strategy (PR vs direct merge to main; this plan and Plan B can ship independently).

---

## Self-Review

**1. Spec coverage.** The brainstorm produced these acceptance points, all covered:
- Sequence-driven leads no longer touch the scraper → Task 8 (route swap) + Task 9 (scraper deletion).
- Sender renders `connect_note` from `outreach_sequences` with CSV tokens → Task 4 (helper) + Task 6 (wiring).
- `connect_message` sends note; `connect_only` sends without note → Task 6 step 3 (`note_text=None` when `outreach_mode == "connect_only"`).
- Validator caps at 300 chars and rejects unknown tokens → Task 1 + Task 3.
- Existing AGENTS.md §2 behaviors preserved (FAILED never PROCESSING, weekly-limit hard stop, screenshot capture, headless on Linux without DISPLAY) → Task 6 carries them through.

**2. Placeholder scan.** Searched for "TBD/TODO/implement later/handle edge cases/etc." — none. The one `# adjust name to match Step 1 finding` comment in Task 6 is intentional: the engineer must look at the existing scraper signature, which is more honest than guessing it. Same applies to the "if scraper helpers are not callable" branch (Task 6 Step 2) — that's an explicit decision point, not a placeholder.

**3. Type consistency.** `validateConnectNote`, `renderSequence`, `render` (Python), `process_invite_one`, `fetch_invite_queue`, `send_connection_request` — names used consistently across tasks. The `result.status` shape (`'sent' | 'limit_reached' | other`) is defined in Task 6 Step 3 and reused in Step 4 — engineer must verify this matches the real scraper return type during Task 6 Step 1.
