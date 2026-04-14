# LinkedIn Sequences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multiple manually editable outreach sequences that can each be assigned to a CSV batch, where one CSV equals one batch, then send a connection request first, then automatically send message 1 after connection acceptance, and send messages 2 and 3 as timed follow-ups every 3 days if there is no reply.

**Architecture:** Keep the feature inside the existing monolith and reuse the current lead/status/draft flow instead of introducing a separate scheduler system. Add a sequence definition model with reusable batch bindings, a sequence-aware sender state machine, and a minimal UI for editing multiple 3-step sequences and assigning each one to exactly one CSV batch. Use the existing Playwright sender and Supabase tables as the source of truth, with acceptance detection done first from the profile action state and only falling back to inbox/thread checks when the profile state is ambiguous.

**Tech Stack:** Next.js App Router, React, TypeScript, Supabase/Postgres, existing Python Playwright sender worker, existing MCP agent prompt pipeline, existing logging helpers.

**Files:** `supabase/schema.sql`, `supabase/migrations/010_add_outreach_sequences.sql`, `apps/web/app/actions.ts`, `apps/web/app/page.tsx`, `apps/web/components/SequenceEditor.tsx`, `apps/web/components/DraftFeed.tsx`, `apps/web/components/LeadList.tsx`, `workers/sender/sender.py`, `workers/sender/README.md`, `mcp-server/run_agent.py`, `mcp-server/prompt_followup.txt`, `README.md`, `apps/web/app/leads/page.tsx`

**LOC/file:** target 50-400 LOC per touched file, with the largest edit centered in `workers/sender/sender.py` and `apps/web/app/actions.ts`; keep new files small and single-purpose.

**Deps:** 0 new runtime dependencies. Reuse the existing Supabase client, Next.js app router, and Playwright worker.

---

### Task 1: Extend the data model for global sequence templates and per-lead sequence state

**Files:**
- Modify: `supabase/schema.sql:38-78`
- Modify: `supabase/migrations/007_enhance_followups.sql`
- Modify: `supabase/migrations/009_add_last_message_tracking.sql`
- Create: `supabase/migrations/010_add_outreach_sequences.sql`
- Modify: `apps/web/app/actions.ts:1180-1485`

- [ ] **Step 1: Write the failing migration test by checking the expected schema contract**

Run:
```bash
npm --prefix apps/web exec -- node -e "console.log('schema contract will be added in migration 010')"
```
Expected: no schema support for `outreach_sequences` or per-lead sequence pointers yet.

- [ ] **Step 2: Add the SQL migration**

Create a migration that adds:
```sql
create table if not exists outreach_sequences (
  id bigserial primary key,
  name text not null,
  context_key text not null unique,
  first_message text not null,
  second_message text not null,
  third_message text not null,
  followup_interval_days int not null default 3,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists outreach_sequence_batches (
  id bigserial primary key,
  sequence_id bigint not null references outreach_sequences(id) on delete cascade,
  batch_name text not null,
  batch_value text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table leads
  add column if not exists sequence_step int not null default 0,
  add column if not exists sequence_started_at timestamptz,
  add column if not exists sequence_last_sent_at timestamptz,
  add column if not exists sequence_last_reply_at timestamptz,
  add column if not exists sequence_stopped_at timestamptz,
  add column if not exists sequence_id bigint references outreach_sequences(id),
  add column if not exists sequence_context jsonb not null default '{}'::jsonb,
  add column if not exists csv_batch_id bigint references outreach_sequence_batches(id);

insert into outreach_sequences (name, context_key, first_message, second_message, third_message)
values ('Default Sequence', 'default', '', '', '')
on conflict (context_key) do nothing;

-- CSV batches are imported from uploaded lead files and each batch maps to exactly one sequence.
```
Keep the default sequence editable, but allow additional sequence rows and per-sequence context mappings.

- [ ] **Step 3: Wire the schema into the web action layer**

Update the analytics and action helpers in `apps/web/app/actions.ts` so lead records can expose sequence fields, and add a small helper that determines whether a lead is active in the sequence, waiting for acceptance, waiting for reply, or finished.

- [ ] **Step 4: Verify the schema in Supabase**

Run:
```bash
npm run lint:web
```
Then apply the migration in the local/dev database and confirm `outreach_sequences` exists and `leads` has the new columns.

- [ ] **Step 5: Commit**

