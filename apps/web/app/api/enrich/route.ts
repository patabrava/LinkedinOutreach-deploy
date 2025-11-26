import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import { logger } from "../../../lib/logger";

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/enrich");
  
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
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";

    const pidFile = path.join(scraperDir, "enrichment.pid");

    const { limit } = (await request.json().catch(() => ({}))) as { limit?: number };
    const limitArg = typeof limit === "number" && limit > 0 ? ["--limit", String(limit)] : [];

    const args = ["scraper.py", "--run", ...limitArg];
    logger.workerSpawn("scraper", args, { correlationId, limit });

    const child = spawn(pythonCmd, args, {
      cwd: scraperDir,
      env: { ...process.env, CORRELATION_ID: correlationId },
      stdio: "inherit",
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

    logger.info("Scraper process started successfully", { correlationId, pid: child.pid });
    logger.apiResponse("POST", "/api/enrich", 200, { correlationId });
    
    return NextResponse.json({ ok: true, message: "Scraper started. Watch .logs/scraper.log for progress." });
  } catch (err: any) {
    logger.error("Failed to start scraper", { correlationId }, err);
    logger.apiResponse("POST", "/api/enrich", 500, { correlationId });
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
