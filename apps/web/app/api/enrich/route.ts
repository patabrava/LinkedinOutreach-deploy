import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../lib/apiGuard";
import { logger } from "../../../lib/logger";
import { mirrorWorkerOutput } from "../../../lib/spawnMirror";
import { trackWorkerChild } from "../../../lib/workerControl";
import { assertScraperLockFree, persistScraperPid } from "./scraperLock";

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/enrich");
  const guardResponse = await requireOperatorAccess(request, "/api/enrich", correlationId);
  if (guardResponse) return guardResponse;
  
  try {
    const webDir = process.cwd();
    const repoRoot = path.resolve(webDir, "..", "..");
    const scraperDir = path.join(repoRoot, "workers", "scraper");

    logger.debug("Checking scraper directory", { correlationId }, { scraperDir });

    if (!fs.existsSync(scraperDir)) {
      logger.error("Scraper directory not found", { correlationId }, undefined, { scraperDir });
      return NextResponse.json({ ok: false, error: "Scraper directory not found" }, { status: 500 });
    }

    const venvPython = path.join(scraperDir, "venv", "bin", "python");
    const systemPython = "/opt/local/bin/python3";
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : (fs.existsSync(systemPython) ? systemPython : "python3");

    const pidFile = path.join(scraperDir, "enrichment.pid");
    const lockState = assertScraperLockFree(pidFile);
    if (!lockState.ok) {
      logger.warn("Scraper already running", { correlationId }, { pid: lockState.activePid, pidFile });
      return NextResponse.json(
        { ok: false, error: `Scraper already running (pid ${lockState.activePid}). Wait for it to finish before starting another run.` },
        { status: 409 },
      );
    }

    const { batchId } = (await request.json().catch(() => ({}))) as { batchId?: number };
    const batchArg = typeof batchId === "number" && batchId > 0 ? ["--batch-id", String(batchId)] : [];

    const senderDir = path.join(repoRoot, "workers", "sender");
    const args = ["sender.py", "--send-invites", ...batchArg];
    logger.workerSpawn("sender", args, { correlationId, batchId });

    const logPath = path.join(repoRoot, ".logs", "sender-spawn.log");
    const child = spawn(pythonCmd, args, {
      cwd: senderDir,
      env: { ...process.env, CORRELATION_ID: correlationId },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const fileStream = fs.createWriteStream(logPath, { flags: "a" });
    child.stdout?.pipe(fileStream);
    child.stderr?.pipe(fileStream);
    mirrorWorkerOutput(child.stdout, "info", correlationId, "stdout");
    mirrorWorkerOutput(child.stderr, "warn", correlationId, "stderr");
    child.on("exit", (code, signal) => {
      logger.info("Sender exited", { correlationId, pid: child.pid }, { code, signal });
      fileStream.end();
    });
    child.unref();

    persistScraperPid(child, pidFile);
    trackWorkerChild({
      child,
      kind: "sender_outreach",
      label: "Invitation outreach",
      args,
    });

    logger.info("Sender process started successfully", { correlationId, pid: child.pid });
    logger.apiResponse("POST", "/api/enrich", 200, { correlationId });

    return NextResponse.json({ ok: true, message: "Sender started. Watch .logs/sender-spawn.log for progress." });
  } catch (err: any) {
    logger.error("Failed to start sender", { correlationId }, err);
    logger.apiResponse("POST", "/api/enrich", 500, { correlationId });
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
