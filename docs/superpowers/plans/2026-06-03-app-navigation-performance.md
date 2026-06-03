# App Navigation Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tab switches feel immediate by reducing blocking server work, removing avoidable refresh loops, and proving route timing improvements.

**Architecture:** Keep the existing Next.js App Router/Supabase shape. Optimize the current vertical slices: route pages render fast shells, Supabase reads return smaller aggregated payloads, and client panels update local state without full-page refreshes. No new dependency is needed.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Supabase JS, Node test scripts.

**Budget:** {files: 8 modified + 6 created max, LOC/file: target <= 1000 and changed LOC <= 180 per existing file, deps: 0}

---

## Context-Zero

**Environment matrix to capture before implementation:**
- OS: run `uname -a`
- Node: run `node -v`
- npm: run `npm -v`
- App server: `./run_all.sh --web` on `http://127.0.0.1:3000`
- Current dirty worktree: run `git status --short` and avoid overwriting unrelated user changes

**Non-functional targets:**
- Warm route TTFB for `/`, `/leads`, `/followups`, `/analytics`, `/settings`, `/upload`: <= 250ms locally after Next warm-up
- Warm route TTFB for `/custom-outreach`: <= 350ms locally after Next warm-up
- First visible page shell after tab click: immediate loading shell instead of blank/waiting navigation
- Background polling: no unconditional route refresh loops faster than 60s; active job polling must pause on hidden tabs
- Dependency budget: 0

**Capability map:**
- Route timing measurement: local HTTP script measures TTFB and total time
- Custom Outreach summary aggregation: one Supabase lead-status fetch for all custom batches
- Page loading shells: route-local `loading.tsx` files for slow protected tabs
- Client refresh reduction: Custom Outreach uses local state and targeted data refreshes instead of post-action `router.refresh()`
- Regression checks: source-level tests prevent N+1 and fast refresh loops from returning

**Boundary map:**
- Auth boundary: `apps/web/lib/auth.ts`, `apps/web/middleware.ts`; keep fail-closed auth behavior intact
- Data boundary: `apps/web/app/actions.ts`; all Supabase shape changes stay here
- UI boundary: route pages and feature components; no global design refactor
- Runtime boundary: `.next` can become stale; recover with `./run_all.sh --web`

---

## File Structure

**Modify:**
- `apps/web/app/actions.ts` - add a batched Custom Outreach summary helper and keep existing action exports stable
- `apps/web/components/CustomOutreachWorkspace.tsx` - remove avoidable full-page refresh after local actions and gate polling by visibility
- `apps/web/components/DraftFeed.tsx` - gate generation polling by visibility
- `apps/web/components/StartEnrichmentButton.tsx` - gate fallback status polling by visibility
- `apps/web/lib/customOutreachSummary.test.mjs` - new source-level regression test for one batched status query
- `apps/web/lib/pollingRefreshGuards.test.mjs` - new source-level regression test for polling and `router.refresh()` rules

**Create:**
- `apps/web/app/custom-outreach/loading.tsx` - fast shell while custom batches load
- `apps/web/app/leads/loading.tsx` - fast shell while leads load
- `apps/web/app/followups/loading.tsx` - fast shell while followups load
- `apps/web/app/analytics/loading.tsx` - fast shell while analytics load
- `apps/web/app/settings/loading.tsx` - fast shell while settings load
- `apps/web/app/upload/loading.tsx` - fast shell while upload auth check loads
- `scripts/measure-web-routes.mjs` - local timing script for route TTFB/total time

---

### Task 1: Add A Repeatable Route Timing Script

**Files:**
- Create: `scripts/measure-web-routes.mjs`
- Modify: none
- Test: run script against local web server

- [ ] **Step 1: Create the timing script**

Create `scripts/measure-web-routes.mjs` with this content:

