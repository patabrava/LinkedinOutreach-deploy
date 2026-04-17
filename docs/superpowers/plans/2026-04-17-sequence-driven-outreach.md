# Sequence-Driven Outreach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split outreach into three explicit flows: invite-only `connect_only` sending with an optional 300-char connect note, sequence-based post-acceptance messaging for `connect_message`, and a separate background enrichment worker that no longer runs inside the invite path.

**Architecture:** Sequences stay the single source of truth for post-acceptance messages, and they also store an optional `connect_note` used only when a batch is in `connect_only` mode. The connect-only action becomes invite-only and spawns the sender worker, the enrichment worker moves to an independent scraper loop, and the post-acceptance sender renders step 1 from the sequence instead of from drafts. Batch intent is inferred from existing batch labels, so the sequence editor can gate the connect-note field without adding a new batch schema.

**Tech Stack:** Next.js 14 app router, React 18, Supabase Postgres, Python Playwright workers, pytest, zero new dependencies.

**Scope:** {files: 10 modified, 4 new, LOC/file: 40-500, deps: 0}

**Source spec:** `docs/superpowers/specs/2026-04-17-sequence-driven-outreach-design.md`

---

## Conventions

- Canonical placeholder syntax stays `{{token}}`.
- Allowed sequence placeholders remain `{{first_name}}`, `{{last_name}}`, `{{full_name}}`, `{{company_name}}`.
- `connect_note` is optional and only editable for batches inferred as `connect_only`.
- `enrichment_ready` is a worker-owned operational flag, not a user-facing status.
- No new dependencies. Use existing Next.js, Supabase, Playwright, and pytest tooling.

---

## File Structure

### New files

- `supabase/migrations/011_sequence_driven_outreach.sql` - schema changes and backfills
- `apps/web/lib/batchIntent.ts` - shared batch-mode inference helper
- `apps/web/lib/sequenceConnectNote.ts` - 300-char connect-note validator
- `workers/sender/sequence_render.py` - pure template renderer for sender
- `workers/sender/test_sequence_render.py` - unit tests for render helper

### Modified files

- `apps/web/app/actions.ts` - sequence save/load, invite queueing, batch actions
- `apps/web/components/SequenceEditor.tsx` - batch-gated connect-note UI
- `apps/web/components/StartEnrichmentButton.tsx` - repurpose connect_only button text and route semantics
- `apps/web/app/api/enrich/connect-only/route.ts` - spawn sender invite worker instead of scraper
- `apps/web/app/api/enrich/status/route.ts` - show enrichment worker state
- `apps/web/app/leads/page.tsx` - mount enrichment status card
- `workers/sender/sender.py` - invite-only mode and sequence-based post-acceptance rendering
- `workers/scraper/scraper.py` - independent enrichment loop
- `run_all.sh` - launch enrichment as its own service

---

## Task 1: Schema Migration

**Files:**
- Create: `supabase/migrations/011_sequence_driven_outreach.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 011: sequence-driven outreach.
-- Adds optional connect note storage, slot fallbacks, a worker flag for enrichment,
-- and the QUEUED_CONNECT lead status used by the invite-only sender path.

ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'QUEUED_CONNECT';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'outreach_sequences'
      AND column_name = 'connect_note'
  ) THEN
    ALTER TABLE outreach_sequences
      ADD COLUMN connect_note text NOT NULL DEFAULT '';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'outreach_sequences'
      AND column_name = 'slot_fallbacks'
  ) THEN
    ALTER TABLE outreach_sequences
      ADD COLUMN slot_fallbacks jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'leads'
      AND column_name = 'enrichment_ready'
  ) THEN
    ALTER TABLE leads
      ADD COLUMN enrichment_ready boolean NOT NULL DEFAULT false;
  END IF;
END $$;

UPDATE leads
SET enrichment_ready = true
WHERE enrichment_ready = false
  AND status NOT IN ('NEW', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_leads_enrichment_ready_false
  ON leads (enrichment_ready)
  WHERE enrichment_ready = false;
```

- [ ] **Step 2: Apply and verify**

