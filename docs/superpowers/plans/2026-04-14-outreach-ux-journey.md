# Outreach UX Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the app so the user sees one understandable outreach journey: choose batch intent on upload, track batch progress on leads, and use Mission Control only for post-acceptance messaging and sequence work.

**Architecture:** Keep the current Next.js/Supabase monolith and keep the data model changes minimal. The upload page becomes the single place where batch intent is chosen, the leads page becomes the single progress dashboard for connect-only and connect-plus-message batches, and the home page becomes the post-acceptance messaging/sequences workspace. Worker triggers remain in place, but the UI should stop surfacing worker vocabulary as primary user actions.

**Tech Stack:** Next.js App Router, React, TypeScript, existing server actions, existing CSS tokens, Playwright CLI for browser validation. No new runtime dependencies.

---

### Task 1: Define the UX language and page responsibilities

**Files:**
- Modify: `apps/web/app/upload/page.tsx:1-40`
- Modify: `apps/web/app/leads/page.tsx:1-130`
- Modify: `apps/web/app/page.tsx:1-90`
- Modify: `apps/web/components/NavBar.tsx:1-40`

- [ ] **Step 1: Write the page responsibility map**

Use this model in the page copy:
```ts
type JourneyPage = {
  upload: "Choose batch intent and import CSV";
  leads: "Track batch progress and next action";
  missionControl: "Review messages and manage post-acceptance sequences";
};
```

- [ ] **Step 2: Make `/upload` the only place where batch intent is chosen**

The upload screen must present exactly two intents before import:
```ts
type BatchIntent = "connect_only" | "connect_message";
```
The page copy should explain that intent is attached to the batch at import time and is not a global app mode.

- [ ] **Step 3: Make `/leads` the progress dashboard**

The leads page should describe what is happening now, what happened already, and what the next step is. It should not present the full worker stack or invite users to think about backend stages.

- [ ] **Step 4: Make `/` Mission Control the post-acceptance workspace**

The home page should say that it is for message review, approval, and sequence management after a connection is accepted. It should not be the place where connect-only outreach is initiated.

- [ ] **Step 5: Update the nav labels so the routes match the mental model**

Use labels that match the user journey:
```tsx
const NAV_ITEMS = [
  { href: "/", label: "Mission Control", hint: "Messages and sequences" },
  { href: "/leads", label: "Leads", hint: "Batch progress" },
  { href: "/upload", label: "Upload", hint: "Choose batch intent" },
];
```

### Task 2: Refactor the upload experience into a batch-intent flow

**Files:**
- Modify: `apps/web/components/CSVUploader.tsx:1-190`
- Modify: `apps/web/app/upload/page.tsx:1-20`
- Modify: `apps/web/app/actions.ts:1200-1288`

- [ ] **Step 1: Add a failing browser check for intent choice before upload**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" open http://localhost:3000/upload --headed
```
Expected: the upload page must clearly show `Connect Only` and `Connect + Message` before the file chooser is used.

- [ ] **Step 2: Keep the selector in the uploader component**

Make the uploader own the batch-intent toggle so the import action receives intent with the file:
```tsx
type CSVUploaderProps = {
  afterImport?: () => void;
  defaultMode?: "connect_only" | "connect_message";
  onModeChange?: (mode: "connect_only" | "connect_message") => void;
};
```
The selector must be visible before the user clicks `Choose CSV`.

- [ ] **Step 3: Keep the import contract aligned with the selected intent**

The server action should continue to stamp imported leads with the selected `outreach_mode`, and the batch must only be created when at least one valid LinkedIn URL survives parsing:
```ts
export async function importLeads(
  rows: LeadCsvRow[],
  fileName?: string,
  outreachMode: "connect_message" | "connect_only" = "connect_message"
)
```

- [ ] **Step 4: Rewrite the upload page copy**

The page should say:
```tsx
<h1>BATCH INTAKE</h1>
<div>Choose what this batch is for, then upload the CSV.</div>
```
It should explain that connect-only batches stop at invite send, while connect-plus-message batches continue into message review later.

- [ ] **Step 5: Verify both import paths in the browser**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" open http://localhost:3000/upload --headed
```
Expected: import one CSV as `Connect Only` and one as `Connect + Message`, then confirm both produce a batch row with the correct label in `/leads`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/CSVUploader.tsx apps/web/app/upload/page.tsx apps/web/app/actions.ts
git commit -m "feat: batch intent upload flow"
```

### Task 3: Turn `/leads` into a clear batch progress dashboard

**Files:**
- Modify: `apps/web/app/leads/page.tsx:1-122`
- Modify: `apps/web/components/LeadList.tsx:1-260`
- Modify: `apps/web/components/StartEnrichmentButton.tsx:1-240`

- [ ] **Step 1: Add a failing browser check for the workflow cards**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" open http://localhost:3000/leads --headed
```
Expected: the page should not read like a control panel full of worker buttons. It should read like a batch progress dashboard with next actions.

- [ ] **Step 2: Replace the intro with a batch-progress summary**

The leads page must lead with:
```tsx
<h1>LEAD INTAKE</h1>
<div>Track each batch from import to the next action.</div>
```
It should expose the batch intent and next step without surfacing worker terminology first.

