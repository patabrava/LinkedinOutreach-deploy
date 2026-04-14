# Outreach UI Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the LinkedIn outreach UI so batch import, connect-only outreach, connect-plus-message outreach, and post-acceptance sequence messaging are explicit separate paths instead of one legacy enrichment-and-drafts flow.

**Architecture:** Keep the existing Next.js/Supabase monolith and preserve the current data model shape where possible, but reframe the UI around batch intent, lead lifecycle, and distinct message channels. The upload screen owns batch intent and import-time routing, the lead views show status progression and next action, and the sequence editor only manages post-acceptance message sequences. The old "start enrichment + drafts" affordance should be removed from the primary path and replaced with clearer batch actions tied to the actual worker behavior.

**Tech Stack:** Next.js App Router, React, TypeScript, Supabase/Postgres, existing server actions, existing Python workers, no new runtime dependencies.

---

### Task 1: Map the current outreach UI and lock the new interaction model

**Files:**
- Modify: `apps/web/app/upload/page.tsx`
- Modify: `apps/web/app/leads/page.tsx`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/components/CSVUploader.tsx`
- Modify: `apps/web/components/SequenceEditor.tsx`
- Modify: `apps/web/components/LeadList.tsx`
- Modify: `apps/web/components/DraftFeed.tsx`
- Test: `apps/web/app/page.tsx` behavior via Playwright CLI

- [ ] **Step 1: Inspect the existing screens and confirm the legacy control surface**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" open http://localhost:3000 --headed
```
Expected: the main page still shows the old enrichment/draft controls and the sequence manager is visually tied to the draft feed instead of the batch import flow.

- [ ] **Step 2: Replace the mental model with three explicit paths**

Define the target interaction model in the UI copy and component responsibilities:
```ts
const outreachPaths = [
  { key: "connect_only", label: "Connect Only" },
  { key: "connect_message", label: "Connect + Message" },
  { key: "sequence", label: "Post-Acceptance Sequence" },
];
```
Use this model only as UI vocabulary; the implementation still keeps one lead record with state transitions.

- [ ] **Step 3: Decide where the mode selector lives**

Use a batch-level selector in the upload flow, not a global top-nav toggle and not a per-lead hidden setting. The selector must be visible before upload completes so the batch is created with the correct intent.

- [ ] **Step 4: Define the sequence editor boundary**

Keep the sequence editor for post-acceptance messages only. It must not be used for the invite note. The invite note, if present, is a separate short composer or preset tied to `connect_message` only.

- [ ] **Step 5: Document the status progression the UI must show**

Adopt these visible states in the lead table and batch cards:
```ts
const visibleLeadStates = [
  "NEW",
  "ENRICHED",
  "CONNECT_SENT",
  "CONNECTED",
  "DRAFT_READY",
  "APPROVED",
  "SENT",
];
```
If a message is short invite text, the UI should label it as `Invite Note`, not `Sequence Step 1`.

### Task 2: Refactor the upload screen into a batch-intent screen

**Files:**
- Modify: `apps/web/components/CSVUploader.tsx`
- Modify: `apps/web/app/upload/page.tsx`
- Modify: `apps/web/app/actions.ts`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Add a failing UI contract check for mode selection at upload time**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" open http://localhost:3000/upload --headed
```
Expected: there is no pre-upload batch-intent selector yet.

- [ ] **Step 2: Add the batch-intent selector to the uploader**

Extend the uploader component props so import can carry intent:
```tsx
type OutreachMode = "connect_only" | "connect_message";

type CSVUploaderProps = {
  afterImport?: () => void;
  defaultMode?: OutreachMode;
  onModeChange?: (mode: OutreachMode) => void;
};
```
Render a small selector above the drop zone with exactly two options: `Connect Only` and `Connect + Message`.

- [ ] **Step 3: Persist the mode with the import**

Update the server action contract so imported rows are stamped with the selected mode and the created batch records it as well:
```ts
export async function importLeads(rows: LeadCsvRow[], fileName?: string, outreachMode: OutreachMode = "connect_message")
```
The action should continue to reject empty/invalid CSVs and must not create a batch if no valid LinkedIn URLs survive parsing.

- [ ] **Step 4: Update the upload page copy**

Rewrite the upload screen text so it says the user is choosing a batch intent, not starting enrichment and drafts. The page should explain that connect-only leads stop after invite send, while connect-plus-message leads continue into post-acceptance messaging.

- [ ] **Step 5: Verify the upload flow end to end**

Run:
```bash
npm run dev:web
```
Then upload `enriched_contacts.csv` twice, once per mode, and confirm the created batch and imported leads carry the selected mode and do not get routed into the wrong worker path.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/CSVUploader.tsx apps/web/app/upload/page.tsx apps/web/app/actions.ts apps/web/app/page.tsx
git commit -m "feat: batch intent on upload"
```

### Task 3: Replace the legacy enrichment-and-drafts cards with workflow cards