Run:
```bash
supabase db push
supabase db execute "select column_name from information_schema.columns where table_name='outreach_sequences' and column_name in ('connect_note','slot_fallbacks');"
supabase db execute "select column_name from information_schema.columns where table_name='leads' and column_name='enrichment_ready';"
```

Expected: migration succeeds, and all three columns are present.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/011_sequence_driven_outreach.sql
git commit -m "feat(db): add connect_note, slot_fallbacks, enrichment_ready, queued_connect"
```

---

## Task 2: Shared Batch-Intent and Connect-Note Helpers

**Files:**
- Create: `apps/web/lib/batchIntent.ts`
- Create: `apps/web/lib/sequenceConnectNote.ts`

- [ ] **Step 1: Add the batch-intent helper**

```typescript
export type BatchIntent = "connect_only" | "connect_message" | null;

export function inferBatchIntent(label: string): BatchIntent {
  const normalized = (label || "").toLowerCase();
  if (normalized.includes("connect only")) return "connect_only";
  if (normalized.includes("connect + message")) return "connect_message";
  if (normalized.includes("connect+message")) return "connect_message";
  return null;
}
```

- [ ] **Step 2: Add the connect-note validator**

```typescript
import { CANONICAL_SEQUENCE_PLACEHOLDERS, findInvalidPlaceholderTokens } from "./sequencePlaceholders";

export const CONNECT_NOTE_MAX_CHARS = 300;

export function worstCaseLength(note: string, fallbacks: Record<string, string>): number {
  let rendered = note ?? "";
  for (const token of CANONICAL_SEQUENCE_PLACEHOLDERS) {
    rendered = rendered.split(token).join(fallbacks[token] ?? "");
  }
  return rendered.length;
}