```javascript
#!/usr/bin/env node

const baseUrl = process.argv[2] || "http://127.0.0.1:3000";
const routes = ["/", "/leads", "/followups", "/analytics", "/custom-outreach", "/settings", "/upload"];
const iterations = Number(process.env.ROUTE_TIMING_ITERATIONS || "3");

async function timeRoute(path) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { redirect: "follow" });
  const headerAt = performance.now();
  await response.arrayBuffer();
  const ended = performance.now();
  return {
    path,
    status: response.status,
    ttfbMs: Math.round(headerAt - started),
    totalMs: Math.round(ended - started),
  };
}

async function main() {
  console.log(`Measuring ${baseUrl} for ${iterations} warm iteration(s)`);
  for (let i = 0; i < iterations; i += 1) {
    console.log(`\nIteration ${i + 1}`);
    for (const route of routes) {
      const result = await timeRoute(route);
      console.log(`${result.path.padEnd(16)} ${String(result.status).padEnd(3)} ttfb=${String(result.ttfbMs).padStart(4)}ms total=${String(result.totalMs).padStart(4)}ms`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run baseline measurement**

Run:

```bash
node scripts/measure-web-routes.mjs http://127.0.0.1:3000
```

Expected: prints all seven routes with HTTP status and `ttfb=`/`total=` timings. If the server is down, start it with `./run_all.sh --web` and rerun.

- [ ] **Step 3: Commit**

```bash
git add scripts/measure-web-routes.mjs
git commit -m "chore: add web route timing script"
```

---

### Task 2: Replace Custom Outreach N+1 Status Reads With One Batched Read

**Files:**
- Modify: `apps/web/app/actions.ts`
- Create: `apps/web/lib/customOutreachSummary.test.mjs`
- Test: `node apps/web/lib/customOutreachSummary.test.mjs`

- [ ] **Step 1: Write the failing source regression test**

Create `apps/web/lib/customOutreachSummary.test.mjs` with this content:

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app/actions.ts", import.meta.url), "utf8");

assert.match(
  source,
  /function buildCustomOutreachBatchSummaries\(/,
  "actions.ts should expose a pure summary builder for batch status aggregation"
);

assert.match(
  source,
  /\.from\("leads"\)[\s\S]*\.in\("batch_id", batchIds\)/,
  "fetchCustomOutreachBatchSummaries should fetch lead statuses for all custom batches in one batched query"
);

const functionBody = source.match(/export async function fetchCustomOutreachBatchSummaries[\s\S]*?\n}\n/)?.[0] || "";
assert.doesNotMatch(
  functionBody,
  /Promise\.all\(\s*\(\s*batches\s*\|\|\s*\[\]\s*\)\.map/,
  "fetchCustomOutreachBatchSummaries should not run one status query per batch"
);

console.log("customOutreachSummary regression checks passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node apps/web/lib/customOutreachSummary.test.mjs
```

Expected: FAIL with `actions.ts should expose a pure summary builder`.

- [ ] **Step 3: Implement the batched summary helper**

In `apps/web/app/actions.ts`, replace the existing `fetchCustomOutreachBatchSummaries` function with this implementation and add the helper immediately above it:

```typescript
type LeadStatusByBatchRow = {
  batch_id: number | null;
  status: string | null;
};

function buildCustomOutreachBatchSummaries(
  batches: Array<{ id: number; name: string; batch_intent: "custom_outreach"; created_at: string }>,
  leadStatuses: LeadStatusByBatchRow[]
): CustomOutreachBatchSummary[] {
  const countsByBatch = new Map<number, Record<string, number>>();

  for (const row of leadStatuses) {
    if (typeof row.batch_id !== "number") continue;
    const counts = countsByBatch.get(row.batch_id) ?? {};
    const status = row.status || "UNKNOWN";
    counts[status] = (counts[status] ?? 0) + 1;
    countsByBatch.set(row.batch_id, counts);
  }

  return batches.map((batch) => {
    const counts = countsByBatch.get(batch.id) ?? {};
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

    return {
      id: batch.id,
      name: batch.name,
      batch_intent: "custom_outreach" as const,
      lead_count: total,
      draft_count: (counts["DRAFT_READY"] ?? 0) + (counts["APPROVED"] ?? 0),
      approved_count: counts["APPROVED"] ?? 0,
      new_count: counts["NEW"] ?? 0,
      enriched_count: counts["ENRICHED"] ?? 0,
      draft_ready_count: counts["DRAFT_READY"] ?? 0,
      sent_count: counts["SENT"] ?? 0,
      failed_count: (counts["FAILED"] ?? 0) + (counts["ENRICH_FAILED"] ?? 0),
    };
  });
}

export async function fetchCustomOutreachBatchSummaries(): Promise<CustomOutreachBatchSummary[]> {
  if (!isSupabaseAdminConfigured()) {
    return [];
  }

  const client = supabaseAdmin();
  const { data: batches, error } = await client
    .from("lead_batches")
    .select("id, name, batch_intent, created_at")
    .eq("batch_intent", "custom_outreach")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  const customBatches = (batches || []) as Array<{
    id: number;
    name: string;
    batch_intent: "custom_outreach";
    created_at: string;
  }>;
  const batchIds = customBatches.map((batch) => batch.id);
  if (batchIds.length === 0) {
    return [];
  }

  const { data: leadStatuses, error: statusErr } = await client
    .from("leads")
    .select("batch_id, status")
    .in("batch_id", batchIds);

  if (statusErr) {
    throw statusErr;
  }

  return buildCustomOutreachBatchSummaries(customBatches, (leadStatuses || []) as LeadStatusByBatchRow[]);
}
```

- [ ] **Step 4: Run regression and type checks**

Run:

```bash
node apps/web/lib/customOutreachSummary.test.mjs
npm --prefix apps/web exec tsc -- --project apps/web/tsconfig.json --noEmit
```

Expected: regression test prints `customOutreachSummary regression checks passed`; TypeScript exits `0`.

- [ ] **Step 5: Re-measure `/custom-outreach`**

Run:

```bash
node scripts/measure-web-routes.mjs http://127.0.0.1:3000
```

