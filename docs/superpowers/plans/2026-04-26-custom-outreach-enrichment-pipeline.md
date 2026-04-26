# Custom Outreach Enrichment Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route custom-outreach leads through a real two-stage pipeline — background enrichment (scraper writes `profile_data`) followed by background AI drafting (agent reads `profile_data`, writes `drafts`) — so operator-reviewed drafts are personalized from actual LinkedIn data instead of from `{}`. Stop importing custom-outreach leads as fake-`ENRICHED`. Add per-batch progress visibility and an "ENRICH NOW" button on the Custom Outreach page.

**Architecture:** Two decoupled background loops, both supervised by `run_all.sh`, communicating only through lead state in Postgres:
- `scraper.py --enrichment-loop` — polls leads where `lead_batches.batch_intent = 'custom_outreach' AND leads.status = 'NEW'`. Writes `profile_data` + `recent_activity`. Flips status to `ENRICHED`. Continuous loop with sleep between passes.
- `run_agent.py --watch` — polls leads where `lead_batches.batch_intent = 'custom_outreach' AND leads.status = 'ENRICHED' AND <no draft yet>`. Calls OpenAI, writes draft, flips status to `DRAFT_READY`. Continuous loop with sleep.
- `/api/custom-outreach/enrich-batch` — operator-triggered one-shot scraper run scoped to a single batch (the "ENRICH NOW" button), so a freshly imported batch can be processed immediately without waiting for the loop's next pass.
- Per-batch progress card on the Custom Outreach page surfaces NEW / ENRICHED / DRAFT_READY counts so the operator can see the pipeline moving.

**Tech Stack:** Next.js 14 app router (TS), Python 3 + Playwright (scraper), Python 3 + OpenAI SDK (mcp-server agent), Supabase Postgres. Zero new dependencies.

**Locality envelope (per AGENTS.md §0):**
- Modified files: `apps/web/app/actions.ts` (~−1 / +30 LOC), `workers/scraper/scraper.py` (~+80 LOC), `mcp-server/tools.py` (~+10 LOC), `mcp-server/run_agent.py` (~+70 LOC), `run_all.sh` (~+30 LOC), `apps/web/app/custom-outreach/page.tsx` (~+10 LOC), `apps/web/components/CustomOutreachWorkspace.tsx` (~+40 LOC).
- New files: `apps/web/app/api/custom-outreach/enrich-batch/route.ts` (~70 LOC), `apps/web/components/CustomOutreachBatchProgress.tsx` (~80 LOC).
- All files <1000 LOC. **0 new deps.**

**Pre-conditions / preserved behavior:**
- AGENTS.md §2 single-spawn-per-pid rule applies to both the new endpoint and the loop. Reuse the existing `assertScraperLockFree` / `persistScraperPid` machinery.
- AGENTS.md §2 `connect_only` scraper rule ("must skip enrich_one()") is unaffected — that mode is being removed in Plan A. This plan only touches the `enrich` mode and adds a new `--enrichment-loop`.
- Plan A removes `--mode connect_only` from `scraper.py`. This plan can land independently of Plan A; both are additive on `scraper.py` argparse.
- Existing fake-`ENRICHED` custom outreach leads in production stay as-is (per user decision). Operators handle them ad-hoc.

---

## File Structure

### Modified files

- `apps/web/app/actions.ts` —
  1. **Drop the `ENRICHED` shortcut** in `importLeads` (line 1542): custom-outreach leads now insert as `NEW`, the same as the other intents.
  2. **Extend `CustomOutreachBatchSummary`** with per-status counts (`new_count`, `enriched_count`, `draft_ready_count`, `approved_count`, `sent_count`, `failed_count`) for the progress card. Update `fetchCustomOutreachBatchSummaries` to populate them.
- `workers/scraper/scraper.py` —
  1. Add `--enrichment-loop` flag (continuous loop) and a corresponding `fetch_custom_outreach_pending_leads(client, limit)` helper that joins `lead_batches` and filters `batch_intent = 'custom_outreach' AND status = 'NEW'`.
  2. The existing `--mode enrich` lead-fetch helper learns a `--batch-intent custom_outreach` filter (passed through from `--enrichment-loop` and from the new ENRICH-NOW endpoint).