export function validateConnectNote(note: string, fallbacks: Record<string, string>) {
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

Run:
```bash
cd apps/web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/batchIntent.ts apps/web/lib/sequenceConnectNote.ts
git commit -m "feat(web): add batch intent helper and connect note validator"
```

---

## Task 3: Sequence Editor Connect-Note UI

**Files:**
- Modify: `apps/web/components/SequenceEditor.tsx`
- Modify: `apps/web/app/actions.ts`

- [ ] **Step 1: Extend the sequence row and draft shape**

Add `connect_note: string` and `slot_fallbacks: Record<string, string>` to `OutreachSequenceRow`, and hydrate them everywhere the editor loads or saves a sequence.

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

- [ ] **Step 2: Add validation to `saveOutreachSequence`**

```typescript
import { validateConnectNote } from "../lib/sequenceConnectNote";

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

Persist `connect_note` and `slot_fallbacks` in the upsert payload and select list.

- [ ] **Step 3: Render the invite note only for connect_only batches**

Use the shared helper from `apps/web/lib/batchIntent.ts` in the batch table.

```tsx
const batchIntent = inferBatchIntent(batch.name);
const showConnectNote = batchIntent === "connect_only";
```

Render a dedicated textarea in the batch row when `showConnectNote` is true:

```tsx
{showConnectNote ? (
  <>
    <label>Invite Note (connect_only only, max 300 chars)</label>
    <textarea
      className="textarea"
      value={draft.connect_note}
      onChange={(event) => setDraft((prev) => ({ ...prev, connect_note: event.target.value }))}
      maxLength={330}
      aria-invalid={!connectNoteValidation.ok}
      placeholder="Short note that will be sent with the connection request."
    />
    <div className="muted">
      {connectNoteValidation.length} / 300 chars, worst-case with fallbacks.
    </div>
  </>
) : (
  <div className="muted">Invite note is disabled for Connect + Message batches.</div>
)}
```

The field must not be editable for `connect_message` batches.

- [ ] **Step 4: Block invalid saves**

If the note is visible and invalid, block save with a clear error message and keep focus on the note field.

- [ ] **Step 5: Typecheck and commit**

Run:
```bash
cd apps/web && npx tsc --noEmit
```

Commit:
```bash
git add apps/web/components/SequenceEditor.tsx apps/web/app/actions.ts
git commit -m "feat(web): batch-gated invite note editor for connect_only sequences"
```

---

## Task 4: Queue Invites and Repurpose the Connect-Only Button

**Files:**
- Modify: `apps/web/app/actions.ts`
- Modify: `apps/web/components/StartEnrichmentButton.tsx`
- Modify: `apps/web/app/api/enrich/connect-only/route.ts`

- [ ] **Step 1: Add the batch queue action**

```typescript
export async function queueInvitesForBatch(batchId: number): Promise<{ queued: number }> {
  const client = supabaseAdmin();
  const { data, error } = await client
    .from("leads")
    .update({ status: "QUEUED_CONNECT" })
    .eq("batch_id", batchId)
    .in("status", ["NEW", "ENRICHED"])
    .select("id");
  if (error) throw error;
  return { queued: (data ?? []).length };
}
```

- [ ] **Step 2: Keep `connect_message` as the enrichment path, repurpose `connect_only` as invite-only**

Update the connect-only server route so it spawns the sender worker in invite mode, not the scraper.

```typescript
const args = ["sender.py", "--send-invites", "--batch-id", String(batchId)];
```

Keep `/api/enrich` for the existing enrichment path used by Connect + Message leads.

- [ ] **Step 3: Update the button labels**

In `StartEnrichmentButton.tsx`, keep the message-mode label as the enrichment action, and change the connect-only mode to invite-only language:

```typescript
connect_only: {
  statusUrl: "/api/enrich/status?mode=connect_only",
  startEndpoint: "/api/enrich/connect-only",
  startLabel: "SEND INVITES",
  runningLabel: "STARTING…",
  buttonClass: "btn secondary",
  defaultStartMessage: "Invite sender started.",
},
```

- [ ] **Step 4: Typecheck and commit**

Run:
```bash
cd apps/web && npx tsc --noEmit
```

Commit:
```bash
git add apps/web/app/actions.ts apps/web/components/StartEnrichmentButton.tsx apps/web/app/api/enrich/connect-only/route.ts
git commit -m "feat(web): repurpose connect_only into invite-only sender"
```

---

## Task 5: Sender Invite Mode and Sequence-Based Post-Acceptance Messages

**Files:**
- Modify: `workers/sender/sender.py`
- Create: `workers/sender/sequence_render.py`
- Create: `workers/sender/test_sequence_render.py`

- [ ] **Step 1: Add a pure renderer for sequence text**

```python
TOKEN_PATTERN = re.compile(r"\{\{[^{}\n]+\}\}")

@dataclass
class RenderResult:
    text: str
    used_fallbacks: list[str] = field(default_factory=list)
    missing_slots: list[str] = field(default_factory=list)

def render_step(template: str, slots: dict[str, str | None], fallbacks: dict[str, str]) -> RenderResult:
    ...
```

Tests should cover:
- canonical tokens are substituted
- missing tokens fall back cleanly
- blank values use fallbacks
- unknown tokens stay intact
- whitespace collapses after substitution

- [ ] **Step 2: Add `--send-invites`**

Fetch `QUEUED_CONNECT` leads, load the sequence, render `connect_note`, and send the invite note only if it exists.

```python
def fetch_queued_invites(client: Client, limit: int | None = None):
    return (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, company_name, sequence_id")
        .eq("status", "QUEUED_CONNECT")
        .not_.is_("sequence_id", "null")
        .limit(limit or 100)
        .execute()
        .data
        or []
    )
```

After a successful send, mark the lead as `CONNECT_ONLY_SENT`, set `connection_sent_at`, and leave enrichment out of this path entirely.

- [ ] **Step 3: Keep post-acceptance sending on the same sequence source**

Update the existing `message_only` flow so `process_message_only_one()` renders `first_message` through `render_step` with the same slot map and fallback map used for invites.

```python
rendered = render_step(
    template=sequence.get("first_message") or "",
    slots=build_lead_slots(lead),
    fallbacks=sequence.get("slot_fallbacks") or {},
)
message_text = rendered.text
```

This keeps accepted-connection messaging sequence-driven and removes the last dependency on `drafts`.

- [ ] **Step 4: Add a smoke test**

```python
def test_render_step_uses_fallbacks_for_invite_notes():
    from sequence_render import render_step

    result = render_step(
        template="Hi {{first_name}} from {{company_name}}",
        slots={"{{first_name}}": None, "{{company_name}}": "Acme"},
        fallbacks={"{{first_name}}": "there"},
    )
    assert result.text == "Hi there from Acme"
    assert result.used_fallbacks == ["{{first_name}}"]
```

Run:
```bash
cd workers/sender && venv/bin/pytest test_sequence_render.py -v
```

- [ ] **Step 5: Commit**

```bash
git add workers/sender/sender.py workers/sender/sequence_render.py workers/sender/test_sequence_render.py
git commit -m "feat(sender): invite-only connect flow and sequence rendering"
```

---

## Task 6: Independent Enrichment Worker

**Files:**
- Modify: `workers/scraper/scraper.py`
- Modify: `run_all.sh`
- Modify: `apps/web/app/api/enrich/status/route.ts`
- Create: `apps/web/components/EnrichmentStatusCard.tsx`
- Modify: `apps/web/app/leads/page.tsx`

- [ ] **Step 1: Add an enrichment loop**

Use the existing per-lead enrichment logic, but run it on `enrichment_ready = false` leads in a loop and never send invites from this path.

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
            time.sleep(idle_seconds)
            continue
        ...
```

- [ ] **Step 2: Add `--enrichment` to `run_all.sh`**

`run_all.sh --enrichment` should start the enrichment loop as a distinct service process, with its own pid file and log file, and should not share the invite sender lock.

- [ ] **Step 3: Add the status card**

The status endpoint should expose `enrichment_worker.pending` and `enrichment_worker.last_ready_at`, and the leads page should show a simple read-only card next to the invite controls.

```tsx
<div className="card">
  <div className="pill">ENRICHMENT WORKER</div>
  <div className="muted">Queue: {status.pending} • Last ready: ...</div>
</div>
```

- [ ] **Step 4: Typecheck and commit**

Run:
```bash
cd apps/web && npx tsc --noEmit
```

Commit:
```bash
git add workers/scraper/scraper.py run_all.sh apps/web/app/api/enrich/status/route.ts apps/web/components/EnrichmentStatusCard.tsx apps/web/app/leads/page.tsx
git commit -m "feat(scraper): split enrichment into independent background loop"
```

---

## Task 7: End-to-End Smoke Check

- [ ] **Step 1: Create a connect_only batch with an invite note**

In the sequence editor, assign a batch whose label resolves to `connect_only`, then add:

```text
Hi {{first_name}}, saw your work at {{company_name}}.
```

The note editor should be visible only for that batch intent and must reject anything over 300 chars.

- [ ] **Step 2: Queue and send invites**

Queue the batch with `queueInvitesForBatch(batchId)`, then click `SEND INVITES`.

Expected:
- leads move to `QUEUED_CONNECT`
- sender logs show `--send-invites`
- successful leads move to `CONNECT_ONLY_SENT`

- [ ] **Step 3: Run enrichment separately**

Start `./run_all.sh --enrichment` and confirm it processes only `enrichment_ready = false` leads.

- [ ] **Step 4: Confirm post-acceptance messaging uses the sequence**

Use the existing message-only path for one accepted lead and verify the rendered message comes from `first_message` plus sequence fallbacks, not from drafts.

- [ ] **Step 5: Commit any doc updates**

```bash
git add -A
git commit -m "docs: sequence-driven outreach smoke notes" --allow-empty
```

---

## Self-Review Checklist

- [ ] `connect_only` now means invite-only sending, not enrichment.
- [ ] Enrichment runs in its own loop and does not share the invite sender path.
- [ ] The invite note field is visible only for batches inferred as `connect_only`.
- [ ] Connect-note validation caps worst-case rendered length at 300 chars.
- [ ] `QUEUED_CONNECT` is added correctly to the enum, not treated like a check constraint.
- [ ] Post-acceptance messages still come from the sequence renderer.
- [ ] No new dependencies were introduced.
- [ ] File count stays tight and each file has one responsibility.

---

## Out of Scope

- Removing legacy DraftFeed / approval paths entirely.
- Replacing label-based batch intent inference with a new persisted batch-mode column.
- Advanced concurrent-worker coordination between invite and enrichment services.
