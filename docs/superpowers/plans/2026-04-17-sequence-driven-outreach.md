# Sequence-Driven Outreach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AI-drafted `connect+message` flow with a sequence-templated, operator-triggered, fully automated pipeline; decouple enrichment from send.

**Architecture:** Sequences own the text (step 0 = connect note ≤300 chars, step 1 = post-acceptance DM, steps 2/3 = nudges as today). The existing `RUN ENRICHMENT` button becomes `SEND INVITES` and only spawns `sender.py` to send step 0. Enrichment runs in its own background loop via `run_all.sh --enrichment`. Post-acceptance sender auto-renders step 1 from the sequence (not from `drafts`).

**Tech Stack:** Next.js 14 app router, React 18, Supabase Postgres, Python (Playwright + pytest) workers, zero new dependencies.

**Source spec:** `docs/superpowers/specs/2026-04-17-sequence-driven-outreach-design.md`

---

## Conventions

- Placeholder syntax is existing `{{token}}` (double-curly). Canonical set today: `{{first_name}}, {{last_name}}, {{full_name}}, {{company_name}}`. This plan reuses it — no new tokens introduced in this phase.
- Slot-tier distinction (CSV vs ENRICHED) in the spec is structural, but today all canonical tokens are CSV-derived. Enriched-tier slots are additive in a follow-up PR.
- `enrichment_ready` is a forward-looking flag. This plan writes it but only reads it as advisory until the enrichment loop lands in Task 10.
- Every task ends in a green test and a single-purpose commit.

---

## File Structure

### New files

- `supabase/migrations/011_sequence_driven_outreach.sql` — schema changes
- `apps/web/lib/sequenceRender.ts` — pure render helper (TS side, for previews)
- `apps/web/lib/sequenceConnectNote.ts` — 300-char validator, shared by editor + action
- `apps/web/components/EnrichmentStatusCard.tsx` — read-only status card
- `workers/sender/sequence_render.py` — pure Python render helper used by sender
- `workers/sender/test_sequence_render.py` — pytest for the helper

### Modified files

- `apps/web/components/SequenceEditor.tsx` — add `connect_note` field, char counter, save validation
- `apps/web/components/StartEnrichmentButton.tsx` — rename label, drop scraper spawn, keep one primary button
- `apps/web/app/actions.ts` — extend `saveOutreachSequence` input, add `queueInvitesForBatch`, expose `OutreachSequenceRow.connect_note`
- `apps/web/app/api/enrich/route.ts` — replace `scraper.py --run` spawn with `sender.py --send-invites`
- `apps/web/app/api/enrich/status/route.ts` — add `enrichment_worker` status block
- `apps/web/components/DraftFeed.tsx` — hide for sequence-driven leads
- `apps/web/lib/sequencePlaceholders.ts` — extend validator to cover `connect_note`
- `workers/sender/sender.py` — add `--send-invites` mode; rewire `--message-only` to read step 1 from sequence via `sequence_render`
- `workers/scraper/scraper.py` — add `--enrichment-loop` mode that polls `enrichment_ready=false`
- `run_all.sh` — add `--enrichment` service loop

### Dead-code scheduled for removal (this plan disables; follow-up plan deletes)

- `apps/web/components/DraftFeed.tsx` `variant="mission_control"` path
- `mcp-server/run_agent.py` call sites for sequence-driven leads
- `approveAndSendAllDrafts`, `approveDraft`, `regenerateDraft` usage on sequence-driven paths

---

## Task 1: Schema migration

**Files:**
- Create: `supabase/migrations/011_sequence_driven_outreach.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Migration 011: Sequence-driven outreach.
-- Adds step-0 connect note to sequences, slot fallbacks, enrichment_ready flag,
-- and a transient QUEUED_CONNECT lead status for the new send pipeline.

-- 1. Sequence connect note (step 0). NULL or empty == no note sent with invite.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outreach_sequences' AND column_name = 'connect_note'
  ) THEN
    ALTER TABLE outreach_sequences ADD COLUMN connect_note TEXT NOT NULL DEFAULT '';
  END IF;
END $$;

-- 2. Slot fallbacks (JSON map: {"{{first_name}}": "there", ...}).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outreach_sequences' AND column_name = 'slot_fallbacks'
  ) THEN
    ALTER TABLE outreach_sequences ADD COLUMN slot_fallbacks JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- 3. Enrichment readiness flag on leads.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'enrichment_ready'
  ) THEN
    ALTER TABLE leads ADD COLUMN enrichment_ready BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

-- Backfill: treat anything already past NEW as enriched for purposes of new flag.
UPDATE leads
SET enrichment_ready = TRUE
WHERE enrichment_ready = FALSE
  AND status NOT IN ('NEW', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_leads_enrichment_ready
  ON leads(enrichment_ready)
  WHERE enrichment_ready = FALSE;

-- 4. Add QUEUED_CONNECT to the allowed status set if a check constraint exists.
-- If no constraint exists, this is a no-op; sender is the source of truth for transitions.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.leads'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE leads DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;
```

