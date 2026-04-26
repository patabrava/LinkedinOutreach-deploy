import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../../lib/apiGuard";
import { logger } from "../../../../lib/logger";
import { mirrorWorkerOutput } from "../../../../lib/spawnMirror";
import { trackWorkerChild } from "../../../../lib/workerControl";
import { assertScraperLockFree, persistScraperPid } from "../../enrich/scraperLock";

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/custom-outreach/enrich-batch");
  const guardResponse = await requireOperatorAccess(request, "/api/custom-outreach/enrich-batch", correlationId);
  if (guardResponse) return guardResponse;

  let body: { batchId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  const batchId = body.batchId;
  if (typeof batchId !== "number" || !Number.isFinite(batchId) || batchId <= 0) {
    return NextResponse.json({ ok: false, error: "batchId required (positive finite number)" }, { status: 400 });
  }

  const webDir = process.cwd();
  const repoRoot = path.resolve(webDir, "..", "..");
  const scraperDir = path.join(repoRoot, "workers", "scraper");

  if (!fs.existsSync(scraperDir)) {
    logger.error("Scraper directory not found", { correlationId }, undefined, { scraperDir });
    return NextResponse.json({ ok: false, error: "Scraper directory not found" }, { status: 500 });
  }

  const pidFile = path.join(scraperDir, "enrichment.pid");
  const lockState = assertScraperLockFree(pidFile);
  if (!lockState.ok) {
    logger.warn("Scraper already running", { correlationId }, { pid: lockState.activePid, pidFile });
    return NextResponse.json(
      { ok: false, error: `Scraper already running (pid ${lockState.activePid}). Wait for it to finish before starting another run.` },
      { status: 409 },
    );
  }

  const venvPython = path.join(scraperDir, "venv", "bin", "python");
  const systemPython = "/opt/local/bin/python3";
  const pythonCmd = fs.existsSync(venvPython) ? venvPython : (fs.existsSync(systemPython) ? systemPython : "python3");

  const args = [
    "scraper.py",
    "--run",
    "--mode", "enrich",
    "--batch-intent", "custom_outreach",
    "--batch-id", String(batchId),
  ];
  logger.workerSpawn("scraper", args, { correlationId, batchId });

  const logPath = path.join(repoRoot, ".logs", "scraper-spawn.log");
  const child = spawn(pythonCmd, args, {
    cwd: scraperDir,
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
    logger.info("Scraper exited", { correlationId, pid: child.pid }, { code, signal });
    fileStream.end();
  });
  child.unref();

  persistScraperPid(child, pidFile);
  trackWorkerChild({
    child,
    kind: "scraper_enrich_custom",
    label: `custom-outreach enrich-batch:${batchId}`,
    args,
  });

  logger.info("custom-outreach enrich-batch spawned", { correlationId, pid: child.pid }, { batchId });
  logger.apiResponse("POST", "/api/custom-outreach/enrich-batch", 200, { correlationId });
  return NextResponse.json({ ok: true, pid: child.pid });
}