```bash
git add supabase/schema.sql supabase/migrations/010_add_outreach_sequences.sql apps/web/app/actions.ts
git commit -m "feat: add sequence data model"
```

### Task 2: Add a global sequence editor in the web app

**Files:**
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/components/DraftFeed.tsx`
- Create: `apps/web/components/SequenceEditor.tsx`
- Modify: `apps/web/app/actions.ts:1-240, 666-1095`

- [ ] **Step 1: Write the failing UI contract test by inspecting the page behavior manually**

Run:
```bash
npm --prefix apps/web run dev
```
Expected: no sequence editor exists yet, and there is no place to enter three global messages.

- [ ] **Step 2: Build the editor component**

Create `SequenceEditor.tsx` with:
```tsx
type SequenceEditorProps = {
  firstMessage: string;
  secondMessage: string;
  thirdMessage: string;
  followupIntervalDays: number;
  onSave: (value: { firstMessage: string; secondMessage: string; thirdMessage: string; followupIntervalDays: number }) => Promise<void>;
};
```
Use plain textareas and one number input. Keep it global, not per lead, and show a note that message 1 is sent after acceptance while messages 2 and 3 are timed follow-ups.

- [ ] **Step 3: Add server actions for reading and saving the global template**

Add `fetchOutreachSequences()`, `saveOutreachSequence()`, and `saveSequenceBatchBinding()` in `apps/web/app/actions.ts`. They should read/write multiple sequence rows, normalize whitespace before saving, and let the user attach exactly one CSV batch to a specific sequence.

- [ ] **Step 4: Mount the editor on the main page**

Render the sequence manager near the existing outreach controls in `apps/web/app/page.tsx`, and pass the loaded sequences and batch bindings down from the page loader. Keep the existing draft feed intact. The page should make it clear that one CSV produces one batch and that a batch can be assigned to one sequence only.

- [ ] **Step 5: Run the web app and verify the editor**

Run:
```bash
npm run dev:web
```
Expected: the page shows a sequence manager, can create multiple sequences, can edit each sequence, can assign a CSV batch to a sequence, and reloads with the same content. The UI should not allow one batch to be assigned to more than one sequence at the same time.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/actions.ts apps/web/components/SequenceEditor.tsx apps/web/components/DraftFeed.tsx
git commit -m "feat: add global sequence editor"
```

### Task 3: Convert the sender worker into a sequence state machine

**Files:**
- Modify: `workers/sender/sender.py`
- Modify: `workers/sender/README.md`
- Modify: `mcp-server/run_agent.py`
- Modify: `mcp-server/prompt_followup.txt`

- [ ] **Step 1: Write the failing behavior check around message routing**

Run:
```bash
python -m py_compile workers/sender/sender.py mcp-server/run_agent.py
```
Expected: no sequence-aware routing yet; sender only knows the old approved draft flow.

- [ ] **Step 2: Add sequence-stage helpers in the sender**

Implement helpers that decide:
```python
sequence_step == 0 -> send connection request
sequence_step == 1 -> if accepted, send first message
sequence_step == 2 -> if no reply and due, send second message
sequence_step == 3 -> if no reply and due, send third message
```
Reuse the existing `open_message_surface()` and `send_message()` paths, and resolve the correct sequence row by looking up the lead's CSV batch against the available sequence batch bindings.

- [ ] **Step 3: Add acceptance detection**

Implement the primary check by inspecting the profile action state on the same page the sender already visits:
```python
def detect_connection_acceptance(page: Page) -> bool:
    ...
```
Return true when the profile shows a connected message surface or equivalent message action, and fall back to inbox/thread detection only if the profile state is unclear.

- [ ] **Step 4: Make the follow-up cadence explicit**

Use `sequence_last_sent_at` and `followup_interval_days` to decide when message 2 or 3 is eligible. Keep the default interval at 3 days.

- [ ] **Step 5: Update follow-up generation for reply-aware conversation**

Adapt `mcp-server/prompt_followup.txt` so follow-up generation can produce:
```json
{ "message": "...", "message_type": "reply_positive | reply_neutral | reply_negative | nudge_first | nudge_final", "tone": "friendly | closing" }
```
and ensure reply-based messages stop the timed fallback branch for that lead.

- [ ] **Step 6: Verify the sender compiles**

Run:
```bash
python -m py_compile workers/sender/sender.py mcp-server/run_agent.py
```
Expected: clean compilation after the new helpers are added.

- [ ] **Step 7: Commit**