- `mcp-server/tools.py` — extend `get_leads_for_generation` to require `lead_batches.batch_intent = 'custom_outreach'`. Defensive belt-and-suspenders so a stray `ENRICHED` sequence-driven lead never accidentally triggers AI drafting.
- `mcp-server/run_agent.py` — add `--watch` mode: continuous loop that picks up `ENRICHED` custom-outreach leads with no draft yet, generates drafts, flips them to `DRAFT_READY`. Sleep between passes when the queue is empty.
- `run_all.sh` — add `--enrichment-loop` and `--draft-loop` services so a single `./run_all.sh --enrichment-loop --draft-loop --web` brings the whole pipeline up. Cleanup must use `"${SERVICE_PIDS[@]-}"` form (AGENTS.md §2 unbound-array rule).
- `apps/web/app/custom-outreach/page.tsx` — fetch the extended summaries and pass them into the workspace; nothing else.
- `apps/web/components/CustomOutreachWorkspace.tsx` — render `<CustomOutreachBatchProgress>` per batch in the existing batch-list view; render an `ENRICH NOW` button next to the import button (already present near top of `apps/web/app/custom-outreach/page.tsx`) bound to the new endpoint.

### New files

- `apps/web/app/api/custom-outreach/enrich-batch/route.ts` — POST endpoint accepting `{ batchId }`. Spawns `scraper.py --mode enrich --batch-intent custom_outreach --batch-id <X>` as a one-shot. Reuses `requireOperatorAccess`, `assertScraperLockFree`, `persistScraperPid`, `trackWorkerChild`, and the spawn-output-mirroring pattern from `apps/web/app/api/enrich/route.ts`.
- `apps/web/components/CustomOutreachBatchProgress.tsx` — brutalist progress card (Space Mono, 3px borders, no radius, no shadows) showing per-status counts as a horizontal status-chip strip. Per CLAUDE.md design tokens.

---

## Conventions

- Tests use `node:test` (TS) and `pytest` (Python) — match existing project pattern.
- Each task ends in green test or grep/syntax/smoke verification, plus a single-purpose commit.
- This plan does NOT introduce a schema migration. `lead_batches.batch_intent` already exists (migration 014).

---

## Task 1: Drop the fake-`ENRICHED` shortcut on import

**Files:**
- Modify: `apps/web/app/actions.ts` (around line 1542)

- [ ] **Step 1: Read the current importLeads block**

Open `apps/web/app/actions.ts`. Locate the line:
```ts
status: normalizedIntent === "custom_outreach" ? "ENRICHED" : "NEW",
```
near line 1542 (inside the `sanitized` map of `importLeads`).

- [ ] **Step 2: Replace with the simple form**

Change to:
```ts
status: "NEW",
```

That's the entire change — no other branch needed; all intents now start in `NEW`.

- [ ] **Step 3: Type-check**

```
cd apps/web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 4: Smoke verify the import flow**

`./run_all.sh --web` → upload a CSV via the UI as Custom Outreach. Inspect the DB:
```
select status, count(*) from leads where batch_id = <new_id> group by status;
```
Expected: all leads in `NEW` (not `ENRICHED`).

- [ ] **Step 5: Commit**

```
git add apps/web/app/actions.ts
git commit -m "fix(custom-outreach): import leads as NEW instead of fake-ENRICHED"
```

---

## Task 2: Defensive filter on the AI draft agent

**Files:**
- Modify: `mcp-server/tools.py` (`get_leads_for_generation`)

- [ ] **Step 1: Read the current implementation**

`mcp-server/tools.py:22-50` (around there). Confirm the current query is:
```python
status_filter = "ENRICHED" if normalized_mode == "message" else "CONNECT_ONLY_SENT"
outreach_filter = "message" if normalized_mode == "message" else "connect_only"
query = (
    client.table("leads")
    .select("*")
    .eq("status", status_filter)
    .eq("outreach_mode", outreach_filter)
    .limit(limit)
)
```

- [ ] **Step 2: Add the batch_intent join filter**

Replace with (preserving the existing argument signature):

```python
query = (
    client.table("leads")
    .select("*, lead_batches!inner(batch_intent)")
    .eq("status", status_filter)
    .eq("outreach_mode", outreach_filter)
    .eq("lead_batches.batch_intent", "custom_outreach")
    .limit(limit)
)
if batch_id is not None:
    query = query.eq("batch_id", batch_id)
