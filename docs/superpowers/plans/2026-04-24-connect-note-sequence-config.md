# Connect Note Sequence Config Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the invite note for `Connect + Message` batches a sequence-owned field that is edited in the sequence configurator, assigned per batch through the existing sequence mapping, and consumed by the sender when it opens LinkedIn's connect-note dialog.

**Architecture:** `outreach_sequences` becomes the single source of truth for both post-acceptance messages and the invite note. Batch intent still comes from CSV upload (`connect_message` vs `connect_only`), but a `connect_message` batch only becomes operational when its assigned sequence has a configured `connect_note`. The web app edits and previews that note in the same sequence editor that already owns `Message 1/2/3`, and the sender resolves the note from the same sequence row before typing into LinkedIn. The existing 300-character invite-note limit stays enforced at the sender boundary.

**Tech Stack:** Next.js 14 app router, React 18, Supabase Postgres, Python Playwright workers, TypeScript, built-in `unittest`, zero new dependencies.

**Scope:** `{files: 5 modified, 2 new, LOC/file: 40-260, deps: 0}`

**Source spec:** `docs/superpowers/specs/2026-04-17-sequence-driven-outreach-design.md`

---

## Conventions

- Canonical sequence placeholders stay `{{first_name}}`, `{{last_name}}`, `{{full_name}}`, `{{company_name}}`.
- UI label should say `Invite note` or `Connect note`; the database field should be `connect_note`.
- `connect_note` is used only for the LinkedIn invite dialog. `first_message` remains the first direct message after acceptance.
- No new dependencies. Use the existing Next.js, Supabase, and Python tooling.

---

## File Structure

### New files

- `supabase/migrations/011_add_sequence_connect_note.sql` - add the new sequence column with a safe backfill
- `workers/sender/test_sequence_messages.py` - built-in `unittest` coverage for sequence note loading and placeholder rendering

### Modified files

- `supabase/schema.sql` - keep the local bootstrap schema aligned with the migration
- `apps/web/app/actions.ts` - read/write `connect_note` in sequence CRUD and validation
- `apps/web/lib/sequencePlaceholders.ts` - validate `connect_note` with the same placeholder rules as the other sequence fields
- `apps/web/components/SequenceEditor.tsx` - expose the connect note field and show batch/sequence previews
- `workers/sender/sender.py` - resolve `connect_note` for the invite dialog and keep the 300-char cap

---

## Task 1: Add the sequence contract and storage field

**Files:**
- Create: `supabase/migrations/011_add_sequence_connect_note.sql`
- Modify: `supabase/schema.sql`
- Modify: `apps/web/app/actions.ts`
- Modify: `apps/web/lib/sequencePlaceholders.ts`

- [ ] **Step 1: Write the migration**

```sql
-- Add an invite note to outreach_sequences.
-- Existing sequences get an empty string so the UI can save immediately.

ALTER TABLE outreach_sequences
  ADD COLUMN IF NOT EXISTS connect_note text NOT NULL DEFAULT '';

UPDATE outreach_sequences
SET connect_note = COALESCE(connect_note, '')
WHERE connect_note IS NULL;
```

- [ ] **Step 2: Extend the shared TypeScript row and save/load contract**

```ts
export type OutreachSequenceRow = {
  id: number;
  name: string;
  connect_note: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
  is_active?: boolean;
  created_at?: string;
  updated_at?: string;
};

export async function fetchOutreachSequences() {
  const client = supabaseAdmin();
  const { data, error } = await client
    .from("outreach_sequences")
    .select("id, name, connect_note, first_message, second_message, third_message, followup_interval_days, is_active, created_at, updated_at")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []) as OutreachSequenceRow[];
}

export async function saveOutreachSequence(input: {
  id?: number;
  name: string;
  connect_note: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
}) {
  const payload = {
    name: input.name.trim(),
    connect_note: input.connect_note.trim(),
    first_message: input.first_message.trim(),
    second_message: input.second_message.trim(),
    third_message: input.third_message.trim(),
    followup_interval_days: input.followup_interval_days,
  };
  // validate connect_note with the same placeholder rules as the other fields
}
```

