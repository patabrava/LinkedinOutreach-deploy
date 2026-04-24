# Custom Outreach Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate `Custom Outreach` tab where an operator chooses a batch up front, generates one custom draft per lead in that batch, reviews those drafts manually, and sends only the approved ones.

**Architecture:** Keep `Mission Control` focused on the automated sequence workflow and move all manual per-lead drafting into a separate route. Store custom-vs-automated batch intent at import time, scope draft generation and bulk send operations to a single batch, and reuse the existing lead/draft/send lifecycle instead of inventing a second sender. The new tab is batch-scoped, but it should still use the same per-lead approval and send primitives the current system already trusts.

**Tech Stack:** Next.js App Router, React, Supabase Postgres, TypeScript, existing Python draft agent, existing Playwright sender, zero new dependencies.

**Scope:** `{files: 6 modified, 5 new, LOC/file: 40-420, deps: 0}`

---

## File Structure

### New files

- `supabase/migrations/012_custom_outreach_batch_intent.sql` - persist batch intent so custom batches can be queried separately from automated ones.
- `apps/web/lib/batchIntent.ts` - normalize upload-time batch intent values and keep the UI/server contract in one place.
- `apps/web/app/custom-outreach/page.tsx` - new route for the custom outreach workspace.
- `apps/web/components/CustomOutreachWorkspace.tsx` - batch selector, per-lead custom draft editor, and batch-scoped send actions.
- `agents/testscripts/custom-outreach-smoke.sh` - end-to-end smoke for the new tab and import flow.

### Modified files

- `supabase/schema.sql` - align the local bootstrap schema with the new batch-intent column.
- `apps/web/components/CSVUploader.tsx` - add `Custom Outreach` as a third import-time choice.
- `apps/web/app/upload/page.tsx` - explain the new batch-intent option in the upload flow.
- `apps/web/app/actions.ts` - persist the batch intent, scope draft fetch/generation/send to one batch, and expose custom-outreach batch queries.
- `apps/web/components/NavBar.tsx` - add the new top-level tab.
- `mcp-server/run_agent.py` - allow draft generation to target one batch instead of the whole queue.

---

## Task 1: Persist custom batch intent at import time

**Files:**
- Create: `supabase/migrations/012_custom_outreach_batch_intent.sql`
- Modify: `supabase/schema.sql`
- Create: `apps/web/lib/batchIntent.ts`
- Modify: `apps/web/components/CSVUploader.tsx`
- Modify: `apps/web/app/upload/page.tsx`
- Modify: `apps/web/app/actions.ts`

- [ ] **Step 1: Add the batch intent column and backfill existing rows**

```sql
ALTER TABLE lead_batches
  ADD COLUMN IF NOT EXISTS batch_intent text NOT NULL DEFAULT 'connect_message';

ALTER TABLE lead_batches
  ADD CONSTRAINT lead_batches_batch_intent_check
  CHECK (batch_intent IN ('connect_message', 'connect_only', 'custom_outreach'));

UPDATE lead_batches
SET batch_intent = 'connect_message'
WHERE batch_intent IS NULL;
```

- [ ] **Step 2: Add a shared batch-intent helper and thread it through importLeads**

```ts
export type BatchIntent = "connect_message" | "connect_only" | "custom_outreach";

export function normalizeBatchIntent(value: string | null | undefined): BatchIntent {
  if (value === "connect_only") return "connect_only";
  if (value === "custom_outreach") return "custom_outreach";
  return "connect_message";
}

export async function importLeads(
  rows: LeadCsvRow[],
  fileName?: string,
  batchIntent: BatchIntent = "connect_message"
) {
  const batchName = `${fileName?.trim() || "CSV batch"} (${batchIntent})`;
  // insert lead_batches.batch_intent with the chosen intent
}
```

```ts
export type LeadBatchRow = {
  id: number;
  name: string;
  source: string;
  sequence_id: number | null;
  batch_intent: BatchIntent;
  created_at: string;
  updated_at: string;
};

export type CustomOutreachBatchSummary = LeadBatchRow & {
  lead_count: number;
  draft_count: number;
  approved_count: number;
};
```

- [ ] **Step 3: Add `Custom Outreach` to the CSV uploader and make the choice explicit**

```tsx
<button
  type="button"
  className={`btn ${mode === "custom_outreach" ? "accent" : "secondary"}`}
  aria-pressed={mode === "custom_outreach"}
  onClick={() => setModeAndNotify("custom_outreach")}
>
  Custom Outreach
</button>
```

```tsx
<div className="muted" style={{ marginBottom: 16 }}>
  Custom Outreach creates a batch that is drafted one lead at a time and reviewed manually before any send.
</div>
```

- [ ] **Step 4: Verify the import contract**

Run:
```bash
cd apps/web && npx tsc --noEmit
cd apps/web && npm run lint
```

Expected: the batch-intent type compiles, the uploader exposes the third intent, and `importLeads` stores the new `lead_batches.batch_intent` value without breaking the existing two modes.