**Files:**
- Modify: `apps/web/app/leads/page.tsx`
- Modify: `apps/web/components/LeadList.tsx`
- Modify: `apps/web/components/DraftFeed.tsx`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Write a failing snapshot check for the old cards**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" snapshot
```
Expected: the page still shows the legacy "Standard Enrichment + Drafts" and "Enrich + Connect (No Note)" cards.

- [ ] **Step 2: Replace the card layout with workflow cards**

Render three cards instead:
```tsx
const workflowCards = [
  { title: "Connect Only", description: "Invite without note, then stop." },
  { title: "Connect + Message", description: "Invite now, sequence after acceptance." },
  { title: "Sequence Pipeline", description: "Create and manage the post-acceptance 3-step sequence." },
];
```
Each card should expose the correct next action button only.

- [ ] **Step 3: Make the lead list expose the true next action**

Update the row status badges so the table tells the user what the system can do next, not just what state the lead is in. Example labels:
```ts
const nextActionByStatus = {
  NEW: "Run enrichment",
  ENRICHED: "Generate invite or message draft",
  CONNECT_SENT: "Waiting for acceptance",
  CONNECTED: "Start sequence",
  DRAFT_READY: "Review draft",
  APPROVED: "Send now",
  SENT: "Done",
};
```

- [ ] **Step 4: Move sequence editing to the sequence area only**

Keep the sequence editor in the main page, but remove any implication that it belongs to connect-only outreach. The sequence section should say it is only used after acceptance or for the connect-plus-message path.

- [ ] **Step 5: Verify the new labels in browser**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" goto http://localhost:3000/
```
Expected: no legacy enrichment-and-drafts cards remain, and the workflow cards explain the three paths clearly.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/leads/page.tsx apps/web/components/LeadList.tsx apps/web/components/DraftFeed.tsx apps/web/app/page.tsx
git commit -m "feat: clarify outreach workflow ui"
```

### Task 4: Align worker triggers and labels with the new workflow language

**Files:**
- Modify: `apps/web/app/actions.ts`
- Modify: `apps/web/components/StartEnrichmentButton.tsx`
- Modify: `apps/web/components/StartLoginButton.tsx`
- Modify: `apps/web/components/FollowupsList.tsx`
- Modify: `workers/scraper/README.md`
- Modify: `README.md`

- [ ] **Step 1: Write the failing worker-routing check**

Run:
```bash
rg -n "START ENRICHMENT|ENRICH \+ CONNECT|draft-generation|message-only" apps/web workers/scraper README.md
```
Expected: legacy copy and trigger labels still exist in the codebase.

- [ ] **Step 2: Rename the trigger buttons to match the workflow**

Replace legacy button labels with explicit stage labels:
```tsx
const actions = {
  connectOnly: "Send Invites",
  connectMessage: "Run Enrichment",
  sequence: "Generate Sequence Drafts",
};
```
The buttons should call the correct worker path for the chosen mode and should not suggest that draft generation is part of connect-only.

- [ ] **Step 3: Update documentation and in-app helper text**

Update the README and worker README so they describe:
- invite-only pipeline
- invite + message pipeline
- post-acceptance sequence pipeline
This keeps future edits from reintroducing the old enrichment-first mental model.

- [ ] **Step 4: Verify no legacy copy is left in the primary workflow**

Run:
```bash
rg -n "Standard Enrichment \+ Drafts|Enrich \+ Connect \(No Note\)|Start Enrichment" apps/web workers/scraper README.md
```
Expected: no primary-path legacy labels remain.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/actions.ts apps/web/components/StartEnrichmentButton.tsx apps/web/components/StartLoginButton.tsx apps/web/components/FollowupsList.tsx workers/scraper/README.md README.md
git commit -m "feat: align outreach triggers with workflow"
```

### Task 5: End-to-end verification with cleared leads

**Files:**
- No code changes expected
- Test: live Supabase data and browser flow

- [ ] **Step 1: Delete the current leads and batches from the live system**

Run a one-time cleanup against Supabase using the service role config from `apps/web/.env` and confirm the counts go to zero for `leads`, `lead_batches`, and any sequence-binding tables used by the new UI.

- [ ] **Step 2: Re-import the sample CSV in each mode**

Use the browser to upload `enriched_contacts.csv` once as `Connect Only` and once as `Connect + Message`, confirming the batch record, lead status, and mode label all match the chosen path.

- [ ] **Step 3: Run the worker flow end to end**

Trigger the correct worker for each mode and verify:
- connect-only stops after the invite step
- connect+message reaches the draft queue
- sequence pipeline is not available until acceptance or explicit post-acceptance routing

- [ ] **Step 4: Record the verification result**

Capture the browser snapshot and the relevant worker logs so the final state shows the new UI labels, the imported leads, and the correct next action for each path.

- [ ] **Step 5: Final review**

Make sure the UI answer to “what happens next?” is always obvious from the batch card or lead row without reading logs.