```

The `select("*, lead_batches!inner(batch_intent)")` does an INNER JOIN, so leads not linked to a custom_outreach batch are excluded. The batch_intent column is dropped from the returned row (Supabase returns it nested under `lead_batches`); existing callers don't read it, so no further change is needed.

- [ ] **Step 3: Verify the agent still picks up legitimate ENRICHED custom-outreach leads**

Quickest check: run the existing one-shot agent against a known-custom-outreach test batch:
```
cd mcp-server && python run_agent.py --batch-id <test-batch> --limit 1
```
Expected: agent finds the lead, generates a draft, lead flips to `DRAFT_READY`.

- [ ] **Step 4: Verify it does NOT pick up sequence-driven ENRICHED leads**

There may be legacy sequence-driven leads with `status='ENRICHED'` in the DB (residual from older flows). After this filter:
```
cd mcp-server && python run_agent.py --limit 100
```
Logs should show only custom-outreach batch leads being processed.

- [ ] **Step 5: Commit**

```
git add mcp-server/tools.py
git commit -m "fix(agent): require batch_intent=custom_outreach when fetching leads for drafting"
```

---

## Task 3: Scraper `--enrichment-loop` mode (custom-outreach scoped)

**Files:**
- Modify: `workers/scraper/scraper.py`

- [ ] **Step 1: Add the new argparse flag**

Find `parse_args()` in `workers/scraper/scraper.py`. Add:

```python
parser.add_argument(
    "--enrichment-loop",
    action="store_true",
    help="Continuously enrich NEW custom-outreach leads. Sleeps between passes when queue is empty.",
)
parser.add_argument(
    "--batch-intent",
    type=str,
    default=None,
    choices=[None, "custom_outreach"],
    help="Restrict lead selection to a specific batch_intent. None = no filter (legacy behavior).",
)
```

(`None` as a choice with `default=None` works in argparse via the `nargs='?'` pattern; if argparse balks, drop `choices` and validate manually with a single `if args.batch_intent and args.batch_intent != 'custom_outreach': parser.error(...)` line.)

- [ ] **Step 2: Add the scoped fetch helper**

Find the existing `fetch_pending_leads`-style function. Add a sibling:

```python
def fetch_pending_leads_for_intent(
    client: Client,
    limit: int,
    batch_intent: str,
    batch_id: int | None = None,
) -> List[Dict[str, Any]]:
    """Fetch NEW leads for a specific batch_intent (e.g., 'custom_outreach')."""
    logger.db_query(
        "select",
        "leads",
        {"status": "NEW", "batch_intent": batch_intent, "limit": limit},
    )
    query = (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, company_name, batch_id, lead_batches!inner(batch_intent)")
        .eq("status", "NEW")
        .eq("lead_batches.batch_intent", batch_intent)
        .limit(limit)
    )
    if batch_id is not None:
        query = query.eq("batch_id", batch_id)
    response = query.execute()
    rows = response.data or []
    logger.db_result("select", "leads", {"limit": limit}, len(rows))
    return rows
```

- [ ] **Step 3: Add the loop dispatch in `main()`**

In the scraper's main flow, before the existing `if args.run:` (or whatever the current entry-gate is), add:

```python
if args.enrichment_loop:
    logger.operation_start("scraper-enrichment-loop", input_data={"intent": "custom_outreach"})
    sleep_when_empty_seconds = int(os.getenv("ENRICHMENT_LOOP_IDLE_SECONDS", "60"))
    pass_size = int(os.getenv("ENRICHMENT_LOOP_PASS_SIZE", "10"))
    try:
        while True:
            leads = fetch_pending_leads_for_intent(client, pass_size, "custom_outreach")
            if not leads:
                logger.info("enrichment-loop: queue empty, sleeping", data={"seconds": sleep_when_empty_seconds})
                await asyncio.sleep(sleep_when_empty_seconds)
                continue

            # Reuse the existing per-lead enrichment path (enrich_one + update_lead).
            # Open a single browser session for the pass.
            playwright, browser, context = await open_browser(headless=force_headless())
            try:
                await ensure_linkedin_auth(context, client)
                for lead in leads:
                    try:
                        # mark PROCESSING via existing helper
                        client.table("leads").update({"status": "PROCESSING"}).eq("id", lead["id"]).execute()
                        page = await context.new_page()
                        try:
                            profile, activity = await enrich_one(page, lead)
                            update_lead(client, lead["id"], profile, activity)  # flips to ENRICHED
                        finally:
                            await page.close()
                    except Exception as exc:
                        logger.error("enrichment-loop: lead failed", {"leadId": lead.get("id")}, error=exc)
                        try:
                            mark_lead_failed(client, lead["id"], reason=str(exc))  # existing helper
                        except Exception:
                            pass
            finally:
                await shutdown(playwright, browser)
    except KeyboardInterrupt:
        logger.info("enrichment-loop: stopping on SIGINT")
        return