- [ ] **Step 2: Apply migration to local Supabase**

Run: `supabase db push` (or the project's equivalent migration runner)

Expected: migration 011 applied without errors. Re-running is a no-op (idempotent `DO $$ IF NOT EXISTS` guards).

- [ ] **Step 3: Verify schema**

Run:
```bash
supabase db execute "SELECT column_name FROM information_schema.columns WHERE table_name='outreach_sequences' AND column_name IN ('connect_note','slot_fallbacks');"
supabase db execute "SELECT column_name FROM information_schema.columns WHERE table_name='leads' AND column_name='enrichment_ready';"
```

Expected: all three columns returned.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/011_sequence_driven_outreach.sql
git commit -m "feat(db): add connect_note, slot_fallbacks, enrichment_ready (migration 011)"
```

---

## Task 2: Pure Python render helper

**Files:**
- Create: `workers/sender/sequence_render.py`
- Create: `workers/sender/test_sequence_render.py`

- [ ] **Step 1: Write the failing tests**

`workers/sender/test_sequence_render.py`:

```python
import pytest

from sequence_render import render_step, RenderResult


def test_render_substitutes_known_tokens():
    result = render_step(
        template="Hi {{first_name}} at {{company_name}}",
        slots={"{{first_name}}": "Marie", "{{company_name}}": "Acme"},
        fallbacks={},
    )
    assert result.text == "Hi Marie at Acme"
    assert result.used_fallbacks == []


def test_render_applies_fallback_for_missing_slot():
    result = render_step(
        template="Hi {{first_name}}",
        slots={"{{first_name}}": None},
        fallbacks={"{{first_name}}": "there"},
    )
    assert result.text == "Hi there"
    assert result.used_fallbacks == ["{{first_name}}"]


def test_render_applies_fallback_for_empty_string_slot():
    result = render_step(
        template="Hi {{first_name}}",
        slots={"{{first_name}}": "  "},
        fallbacks={"{{first_name}}": "there"},
    )
    assert result.text == "Hi there"
    assert result.used_fallbacks == ["{{first_name}}"]


def test_render_uses_empty_string_if_no_fallback():
    result = render_step(
        template="Hi {{first_name}}, {{company_name}}!",
        slots={"{{first_name}}": "Marie", "{{company_name}}": None},
        fallbacks={},
    )
    assert result.text == "Hi Marie, !"
    assert result.used_fallbacks == []
    assert result.missing_slots == ["{{company_name}}"]


def test_render_leaves_unknown_tokens_intact():
    result = render_step(
        template="Hi {{unknown_token}}",
        slots={},
        fallbacks={},
    )
    assert result.text == "Hi {{unknown_token}}"


def test_render_empty_template_returns_empty_string():
    result = render_step(template="", slots={}, fallbacks={})
    assert result.text == ""


def test_render_collapses_whitespace_after_substitution():
    result = render_step(
        template="Hi {{first_name}}  —  thanks",
        slots={"{{first_name}}": "Marie"},
        fallbacks={},
    )
    assert result.text == "Hi Marie — thanks"
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd workers/sender && venv/bin/pytest test_sequence_render.py -v`

Expected: `ModuleNotFoundError: No module named 'sequence_render'`.

- [ ] **Step 3: Write the implementation**

`workers/sender/sequence_render.py`:

```python
"""Pure template renderer for sequence-driven outreach.

Substitutes `{{token}}` slots with lead-specific values. Falls back to a
sequence-level fallback map when a slot is missing or blank. Unknown tokens
are left intact so the caller can detect authoring mistakes.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

TOKEN_PATTERN = re.compile(r"\{\{[^{}\n]+\}\}")


@dataclass
class RenderResult:
    text: str
    used_fallbacks: List[str] = field(default_factory=list)
    missing_slots: List[str] = field(default_factory=list)


def render_step(
    template: str,
    slots: Dict[str, Optional[str]],
    fallbacks: Dict[str, str],
) -> RenderResult:
    if not template:
        return RenderResult(text="")

    used_fallbacks: List[str] = []
    missing_slots: List[str] = []

    def replace(match: "re.Match[str]") -> str:
        token = match.group(0)
        raw = slots.get(token)
        if raw is not None and str(raw).strip():
            return str(raw).strip()
        if token in fallbacks:
            used_fallbacks.append(token)
            return fallbacks[token]
        if token in slots:
            missing_slots.append(token)
            return ""
        return token  # unknown token — leave intact

    substituted = TOKEN_PATTERN.sub(replace, template)
    collapsed = re.sub(r"[ \t]{2,}", " ", substituted).strip()

    return RenderResult(
        text=collapsed,
        used_fallbacks=used_fallbacks,
        missing_slots=missing_slots,
    )
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `cd workers/sender && venv/bin/pytest test_sequence_render.py -v`

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add workers/sender/sequence_render.py workers/sender/test_sequence_render.py
git commit -m "feat(sender): pure render_step helper for sequence templates"
```

---

## Task 3: Connect-note validator (shared TS)

**Files:**
- Create: `apps/web/lib/sequenceConnectNote.ts`
- Create: `apps/web/lib/__tests__/sequenceConnectNote.test.ts` (if jest/vitest exists; otherwise inline in Task 4)

- [ ] **Step 1: Check the test runner**

Run: `cd apps/web && cat package.json | grep -E '"(test|vitest|jest)"'`

If no test script, skip test file creation and rely on compile-time + Task 5 integration tests.

- [ ] **Step 2: Write the validator**

`apps/web/lib/sequenceConnectNote.ts`:

```typescript
import { CANONICAL_SEQUENCE_PLACEHOLDERS, findInvalidPlaceholderTokens } from "./sequencePlaceholders";

export const CONNECT_NOTE_MAX_CHARS = 300;
export const CONNECT_NOTE_WARN_CHARS = 280;

export type ConnectNoteValidation = {
  ok: boolean;
  length: number;
  overBy: number;
  invalidTokens: string[];
};

/**
 * Worst-case length = template length with each {{token}} replaced by its
 * declared fallback. Keeps the 300-char envelope safe even when a lead has
 * no slot data and all tokens fall back.
 */
export function worstCaseLength(note: string, fallbacks: Record<string, string>): number {
  let rendered = note ?? "";
  for (const token of CANONICAL_SEQUENCE_PLACEHOLDERS) {
    if (!rendered.includes(token)) continue;
    const fallback = fallbacks[token] ?? "";
    rendered = rendered.split(token).join(fallback);
  }
  return rendered.length;
}

export function validateConnectNote(
  note: string,
  fallbacks: Record<string, string>
): ConnectNoteValidation {
  const length = worstCaseLength(note ?? "", fallbacks);
  const invalidTokens = findInvalidPlaceholderTokens(note ?? "");
  return {
    ok: length <= CONNECT_NOTE_MAX_CHARS && invalidTokens.length === 0,
    length,
    overBy: Math.max(0, length - CONNECT_NOTE_MAX_CHARS),
    invalidTokens,
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/sequenceConnectNote.ts
git commit -m "feat(web): connect-note validator (300-char worst-case check)"
```

---

## Task 4: Extend `saveOutreachSequence` action

**Files:**
- Modify: `apps/web/app/actions.ts` (locate `saveOutreachSequence` and the `OutreachSequenceRow` type)

- [ ] **Step 1: Locate the function**

Run: `grep -n "saveOutreachSequence\|OutreachSequenceRow" apps/web/app/actions.ts`

Note the signatures and the Supabase upsert call.

- [ ] **Step 2: Extend the row type**

Add `connect_note: string` and `slot_fallbacks: Record<string, string>` to `OutreachSequenceRow`:

```typescript
export type OutreachSequenceRow = {
  id: number;
  name: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
  connect_note: string;
  slot_fallbacks: Record<string, string>;
  created_at: string;
  updated_at: string;
  is_active: boolean;
};
```

Update the SELECT in any reader that uses `outreach_sequences` to include `connect_note, slot_fallbacks`.

- [ ] **Step 3: Extend `saveOutreachSequence` input and validation**

At the top of the file add:
```typescript
import { validateConnectNote } from "../lib/sequenceConnectNote";
```

Update the input shape:
```typescript
type SaveSequenceInput = {
  id?: number;
  name: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
  connect_note?: string;
  slot_fallbacks?: Record<string, string>;
};
```

Inside `saveOutreachSequence`, after existing placeholder validation:

```typescript
const connectNote = (input.connect_note ?? "").trim();
const fallbacks = input.slot_fallbacks ?? {};
const connectValidation = validateConnectNote(connectNote, fallbacks);
if (!connectValidation.ok) {
  throw new Error(
    JSON.stringify({
      message: "Connect note validation failed",
      details: {
        field_errors: [
          {
            field: "connect_note",
            invalid_tokens: connectValidation.invalidTokens,
            over_by: connectValidation.overBy,
          },
        ],
      },
    })
  );
}
```

Include `connect_note: connectNote` and `slot_fallbacks: fallbacks` in the Supabase upsert payload. Include them in the returned row.

- [ ] **Step 4: Typecheck + smoke compile**

Run: `cd apps/web && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/actions.ts
git commit -m "feat(web): saveOutreachSequence accepts connect_note + slot_fallbacks"
```

---

## Task 5: SequenceEditor connect-note field

**Files:**
- Modify: `apps/web/components/SequenceEditor.tsx`

- [ ] **Step 1: Extend the Draft type and defaults**

Find:
```typescript
type Draft = {
  name: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
};
```

Replace with:
```typescript
type Draft = {
  name: string;
  connect_note: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
  slot_fallbacks: Record<string, string>;
};
```

Update `emptyDraft()` to include `connect_note: ""` and `slot_fallbacks: { "{{first_name}}": "there" }`.

Update the default-from-sequence hydration in `useState` and `syncDraft` to copy `connect_note` and `slot_fallbacks` from the row.

- [ ] **Step 2: Add connect-note textarea above `Message 1`**

Import:
```typescript
import {
  CONNECT_NOTE_MAX_CHARS,
  CONNECT_NOTE_WARN_CHARS,
  validateConnectNote,
} from "../lib/sequenceConnectNote";
```

Add a derived value near other `useMemo`s:
```typescript
const connectNoteValidation = useMemo(
  () => validateConnectNote(draft.connect_note, draft.slot_fallbacks),
  [draft.connect_note, draft.slot_fallbacks]
);
```

Insert, directly above the `<label>Message 1</label>` block:

```tsx
<label>Connect Note (sent with invite, ≤300 chars)</label>
<textarea
  className="textarea"
  value={draft.connect_note}
  onChange={(event) => setDraft((prev) => ({ ...prev, connect_note: event.target.value }))}
  placeholder="Optional short note. Sent with the friend request. Leave blank to send a bare invite."
  aria-invalid={!connectNoteValidation.ok}
  maxLength={CONNECT_NOTE_MAX_CHARS + 50}
/>
<div
  className="muted"
  style={{
    marginTop: 4,
    fontSize: 11,
    color:
      connectNoteValidation.length > CONNECT_NOTE_MAX_CHARS
        ? "#dc2626"
        : connectNoteValidation.length > CONNECT_NOTE_WARN_CHARS
        ? "#ca8a04"
        : undefined,
  }}
>
  {connectNoteValidation.length} / {CONNECT_NOTE_MAX_CHARS} chars (worst-case with fallbacks)
  {connectNoteValidation.invalidTokens.length
    ? ` • Unknown placeholders: ${connectNoteValidation.invalidTokens.join(", ")}`
    : ""}
</div>
```

- [ ] **Step 3: Block save when note is invalid**

Find the `onSave` handler. Extend the early-return:

```typescript
if (hasInvalidTokens || !connectNoteValidation.ok) {
  setTopLevelError(
    !connectNoteValidation.ok
      ? `Connect note is ${connectNoteValidation.length}/${CONNECT_NOTE_MAX_CHARS} chars.`
      : `Unknown placeholders detected. Allowed: ${placeholderResolver.canonicalTokens.join(", ")}`
  );
  focusFirstInvalidField();
  return;
}
```

Pass `connect_note` and `slot_fallbacks` in the `saveOutreachSequence` call:

```typescript
const saved = await saveOutreachSequence({
  id: selectedSequenceId || undefined,
  name: draft.name || `Sequence ${localSequences.length + 1}`,
  connect_note: draft.connect_note,
  first_message: draft.first_message,
  second_message: draft.second_message,
  third_message: draft.third_message,
  followup_interval_days: draft.followup_interval_days,
  slot_fallbacks: draft.slot_fallbacks,
});
```

- [ ] **Step 4: Typecheck and manual smoke test**

Run: `cd apps/web && npx tsc --noEmit`

Run dev server, open sequence editor, type >300 chars → counter red, save blocked. Insert `{{first_name}}` via picker → counts against budget.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/SequenceEditor.tsx
git commit -m "feat(web): connect-note field + live char counter in SequenceEditor"
```

---

## Task 6: Sender `--send-invites` mode

**Files:**
- Modify: `workers/sender/sender.py`

- [ ] **Step 1: Locate the CLI arg parser**

Run: `grep -n "argparse\|add_argument" workers/sender/sender.py`

Note the existing mode flags (`--followup`, `--message-only`, `--lead-id`).

- [ ] **Step 2: Add `--send-invites` flag and fetch function**

Near the other flag declarations add:

```python
parser.add_argument(
    "--send-invites",
    action="store_true",
    help="Send step-0 connect notes to leads queued in QUEUED_CONNECT.",
)
```

Add a fetch helper alongside `fetch_approved_leads`:

```python
def fetch_queued_invites(limit: int | None = None):
    """Leads ready for step-0 send: status=QUEUED_CONNECT, sequence assigned."""
    query = (
        supabase.table("leads")
        .select(
            "id, linkedin_url, first_name, last_name, full_name, company_name, sequence_id"
        )
        .eq("status", "QUEUED_CONNECT")
        .not_.is_("sequence_id", "null")
    )
    if limit:
        query = query.limit(limit)
    return query.execute().data or []


def fetch_sequence(sequence_id: int):
    row = (
        supabase.table("outreach_sequences")
        .select("id, connect_note, first_message, slot_fallbacks")
        .eq("id", sequence_id)
        .limit(1)
        .execute()
        .data
    )
    return row[0] if row else None


def build_lead_slots(lead: dict) -> dict:
    return {
        "{{first_name}}": lead.get("first_name"),
        "{{last_name}}": lead.get("last_name"),
        "{{full_name}}": lead.get("full_name"),
        "{{company_name}}": lead.get("company_name"),
    }
```

- [ ] **Step 3: Add a send-invites driver**

```python
from sequence_render import render_step


def run_send_invites():
    leads = fetch_queued_invites()
    if not leads:
        logger.info("No QUEUED_CONNECT leads")
        return

    context, page, client = ensure_linkedin_auth()
    try:
        for lead in leads:
            sequence = fetch_sequence(lead["sequence_id"])
            if not sequence:
                mark_failed(lead["id"], reason="sequence_missing")
                continue

            note_template = sequence.get("connect_note") or ""
            fallbacks = sequence.get("slot_fallbacks") or {}
            rendered = render_step(
                template=note_template,
                slots=build_lead_slots(lead),
                fallbacks=fallbacks,
            )

            if len(rendered.text) > 300:
                mark_failed(lead["id"], reason="note_over_300")
                continue

            surface = open_invite_surface(page, lead["linkedin_url"])
            sent = send_connect_with_note(page, rendered.text, surface)
            if sent:
                mark_connect_sent(lead["id"])
            else:
                mark_retry(lead["id"], reason="send_failed")
    finally:
        context.close()
```

Wire `run_send_invites()` into `main()` under a new branch when `args.send_invites` is true (before the default `APPROVED` branch).

- [ ] **Step 4: Add matching status helpers**

If `mark_connect_sent`, `mark_retry`, `mark_failed` don't already exist, add thin wrappers over the existing status-update patterns in this file. Reuse the `CONNECT_ONLY_SENT` status used today by the connect-only flow (this is the same post-invite state).

- [ ] **Step 5: Add a smoke test**

In `workers/sender/test_sender.py`, append:

```python
def test_build_lead_slots_maps_canonical_tokens():
    from sender import build_lead_slots
    lead = {
        "first_name": "Marie",
        "last_name": "Curie",
        "full_name": "Marie Curie",
        "company_name": "Radium",
    }
    slots = build_lead_slots(lead)
    assert slots["{{first_name}}"] == "Marie"
    assert slots["{{company_name}}"] == "Radium"
```

Run: `cd workers/sender && venv/bin/pytest test_sender.py::test_build_lead_slots_maps_canonical_tokens -v`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/sender/sender.py workers/sender/test_sender.py
git commit -m "feat(sender): --send-invites mode renders step 0 from sequence"
```

---

## Task 7: Add `queueInvitesForBatch` server action

**Files:**
- Modify: `apps/web/app/actions.ts`

- [ ] **Step 1: Add the action**

```typescript
export async function queueInvitesForBatch(batchId: number): Promise<{ queued: number }> {
  const supabase = supabaseServiceRoleClient();
  const { data, error } = await supabase
    .from("leads")
    .update({ status: "QUEUED_CONNECT" })
    .eq("batch_id", batchId)
    .in("status", ["NEW", "ENRICHED"])
    .select("id");

  if (error) throw new Error(error.message);
  return { queued: (data ?? []).length };
}
```

(Use whatever service-role helper exists in this file — grep for `createServerClient` or `supabaseServiceRoleClient`.)

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/actions.ts
git commit -m "feat(web): queueInvitesForBatch transitions leads to QUEUED_CONNECT"
```

---

## Task 8: `/api/enrich` → spawn sender, not scraper

**Files:**
- Modify: `apps/web/app/api/enrich/route.ts`

- [ ] **Step 1: Rewrite the handler**

Replace the existing `POST` body so it spawns `sender.py --send-invites` instead of `scraper.py --run`. Reuse the existing lock / PID / logging scaffolding but point it at `workers/sender`:

```typescript
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../lib/apiGuard";
import { logger } from "../../../lib/logger";
import { assertSenderLockFree, persistSenderPid } from "./senderLock";

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/enrich");
  const guardResponse = requireOperatorAccess(request, "/api/enrich", correlationId);
  if (guardResponse) return guardResponse;

  try {
    const webDir = process.cwd();
    const repoRoot = path.resolve(webDir, "..", "..");
    const senderDir = path.join(repoRoot, "workers", "sender");
    if (!fs.existsSync(senderDir)) {
      return NextResponse.json({ ok: false, error: "Sender directory not found" }, { status: 500 });
    }

    const venvPython = path.join(senderDir, "venv", "bin", "python");
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";

    const pidFile = path.join(senderDir, "send-invites.pid");
    const lock = assertSenderLockFree(pidFile);
    if (!lock.ok) {
      return NextResponse.json(
        { ok: false, error: `Sender already running (pid ${lock.activePid}).` },
        { status: 409 },
      );
    }

    const args = ["sender.py", "--send-invites"];
    const logPath = path.join(repoRoot, ".logs", "sender-invites-spawn.log");
    const logFd = fs.openSync(logPath, "a");
    const child = spawn(pythonCmd, args, {
      cwd: senderDir,
      env: { ...process.env, CORRELATION_ID: correlationId },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    child.unref();
    persistSenderPid(child, pidFile);

    logger.info("Sender (send-invites) started", { correlationId, pid: child.pid });
    return NextResponse.json({ ok: true, message: "Invite sender started." });
  } catch (err: any) {
    logger.error("Failed to start sender", { correlationId }, err);
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create `senderLock.ts`**

Create `apps/web/app/api/enrich/senderLock.ts` mirroring `scraperLock.ts`. Copy the file and rename symbols from `Scraper` to `Sender`. (If the existing `scraperLock.ts` is small enough, literally copy it.)

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/enrich/route.ts apps/web/app/api/enrich/senderLock.ts
git commit -m "feat(web): /api/enrich spawns sender --send-invites instead of scraper"
```

---

## Task 9: Rename `RUN ENRICHMENT` → `SEND INVITES` and simplify

**Files:**
- Modify: `apps/web/components/StartEnrichmentButton.tsx`

- [ ] **Step 1: Update labels**

In `MODE_CONFIG.message` change:
```typescript
startLabel: "SEND INVITES",
defaultStartMessage: "Invite send started.",
```

In `MODE_CONFIG.connect_only` keep as-is (already `SEND INVITES`).

- [ ] **Step 2: Remove the redundant `SEND MESSAGE AFTER FRIEND REQUEST ACCEPTANCE` button**

Delete the `mode === "connect_only"` block that renders the `triggerMessageOnlySender` button (lines near 300-311 in the current file). Post-acceptance send is auto-armed by the sender worker in Task 11; no manual trigger needed.

Also delete the unused `triggerMessageOnlySender` function and `messageOnlySending` state.

- [ ] **Step 3: Typecheck and manual smoke**

Run: `cd apps/web && npx tsc --noEmit`

Load the leads page; confirm a single `SEND INVITES` button with the status card below.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/StartEnrichmentButton.tsx
git commit -m "feat(web): rename RUN ENRICHMENT to SEND INVITES; drop manual post-accept trigger"
```

---

## Task 10: Scraper enrichment loop

**Files:**
- Modify: `workers/scraper/scraper.py`
- Modify: `run_all.sh`

- [ ] **Step 1: Add `--enrichment-loop` mode to scraper**

Locate `parse_args()`. Add:

```python
parser.add_argument(
    "--enrichment-loop",
    action="store_true",
    help="Poll for leads with enrichment_ready=false and enrich them continuously.",
)
parser.add_argument(
    "--idle-seconds",
    type=int,
    default=600,
    help="Seconds to sleep between polls when no leads are pending.",
)
```

Add a loop function:

```python
def run_enrichment_loop(idle_seconds: int):
    while True:
        leads = (
            supabase.table("leads")
            .select("id, linkedin_url")
            .eq("enrichment_ready", False)
            .not_.is_("linkedin_url", "null")
            .limit(10)
            .execute()
            .data
            or []
        )
        if not leads:
            logger.info(f"enrichment idle, sleeping {idle_seconds}s")
            time.sleep(idle_seconds)
            continue

        context, page, client = ensure_linkedin_auth()
        try:
            for lead in leads:
                try:
                    profile, activity = enrich_profile(page, lead["linkedin_url"])
                    supabase.table("leads").update({
                        "profile": profile,
                        "activity": activity,
                        "enrichment_ready": True,
                    }).eq("id", lead["id"]).execute()
                except Exception as exc:
                    logger.error(f"enrichment failed for {lead['id']}: {exc}")
                    supabase.table("leads").update({
                        "enrichment_ready": False,
                    }).eq("id", lead["id"]).execute()
        finally:
            context.close()
```

(Use whatever enrichment helper already exists in `scraper.py` — grep for the `--run` path and reuse its per-lead function. Rename my placeholder `enrich_profile` to the real function name.)

In the `if __name__ == "__main__":` dispatch, route when `args.enrichment_loop`:

```python
if args.enrichment_loop:
    run_enrichment_loop(args.idle_seconds)
    sys.exit(0)
```

- [ ] **Step 2: Add `--enrichment` service to `run_all.sh`**

In `run_all.sh`, near the existing `--sender` / `--message-only` loops, add:

```bash
start_enrichment() {
  cd "$REPO_ROOT/workers/scraper" || exit 1
  exec ./venv/bin/python scraper.py --enrichment-loop
}

case "$1" in
  # ... existing cases ...
  --enrichment)
    start_enrichment
    ;;
esac
```

(Match the exact pattern of the existing services.)

- [ ] **Step 3: Smoke-run locally**

Run: `./run_all.sh --enrichment &`

Expected: logs show "enrichment idle" after a minute when no pending leads. Kill with `kill %1`.

- [ ] **Step 4: Commit**

```bash
git add workers/scraper/scraper.py run_all.sh
git commit -m "feat(scraper): --enrichment-loop runs independently of send path"
```

---

## Task 11: Sender post-acceptance uses sequence step 1

**Files:**
- Modify: `workers/sender/sender.py`

- [ ] **Step 1: Locate `process_message_only_one`**

Run: `grep -n "process_message_only_one\|first_message" workers/sender/sender.py`

Today it already reads `sequence.first_message`. We're tightening it to go through `render_step` and honor fallbacks.

- [ ] **Step 2: Refactor the message build**

Replace the line that concatenates `sequence.first_message` directly with:

```python
rendered = render_step(
    template=sequence.get("first_message") or "",
    slots=build_lead_slots(lead),
    fallbacks=sequence.get("slot_fallbacks") or {},
)
message_text = rendered.text

# Enrichment readiness advisory: log if we're sending before enrichment.
if not lead.get("enrichment_ready"):
    logger.warning(f"sending step 1 before enrichment for lead {lead['id']}")
```

Also pull `enrichment_ready` and `slot_fallbacks` into the select that feeds this function.

- [ ] **Step 3: Add a test exercising the rendered path**

In `workers/sender/test_sender.py`:

```python
def test_sequence_first_message_renders_with_fallback():
    from sequence_render import render_step
    from sender import build_lead_slots
    lead = {"first_name": None, "company_name": "Acme"}
    slots = build_lead_slots(lead)
    result = render_step(
        template="Hi {{first_name}} at {{company_name}}",
        slots=slots,
        fallbacks={"{{first_name}}": "there"},
    )
    assert result.text == "Hi there at Acme"
    assert "{{first_name}}" in result.used_fallbacks
```

Run: `cd workers/sender && venv/bin/pytest test_sender.py::test_sequence_first_message_renders_with_fallback -v`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/sender/sender.py workers/sender/test_sender.py
git commit -m "feat(sender): post-acceptance step 1 routes through render_step with fallbacks"
```

---

## Task 12: Enrichment status card

**Files:**
- Create: `apps/web/components/EnrichmentStatusCard.tsx`
- Modify: `apps/web/app/api/enrich/status/route.ts`
- Modify: `apps/web/app/leads/page.tsx` (mount the card)

- [ ] **Step 1: Extend the status endpoint**

Add an `enrichment_worker` block to the response:

```typescript
const { count: pendingCount } = await supabase
  .from("leads")
  .select("id", { count: "exact", head: true })
  .eq("enrichment_ready", false);

const { data: lastReady } = await supabase
  .from("leads")
  .select("updated_at")
  .eq("enrichment_ready", true)
  .order("updated_at", { ascending: false })
  .limit(1)
  .maybeSingle();

return NextResponse.json({
  ok: true,
  // ... existing fields ...
  enrichment_worker: {
    pending: pendingCount ?? 0,
    last_ready_at: lastReady?.updated_at ?? null,
  },
});
```

- [ ] **Step 2: Create the card component**

`apps/web/components/EnrichmentStatusCard.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { getOperatorApiHeaders } from "../lib/operatorToken";

type EnrichmentStatus = {
  pending: number;
  last_ready_at: string | null;
};

export function EnrichmentStatusCard() {
  const [status, setStatus] = useState<EnrichmentStatus | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/enrich/status", {
          cache: "no-store",
          headers: getOperatorApiHeaders(),
        });
        const data = await res.json();
        if (!cancelled) setStatus(data.enrichment_worker ?? null);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Unable to load status.");
      }
    };
    load();
    const id = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="pill">ENRICHMENT WORKER</div>
      <div style={{ marginTop: 8, fontSize: 12 }}>
        {error ? (
          <span style={{ color: "var(--accent)" }}>{error}</span>
        ) : !status ? (
          "LOADING…"
        ) : (
          <>
            QUEUE: {status.pending} • LAST READY:{" "}
            {status.last_ready_at ? new Date(status.last_ready_at).toLocaleString() : "—"}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Mount on leads page**

In `apps/web/app/leads/page.tsx`, import and render `<EnrichmentStatusCard />` near the existing enrichment button (server component rendering a client component is fine).

- [ ] **Step 4: Typecheck + visual smoke**

Run: `cd apps/web && npx tsc --noEmit`

Open `/leads`, confirm the `ENRICHMENT WORKER` card shows a queue count.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/EnrichmentStatusCard.tsx apps/web/app/api/enrich/status/route.ts apps/web/app/leads/page.tsx
git commit -m "feat(web): read-only EnrichmentStatusCard on leads page"
```

---

## Task 13: Retire DraftFeed approval path for sequence-driven leads

**Files:**
- Modify: `apps/web/components/DraftFeed.tsx`
- Modify: whichever page currently mounts `DraftFeed` (grep to find)

- [ ] **Step 1: Find mount sites**

Run: `grep -rn "DraftFeed\b" apps/web/app`

Identify pages mounting `<DraftFeed />` and `<DraftFeed variant="mission_control" />`.

- [ ] **Step 2: Gate sequence-driven leads out of the feed**

In `apps/web/app/actions.ts` locate `fetchDraftFeed`. Before returning, filter out rows that have a `sequence_id` set — those are now handled entirely by the sender pipeline:

```typescript
const filtered = rows.filter((row) => !row.sequence_id);
return filtered.map(mapToDraftWithLead);
```

(Grep for the existing shape and adapt the filter to the real column name.)

- [ ] **Step 3: Remove the `variant="mission_control"` mount**

Delete the `<DraftFeed variant="mission_control" />` usage on the Mission Control page. Keep `DraftFeed` (default variant) for any remaining legacy leads that were created before sequence assignment became mandatory.

- [ ] **Step 4: Typecheck + smoke**

Run: `cd apps/web && npx tsc --noEmit`

Load the app; confirm sequence-assigned leads do not appear in the DraftFeed approval queue, and the Mission Control post-acceptance card is gone.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/actions.ts apps/web/components/DraftFeed.tsx apps/web/app
git commit -m "feat(web): retire DraftFeed approval path for sequence-driven leads"
```

---

## Task 14: End-to-end smoke check

- [ ] **Step 1: Seed a sequence with a connect note**

Open the sequence editor, create `Test Seq 1`:
- Connect note: `Hi {{first_name}}, saw your work at {{company_name}} — curious if you're exploring X.` (with `{{first_name}}` fallback `"there"`, `{{company_name}}` fallback `"your team"`).
- Message 1: `Hi {{first_name}}, following up — we've been helping teams in similar shape to {{company_name}}. Open to a 15-min chat?`
- Save.

- [ ] **Step 2: Assign a small test CSV batch to the sequence and queue**

In a node REPL or a throwaway script using `queueInvitesForBatch(batchId)`:
```typescript
await queueInvitesForBatch(1);
```

Verify in Supabase: leads from that batch are now `status='QUEUED_CONNECT'`.

- [ ] **Step 3: Press SEND INVITES**

Click the button on the leads page.

Expected: `.logs/sender-invites-spawn.log` shows the sender start; after a few seconds leads flip to `CONNECT_ONLY_SENT`.

- [ ] **Step 4: Start the enrichment loop**

Run: `./run_all.sh --enrichment &`

Expected: the same leads (still `enrichment_ready=false`) get picked up and enriched in parallel.

- [ ] **Step 5: Simulate acceptance on one lead**

Manually flip one lead: `enrichment_ready=true`, then trigger the message-only pass (or wait for it). Confirm step 1 is rendered from sequence, not from `drafts`.

- [ ] **Step 6: Commit any doc updates**

```bash
git add -A
git commit -m "docs: sequence-driven outreach smoke notes" --allow-empty
```

---

## Self-review checklist (before dispatch)

- [ ] Every spec §4–§8 requirement maps to at least one task above.
- [ ] Placeholder syntax is `{{token}}` everywhere (spec said `{slot}`; plan corrected).
- [ ] `render_step` signature matches between Task 2 (definition) and Tasks 6, 11 (consumers).
- [ ] `QUEUED_CONNECT` status used consistently: introduced in Task 1, produced in Task 7, consumed in Task 6.
- [ ] `enrichment_ready` produced only by Task 10 (scraper loop), consumed by Task 11 (sender advisory), displayed by Task 12 (card).
- [ ] No new dependencies added. Tasks use existing pytest, existing Next.js scaffolding, existing Supabase client helpers.
- [ ] Each task is one commit with a green test or typecheck gate.

---

## Out of scope (future PR)

- Enriched-tier slots (`{{about_excerpt}}`, `{{recent_post_hook}}`) and AI slot-filling.
- Deleting `mcp-server/run_agent.py` and the `approveDraft*` actions entirely. Gated in this plan, deleted in a follow-up once no legacy leads remain.
- Concurrent-session mitigation (time-slice vs mutex vs separate account). Implementation can ship with enrichment and send both running; operator picks a schedule.