- [ ] **Step 3: Add `connect_note` to placeholder validation**

```ts
export type SequenceMessageField = "connect_note" | "first_message" | "second_message" | "third_message";

const DOUBLE_CURLY_TOKEN_REGEX = /\{\{[^{}\n]+\}\}/g;
const SINGLE_CURLY_TOKEN_REGEX = /\{[^{}\n]+\}/g;
const BRACKET_TOKEN_REGEX = /\[[^\[\]\n]+\]/g;

export function validateSequencePlaceholdersByField(
  fields: Record<SequenceMessageField, string>
): SequencePlaceholderValidationByFieldResult {
  const result = validateSequencePlaceholderFields(fields);
  return {
    isValid: result.isValid,
    errors: result.errors.map((entry) => ({
      fieldKey: entry.field,
      invalidTokens: entry.invalidTokens,
      allowedTokens: entry.allowedTokens,
    })),
    allowedTokens: CANONICAL_SEQUENCE_PLACEHOLDERS,
  };
}
```

- [ ] **Step 4: Verify the TypeScript contract**

Run:
```bash
cd apps/web && npx tsc --noEmit
cd apps/web && npm run lint
```

Expected: both commands pass with `connect_note` included in the sequence types and validation paths.

---

## Task 2: Add the connect note to the sequence configurator and batch preview

**Files:**
- Modify: `apps/web/components/SequenceEditor.tsx`

- [ ] **Step 1: Add the note to the editor draft and form**

```tsx
type Draft = {
  name: string;
  connect_note: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
};

const emptyDraft = (): Draft => ({
  name: "",
  connect_note: "",
  first_message: "",
  second_message: "",
  third_message: "",
  followup_interval_days: 3,
});

<label>Invite Note</label>
<textarea
  className="textarea"
  value={draft.connect_note}
  onChange={(event) => setDraft((prev) => ({ ...prev, connect_note: event.target.value }))}
  placeholder="Text sent with the connection request"
  aria-invalid={fieldErrors.connect_note.length > 0}
/>
<div className="muted" style={{ marginTop: 6 }}>
  Used only for Connect + Message batches. The sender will cap this at 300 characters after rendering placeholders.
</div>
```

- [ ] **Step 2: Show the note where batches are assigned to sequences**

```tsx
{selectedSequence ? (
  <div style={{ marginTop: 8 }}>
    <div className="pill">Connect note preview</div>
    <div className="muted" style={{ marginTop: 6 }}>
      {selectedSequence.connect_note?.trim()
        ? selectedSequence.connect_note.trim()
        : "No invite note configured yet."}
    </div>
  </div>
) : null}
```

- [ ] **Step 3: Keep the batch assignment helper copy explicit**

```tsx
<div className="muted" style={{ marginBottom: 16 }}>
  Sequences are used only after a connection is accepted. Invite notes live here too, and the assigned sequence controls the invite message for Connect + Message batches.
</div>
```

- [ ] **Step 4: Verify the editor copy and controlled inputs in the browser**

Run:
```bash
npm --prefix apps/web run dev -- --hostname 0.0.0.0 --port 3000
```

Expected:
- the sequence editor shows `Invite Note`
- the selected sequence shows a preview of the invite text
- the save form still edits `Message 1/2/3` with no regression in batch assignment

---

## Task 3: Teach the sender to use the sequence-owned invite note

**Files:**
- Modify: `workers/sender/sender.py`
- Create: `workers/sender/test_sequence_messages.py`

- [ ] **Step 1: Load `connect_note` alongside the other sequence fields**

```python
def load_sequence_messages(client: Client, lead: Dict[str, Any]) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "connect_note": "",
        "first_message": SEQUENCE_DEFAULT_MESSAGES["first_message"],
        "second_message": SEQUENCE_DEFAULT_MESSAGES["second_message"],
        "third_message": SEQUENCE_DEFAULT_MESSAGES["third_message"],
        "followup_interval_days": SEQUENCE_INTERVAL_DEFAULT_DAYS,
        "source": "defaults",
    }

    query = client.table("outreach_sequences").select(
        "id, connect_note, first_message, second_message, third_message, followup_interval_days, is_active, created_at"
    )
    # ... keep the existing sequence-id lookup and settings fallback logic
    # ... but populate result["connect_note"] from the row/template if present
```

