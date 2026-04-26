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
