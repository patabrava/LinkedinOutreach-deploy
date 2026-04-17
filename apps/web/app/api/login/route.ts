import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../lib/apiGuard";
import { logger } from "../../../lib/logger";

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/login");
  const guardResponse = await requireOperatorAccess(request, "/api/login", correlationId);
  if (guardResponse) return guardResponse;
  
  try {
    const webDir = process.cwd();
    const repoRoot = path.resolve(webDir, "..", "..");
    const runtimeScraperDir = process.env.LINKEDIN_SCRAPER_DIR?.trim();
    const scraperDir = runtimeScraperDir && fs.existsSync(runtimeScraperDir)
      ? runtimeScraperDir
      : fs.existsSync("/data/scraper")
        ? "/data/scraper"
        : path.join(repoRoot, "workers", "scraper");
    const authPath = path.join(scraperDir, "auth.json");

    logger.debug("Preparing LinkedIn login attempt", { correlationId }, { scraperDir, authPath });

    if (!fs.existsSync(scraperDir)) {
      logger.error("Scraper directory not found", { correlationId }, undefined, { scraperDir });
      return NextResponse.json({ ok: false, error: "Scraper directory not found" }, { status: 500 });
    }

    const venvPython = path.join(scraperDir, "venv", "bin", "python");
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";
    const scraperEntry = path.join(scraperDir, "scraper.py");
    const args = [scraperEntry, "--run", "--login-only"];
    logger.workerSpawn("scraper-login", args, { correlationId });

    const launchScript = `
const { spawn } = require("child_process");

const pythonCmd = ${JSON.stringify(pythonCmd)};
const args = ${JSON.stringify(args)};
const cwd = ${JSON.stringify(scraperDir)};
const env = { ...process.env, CORRELATION_ID: ${JSON.stringify(correlationId)} };

const child = spawn(pythonCmd, args, { cwd, env, stdio: "ignore" });

child.on("exit", (code) => {
  if (code !== 0) {
    // The worker writes the detailed auth status; the launcher only keeps the process alive.
  }
});
`;

    const wrapper = spawn(process.execPath, ["-e", launchScript], {
      cwd: scraperDir,
      env: { ...process.env, CORRELATION_ID: correlationId },
      stdio: "ignore",
      detached: true,
    });
    wrapper.unref();

    logger.info("LinkedIn login started on worker", { correlationId, pid: wrapper.pid });
    logger.apiResponse("POST", "/api/login", 200, { correlationId });

    return NextResponse.json({
      ok: true,
      message: "LinkedIn login started on the worker. Recheck session state after it completes.",
    });
  } catch (err: unknown) {
    logger.error("Failed to start LinkedIn login attempt", { correlationId }, err instanceof Error ? err : undefined);
    logger.apiResponse("POST", "/api/login", 500, { correlationId });
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
