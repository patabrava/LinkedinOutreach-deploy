import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../lib/apiGuard";
import { logger } from "../../../lib/logger";
import { assertScraperLockFree, persistScraperPid } from "./scraperLock";

const mirrorWorkerOutput = (
  stream: NodeJS.ReadableStream | null,
  logLevel: "info" | "warn",
  correlationId: string,
  label: string,
) => {
  if (!stream) return;

  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      logger[logLevel](`Scraper ${label}`, { correlationId }, { line: trimmed });
    }
  });

  stream.on("end", () => {
    const trimmed = buffer.trim();
    if (!trimmed) return;
    logger[logLevel](`Scraper ${label}`, { correlationId }, { line: trimmed });
  });
};

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

    const { limit } = (await request.json().catch(() => ({}))) as { limit?: number };
    const limitArg = typeof limit === "number" && limit > 0 ? ["--limit", String(limit)] : [];

    const args = ["scraper.py", "--run", ...limitArg];
    logger.workerSpawn("scraper", args, { correlationId, limit });

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

    logger.info("Scraper process started successfully", { correlationId, pid: child.pid });
    logger.apiResponse("POST", "/api/enrich", 200, { correlationId });
    
    return NextResponse.json({ ok: true, message: "Scraper started. Watch .logs/scraper.log for progress." });
  } catch (err: any) {
    logger.error("Failed to start scraper", { correlationId }, err);
    logger.apiResponse("POST", "/api/enrich", 500, { correlationId });
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
