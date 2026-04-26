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