---

## Task 2: Scope draft generation and bulk send to one batch

**Files:**
- Modify: `apps/web/app/actions.ts`
- Modify: `mcp-server/run_agent.py`

- [ ] **Step 1: Add batch-scoped draft fetching and bulk operations**

```ts
export async function fetchDraftFeed(
  outreachMode: OutreachMode = "connect_message",
  batchId?: number
) {
  // existing mode filter + optional .eq("batch_id", batchId)
}

export async function fetchCustomOutreachBatches() {
  // return batch rows plus lead_count / draft_count / approved_count for batches where batch_intent === "custom_outreach"
}

export async function approveAndSendAllDrafts(
  outreachMode: OutreachMode = "connect_message",
  batchId?: number
) {
  // approve only the drafts that belong to the selected batch
}
```

- [ ] **Step 2: Let the draft agent generate only for one batch**

```ts
export async function triggerDraftGeneration(
  promptType: PromptType = 1,
  outreachMode: OutreachMode = "connect_message",
  batchId?: number
) {
  // pass --batch-id <id> to the agent when batchId is supplied
}
```

```python
parser.add_argument("--batch-id", type=int, default=None)

if args.batch_id is not None:
    leads_query = leads_query.eq("batch_id", args.batch_id)
```

- [ ] **Step 3: Keep the sender path unchanged**

The custom tab should still use the existing `sendLeadNow` and `approveDraft` semantics. The only new behavior is the batch filter; no new sender mode is introduced.

- [ ] **Step 4: Verify batch isolation**

Run:
```bash
cd apps/web && npx tsc --noEmit
python mcp-server/run_agent.py --help
```

Expected: the batch flag is accepted by the agent, and the action signatures compile with the new optional batch scope.

---

## Task 3: Build the `Custom Outreach` tab and workspace

**Files:**
- Modify: `apps/web/components/NavBar.tsx`
- Create: `apps/web/app/custom-outreach/page.tsx`
- Create: `apps/web/components/CustomOutreachWorkspace.tsx`

- [ ] **Step 1: Add the navigation entry**

```ts
const NAV_ITEMS = [
  { href: "/", label: "Mission Control" },
  { href: "/custom-outreach", label: "Custom Outreach" },
  { href: "/leads", label: "Leads" },
  { href: "/upload", label: "Upload" },
  { href: "/followups", label: "Follow-ups" },
  { href: "/analytics", label: "Analytics" },
  { href: "/settings", label: "Settings" },
];
```

- [ ] **Step 2: Add the new page shell**

```tsx
export default async function CustomOutreachPage() {
  await requireServerSession("/custom-outreach");
  const [customBatches] = await Promise.all([
    fetchCustomOutreachBatches(),
  ]);

  return (
    <div className="page">
      <div className="pill">Custom Outreach</div>
      <h1 className="page-title">ONE LEAD, ONE CUSTOM DRAFT</h1>
      <CustomOutreachWorkspace batches={customBatches} />
    </div>
  );
}
```

- [ ] **Step 3: Build the batch-scoped workspace**

```tsx
type Props = {
  batches: CustomOutreachBatchSummary[];
};

// The workspace should:
// - let the operator select one custom batch
// - load only the leads in that batch
// - show one editable draft card per lead
// - support per-lead approve/reject/send
// - support batch-wide approve & send all
// - show empty/loading/error states that are specific to the selected batch
```

- [ ] **Step 4: Keep the copy distinct from Mission Control**

The tab should say it is for custom, manually reviewed outreach only. It should not mention automated sequence generation, connect-only acceptance, or post-acceptance Mission Control language.

- [ ] **Step 5: Verify the UI boundary in the browser**

Run:
```bash
cd apps/web && npm run dev -- --hostname 0.0.0.0 --port 3000
```

Expected: the top nav shows `Custom Outreach`, the page opens separately from Mission Control, and the workspace loads a custom batch without showing the automated sequence controls.

---

## Task 4: Add smoke coverage for the new flow

**Files:**
- Create: `agents/testscripts/custom-outreach-smoke.sh`

- [ ] **Step 1: Create a single smoke script that proves the new route and upload intent exist**

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach/apps/web
npx tsc --noEmit
npm run lint
```

- [ ] **Step 2: Extend the smoke script with route checks**

Add checks that the app exposes `/custom-outreach`, the navbar contains the new tab, and the upload screen contains `Custom Outreach` as a batch intent option.

- [ ] **Step 3: Run the smoke after the implementation lands**

Run:
```bash
bash agents/testscripts/custom-outreach-smoke.sh
```

Expected: typecheck and lint pass, the new route renders, and the import flow exposes the new batch intent without regressing `connect_message` or `connect_only`.

---

## Review Checklist

- The custom tab is separate from Mission Control.
- Custom batches are marked at import time, not retrofitted later.
- Draft generation and bulk send only touch the selected batch.
- Existing automated sequence flows keep their current behavior.
- No new package dependencies are introduced.