```

(Function names like `enrich_one`, `update_lead`, `mark_lead_failed`, `force_headless`, `open_browser`, `ensure_linkedin_auth`, `shutdown` reflect existing helpers in `scraper.py`. Match real names during implementation.)

- [ ] **Step 4: Honor `--batch-intent` in the existing one-shot `--run` path**

In the existing `--run` path's lead-selection call, when `args.batch_intent` is set, route to `fetch_pending_leads_for_intent(client, limit, args.batch_intent, args.batch_id)` instead of the unfiltered helper. This is what the ENRICH-NOW endpoint (Task 7) will call.

- [ ] **Step 5: Verify by syntax + dry run**

```
python -c "import ast; ast.parse(open('workers/scraper/scraper.py').read())"
python workers/scraper/scraper.py --help
```
Expected: clean parse, help lists `--enrichment-loop` and `--batch-intent`.

- [ ] **Step 6: Smoke-run the loop briefly**

With at least one custom-outreach NEW lead in DB:
```
python workers/scraper/scraper.py --enrichment-loop
```
Watch logs for: `scraper-enrichment-loop` operation_start, lead pickup, browser open, enrichment, status flip to `ENRICHED`. SIGINT (Ctrl-C) to stop. Verify the lead landed at `ENRICHED` with `profile_data IS NOT NULL`.

- [ ] **Step 7: Commit**

```
git add workers/scraper/scraper.py
git commit -m "feat(scraper): add --enrichment-loop scoped to custom_outreach batch_intent"
```

---

## Task 4: Draft agent `--watch` mode

**Files:**
- Modify: `mcp-server/run_agent.py`

- [ ] **Step 1: Add the argparse flag**

In `mcp-server/run_agent.py`'s `main()` (or wherever argparse is set up), add:

```python
parser.add_argument(
    "--watch",
    action="store_true",
    help="Continuously process ENRICHED custom-outreach leads into drafts. Sleeps between passes when queue is empty.",
)
parser.add_argument(
    "--watch-idle-seconds",
    type=int,
    default=60,
    help="Seconds to sleep between passes when the queue is empty.",
)
parser.add_argument(
    "--watch-pass-size",
    type=int,
    default=10,
    help="Max leads to draft per pass.",
)
```

- [ ] **Step 2: Add the loop**

Add this block at the top of the dispatch in `main()`, before the existing one-shot logic:

```python
if args.watch:
    import time
    logger.operation_start("agent-watch", input_data={"intent": "custom_outreach"})
    while True:
        try:
            leads = get_leads_for_generation(
                client,
                mode="connect_message",  # routes to status='ENRICHED' + outreach_mode='message'
                batch_id=None,
                limit=args.watch_pass_size,
            )
            if not leads:
                logger.info("agent-watch: queue empty, sleeping", data={"seconds": args.watch_idle_seconds})
                time.sleep(args.watch_idle_seconds)
                continue

            for lead in leads:
                try:
                    process_lead(lead, client, prompt_type=1)  # name matches existing one-shot path
                except Exception as exc:
                    logger.error("agent-watch: lead failed", {"leadId": lead.get("id")}, error=exc)
        except KeyboardInterrupt:
            logger.info("agent-watch: stopping on SIGINT")
            return
