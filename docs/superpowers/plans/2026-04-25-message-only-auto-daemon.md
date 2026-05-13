# Message-Only Auto Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a UI-controlled, server-side polling daemon for `sender.py --message-only` so an operator can start, stop, and observe the auto-send-after-acceptance loop from `/leads`.

**Architecture:** Spawn a detached `bash -c "while true; do python -u sender.py --message-only; sleep $INTERVAL; done"` from a Next.js API route. Track it through the existing worker registry under a new `sender_message_only` kind, with a `processGroup` flag that lets `stopWorkers` send SIGTERM to the negative PID (kills bash + python + Playwright in one shot). Health derives from three independent signals: PID-alive, daemon log `mtime`, and tail-parsed `Operation Complete / Error` markers. A new client component polls health every 5 s and exposes START / STOP / REFRESH buttons on `/leads`. No changes to `sender.py`.

**Tech Stack:** Next.js 14 (App Router) API routes, React client component, Node `child_process.spawn` with `detached: true`, `node:test` + `tsx` for unit tests.

**Files (per AGENTS.md §0 locality envelope — `{files: 6 modified/created + 1 test, LOC ≤ 280, deps: 0}`):**
1. Modify: `apps/web/lib/workerControl.ts` — add `sender_message_only` kind, `processGroup` field, group-kill branch.
2. Modify: `apps/web/lib/workerControl.test.ts` — add a process-group kill test.
3. Create: `apps/web/lib/senderMessageOnlyHealth.ts` — pure log-tail parser.
4. Create: `apps/web/lib/senderMessageOnlyHealth.test.ts` — parser unit tests.
5. Create: `apps/web/app/api/sender/message-only/start/route.ts` — POST, spawns the daemon.
6. Create: `apps/web/app/api/sender/message-only/health/route.ts` — GET, returns health JSON.
7. Modify: `apps/web/app/api/workers/status/route.ts` — add `sender_message_only` to `KIND_LABELS`.
8. Create: `apps/web/components/SenderMessageOnlyControl.tsx` — operator card.
9. Modify: `apps/web/app/leads/page.tsx` — render the new card.

**Test runner:** `cd apps/web && npx --yes tsx --test <path>`. Confirmed working in this repo (Node 20 + tsx; matches the existing `workerControl.test.ts` invocation convention).

---

## Task 1: Add `sender_message_only` kind + `processGroup` field + group-kill in `workerControl`

**Files:**
- Modify: `apps/web/lib/workerControl.ts`
- Modify: `apps/web/lib/workerControl.test.ts`

Establishes the registry primitive needed by every later task. Done first because the start route, the status route, and the stop route all reference the new kind.

- [ ] **Step 1: Write the failing test** — append to `apps/web/lib/workerControl.test.ts` (after the existing `stopWorkers` test):

```ts
import { spawn as nodeSpawn } from "child_process";

test("stopWorkers with processGroup=true kills the entire process group", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-control-pgroup-"));
  const registryPath = path.join(tmpDir, "worker-control.json");

  // bash spawns a sleep child, prints its PID, then waits — so we can verify
  // that killing the process group also kills the inner sleep, not only bash.
  const child = nodeSpawn(
    "bash",
    ["-c", "sleep 60 & echo $! ; wait"],
    { stdio: ["ignore", "pipe", "ignore"], detached: true },
  );
  assert.ok(child.pid);

  const innerPid = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("never read inner pid")), 5000);
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const pid = Number(buffer.slice(0, newline).trim());
        clearTimeout(timeout);
        resolve(pid);
      }
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  registerWorkerPid({
    registryPath,
    kind: "sender_message_only",
    pid: child.pid!,
    label: "Message-only daemon",
    args: ["bash", "-c", "loop"],
    processGroup: true,
  });

  const result = stopWorkers({ registryPath, kinds: ["sender_message_only"] });
  assert.equal(result.stopped.length, 1);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("bash did not exit after group SIGTERM")), 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // The inner sleep should be dead too. Poll briefly to allow signal delivery.
  const innerDead = await new Promise<boolean>((resolve) => {
    const deadline = Date.now() + 3000;
    const tick = () => {
      try {
        process.kill(innerPid, 0);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return resolve(true);
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
  assert.equal(innerDead, true, "inner sleep child must be killed by group SIGTERM");
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/web && npx --yes tsx --test lib/workerControl.test.ts`
Expected: TypeScript error on `processGroup: true` ("Object literal may only specify known properties") OR test fails because the inner `sleep` survives — bash receives SIGTERM but its child does not.

- [ ] **Step 3: Implement the change** — edit `apps/web/lib/workerControl.ts`:

Replace the `WorkerKind` union at line 5–10:

```ts
export type WorkerKind =
  | "scraper_outreach"
  | "scraper_inbox"
  | "draft_agent"
  | "sender_outreach"
  | "sender_followup"
  | "sender_message_only";
```

Replace `WorkerRecord` (line 12–19) with the optional flag added:

```ts
export type WorkerRecord = {
  id: string;
  kind: WorkerKind;
  pid: number;
  label: string;
  startedAt: string;
  args: string[];
  processGroup?: boolean;
};
```

Replace `RegisterWorkerInput` (line 25–31):

```ts
type RegisterWorkerInput = {
  registryPath?: string;
  kind: WorkerKind;
  pid: number;
  label: string;
  args?: string[];
  processGroup?: boolean;
};
```

Replace the worker construction inside `registerWorkerPid` (currently at lines 125–132):

```ts
  const worker: WorkerRecord = {
    id: `${input.kind}:${input.pid}`,
    kind: input.kind,
    pid: input.pid,
    label: input.label,
    startedAt: new Date().toISOString(),
    args: input.args || [],
    ...(input.processGroup ? { processGroup: true } : {}),
  };
```

Update `trackWorkerChild` (currently at lines 153–171) so it forwards `processGroup`:

```ts
export function trackWorkerChild({ child, registryPath, kind, label, args, processGroup }: TrackWorkerChildInput) {
  if (!child.pid) {
    return null;
  }

  const record = registerWorkerPid({
    registryPath,
    kind,
    pid: child.pid,
    label,
    args,
    processGroup,
  });

  child.on("exit", () => {
    unregisterWorkerPid(child.pid || 0, registryPath);
  });

  return record;
}
```

Inside `stopWorkers` (currently at lines 178–190), change the `process.kill` line to switch on `processGroup`:

```ts
  matchingWorkers.forEach((worker) => {
    try {
      const target = worker.processGroup ? -worker.pid : worker.pid;
      process.kill(target, "SIGTERM");
      stopped.push(worker);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ESRCH") {
        notRunning.push(worker);
        return;
      }
      throw error;
    }
  });
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd apps/web && npx --yes tsx --test lib/workerControl.test.ts`
Expected: `# pass 3 / # fail 0`. The pre-existing two tests still pass; the new pgroup test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/workerControl.ts apps/web/lib/workerControl.test.ts
git commit -m "feat(workers): add sender_message_only kind and process-group kill"
```

---

## Task 2: Extract pure log-tail health parser with tests

**Files:**
- Create: `apps/web/lib/senderMessageOnlyHealth.ts`
- Create: `apps/web/lib/senderMessageOnlyHealth.test.ts`

Pure-function parser, isolated for unit testing — the health route will read the log file and call this. Per spec §5.2 step 5, we ignore indented `  Data:` JSON blocks and only inspect single marker lines.

- [ ] **Step 1: Write the failing test** — create `apps/web/lib/senderMessageOnlyHealth.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { parseSenderMessageOnlyTail } from "./senderMessageOnlyHealth";

test("parses Operation Complete as ok with timestamp", () => {
  const tail = [
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Start: sender-message_only [operation=sender-message_only]",
    "[2026-04-25T10:01:00.000000Z] INFO: Operation Complete: sender-message-only [operation=sender-message-only]",
    "  Data: {",
    "    \"sent\": 0",
    "  }",
  ].join("\n");
  const result = parseSenderMessageOnlyTail(tail);
  assert.equal(result.lastIterationOutcome, "ok");
  assert.equal(result.lastIterationAt, "2026-04-25T10:01:00.000000Z");
  assert.equal(result.lastError, null);
});

test("parses Operation Error as error and surfaces the line as lastError", () => {
  const tail = [
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Start: sender-message_only [operation=sender-message_only]",
    "[2026-04-25T10:00:30.000000Z] ERROR: Operation Error: sender-message_only [operation=sender-message_only]",
    "  Error: auth.json missing",
  ].join("\n");
  const result = parseSenderMessageOnlyTail(tail);
  assert.equal(result.lastIterationOutcome, "error");
  assert.equal(result.lastIterationAt, "2026-04-25T10:00:30.000000Z");
  assert.ok(result.lastError && result.lastError.includes("Operation Error: sender-message_only"));
});

test("only Operation Start present → unknown outcome", () => {
  const tail = "[2026-04-25T10:00:00.000000Z] INFO: Operation Start: sender-message_only";
  const result = parseSenderMessageOnlyTail(tail);
  assert.equal(result.lastIterationOutcome, "unknown");
  assert.equal(result.lastIterationAt, null);
});

