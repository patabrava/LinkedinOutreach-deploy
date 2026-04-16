import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../../lib/apiGuard";
import { logger } from "../../../../lib/logger";

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/enrich/connect-only");
  const guardResponse = requireOperatorAccess(request, "/api/enrich/connect-only", correlationId);
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

    const { limit } = (await request.json().catch(() => ({}))) as { limit?: number };
    const limitArg = typeof limit === "number" && limit > 0 ? ["--limit", String(limit)] : [];

    const args = ["scraper.py", "--run", "--mode", "connect_only", ...limitArg];
    logger.workerSpawn("scraper", args, { correlationId, limit, mode: "connect_only" });

    const logPath = path.join(repoRoot, ".logs", "scraper-spawn.log");
    const logFd = fs.openSync(logPath, "a");
    
    const child = spawn(pythonCmd, args, {
      cwd: scraperDir,
      env: { ...process.env, CORRELATION_ID: correlationId },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    child.unref();

    try {
      fs.writeFileSync(pidFile, String(child.pid));
    } catch (writeErr) {
      logger.warn("Failed to persist scraper PID", { correlationId }, {
        pidFile,
        error: (writeErr as Error)?.message || String(writeErr),
      });
    }

    logger.info("Connect-only scraper started successfully", { correlationId, pid: child.pid });
    logger.apiResponse("POST", "/api/enrich/connect-only", 200, { correlationId });

    return NextResponse.json({ ok: true, message: "Connect-only run started. Watch .logs/scraper.log for progress." });
  } catch (err: any) {
    logger.error("Failed to start connect-only scraper", { correlationId }, err);
    logger.apiResponse("POST", "/api/enrich/connect-only", 500, { correlationId });
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