```

(Replace `process_lead` with the actual single-lead entrypoint name from `run_agent.py`. If only an N-leads-per-call function exists, call it inside the loop with `[lead]`.)

The `mode="connect_message"` argument is what makes `get_leads_for_generation` filter on `status='ENRICHED' AND outreach_mode='message'`. Combined with Task 2's defensive `batch_intent='custom_outreach'` filter, this ends up scoped to exactly the right slice.

- [ ] **Step 3: Verify by syntax + dry run**

```
python -c "import ast; ast.parse(open('mcp-server/run_agent.py').read())"
python mcp-server/run_agent.py --help
```
Expected: clean parse, help lists `--watch`.

- [ ] **Step 4: Smoke-run briefly**

With at least one custom-outreach `ENRICHED` lead:
```
python mcp-server/run_agent.py --watch
```
Watch logs for: `agent-watch` operation_start, draft generation, status flip to `DRAFT_READY`. SIGINT to stop. Verify the lead's draft row exists in `drafts` and the lead status is `DRAFT_READY`.

- [ ] **Step 5: Commit**

```
git add mcp-server/run_agent.py
git commit -m "feat(agent): add --watch mode for continuous custom-outreach drafting"
```

---

## Task 5: Wire both loops into `run_all.sh`

**Files:**
- Modify: `run_all.sh`

- [ ] **Step 1: Read the existing service-spawn pattern**

Locate how existing services (e.g., `--web`, `--inbox`) are spawned. Match the pattern: PID tracked in `SERVICE_PIDS`, log file in `.logs/`, output mirrored.

- [ ] **Step 2: Add `--enrichment-loop` and `--draft-loop` flags**

Add to the argument parsing block:

```bash
ENABLE_ENRICHMENT_LOOP=0
ENABLE_DRAFT_LOOP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    # ...existing cases...
    --enrichment-loop) ENABLE_ENRICHMENT_LOOP=1; shift ;;
    --draft-loop)      ENABLE_DRAFT_LOOP=1; shift ;;
    *) shift ;;
  esac
done
```

(Match the actual existing parsing style; the snippet above is illustrative.)

- [ ] **Step 3: Spawn the services**

Where existing services are spawned, add:

```bash
if [[ "$ENABLE_ENRICHMENT_LOOP" == "1" ]]; then
  log_path=".logs/scraper-enrichment-loop.log"
  ( cd workers/scraper && python scraper.py --enrichment-loop ) >"$log_path" 2>&1 &
  pid=$!
  SERVICE_PIDS+=("$pid")
  echo "[run_all] enrichment-loop pid=$pid log=$log_path"
fi

if [[ "$ENABLE_DRAFT_LOOP" == "1" ]]; then
  log_path=".logs/agent-watch.log"
  ( cd mcp-server && python run_agent.py --watch ) >"$log_path" 2>&1 &
  pid=$!
  SERVICE_PIDS+=("$pid")
  echo "[run_all] draft-loop pid=$pid log=$log_path"
fi
```

- [ ] **Step 4: Verify the cleanup pattern uses safe array expansion**

Per AGENTS.md §2: "cleanup loops must use `"${TAIL_PIDS[@]-}"` and `"${SERVICE_PIDS[@]-}"`". Confirm the existing trap/cleanup loop already uses this form for `SERVICE_PIDS`. If not, fix it as part of this task.

- [ ] **Step 5: Verify shellcheck**

```
shellcheck run_all.sh
```
(If shellcheck is not installed, skip — it's not a hard project dependency.)

- [ ] **Step 6: Smoke-run the supervisor**

```
./run_all.sh --enrichment-loop --draft-loop --web
```
Confirm three PIDs are reported, three log files appear in `.logs/`, and SIGINT cleans up all three. Verify no "unbound variable" or "command not found" errors.

- [ ] **Step 7: Commit**

```
git add run_all.sh
git commit -m "feat(run_all): supervise --enrichment-loop and --draft-loop services"
```

---

## Task 6: Per-batch progress aggregation

**Files:**
- Modify: `apps/web/app/actions.ts` (`fetchCustomOutreachBatchSummaries` + `CustomOutreachBatchSummary` type)

- [ ] **Step 1: Extend the type**

In `apps/web/app/actions.ts`, replace `CustomOutreachBatchSummary` with:

```ts
export type CustomOutreachBatchSummary = {
  id: number;
  name: string;
  batch_intent: "custom_outreach";
  lead_count: number;
  draft_count: number;
  approved_count: number;
  // New: per-status counts driving the progress card.
  new_count: number;
  enriched_count: number;
  draft_ready_count: number;
  sent_count: number;
  failed_count: number;
};
```

- [ ] **Step 2: Extend the fetch**

Replace the current `Promise.all([leadCountResult, draftCountResult, approvedCountResult])` block with a single grouped query that returns all status counts in one round-trip:

```ts
const { data: statusRows, error: statusErr } = await client
  .from("leads")
  .select("status")
  .eq("batch_id", batch.id);
if (statusErr) throw statusErr;

const counts: Record<string, number> = {};
for (const row of statusRows ?? []) {
  counts[row.status] = (counts[row.status] ?? 0) + 1;
}
const total = (statusRows ?? []).length;