Expected: warm `/custom-outreach` TTFB is <= 350ms after any first compilation hit.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/actions.ts apps/web/lib/customOutreachSummary.test.mjs
git commit -m "perf: batch custom outreach summary reads"
```

---

### Task 3: Add Fast Loading Shells For Protected Tabs

**Files:**
- Create: `apps/web/app/custom-outreach/loading.tsx`
- Create: `apps/web/app/leads/loading.tsx`
- Create: `apps/web/app/followups/loading.tsx`
- Create: `apps/web/app/analytics/loading.tsx`
- Create: `apps/web/app/settings/loading.tsx`
- Create: `apps/web/app/upload/loading.tsx`
- Test: browser navigation plus route timing script

- [ ] **Step 1: Create Custom Outreach loading shell**

Create `apps/web/app/custom-outreach/loading.tsx`:

```tsx
export default function LoadingCustomOutreach() {
  return (
    <div className="page">
      <div className="pill">Custom Outreach</div>
      <h1 className="page-title">MANUAL DRAFT REVIEW</h1>
      <div className="muted" style={{ maxWidth: 720 }}>
        Loading custom batches and draft status.
      </div>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="muted">Preparing review workspace...</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create Leads loading shell**

Create `apps/web/app/leads/loading.tsx`:

```tsx
export default function LoadingLeads() {
  return (
    <div className="page">
      <div className="pill">Batch Operations</div>
      <h1 className="page-title">LEADS OPERATIONS</h1>
      <div className="muted">Loading leads, sequences, and worker controls.</div>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="muted">Preparing lead table...</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create Followups loading shell**

Create `apps/web/app/followups/loading.tsx`:

```tsx
export default function LoadingFollowups() {
  return (
    <main className="container">
      <div className="pill">Follow-ups</div>
      <h1 className="page-title">FOLLOW-UP REVIEW</h1>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="muted">Loading due follow-ups...</div>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Create Analytics loading shell**

Create `apps/web/app/analytics/loading.tsx`:

```tsx
export default function LoadingAnalytics() {
  return (
    <div className="page">
      <div className="pill">Analytics</div>
      <h1 className="page-title" style={{ textTransform: "uppercase" }}>
        Outreach Performance
      </h1>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="muted">Calculating current metrics...</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create Settings loading shell**

Create `apps/web/app/settings/loading.tsx`:

```tsx
export default function LoadingSettings() {
  return (
    <div className="page">
      <div className="pill">Settings</div>
      <h1 className="page-title">SYSTEM SETTINGS</h1>
      <div className="card" style={{ marginTop: 18, maxWidth: 540 }}>
        <div className="muted">Loading LinkedIn session state...</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Create Upload loading shell**

Create `apps/web/app/upload/loading.tsx`:

```tsx
export default function LoadingUpload() {
  return (
    <div className="page">
      <div className="pill">Import</div>
      <h1 className="page-title">BATCH INTAKE</h1>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="muted">Preparing CSV intake...</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Verify shells compile**

Run:

```bash
npm --prefix apps/web exec tsc -- --project apps/web/tsconfig.json --noEmit
```

Expected: exits `0`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/custom-outreach/loading.tsx apps/web/app/leads/loading.tsx apps/web/app/followups/loading.tsx apps/web/app/analytics/loading.tsx apps/web/app/settings/loading.tsx apps/web/app/upload/loading.tsx
git commit -m "perf: add loading shells for protected tabs"
```

---

### Task 4: Reduce Remaining Client Refresh And Polling Pressure

**Files:**
- Modify: `apps/web/components/CustomOutreachWorkspace.tsx`
- Modify: `apps/web/components/DraftFeed.tsx`
- Modify: `apps/web/components/StartEnrichmentButton.tsx`
- Create: `apps/web/lib/pollingRefreshGuards.test.mjs`
- Test: `node apps/web/lib/pollingRefreshGuards.test.mjs`

- [ ] **Step 1: Write the failing polling guard test**

Create `apps/web/lib/pollingRefreshGuards.test.mjs` with this content:

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const customWorkspace = readFileSync(new URL("../components/CustomOutreachWorkspace.tsx", import.meta.url), "utf8");
const draftFeed = readFileSync(new URL("../components/DraftFeed.tsx", import.meta.url), "utf8");
const startButton = readFileSync(new URL("../components/StartEnrichmentButton.tsx", import.meta.url), "utf8");

const refreshCalls = [...customWorkspace.matchAll(/router\.refresh\(\)/g)].length;
assert.equal(refreshCalls, 0, "CustomOutreachWorkspace should not force full route refresh after local draft actions");

assert.match(
  customWorkspace,
  /document\.visibilityState !== "visible"/,
  "CustomOutreachWorkspace polling should pause on hidden tabs"
);

assert.match(
  draftFeed,
  /document\.visibilityState !== "visible"/,
  "DraftFeed polling should pause on hidden tabs"
);

assert.match(
  startButton,
  /document\.visibilityState !== "visible"/,
  "StartEnrichmentButton fallback polling should pause on hidden tabs"
);

console.log("pollingRefreshGuards regression checks passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node apps/web/lib/pollingRefreshGuards.test.mjs
```

Expected: FAIL because `CustomOutreachWorkspace` still contains `router.refresh()` calls and some polling lacks visibility gating.

- [ ] **Step 3: Remove route refresh from Custom Outreach actions**

In `apps/web/components/CustomOutreachWorkspace.tsx`, remove the `useRouter` import and `const router = useRouter();`. In action handlers, keep `await syncDrafts(false);` and delete the following line each time it appears:

```typescript
router.refresh();
```

The affected handlers are approve, send, reject, bulk approve/send, and the import action button area.

- [ ] **Step 4: Gate Custom Outreach polling by tab visibility**

In the `polling` effect in `apps/web/components/CustomOutreachWorkspace.tsx`, change the interval callback to:

```typescript
const interval = setInterval(() => {
  if (document.visibilityState !== "visible") return;
  syncDrafts(false);
}, 4000);
```

- [ ] **Step 5: Gate DraftFeed polling by tab visibility**

In `apps/web/components/DraftFeed.tsx`, change the polling interval to:

```typescript
const interval = setInterval(() => {
  if (document.visibilityState !== "visible") return;
  fetchDrafts();
}, POLL_INTERVAL_MS);
```

- [ ] **Step 6: Gate StartEnrichmentButton fallback polling by tab visibility**

In `apps/web/components/StartEnrichmentButton.tsx`, change the fallback interval callback to:

```typescript
const intervalId = setInterval(() => {
  if (document.visibilityState !== "visible") return;
  refreshStatus({ silent: true }).catch(() => undefined);
}, POLL_INTERVAL_MS);
```

- [ ] **Step 7: Run regression and type checks**

Run:

```bash
node apps/web/lib/pollingRefreshGuards.test.mjs
npm --prefix apps/web exec tsc -- --project apps/web/tsconfig.json --noEmit
```

Expected: regression test prints `pollingRefreshGuards regression checks passed`; TypeScript exits `0`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/CustomOutreachWorkspace.tsx apps/web/components/DraftFeed.tsx apps/web/components/StartEnrichmentButton.tsx apps/web/lib/pollingRefreshGuards.test.mjs
git commit -m "perf: reduce custom outreach refresh pressure"
```

---

### Task 5: Final Runtime Verification

**Files:**
- Modify: none unless a verification failure exposes a code defect
- Test: route timing script, browser tab-click smoke, TypeScript, targeted regression scripts

- [ ] **Step 1: Restart the web server cleanly**

Run:

```bash
./run_all.sh --web
```

Expected: Next starts on `http://127.0.0.1:3000`. If another server is already running, the launcher should pre-stop the old listener on port `3000`.

- [ ] **Step 2: Run all targeted checks**

Run:

```bash
node apps/web/lib/customOutreachSummary.test.mjs
node apps/web/lib/pollingRefreshGuards.test.mjs
npm --prefix apps/web exec tsc -- --project apps/web/tsconfig.json --noEmit
```

Expected: both source regression scripts pass; TypeScript exits `0`.

- [ ] **Step 3: Measure warm route timings**

Run:

```bash
ROUTE_TIMING_ITERATIONS=3 node scripts/measure-web-routes.mjs http://127.0.0.1:3000
```

Expected: after any first compile hit, warm TTFB for `/custom-outreach` is <= 350ms and the other measured routes are <= 250ms.

- [ ] **Step 4: Browser smoke test**

Open `http://127.0.0.1:3000` in the browser and click these tabs:

```text
Mission Control -> Leads Operations -> Custom Outreach -> More -> Follow-ups -> More -> Analytics -> More -> Settings -> More -> Upload
```

Expected: each navigation shows either the final page or its loading shell immediately; no tab click leaves the screen apparently frozen for multiple seconds.

- [ ] **Step 5: Commit verification notes if repo convention requires it**

If the implementation produced only code changes, do not add a separate verification document. If a failure report was needed, add it under `agents/testscripts/failure_report.md` per AGENTS routing.

---

## Self-Review

**Spec coverage:** The plan covers the slow tab-switch symptom through measured route timing, server-side query reduction, immediate loading shells, and remaining client refresh/polling pressure.

**Placeholder scan:** No task uses deferred-work wording or vague test instructions. Every code-producing step includes exact file paths and code.

**Type consistency:** New helper names are consistent: `LeadStatusByBatchRow`, `buildCustomOutreachBatchSummaries`, and `fetchCustomOutreachBatchSummaries`. Test names and commands match their file paths.

**AGENTS budget check:** {files: 8 modified + 6 created max, LOC/file: target <= 1000 and changed LOC <= 180 per existing file, deps: 0}