- [ ] **Step 2: Use the sequence note when the sender opens the invite dialog**

```python
sequence_messages = load_sequence_messages(client, lead)
connect_note = (sequence_messages.get("connect_note") or "").strip()
message = build_message(draft)

surface = await open_message_surface(page)
if surface == "connect_note":
    note = connect_note or message
    if not connect_note:
        logger.warn("Missing connect_note on sequence; falling back to legacy draft message", {"leadId": lead_id})
    await send_message(page, note, surface, draft)
else:
    await send_message(page, message, surface, draft)
```

- [ ] **Step 3: Keep the existing 300-character safety cap**

```python
if surface == "connect_note":
    safe_message = (message or "").strip()
    if len(safe_message) > 300:
        safe_message = safe_message[:297] + "..."
```

- [ ] **Step 4: Add a focused unittest for sequence note hydration**

```python
import unittest

from sender import load_sequence_messages


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def execute(self):
        return self


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows
        self.table_name = ""

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        return FakeResponse(self.rows[self.table_name])


class FakeClient:
    def __init__(self, rows):
        self.rows = rows

    def table(self, table_name):
        query = FakeQuery(self.rows)
        query.table_name = table_name
        return query


class LoadSequenceMessagesTest(unittest.TestCase):
    def test_connect_note_is_hydrated_from_sequence_row(self):
        client = FakeClient(
            {
                "outreach_sequences": [
                    {
                        "id": 7,
                        "connect_note": "Hi {{first_name}}",
                        "first_message": "Hello {{first_name}}",
                        "second_message": "",
                        "third_message": "",
                        "followup_interval_days": 3,
                        "is_active": True,
                        "created_at": "2026-04-24T00:00:00Z",
                    }
                ],
                "settings": [],
            }
        )
        lead = {"sequence_id": 7, "first_name": "Mia", "last_name": "Lopez", "company_name": "ACME"}
        result = load_sequence_messages(client, lead)
        self.assertEqual(result["connect_note"], "Hi Mia")
```

- [ ] **Step 5: Run the Python test and the sender syntax check**

Run:
```bash
cd workers/sender && python -m unittest test_sequence_messages.py -v
python -m compileall workers/sender/sender.py
```

Expected:
- the unittest passes and proves the invite note is loaded from the sequence row
- `sender.py` still compiles cleanly after the new branch logic

---

## Task 4: End-to-end browser smoke and rollout check

**Files:**
- None new if the first three tasks already cover the code changes

- [ ] **Step 1: Exercise the UI in a real browser**

Run:
```bash
npm run dev:web
```

Smoke path:
1. Open `/upload` and create a `connect_message` batch.
2. Open `/` and create or edit a sequence.
3. Enter an `Invite Note`.
4. Assign that sequence to the uploaded batch.
5. Confirm the batch card shows the sequence and the invite-note preview.
6. Open the approved lead path and verify the sender still treats `Message 1` as the first post-acceptance message.

Expected:
- the invite note is visible where the sequence is configured
- the batch preview makes it obvious which invite note belongs to which batch
- no regression in the direct message flow or 300-character cap

- [ ] **Step 2: Re-run the earlier checks after the browser smoke**

Run:
```bash
cd apps/web && npx tsc --noEmit
cd apps/web && npm run lint
cd workers/sender && python -m unittest test_sequence_messages.py -v
```

Expected: all checks still pass after the browser-verified changes.

---

## Self-Review

- Spec coverage: the plan covers the new storage field, the sequence editor UI, the sender runtime, and a focused unit test.
- Placeholder scan: no `TBD`, `TODO`, or vague validation steps remain.
- Type consistency: the canonical field name is `connect_note`; `Invite Note` is the UI label only; `first_message` remains the post-acceptance first DM.
- Scope check: this stays inside the existing monolith and does not introduce new dependencies or new services.
