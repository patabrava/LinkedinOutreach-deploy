# Message-Only Auto Daemon — Design Spec

**Date:** 2026-04-25
**Branch:** `codex/custom-outreach-tab-design`
**Owner:** Camilo
**Status:** Draft, pending implementation plan

---

## 1. Problem

`workers/sender/sender.py --message-only` polls leads in status `CONNECT_ONLY_SENT` (friend request accepted) and sends them the first sequence message. In production this loop is started by `run_all.sh --message-only`, which wraps it as:

```
while true; do python -u sender.py --message-only; sleep 900; done
```

That daemon is the answer to "send the first message within minutes of acceptance, hands-off." But there is no UI to start it, no UI to confirm it is running, and no UI to detect when it is silently broken.

The existing UI offers only:

- **`SEND MESSAGE AFTER FRIEND REQUEST ACCEPTANCE`** — a one-shot of `sender.py --message-only` triggered via `sendAllApproved("connect_only")`. It drains the current queue and exits. No persistence.
- `WorkerControlPanel` — shows PIDs of currently-tracked workers and a STOP button. PID-alive only; no signal that the worker is actually doing work.

## 2. Goals

1. Operator can **start** the message-only polling daemon from the `/leads` page.
2. Operator can **stop** the daemon from the same page.
3. Operator can see, at a glance, whether the daemon is **running, stuck, or stopped** — based on real signals (process alive AND log activity), not PID-alive only.
4. Existing one-shot button stays untouched.
5. Existing scraper buttons (`CONNECT + MESSAGE`, `SEND INVITES`) stay untouched.
6. No changes to `sender.py`.
7. Survives a Next dev-server reload (daemon keeps running, status keeps reporting).

## 3. Non-goals

- Daemon for `sender.py --followup`. Deferred.
- Daemon for default `sender.py` (initial outreach). Deferred.
- Auto-restart-on-crash semantics beyond what the bash `while true` already provides.
- Cross-tab leader election or browser-driven polling (server-side process is the only mechanism).
- Editing `sender.py` to add a `--loop` flag, or changing its log format.

## 4. Architecture

### 4.1 Daemon process model

Spawn a detached bash wrapper from the Next.js API route:

```
bash -c "while true; do python -u sender.py --message-only; sleep ${SENDER_MESSAGE_ONLY_INTERVAL_SEC:-900}; done"
```