return {
  id: batch.id,
  name: batch.name,
  batch_intent: "custom_outreach" as const,
  lead_count: total,
  // legacy aggregates kept for unchanged consumers
  draft_count: (counts["DRAFT_READY"] ?? 0) + (counts["APPROVED"] ?? 0),
  approved_count: counts["APPROVED"] ?? 0,
  new_count: counts["NEW"] ?? 0,
  enriched_count: counts["ENRICHED"] ?? 0,
  draft_ready_count: counts["DRAFT_READY"] ?? 0,
  sent_count: counts["SENT"] ?? 0,
  failed_count: (counts["FAILED"] ?? 0) + (counts["ENRICH_FAILED"] ?? 0),
};
```

This swaps three count queries for one fetch+groupby in JS. Cheap for typical batch sizes (≤thousands).

- [ ] **Step 3: Type-check**

```
cd apps/web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 4: Smoke verify in DB**

After running the dev server:
```
curl -s 'http://localhost:3000/custom-outreach' | grep -o 'data-batch-summary[^>]*' | head
```
(Or just navigate to `/custom-outreach` and inspect the page; the data is server-rendered.)

- [ ] **Step 5: Commit**

```
git add apps/web/app/actions.ts
git commit -m "feat(custom-outreach): expose per-status batch counts for progress card"
```

---

## Task 7: ENRICH NOW one-shot endpoint

**Files:**
- Create: `apps/web/app/api/custom-outreach/enrich-batch/route.ts`

- [ ] **Step 1: Read the existing scraper-spawn pattern**

Open `apps/web/app/api/enrich/route.ts`. Note: `requireOperatorAccess`, `assertScraperLockFree`, `persistScraperPid`, `trackWorkerChild`, output mirroring (`mirrorWorkerOutput`), 409 on already-running.

- [ ] **Step 2: Create the new endpoint**

Create `apps/web/app/api/custom-outreach/enrich-batch/route.ts`:

```ts
import { spawn } from "child_process";
import path from "path";
import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../../lib/apiGuard";
import { logger } from "../../../../lib/logger";
import { trackWorkerChild } from "../../../../lib/workerControl";
import { assertScraperLockFree, persistScraperPid } from "../../enrich/scraperLock";

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/custom-outreach/enrich-batch");
  const guardResponse = await requireOperatorAccess(request, "/api/custom-outreach/enrich-batch", correlationId);
  if (guardResponse) return guardResponse;

  let body: { batchId?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.batchId || !Number.isFinite(body.batchId)) {
    return NextResponse.json({ error: "batchId required" }, { status: 400 });
  }

  try {
    await assertScraperLockFree();
  } catch (err: unknown) {
    return NextResponse.json({ error: "scraper already running" }, { status: 409 });
  }

  const webDir = process.cwd();
  const repoRoot = path.resolve(webDir, "..", "..");
  const scraperDir = path.join(repoRoot, "workers", "scraper");
  const pythonCmd = process.env.PYTHON_BIN || "python";
  const args = [
    "scraper.py",
    "--run",
    "--mode", "enrich",
    "--batch-intent", "custom_outreach",
    "--batch-id", String(body.batchId),
  ];

  const child = spawn(pythonCmd, args, {
    cwd: scraperDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  await persistScraperPid(child.pid ?? null);
  trackWorkerChild(child, { kind: "enrichment_one_shot", label: `enrich-batch:${body.batchId}` });

  // Mirror output to .logs (per AGENTS.md §2 worker-spawn rule).
  // Reuse the same helper used in apps/web/app/api/enrich/route.ts.
  // (If the helper isn't exported, copy its body here; do not import-cycle.)

  child.unref();
  logger.info("custom-outreach enrich-batch spawned", { correlationId }, { pid: child.pid, batchId: body.batchId });
  return NextResponse.json({ ok: true, pid: child.pid });
}
```

(If `mirrorWorkerOutput` is not currently exported from `enrich/route.ts`, lift it into a shared module like `apps/web/lib/spawnMirror.ts` as part of this task, and import from both routes. AGENTS.md §2 says spawn output must mirror to container logs *and* `.logs/` — both routes must obey.)

- [ ] **Step 3: Type-check**

```
cd apps/web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 4: Smoke verify the endpoint**

With the dev server running and at least one NEW custom-outreach lead in the test batch:
```
curl -X POST http://localhost:3000/api/custom-outreach/enrich-batch \
  -H "Content-Type: application/json" \
  -d '{"batchId": <test_batch_id>}' \
  --cookie "<session cookie or auth header>"