- [ ] **Step 3: Make the action cards describe user outcomes**

The three cards should be outcome-driven:
```tsx
const workflowCards = [
  { title: "Connect Only", description: "Invite without note, then wait for acceptance." },
  { title: "Connect + Message", description: "Invite now, then continue to message review after acceptance." },
  { title: "Post-Acceptance Sequences", description: "Edit and assign the 3-step sequence used after acceptance." },
];
```
The buttons can still call the existing workers, but the copy should never say “start enrichment + drafts.”

- [ ] **Step 4: Make the lead list explain state and next action**

Update the visible labels so the table answers:
```ts
const nextActionByStatus = {
  NEW: "Run enrichment",
  ENRICHED: "Review invite or draft",
  CONNECT_SENT: "Waiting for acceptance",
  CONNECTED: "Start sequence",
  DRAFT_READY: "Review message",
  APPROVED: "Send now",
  SENT: "Done",
};
```

- [ ] **Step 5: Verify the `/leads` page in the browser**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" goto http://localhost:3000/leads
```
Expected: the page communicates current batch status and the next action in plain language.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/leads/page.tsx apps/web/components/LeadList.tsx apps/web/components/StartEnrichmentButton.tsx
git commit -m "feat: batch progress dashboard"
```

### Task 4: Make Mission Control the post-acceptance workspace only

**Files:**
- Modify: `apps/web/app/page.tsx:1-90`
- Modify: `apps/web/components/DraftFeed.tsx:1-620`
- Modify: `apps/web/components/SequenceEditor.tsx:1-220`

- [ ] **Step 1: Add a failing browser check for the home page role**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" open http://localhost:3000 --headed
```
Expected: the page should explicitly read as message review and sequence management, not as the main entry point for connect-only outreach.

- [ ] **Step 2: Simplify the hero copy**

Use copy that says Mission Control is for:
```tsx
<div>Review messages, approve sends, and manage post-acceptance sequences.</div>
```
Do not mention connect-only initiation on this page.

- [ ] **Step 3: Keep connect-only hidden from Mission Control**

The draft feed should only surface connect-only status where acceptance creates a message-relevant next step. It should not invite the user to treat connect-only as a sequence workflow.

- [ ] **Step 4: Make the sequence editor explicitly post-acceptance only**

Sequence management must say:
```tsx
<div>These 3-step sequences are used only after acceptance.</div>
```
The editor should not imply it is part of the import flow.

- [ ] **Step 5: Verify the home page in the browser**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" goto http://localhost:3000/
```
Expected: the page reads as a post-acceptance workspace, with drafts and sequences as the central tasks.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/page.tsx apps/web/components/DraftFeed.tsx apps/web/components/SequenceEditor.tsx
git commit -m "feat: mission control post acceptance"
```

### Task 5: Tighten the visual hierarchy and accessibility of the new journey

**Files:**
- Modify: `apps/web/app/globals.css:1-260`
- Modify: `apps/web/components/NavBar.tsx:1-40`
- Modify: `apps/web/app/layout.tsx:1-30`

- [ ] **Step 1: Add a browser check for keyboard focus and mobile layout**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" open http://localhost:3000/upload --headed
```
Expected: the intent buttons, upload button, and nav links are easy to see and operate with keyboard focus.

- [ ] **Step 2: Add visible focus states**

Use a small focus ring on buttons, inputs, links, and selectable cards:
```css
.btn:focus-visible,
.input:focus-visible,
a:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 2px;
}
```

- [ ] **Step 3: Reduce fixed-width friction**

The two-column lead-intake shell should collapse cleanly on narrower screens, and the table should not force horizontal scrolling until it is genuinely necessary.

- [ ] **Step 4: Improve semantic and brand clarity**

Update the nav and page titles so route names match the user journey. Keep the existing brutalist direction, but soften repetition so the app feels deliberate rather than templated.

- [ ] **Step 5: Run the final browser validation**

Run:
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"; "$PWCLI" open http://localhost:3000/upload --headed
```
Expected: the three-page journey is understandable at a glance and works with keyboard navigation.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/globals.css apps/web/components/NavBar.tsx apps/web/app/layout.tsx
git commit -m "feat: polish outreach journey ux"
```

---

### Self-Review

**Spec coverage**
- Upload intent choice: covered in Task 2.
- Leads page as progress dashboard: covered in Task 3.
- Mission Control for post-acceptance messaging and sequences: covered in Task 4.
- Clear page hierarchy and navigation: covered in Task 1 and Task 5.

**Placeholder scan**
- No TBD/TODO placeholders.
- Every task has exact files, commands, and concrete UI copy.
- No task references an undefined helper or type.

**Type consistency**
- `BatchIntent` and `OutreachMode` use the same values: `connect_only` and `connect_message`.
- The upload page, lead dashboard, and Mission Control all use the same journey vocabulary.
- No task introduces a new runtime dependency.

**File budget**
- Files touched: 10
- LOC/file: keep each edited file under ~1,000 LOC; `apps/web/app/actions.ts` and `apps/web/components/DraftFeed.tsx` should be edited surgically, not rewritten wholesale.
- Deps: 0 new runtime deps