test("clean Operation Complete after earlier error still surfaces last ERROR line", () => {
  const tail = [
    "[2026-04-25T09:00:00.000000Z] ERROR: connection timeout [op=foo]",
    "[2026-04-25T09:30:00.000000Z] ERROR: Operation Error: sender-message_only",
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Complete: sender-message-only",
  ].join("\n");
  const result = parseSenderMessageOnlyTail(tail);
  assert.equal(result.lastIterationOutcome, "ok");
  assert.equal(result.lastIterationAt, "2026-04-25T10:00:00.000000Z");
  assert.ok(result.lastError && result.lastError.includes("Operation Error: sender-message_only"));
});

test("empty input returns unknown nulls", () => {
  const result = parseSenderMessageOnlyTail("");
  assert.equal(result.lastIterationOutcome, "unknown");
  assert.equal(result.lastIterationAt, null);
  assert.equal(result.lastError, null);
});

test("hyphen-vs-underscore variants of the marker are both recognized", () => {
  const okHyphen = parseSenderMessageOnlyTail(
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Complete: sender-message-only",
  );
  const okUnderscore = parseSenderMessageOnlyTail(
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Complete: sender-message_only",
  );
  assert.equal(okHyphen.lastIterationOutcome, "ok");
  assert.equal(okUnderscore.lastIterationOutcome, "ok");
});

test("lastError is truncated to 240 chars", () => {
  const long = "x".repeat(500);
  const tail = `[2026-04-25T10:00:00.000000Z] ERROR: ${long}`;
  const result = parseSenderMessageOnlyTail(tail);
  assert.ok(result.lastError);
  assert.equal(result.lastError!.length, 240);
});

test("indented Data lines are ignored when scanning for ERROR", () => {
  const tail = [
    "[2026-04-25T10:00:00.000000Z] INFO: Operation Complete: sender-message-only",
    "  Data: {",
    "    \"error_field\": \"this should not be matched as ERROR\"",
    "  }",
  ].join("\n");
  const result = parseSenderMessageOnlyTail(tail);
  assert.equal(result.lastError, null);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/web && npx --yes tsx --test lib/senderMessageOnlyHealth.test.ts`
Expected: Module not found (`./senderMessageOnlyHealth`).

- [ ] **Step 3: Implement the parser** — create `apps/web/lib/senderMessageOnlyHealth.ts`:

```ts
export type IterationOutcome = "ok" | "error" | "unknown";

export type SenderMessageOnlyHealthParse = {
  lastIterationOutcome: IterationOutcome;
  lastIterationAt: string | null;
  lastError: string | null;
};

const TIMESTAMP_RE = /^\[([^\]]+)\]/;
const COMPLETE_RE = /Operation Complete: sender-message[-_]only/;
const ERROR_MARKER_RE = /Operation Error: sender-message[-_]only/;
const ERROR_LEVEL_RE = /^\[[^\]]+\]\s+ERROR:\s/;
const ERROR_TRUNCATE = 240;

const isMarkerLine = (line: string): boolean => line.startsWith("[");

export function parseSenderMessageOnlyTail(tail: string): SenderMessageOnlyHealthParse {
  const result: SenderMessageOnlyHealthParse = {
    lastIterationOutcome: "unknown",
    lastIterationAt: null,
    lastError: null,
  };

  if (!tail) return result;

  const lines = tail.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!isMarkerLine(line)) continue;

    if (COMPLETE_RE.test(line)) {
      const tsMatch = TIMESTAMP_RE.exec(line);
      result.lastIterationOutcome = "ok";
      result.lastIterationAt = tsMatch ? tsMatch[1] : null;
      break;
    }

    if (ERROR_MARKER_RE.test(line)) {
      const tsMatch = TIMESTAMP_RE.exec(line);
      result.lastIterationOutcome = "error";
      result.lastIterationAt = tsMatch ? tsMatch[1] : null;
      result.lastError = line.length > ERROR_TRUNCATE ? line.slice(0, ERROR_TRUNCATE) : line;
      break;
    }
  }

  if (result.lastError === null) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!isMarkerLine(line)) continue;
      if (ERROR_LEVEL_RE.test(line)) {
        result.lastError = line.length > ERROR_TRUNCATE ? line.slice(0, ERROR_TRUNCATE) : line;
        break;
      }
    }
  }

  return result;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd apps/web && npx --yes tsx --test lib/senderMessageOnlyHealth.test.ts`
Expected: `# pass 8 / # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/senderMessageOnlyHealth.ts apps/web/lib/senderMessageOnlyHealth.test.ts
git commit -m "feat(sender-message-only): add log-tail health parser"
```

---

## Task 3: `POST /api/sender/message-only/start` — spawn the bash-wrapped daemon

**Files:**
- Create: `apps/web/app/api/sender/message-only/start/route.ts`

Mirrors the auth/python-resolution pattern from `apps/web/app/api/enrich/connect-only/route.ts`. Uses `fs.openSync` for the log fd so the daemon survives Next dev hot-reload (pipes opened by the dev process die when it reloads; raw fds are inherited and persist).

- [ ] **Step 1: Create the route** — write `apps/web/app/api/sender/message-only/start/route.ts`:

```ts
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../../../lib/apiGuard";
import { logger } from "../../../../../lib/logger";
import { listActiveWorkers, trackWorkerChild } from "../../../../../lib/workerControl";