```
Expected: `{ ok: true, pid: <number> }`. Watch the spawned scraper's logs to see it pick up the leads scoped to that batch only. Re-fire while it's running → `409`.

- [ ] **Step 5: Commit**

```
git add apps/web/app/api/custom-outreach/enrich-batch/route.ts
git commit -m "feat(api): add custom-outreach enrich-batch one-shot endpoint"
```

---

## Task 8: Progress card component

**Files:**
- Create: `apps/web/components/CustomOutreachBatchProgress.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/components/CustomOutreachBatchProgress.tsx`:

```tsx
"use client";

import type { CustomOutreachBatchSummary } from "../app/actions";

type Props = {
  batch: CustomOutreachBatchSummary;
};

const STAGES: Array<{ key: keyof CustomOutreachBatchSummary; label: string; modifier: string }> = [
  { key: "new_count",         label: "NEW",         modifier: "status-pending" },
  { key: "enriched_count",    label: "ENRICHED",    modifier: "status-progress" },
  { key: "draft_ready_count", label: "DRAFT READY", modifier: "status-progress" },
  { key: "approved_count",    label: "APPROVED",    modifier: "status-attention" },
  { key: "sent_count",        label: "SENT",        modifier: "status-success" },
  { key: "failed_count",      label: "FAILED",      modifier: "status-error" },
];

export function CustomOutreachBatchProgress({ batch }: Props) {
  const total = batch.lead_count;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
        border: "3px solid var(--fg)",
        padding: "8px 10px",
        marginTop: 6,
      }}
      data-testid="custom-outreach-batch-progress"
    >
      <span className="muted" style={{ textTransform: "uppercase", fontSize: 11 }}>
        {total} LEADS
      </span>
      {STAGES.map((stage) => {
        const count = (batch[stage.key] as number) ?? 0;
        if (count === 0) return null;
        return (
          <span key={stage.key} className={`status-chip ${stage.modifier}`}>
            {stage.label} · {count}
          </span>
        );
      })}
    </div>
  );
}
```

(If the project's status-chip modifier names differ from `status-pending` / `status-progress` / etc., use the actual names from `apps/web/app/globals.css` or wherever they're defined. CLAUDE.md token vocabulary mentions `.status-chip` and `.status-*` modifiers.)

- [ ] **Step 2: Type-check**

```
cd apps/web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 3: Visual smoke**

Render it in isolation by adding it temporarily to the custom-outreach page (or via a Storybook/MDX page if one exists) and confirming the brutalist look. Remove the temporary mount before commit.

- [ ] **Step 4: Commit**

```
git add apps/web/components/CustomOutreachBatchProgress.tsx
git commit -m "feat(custom-outreach): add per-batch progress chip strip (brutalist)"
```

---

## Task 9: Wire progress + ENRICH NOW into the workspace

**Files:**
- Modify: `apps/web/components/CustomOutreachWorkspace.tsx`

- [ ] **Step 1: Import the component**

Top of file:

```tsx
import { CustomOutreachBatchProgress } from "./CustomOutreachBatchProgress";
```

- [ ] **Step 2: Render the progress card per batch**

Find the batch list rendering (`batches.map((batch) => { ... })` around line 370). Inside the existing batch row, after the `<strong>{batch.name}</strong>`, insert:

```tsx
<CustomOutreachBatchProgress batch={batch} />
```

- [ ] **Step 3: Add the ENRICH NOW button per batch**

Inside the same batch row, alongside any existing per-batch actions (or add a new action stack if none), add:

```tsx
<button
  className="btn"
  type="button"
  onClick={async (event) => {
    event.stopPropagation();
    const res = await fetch("/api/custom-outreach/enrich-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: batch.id }),
    });
    if (res.status === 409) {
      window.alert("Scraper already running. Wait for it to finish.");
      return;
    }
    if (!res.ok) {
      window.alert("Failed to start enrichment.");
      return;
    }
    router.refresh();
  }}
>
  ENRICH NOW
</button>
```

The button STOPS PROPAGATION because the parent batch row already has an `onClick` for selection. CLAUDE.md design-context: brutalist, uppercase, no chrome — use the existing `.btn` class.

- [ ] **Step 4: Type-check**