```bash
git add workers/sender/sender.py workers/sender/README.md mcp-server/run_agent.py mcp-server/prompt_followup.txt
git commit -m "feat: sequence-aware sender state machine"
```

### Task 4: Add sequence-aware lead controls and status transitions

**Files:**
- Modify: `apps/web/app/actions.ts`
- Modify: `apps/web/components/DraftFeed.tsx`
- Modify: `apps/web/components/LeadList.tsx`

- [ ] **Step 1: Write the failing UI/state transition checks**

Run:
```bash
npm --prefix apps/web run lint
```
Expected: the UI still assumes one-off drafts and does not expose sequence lifecycle controls.

- [ ] **Step 2: Add sequence start/stop actions**

Implement actions to:
```ts
startSequenceForLead(leadId)
stopSequenceForLead(leadId)
markConnectionAccepted(leadId)
markSequenceReply(leadId, replyText)
```
Each action should update the lead timestamps and sequence_step atomically.

- [ ] **Step 3: Update the feed to show sequence progress**

In `DraftFeed.tsx`, show whether a lead is:
```txt
waiting for connection
waiting for reply follow-up 1
waiting for reply follow-up 2
waiting for reply follow-up 3
done
```
Keep the current draft list working for existing outreach modes.

- [ ] **Step 4: Surface the sequence state in the lead list**

Add a compact sequence badge in `LeadList.tsx` so operators can see which CSV batch each lead belongs to, which sequence it uses, and where it is in that sequence without opening the detail view.

- [ ] **Step 5: Run the web lint and smoke test the UI**

Run:
```bash
npm run lint:web
```
Then open the app and verify a lead can be started, advanced, and stopped through the new sequence state.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/actions.ts apps/web/components/DraftFeed.tsx apps/web/components/LeadList.tsx
git commit -m "feat: expose sequence controls in ui"
```

### Task 5: Add automated coverage for the new sequence behavior

**Files:**
- Create: `apps/web/app/__tests__/sequence-actions.test.ts`
- Create: `workers/sender/tests/test_sequence_state.py`
- Modify: `package.json`

- [ ] **Step 1: Write the failing tests**

Add tests for:
```ts
// web action: saving and loading the global sequence
// sender behavior: acceptance detection fallback and 3 day follow-up scheduling
```
and Python tests for the message routing/state helpers.

- [ ] **Step 2: Implement the minimal test harness**

Use the repo’s existing test runner pattern if present. If none exists for the web side, keep the tests narrow and runnable with the current tooling rather than introducing a new framework.

- [ ] **Step 3: Run the targeted tests**

Run:
```bash
npm run lint:web
python -m py_compile workers/sender/sender.py mcp-server/run_agent.py
```
Then run the new tests from their exact locations.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/__tests__/sequence-actions.test.ts workers/sender/tests/test_sequence_state.py package.json
git commit -m "test: cover sequence workflow"
```

### Task 6: Update docs and operator notes

**Files:**
- Modify: `README.md`
- Modify: `workers/sender/README.md`
- Modify: `apps/web/app/leads/page.tsx`

- [ ] **Step 1: Document the new operating model**

Add a short operator note that explains:
```txt
Global sequence template
Connection request first
Message 1 after acceptance
Message 2 and 3 every 3 days if no reply
Reply stops the timed fallback path
```

- [ ] **Step 2: Explain the acceptance detection rule**

Document that the system tries profile-state detection first, then inbox/thread fallback only when needed.

- [ ] **Step 3: Run a final repo smoke check**

Run:
```bash
npm run lint:web
python -m py_compile workers/sender/sender.py mcp-server/run_agent.py
```

- [ ] **Step 4: Commit**

```bash
git add README.md workers/sender/README.md apps/web/app/leads/page.tsx
git commit -m "docs: describe sequence outreach workflow"
```

## Self-Review

- Spec coverage: multiple template storage, one CSV per batch binding, manual editing, sender state machine, acceptance detection, timed follow-ups, reply stop condition, UI surfacing, and tests all have tasks.
- Placeholder scan: no TBD/TODO blocks remain in the plan.
- Type consistency: sequence uses `firstMessage`, `secondMessage`, `thirdMessage`, `followupIntervalDays`, and per-lead `sequence_step` / `sequence_*_at` fields consistently across tasks.
- Scope check: this is one feature slice, not multiple independent products. If you want reply intelligence to become its own drafting engine later, that can be a separate plan.