const DAEMON_LOG_FILENAME = "sender-message-only-daemon.log";

const resolveIntervalSec = (): number => {
  const raw = Number(process.env.SENDER_MESSAGE_ONLY_INTERVAL_SEC);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 900;
};

const senderAuthPresent = (repoRoot: string): boolean => {
  const candidates = [
    process.env.LINKEDIN_SENDER_DIR ? path.join(process.env.LINKEDIN_SENDER_DIR, "auth.json") : null,
    process.env.LINKEDIN_SCRAPER_DIR ? path.join(process.env.LINKEDIN_SCRAPER_DIR, "auth.json") : null,
    path.join(repoRoot, "workers", "sender", "auth.json"),
    path.join(repoRoot, "workers", "scraper", "auth.json"),
  ].filter((p): p is string => Boolean(p));
  return candidates.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
};

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/sender/message-only/start");
  const guardResponse = await requireOperatorAccess(request, "/api/sender/message-only/start", correlationId);
  if (guardResponse) return guardResponse;

  try {
    const webDir = process.cwd();
    const repoRoot = path.resolve(webDir, "..", "..");
    const senderDir = path.join(repoRoot, "workers", "sender");
    const logsDir = path.join(repoRoot, ".logs");

    if (!fs.existsSync(senderDir)) {
      logger.error("Sender directory not found", { correlationId }, undefined, { senderDir });
      return NextResponse.json({ ok: false, error: "Sender directory not found" }, { status: 500 });
    }

    if (!senderAuthPresent(repoRoot)) {
      logger.warn("Cannot start message-only daemon: no auth.json found", { correlationId });
      return NextResponse.json(
        {
          ok: false,
          error: "auth.json missing — log in once via the LinkedIn auth flow before starting the daemon.",
        },
        { status: 412 },
      );
    }

    const existing = listActiveWorkers({ kinds: ["sender_message_only"] });
    if (existing.length > 0) {
      const pid = existing[0]!.pid;
      logger.warn("Message-only daemon already running", { correlationId }, { pid });
      return NextResponse.json(
        { ok: false, error: `Daemon already running (pid ${pid}). Stop it before starting a new one.` },
        { status: 409 },
      );
    }

    const venvPython = path.join(senderDir, "venv", "bin", "python");
    const systemPython = "/opt/local/bin/python3";
    const pythonCmd = fs.existsSync(venvPython)
      ? venvPython
      : fs.existsSync(systemPython)
      ? systemPython
      : "python3";

    const intervalSec = resolveIntervalSec();
    const loopCmd = `while true; do "${pythonCmd}" -u sender.py --message-only; sleep ${intervalSec}; done`;

    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, DAEMON_LOG_FILENAME);
    const logFd = fs.openSync(logPath, "a");

    const child = spawn("bash", ["-c", loopCmd], {
      cwd: senderDir,
      env: { ...process.env, CORRELATION_ID: correlationId, SENDER_MESSAGE_ONLY_INTERVAL_SEC: String(intervalSec) },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });

    fs.closeSync(logFd);

    if (!child.pid) {
      logger.error("Failed to spawn message-only daemon", { correlationId });
      return NextResponse.json({ ok: false, error: "Failed to spawn daemon." }, { status: 500 });
    }

    trackWorkerChild({
      child,
      kind: "sender_message_only",
      label: "Message-only daemon",
      args: ["bash", "-c", loopCmd],
      processGroup: true,
    });
    child.unref();

    logger.info("Message-only daemon started", { correlationId, pid: child.pid }, { intervalSec, logPath });
    logger.apiResponse("POST", "/api/sender/message-only/start", 200, { correlationId });

    return NextResponse.json({
      ok: true,
      pid: child.pid,
      message: "Message-only auto daemon started.",
    });
  } catch (err: any) {
    logger.error("Failed to start message-only daemon", { correlationId }, err);
    logger.apiResponse("POST", "/api/sender/message-only/start", 500, { correlationId });
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Type-check the new route**

Run: `cd apps/web && npx --yes tsc --noEmit`
Expected: No errors. (If `tsc` isn't installed locally, run `npm --prefix apps/web run build -- --no-lint` instead and confirm it compiles.)

- [ ] **Step 3: Manual smoke** — with the dev server running:

```bash
# Terminal 1
cd apps/web && npm run dev
# Terminal 2
curl -i -X POST http://127.0.0.1:3000/api/sender/message-only/start
```
Expected outcomes:
- If `auth.json` is present and no daemon running: `200 OK` with `{ "ok": true, "pid": <number>, ... }`.
- Second call without stop: `409 Conflict`.
- After deleting/renaming all auth.json candidates: `412 Precondition Failed`.

Verify the daemon is running: `pgrep -fa "sender.py --message-only"` returns one python process; `pgrep -fa "while true; do"` returns one bash process.

Check the log file is being appended: `ls -la .logs/sender-message-only-daemon.log` should show a non-zero file with growing mtime within ~30 s of start.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/sender/message-only/start/route.ts
git commit -m "feat(api): add POST /api/sender/message-only/start"
```

---

## Task 4: `GET /api/sender/message-only/health` — surface health JSON

**Files:**
- Create: `apps/web/app/api/sender/message-only/health/route.ts`

Reads the registry, stats the daemon log, tails the last ~32 KiB, runs the parser from Task 2.

- [ ] **Step 1: Create the route** — write `apps/web/app/api/sender/message-only/health/route.ts`:

```ts
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../../../lib/apiGuard";
import { logger } from "../../../../../lib/logger";
import { listActiveWorkers } from "../../../../../lib/workerControl";
import { parseSenderMessageOnlyTail } from "../../../../../lib/senderMessageOnlyHealth";

const DAEMON_LOG_FILENAME = "sender-message-only-daemon.log";
const TAIL_BYTES = 32 * 1024;

const resolveIntervalSec = (): number => {
  const raw = Number(process.env.SENDER_MESSAGE_ONLY_INTERVAL_SEC);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 900;
};

const readTail = (logPath: string): { content: string; mtime: Date } | null => {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(logPath);
  } catch {
    return null;
  }
  const size = stat.size;
  if (size === 0) return { content: "", mtime: stat.mtime };

  const start = Math.max(0, size - TAIL_BYTES);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(logPath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let content = buffer.toString("utf8");
  if (start > 0) {
    const newline = content.indexOf("\n");
    if (newline !== -1) content = content.slice(newline + 1);
  }
  return { content, mtime: stat.mtime };
};

export async function GET(request: Request) {
  const correlationId = logger.apiRequest("GET", "/api/sender/message-only/health");
  const guardResponse = await requireOperatorAccess(request, "/api/sender/message-only/health", correlationId);
  if (guardResponse) return guardResponse;

  try {
    const webDir = process.cwd();
    const repoRoot = path.resolve(webDir, "..", "..");
    const logPath = path.join(repoRoot, ".logs", DAEMON_LOG_FILENAME);

    const intervalSec = resolveIntervalSec();
    const stuckThresholdSec = 2 * intervalSec;

    const workers = listActiveWorkers({ kinds: ["sender_message_only"] });
    const worker = workers[0] || null;

    if (!worker) {
      logger.apiResponse("GET", "/api/sender/message-only/health", 200, { correlationId }, { running: false });
      return NextResponse.json({
        ok: true,
        running: false,
        stuck: false,
        pid: null,
        startedAt: null,
        lastActivityAt: null,
        lastIterationAt: null,
        lastIterationOutcome: "unknown" as const,
        lastError: null,
        intervalSec,
        stuckThresholdSec,
      });
    }

    const tail = readTail(logPath);
    const lastActivityAt = tail ? tail.mtime.toISOString() : null;
    const parsed = parseSenderMessageOnlyTail(tail?.content || "");

    const stuck = tail
      ? Date.now() - tail.mtime.getTime() > stuckThresholdSec * 1000
      : false;

    logger.apiResponse(
      "GET",
      "/api/sender/message-only/health",
      200,
      { correlationId },
      { running: true, stuck, outcome: parsed.lastIterationOutcome },
    );

    return NextResponse.json({
      ok: true,
      running: true,
      stuck,
      pid: worker.pid,
      startedAt: worker.startedAt,
      lastActivityAt,
      lastIterationAt: parsed.lastIterationAt,
      lastIterationOutcome: parsed.lastIterationOutcome,
      lastError: parsed.lastError,
      intervalSec,
      stuckThresholdSec,
    });
  } catch (err: any) {
    logger.error("Failed to read message-only daemon health", { correlationId }, err);
    logger.apiResponse("GET", "/api/sender/message-only/health", 500, { correlationId });
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd apps/web && npx --yes tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Manual smoke** — with the dev server running and a daemon started from Task 3:

```bash
curl -s http://127.0.0.1:3000/api/sender/message-only/health | python3 -m json.tool
```
Expected: `running: true`, `pid` matches the bash PID, `lastActivityAt` is recent, `lastIterationOutcome` is `"unknown"` initially then `"ok"` once the first iteration completes (within ~30–60 s for an empty queue).

After STOPping the daemon (`curl -X POST http://127.0.0.1:3000/api/workers/stop -H 'Content-Type: application/json' -d '{"kinds":["sender_message_only"]}'`), the health endpoint should return `running: false`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/sender/message-only/health/route.ts
git commit -m "feat(api): add GET /api/sender/message-only/health"
```

---

## Task 5: Add `sender_message_only` to `KIND_LABELS` in `/api/workers/status`

**Files:**
- Modify: `apps/web/app/api/workers/status/route.ts:7-13`

Keeps the existing status route exhaustive over `WorkerKind` (now expanded). One-line change.

- [ ] **Step 1: Edit the file** — replace the `KIND_LABELS` map at lines 7–13 with:

```ts
const KIND_LABELS: Record<WorkerKind, string> = {
  scraper_outreach: "Invitation outreach",
  scraper_inbox: "Inbox scan",
  draft_agent: "Draft generation",
  sender_outreach: "Messaging sender",
  sender_followup: "Follow-up sender",
  sender_message_only: "Message-only daemon",
};
```

- [ ] **Step 2: Type-check**

Run: `cd apps/web && npx --yes tsc --noEmit`
Expected: No errors. (Without this change, TypeScript flags the `Record<WorkerKind, string>` as missing the new key.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/workers/status/route.ts
git commit -m "feat(api): label sender_message_only workers in status route"
```

---

## Task 6: `SenderMessageOnlyControl` client component

**Files:**
- Create: `apps/web/components/SenderMessageOnlyControl.tsx`

Self-contained card. Polls health every 5 s. Reuses existing button classes (`btn`, `btn warn`, `btn secondary`) and tokens from `globals.css` per the brutalist aesthetic locked in CLAUDE.md.

- [ ] **Step 1: Create the component** — write `apps/web/components/SenderMessageOnlyControl.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

import { getOperatorApiHeaders } from "../lib/operatorToken";

type IterationOutcome = "ok" | "error" | "unknown";

type HealthResponse = {
  ok: boolean;
  running: boolean;
  stuck: boolean;
  pid: number | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  lastIterationAt: string | null;
  lastIterationOutcome: IterationOutcome;
  lastError: string | null;
  intervalSec: number;
  stuckThresholdSec: number;
  error?: string;
};

const POLL_INTERVAL_MS = 5000;

const formatClock = (value: string | null): string => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
};

const formatStaleness = (lastActivityAt: string | null): string => {
  if (!lastActivityAt) return "—";
  const date = new Date(lastActivityAt);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

const outcomeLabel = (outcome: IterationOutcome): string => {
  if (outcome === "ok") return "OK";
  if (outcome === "error") return "ERROR";
  return "PENDING";
};

export function SenderMessageOnlyControl() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<"start" | "stop" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/sender/message-only/health", {
        cache: "no-store",
        headers: getOperatorApiHeaders(),
      });
      const data = (await response.json()) as HealthResponse;
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Failed to fetch daemon health.");
      }
      setHealth(data);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to load daemon health.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      refresh({ silent: true }).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const start = async () => {
    setActing("start");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/sender/message-only/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getOperatorApiHeaders() },
      });
      const data = (await response.json()) as { ok: boolean; message?: string; error?: string; pid?: number };
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Failed to start daemon.");
      }
      setMessage(data.message || `Started (pid ${data.pid}).`);
      await refresh({ silent: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to start daemon.");
    } finally {
      setActing(null);
    }
  };

  const stop = async () => {
    setActing("stop");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/workers/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getOperatorApiHeaders() },
        body: JSON.stringify({ kinds: ["sender_message_only"] }),
      });
      const data = (await response.json()) as { ok: boolean; message?: string; error?: string };
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Failed to stop daemon.");
      }
      setMessage(data.message || "Stop requested.");
      await refresh({ silent: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to stop daemon.");
    } finally {
      setActing(null);
    }
  };

  const running = Boolean(health?.running);
  const stuck = Boolean(health?.stuck);
  const status = !running ? "STOPPED" : stuck ? "STUCK" : "RUNNING";

  const chipStyle: React.CSSProperties =
    status === "RUNNING"
      ? { background: "var(--fg)", color: "var(--bg)", padding: "2px 8px", border: "3px solid var(--fg)" }
      : status === "STUCK"
      ? { color: "var(--fg)", padding: "2px 8px", border: "3px dashed var(--fg)" }
      : { color: "var(--muted)", padding: "2px 8px", border: "3px solid var(--muted)" };

  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div className="pill">Auto Mode</div>
          <h3 className="section-title-tight">MESSAGE-ONLY AUTO MODE</h3>
          <div className="muted" style={{ maxWidth: 540 }}>
            Polls accepted friend requests every ~{Math.round((health?.intervalSec ?? 900) / 60)} min and sends the
            first sequence message until stopped.
          </div>
        </div>
        <div style={{ display: "grid", gap: 8, justifyItems: "end" }}>
          <span style={{ ...chipStyle, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>{status}</span>
          {loading && !health ? <div className="muted" style={{ fontSize: 12 }}>Checking…</div> : null}
        </div>
      </div>

      <div style={{ fontSize: 12, fontFamily: "inherit", letterSpacing: 0.5 }}>
        PID {health?.pid ?? "—"} · STARTED {formatClock(health?.startedAt ?? null)} · LAST RUN{" "}
        {formatClock(health?.lastIterationAt ?? null)} · {outcomeLabel(health?.lastIterationOutcome ?? "unknown")}
      </div>

      {stuck ? (
        <div style={{ border: "3px dashed var(--fg)", padding: "8px 10px", fontSize: 12 }}>
          NO LOG ACTIVITY IN {formatStaleness(health?.lastActivityAt ?? null)} — DAEMON MAY BE HUNG.
        </div>
      ) : null}

      {health?.lastError ? (
        <div style={{ border: "3px dashed var(--fg)", padding: "8px 10px", fontSize: 12, wordBreak: "break-all" }}>
          LAST ERROR: {health.lastError}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 0, flexWrap: "wrap" }}>
        <button
          className="btn"
          onClick={start}
          disabled={Boolean(acting) || running}
        >
          {acting === "start" ? "STARTING…" : "START FULL AUTO"}
        </button>
        <button
          className="btn warn"
          onClick={stop}
          disabled={Boolean(acting) || !running}
        >
          {acting === "stop" ? "STOPPING…" : "STOP FULL AUTO"}
        </button>
        <button className="btn secondary" onClick={() => refresh()} disabled={loading || Boolean(acting)}>
          REFRESH
        </button>
      </div>

      {message ? (
        <div className="muted" style={{ fontSize: 12 }} aria-live="polite">{message}</div>
      ) : null}
      {error ? (
        <div style={{ fontSize: 12, color: "var(--accent)" }} aria-live="polite">{error}</div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd apps/web && npx --yes tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/SenderMessageOnlyControl.tsx
git commit -m "feat(ui): add message-only auto daemon control card"
```

---

## Task 7: Render `SenderMessageOnlyControl` on `/leads`

**Files:**
- Modify: `apps/web/app/leads/page.tsx`

Spec §6.2: place directly below the existing `SEND DUE FOLLOW-UPS` block, inside the same `dashboard-grid` column, so the daemon state sits next to the manual triggers.

- [ ] **Step 1: Add the import** at the top of `apps/web/app/leads/page.tsx` (after the existing `WorkerControlPanel` import):

```ts
import { SenderMessageOnlyControl } from "../../components/SenderMessageOnlyControl";
```

- [ ] **Step 2: Render the card** — replace the existing follow-ups card block (the `<div className="card" ...>` containing `SEND DUE FOLLOW-UPS`, currently at lines 48–61) so the new card sits inside the same wrapper as a sibling `<div className="card">` directly below it. The full replacement block:

```tsx
        <div className="card" style={{ padding: 20, borderLeft: "none", borderTop: "none", borderBottom: "none" }}>
          <div className="pill">Follow-Ups</div>
          <h3 className="page-title">SEND DUE FOLLOW-UPS</h3>
          <div className="muted">Approved follow-ups still run independently of the sequence selector.</div>
          <div style={{ marginTop: 12 }}>
            <TriggerButton
              action={triggerFollowupSender}
              label="SEND DUE FOLLOW-UPS"
              pendingLabel="SENDING…"
              successMessage="Follow-up sender started."
              variant="secondary"
            />
          </div>
        </div>

        <SenderMessageOnlyControl />
```

- [ ] **Step 3: Type-check + build**

Run: `cd apps/web && npx --yes tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Manual UI smoke** — start the dev server, log in, navigate to `/leads`. Verify:
  - The `MESSAGE-ONLY AUTO MODE` card renders directly below `SEND DUE FOLLOW-UPS`.
  - On first load (no daemon): chip shows `STOPPED` (muted border), `START FULL AUTO` enabled, `STOP FULL AUTO` disabled.
  - Click `START FULL AUTO`: chip flips to `RUNNING` (solid black), `PID` populates, `LAST RUN` updates within ~30–60 s.
  - Click `STOP FULL AUTO`: chip flips to `STOPPED` within ≤ 5 s, START re-enables.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/leads/page.tsx
git commit -m "feat(leads): render message-only auto daemon control"
```

---

## Task 8: End-to-end manual verification

**Files:** none modified — verification only.

This is the spec §9 manual checklist. Run each item and confirm expected behavior before declaring the feature done.

- [ ] **Step 1: Auth-missing precondition (412)**

```bash
# Temporarily move auth.json files out of the way
mv workers/sender/auth.json /tmp/auth.sender.bak 2>/dev/null || true
mv workers/scraper/auth.json /tmp/auth.scraper.bak 2>/dev/null || true
curl -i -X POST http://127.0.0.1:3000/api/sender/message-only/start
# Restore
mv /tmp/auth.sender.bak workers/sender/auth.json 2>/dev/null || true
mv /tmp/auth.scraper.bak workers/scraper/auth.json 2>/dev/null || true
```
Expected: HTTP 412 with `auth.json missing` error message. UI button click also surfaces this inline.

- [ ] **Step 2: Start with auth present** — click `START FULL AUTO` from `/leads`. Within 5 s the chip shows `RUNNING`. Within ~60 s `tail -F .logs/sender-message-only-daemon.log` shows `Operation Start: sender-message_only`.

- [ ] **Step 3: Duplicate start (409)** — without stopping, click `START FULL AUTO` again. Card shows red error: `Daemon already running (pid <n>). Stop it before starting a new one.`. The original daemon is untouched (`pgrep -fa "sender.py --message-only"` still shows one process).

- [ ] **Step 4: Stop** — click `STOP FULL AUTO`. Within 5 s chip flips to `STOPPED`. Verify both bash and python died:

```bash
pgrep -fa "while true; do" | grep -v grep
pgrep -fa "sender.py --message-only" | grep -v grep
```
Expected: both empty (process-group kill killed both).

- [ ] **Step 5: Survives Next dev hot-reload**

Start daemon, then in `apps/web` touch any file that triggers Next reload (e.g., `touch app/leads/page.tsx`). Wait for the dev server to recompile. Refresh `/leads`. Daemon chip remains `RUNNING`, same PID.

- [ ] **Step 6: STUCK detection**

Set a short interval to make this fast: stop the daemon, set `SENDER_MESSAGE_ONLY_INTERVAL_SEC=60` in the env loaded by `apps/web` (e.g., `apps/web/.env.local`), restart `npm run dev`, click START. Once the first iteration completes, send `SIGSTOP` to the python child:

```bash
PY_PID=$(pgrep -f "sender.py --message-only")
kill -STOP "$PY_PID"
```
Wait > 120 s (2 × 60). Chip flips to `STUCK` (dashed border) and the body shows `NO LOG ACTIVITY IN <Nm Ns> — DAEMON MAY BE HUNG.`. Resume with `kill -CONT "$PY_PID"` then stop the daemon. Restore the original `SENDER_MESSAGE_ONLY_INTERVAL_SEC` value.

- [ ] **Step 7: Done** — no commit; verification only. If any step fails, file a defect report (per AGENTS.md `LLM_FRIENDLY_PLAN_TEST_DEBUG`) with the failing step number, environment matrix, and observed log snippet.

---

## Self-review notes

- **Spec coverage:**
  - §4.1 detached bash daemon → Task 3.
  - §4.2 new `sender_message_only` kind → Task 1 + Task 5.
  - §4.3 process-group kill → Task 1.
  - §4.4 health signals (PID-alive, log mtime, marker tail) → Tasks 1 + 2 + 4.
  - §5.1 start route (200/409/412/500) → Task 3.
  - §5.2 health route → Task 4.
  - §5.3 reused stop route → no new code; Task 1 makes the existing `POST /api/workers/stop` group-aware.
  - §5.4 KIND_LABELS update → Task 5.
  - §6.1 control component → Task 6.
  - §6.2 placement on `/leads` → Task 7.
  - §6.3 don't-touch list → respected; no changes to `WorkerControlPanel`, `StartEnrichmentButton`, `LeadRunControls`, Mission Control, or `/followups`.
  - §7 env vars → handled by `resolveIntervalSec` in start + health routes.
  - §8 edge cases → Task 8 verifies §8 rows 1, 3, 5, 6.
  - §9 testing strategy → Tasks 1, 2 (unit) + Task 8 (manual).
  - §10 file/LOC budget → 6 runtime files + 2 test files; runtime LOC ≈ 280.
  - §11 deferred items → noted; v1 keeps `ok | error | unknown` (no `no_work` parsing); the start-route preflight only checks the worker registry (does **not** pgrep `sender.py --message-only` to detect a `run_all.sh` daemon — documented foot-gun).

- **Type consistency:** `processGroup?: boolean` is added on `WorkerRecord`, `RegisterWorkerInput`, and forwarded through `trackWorkerChild`. `IterationOutcome` is defined once in `senderMessageOnlyHealth.ts` and reused by the route + component. `WorkerKind` includes `sender_message_only` everywhere it's used (`workerControl.ts`, status route, stop route inputs, health route inputs, component literal).

- **Placeholder scan:** No TBD/TODO/handle-edge-cases placeholders. Every code step shows the actual code; every command step shows the exact command and expected output.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-25-message-only-auto-daemon.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