```
cd apps/web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 5: Smoke verify in the UI**

1. Upload a fresh custom-outreach CSV → leads land as NEW.
2. The batch's progress chip shows `NEW · N`.
3. Click ENRICH NOW → 200 response, scraper spawns.
4. Refresh the page (or wait for polling if any) → chips update through ENRICHED → DRAFT_READY as the loops process leads.

- [ ] **Step 6: Commit**

```
git add apps/web/components/CustomOutreachWorkspace.tsx
git commit -m "feat(custom-outreach): show per-batch progress + ENRICH NOW button"
```

---

## Task 10: End-to-end verification + plan close-out

- [ ] **Step 1: Full pipeline smoke**

With nothing else running:
```
./run_all.sh --enrichment-loop --draft-loop --web
```

Then in the UI:
1. Upload a custom-outreach CSV (5 leads).
2. Verify the batch shows `NEW · 5`.
3. Either click ENRICH NOW (immediate), or wait for the loop's idle interval.
4. Watch chips: `NEW` decreases, `ENRICHED` increases, then `DRAFT_READY` increases as the agent loop processes them.
5. Open the batch in the workspace → drafts visible, with personalized openers (verify in the actual draft text that `profile_data` was used: it should reference something from the LinkedIn profile, not just CSV fields).
6. Approve one draft → status flips to `APPROVED`.
7. Trigger the existing sender → `APPROVED` flips to `SENT`.

- [ ] **Step 2: Cross-mode isolation check**

Upload a sequence-driven (`connect_message`) batch in parallel. Verify:
- The enrichment-loop logs do NOT pick up its leads (filter is `batch_intent='custom_outreach'`).
- The draft loop does NOT generate drafts for them (Task 2's defensive filter).
- Plan A's `SEND INVITES` flow on that batch still works without interference.

- [ ] **Step 3: Single-spawn enforcement**

While `--enrichment-loop` is running, click ENRICH NOW → expect `409 scraper already running`. While `--enrichment-loop` is stopped, click ENRICH NOW → expect 200 + spawn.

- [ ] **Step 4: Negative path**

Mark a known-bad LinkedIn URL as a custom-outreach lead. After the loop processes it:
- Expected: `status='ENRICH_FAILED'` (existing `mark_lead_failed` semantics).
- The chip shows it under `FAILED` (Task 6 collapses both `FAILED` and `ENRICH_FAILED` into `failed_count`).

- [ ] **Step 5: Final commit (only if smoke uncovered fixes)**

```
git commit -m "fix(custom-outreach): smoke-test fixups"
```

- [ ] **Step 6: Finishing-a-development-branch handoff**

Invoke superpowers:finishing-a-development-branch to choose the merge strategy. Plan A (sequence sender decoupling) and Plan B (this) can ship independently.

---

## Self-Review

**1. Spec coverage.** The brainstorm produced these acceptance points, all covered:
- Custom-outreach leads import as NEW, not fake-ENRICHED → Task 1.
- Background enrichment scoped to custom_outreach → Task 3.
- Background drafting scoped to custom_outreach → Task 2 (filter) + Task 4 (loop).
- Both loops supervised by run_all.sh → Task 5.
- Per-batch progress visibility → Tasks 6 + 8 + 9.
- ENRICH NOW one-shot button → Tasks 7 + 9.
- AGENTS.md §2 single-spawn enforcement preserved → Task 7 reuses `assertScraperLockFree`/`persistScraperPid`.
- Existing sequence-driven leads unaffected → Task 2 (defensive filter), Task 3 (scoped fetch); cross-mode check in Task 10.

**2. Placeholder scan.** Searched for "TBD/TODO/handle edge cases/etc." — none. Two intentional engineer-decision points are flagged inline:
- Task 3 Step 1 mentions adapting `choices=[None, ...]` if argparse balks — that's an explicit fallback, not a placeholder.
- Task 4 Step 2 says "match the actual entrypoint name from `run_agent.py`" — the engineer must look; this is honest about not pre-guessing the codebase.

**3. Type consistency.** `CustomOutreachBatchSummary` extended once in Task 6 and consumed in Task 8 (component) + Task 9 (workspace) — all reference the same fields. `--enrichment-loop` / `--watch` / `--batch-intent` flag names used consistently. The `mode='connect_message'` argument to `get_leads_for_generation` (Task 4) maps to `status='ENRICHED' AND outreach_mode='message'` (Task 2) — that mapping must hold; if `mcp-server/tools.py` ever changes the status_filter computation, this plan's draft loop breaks. Engineer should check before commit.