- `cwd` = `workers/sender`
- `stdio` = `["ignore", logFile, logFile]` where `logFile = .logs/sender-message-only-daemon.log` (dedicated; does not collide with `run_all.sh`'s `.logs/sender_message_only.log`).
- `detached: true` so the bash process becomes its own process-group leader. This lets us kill the **process group** later (bash + python child + Playwright children) with one signal.
- `child.unref()` so the Next process exit does not kill the daemon.

**Why bash-while and not a Python `--loop` flag:** `sender.py` opens a fresh Playwright browser per invocation by design. An in-process loop risks browser state leaks and behavior drift from `run_all.sh`. Bash-wrap keeps runtime semantics identical to the production daemon.

### 4.2 Worker registry kind

Add new kind `sender_message_only` to `WorkerKind` in `apps/web/lib/workerControl.ts`. Distinct from existing `sender_outreach` so:

- The daemon shows up as its own row in any future status panel.
- The existing `WorkerControlPanel kinds={["sender_outreach", ...]}` STOP buttons on Mission Control / followups do **not** kill the daemon by accident.
- The existing one-shot senders fired from `actions.ts` (which register as `sender_outreach`) stay separate.

### 4.3 Process-group kill

`WorkerRecord` gets one new optional field: `processGroup?: boolean`.

`stopWorkers` is updated:

- When `processGroup === true`, send SIGTERM to `-pid` (the negative PID, which targets the entire process group).
- Otherwise, fall back to current behavior: SIGTERM to `pid`.

Existing one-shot worker records do not set `processGroup`, so their kill path is unchanged.

### 4.4 Health signal

A daemon can be PID-alive but functionally dead — bash spinning while every python iteration crashes immediately. Three independent signals, all derivable without modifying `sender.py`:

| Signal | Source | Meaning |
|---|---|---|
| **Process alive** | `process.kill(pid, 0)` | Bash wrapper still running. |
| **Loop iterating** | `mtime` of daemon log file | sender.py is producing output (not hung mid-iteration). |
| **Last iteration outcome** | tail-parse for `Operation Complete: sender-message[-_]only` / `Operation Error: sender-message[-_]only` | Did the most recent run succeed, fail, or find no work. |

**Stuck threshold:** `now − mtime > 2 × SENDER_MESSAGE_ONLY_INTERVAL_SEC`. If the daemon is alive but stale, surface as a loud red `STUCK` state.

**Log line format (verified):** `shared_logger.StructuredLogger` emits to console (stderr) as:

```
[<iso-ts>] LEVEL: <message>[ context=k=v ...]
  Data: <pretty-printed JSON, multi-line, only when entry has "data" and len < 500>
```

The bash wrapper's stdio redirect captures stderr+stdout into the daemon log file. Markers we parse:

- `Operation Start: sender-message_only`
- `Operation Complete: sender-message-only`
- `Operation Error: sender-message_only`

The literal-hyphen vs underscore inconsistency between `operation_start`/`operation_error` (uses `f"sender-{mode}"` where `mode = "message_only"`) and `operation_complete` (literal `sender-message-only` at sender.py:2098) is matched by a single regex: `sender-message[-_]only`.

**Parser scope for v1:** match the marker line and extract its leading `[<iso-ts>]`. **Do not** attempt to parse the multi-line `  Data: {...}` JSON block that follows `Operation Complete`. Counts are out of scope for v1; the result block is a future enhancement.

## 5. API surface

### 5.1 New: `POST /api/sender/message-only/start`

Operator-guarded via existing `requireOperatorAccess`.

Request: empty body.

Response (200):
```json
{ "ok": true, "pid": 12345, "message": "Message-only auto daemon started." }
```

Response (409) when a `sender_message_only` worker is already registered and PID-alive:
```json
{ "ok": false, "error": "Daemon already running (pid 12345). Stop it before starting a new one." }
```

Response (412) when neither `workers/sender/auth.json` nor `workers/scraper/auth.json` (nor their `LINKEDIN_*_DIR` env-var equivalents) exists. Mirrors `run_all.sh`'s `has_sender_auth_state` check.

Response (500) on spawn failure.

Behavior:

1. Resolve repo root from `apps/web` cwd (existing pattern: `path.resolve(process.cwd(), "..", "..")`).
2. Verify auth state present.
3. Verify no live `sender_message_only` worker.
4. Resolve venv python (existing pattern: `workers/sender/venv/bin/python` → `/opt/local/bin/python3` → `python3`).
5. Open append stream to `.logs/sender-message-only-daemon.log`.
6. `spawn("bash", ["-c", LOOP_CMD], { cwd: senderDir, env: { ...process.env, CORRELATION_ID }, stdio: ["ignore", "pipe", "pipe"], detached: true })`.
7. Pipe child stdout/stderr to the log file.
8. `trackWorkerChild({ child, kind: "sender_message_only", label: "Message-only daemon", processGroup: true, args: ["bash", "-c", LOOP_CMD] })`.
9. `child.unref()`.
10. Return 200.

### 5.2 New: `GET /api/sender/message-only/health`

Operator-guarded.

Response:
```ts
{
  ok: true,
  running: boolean,             // PID-alive of registered sender_message_only worker
  stuck: boolean,               // running && (now - logMtime) > 2 * intervalSec
  pid: number | null,
  startedAt: string | null,     // ISO; from registry record
  lastActivityAt: string | null, // ISO; daemon log file mtime
  lastIterationAt: string | null, // ISO; from last "Operation Complete: sender-message[-_]only" line, else last "Operation Error: sender-message[-_]only" line
  lastIterationOutcome: "ok" | "error" | "unknown",  // v1; "no_work" deferred (see §11)
  lastError: string | null,     // last ERROR-tagged log line (truncated to 240 chars), or null
  intervalSec: number,          // resolved SENDER_MESSAGE_ONLY_INTERVAL_SEC
  stuckThresholdSec: number     // 2 * intervalSec
}
```

Implementation:

1. `listActiveWorkers({ kinds: ["sender_message_only"] })` → first record (there should be at most one).
2. If no record: return `running: false`, all fields null, plus `intervalSec` / `stuckThresholdSec`.
3. If record: `fs.stat` the daemon log file → `lastActivityAt = mtime.toISOString()`.
4. Tail the last ~200 lines (read last 32 KiB; split on newline; drop incomplete first line).
5. Walk lines in reverse, looking only at single lines (ignore the indented `  Data:` blocks):
   - First line matching `Operation Complete: sender-message[-_]only` → `lastIterationOutcome = "ok"`, `lastIterationAt` = parsed timestamp from leading `[ts]`. Stop.
   - Else first line matching `Operation Error: sender-message[-_]only` → `lastIterationOutcome = "error"`, `lastIterationAt` = parsed timestamp, `lastError` = the same line (truncated to 240 chars). Stop.
   - Else `lastIterationOutcome = "unknown"`, `lastIterationAt = null`.
6. Independently, `lastError`: walk in reverse for the most recent line tagged ` ERROR: `. If found and not already set above, populate `lastError`.
7. `stuck = running && lastActivityAt !== null && (Date.now() - mtime) > stuckThresholdSec * 1000`.

### 5.3 Reused: `POST /api/workers/stop`

Body: `{ "kinds": ["sender_message_only"] }`. No new route. Process-group kill is handled inside `stopWorkers` based on `processGroup` flag on the worker record.

### 5.4 Reused: `GET /api/workers/status`

Add `KIND_LABELS["sender_message_only"] = "Message-only daemon"` so it renders correctly if a future panel reuses it. No other change.

## 6. Frontend

### 6.1 New component: `apps/web/components/SenderMessageOnlyControl.tsx`

Self-contained card. Polls `GET /api/sender/message-only/health` every 5 s.

Visual structure (brutalist, per CLAUDE.md aesthetic):

```
┌─────────────────────────────────────────────────────────────┐
│ MESSAGE-ONLY AUTO MODE                          [STATUS]    │
│ Polls accepted friend requests every ~15 min and sends      │
│ the first sequence message until stopped.                   │
│                                                             │
│ PID 12345 · STARTED 14:02 · LAST RUN 14:17 · OK             │
│ LAST ERROR (if any, dashed border block)                    │
│                                                             │
│ [START FULL AUTO]    [STOP FULL AUTO]    [REFRESH]          │
└─────────────────────────────────────────────────────────────┘
```

Status chip variants:

- `RUNNING` — solid black bg, white fg. `running && !stuck`.
- `STUCK` — dashed black border, no fill. `running && stuck`. Plus a body warning: "No log activity in {Nm Ns}; daemon may be hung."
- `STOPPED` — `var(--muted)` text, no border. `!running`.

Buttons:

- `START FULL AUTO` — disabled when `running`. POSTs to `/api/sender/message-only/start` with operator headers. On 409, shows the error inline. On 412, shows a clear "auth.json missing — log in once" message.
- `STOP FULL AUTO` — disabled when `!running`. POSTs to `/api/workers/stop` with `{ kinds: ["sender_message_only"] }`.
- `REFRESH` — re-fetches health.

After START / STOP succeed, immediately re-fetch health (silent), don't wait for the 5 s tick.

Reuses existing button classes (`btn`, `btn warn`, `btn secondary`) and tokens from `globals.css`. No new palette values.

### 6.2 Placement

`apps/web/app/leads/page.tsx` — render `<SenderMessageOnlyControl />` directly below the existing `<TriggerButton ... label="SEND DUE FOLLOW-UPS" />` block, inside the same column, so the operator sees the daemon state next to the manual triggers.

### 6.3 What does not change

- `WorkerControlPanel.tsx` — untouched.
- `StartEnrichmentButton.tsx` — untouched.
- `LeadRunControls.tsx` — untouched.
- Mission Control (`/`) and `/followups` — untouched.

## 7. Configuration

| Env var | Default | Purpose |
|---|---|---|
| `SENDER_MESSAGE_ONLY_INTERVAL_SEC` | `900` (15 min) | Sleep between iterations inside the bash loop. |
| (existing) `LINKEDIN_SENDER_DIR` / `LINKEDIN_SCRAPER_DIR` | — | Used by auth-state preflight check, same as `run_all.sh`. |
| (existing) `DAILY_SEND_LIMIT` | — | Honored by sender.py itself; daemon does not duplicate the cap. |

## 8. Edge cases & failure modes

| Case | Behavior |
|---|---|
| Auth missing at start time | 412 with explicit message; daemon never spawns. |
| Auth lost mid-run | sender.py exits non-zero with auth error; bash loops; ERROR lines appear in log; UI surfaces `lastError`. Operator stops daemon, re-auths, restarts. |
| Daemon already running, START clicked | 409 from start route; UI shows error inline; existing daemon untouched. |
| Daily cap reached | sender.py returns early with INFO log; bash loops; UI shows `lastIterationOutcome: "ok"` (or `"no_work"`) with recent `lastIterationAt`. Acceptable. |
| Next dev hot-reload | `child.unref()` keeps the daemon alive; registry file (`.logs/worker-control.json`) survives the reload; status endpoint sees the worker via PID-aliveness. No daemon restart needed. |
| Hard kill of daemon (e.g., reboot) | `cleanupRegistry` removes the dead PID on next status read. UI flips to `STOPPED`. Operator can START again. |
| Bash wrapper killed but python child orphaned | Process-group kill (`-pid`) addresses this. If somehow a python orphan survives (shouldn't, since python is in the same group), operator must `pkill -f sender.py` from terminal — call out in spec but not handled in v1. |
| Log file rotated / deleted while daemon runs | `fs.stat` raises ENOENT; health endpoint returns `lastActivityAt: null` and `lastIterationOutcome: "unknown"`. Daemon keeps running. |
| Multiple operators clicking START at once | Server-side check is the source of truth; second request returns 409. UI does not need a client-side lock. |
| `process.kill(-pid, ...)` on Windows | Not supported. Project is darwin/linux only (per repo context). Out of scope. |

## 9. Testing strategy

Per `superpowers:test-driven-development`:

- **Unit:** extend `apps/web/lib/workerControl.test.ts` with a case asserting `processGroup: true` records get killed via negative PID. Mock `process.kill`.
- **Unit (parser):** new `apps/web/lib/senderMessageOnlyHealth.test.ts` — feed fixture log contents into the parser and assert `lastIterationOutcome`, `lastIterationAt`, `lastError`. Cases: (a) most recent marker is Operation Complete → ok, (b) most recent marker is Operation Error → error + lastError populated, (c) only Operation Start, no completion → unknown, (d) interleaved errors followed by a clean Operation Complete → ok with lastError still surfaced from earlier ERROR line, (e) empty file → unknown / nulls, (f) hyphen-vs-underscore variant lines both recognized.
- **Integration:** none required for v1. Manual smoke: start daemon, observe RUNNING, stop daemon, observe STOPPED. Force a stuck condition by SIGSTOPing the python child and observe STUCK after `2 × interval`.
- **Manual checklist** (added to plan):
  - START with auth missing → 412
  - START with auth present → RUNNING within 5 s
  - Within 1 minute, daemon log shows `Operation Start: sender-message_only`
  - STOP → STOPPED within 5 s; `pgrep -f "sender.py --message-only"` returns empty
  - Restart Next dev server → daemon survives, UI re-attaches
  - SIGSTOP the python child for 35 min → UI flips to STUCK

## 10. Locality envelope (per AGENTS.md §0)

| Aspect | Budget |
|---|---|
| Files touched | 6 |
| Net LOC added | ≤ 280 |
| New runtime deps | 0 |

Files:

1. `apps/web/lib/workerControl.ts` — modify: add `sender_message_only` kind, `processGroup` field, group-kill branch in `stopWorkers`. ~25 LOC.
2. `apps/web/app/api/sender/message-only/start/route.ts` — new. ~120 LOC.
3. `apps/web/app/api/sender/message-only/health/route.ts` — new. ~90 LOC (includes log-tail + parser; parser may be extracted to `lib/senderMessageOnlyHealth.ts` if it grows).
4. `apps/web/app/api/workers/status/route.ts` — modify: one new entry in `KIND_LABELS`. ~3 LOC.
5. `apps/web/components/SenderMessageOnlyControl.tsx` — new. ~150 LOC.
6. `apps/web/app/leads/page.tsx` — modify: import + render. ~5 LOC.

Plus tests (additive, do not count against runtime budget): `workerControl.test.ts` (modify) and optionally `senderMessageOnlyHealth.test.ts` (new) if the parser is extracted.

## 11. Open questions deferred to implementation

- **`no_work` outcome.** Does sender.py emit a stable, greppable line when there are no leads to process in `--message-only` mode? Verify before finalizing the parser branch. Fallback: keep three states (`ok | error | unknown`) for v1 and add `no_work` later if it earns its complexity.
- **Log file path under containerized runs.** `run_all.sh` uses `.logs/sender_message_only.log` for its own daemon. We use `.logs/sender-message-only-daemon.log` to disambiguate. If the operator is running both `run_all.sh --message-only` AND clicks START in the UI, two daemons will be polling the same queue concurrently — this is not a corruption risk (sender.py uses DB row claiming) but it doubles the LinkedIn request rate. Mitigation: the start route's preflight could also `pgrep -f "sender.py --message-only"` to detect the run_all.sh daemon and refuse, but cross-process-tree detection is fragile. **Decision for v1:** detect only via the worker-control registry; document the foot-gun in the operator-facing description text.
- **Operator description copy.** Final wording for the card and confirmation messages — to be polished during implementation.

## 12. Glossary

- **Daemon** — long-lived process that polls a queue. In this spec, a bash `while true` wrapper around `sender.py --message-only`.
- **One-shot** — single invocation of `sender.py --message-only` that drains current queue and exits.
- **Stuck** — daemon process is alive (PID exists) but log file `mtime` is older than `2 × interval`. Indicates the python iteration is hung (e.g., Playwright navigation stalled, deadlock).
- **Worker registry** — `.logs/worker-control.json`, written/read by `apps/web/lib/workerControl.ts`. Tracks all spawned workers regardless of kind.
