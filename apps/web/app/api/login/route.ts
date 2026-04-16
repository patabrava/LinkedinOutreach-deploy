import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../lib/apiGuard";
import { logger } from "../../../lib/logger";

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/login");
  const guardResponse = requireOperatorAccess(request, "/api/login", correlationId);
  if (guardResponse) return guardResponse;
  
  try {
    const webDir = process.cwd();
    const repoRoot = path.resolve(webDir, "..", "..");
    const scraperDir = path.join(repoRoot, "workers", "scraper");
    const authPath = path.join(scraperDir, "auth.json");

    logger.debug("Preparing to launch login window", { correlationId }, { scraperDir, authPath });

    if (!fs.existsSync(scraperDir)) {
      logger.error("Scraper directory not found", { correlationId }, undefined, { scraperDir });
      return NextResponse.json({ ok: false, error: "Scraper directory not found" }, { status: 500 });
    }

    const venvPython = path.join(scraperDir, "venv", "bin", "python");
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";

    const args = ["-m", "playwright", "codegen", `--save-storage=${authPath}`, "https://www.linkedin.com/login"];
    logger.workerSpawn("playwright-codegen", args, { correlationId });

    const child = spawn(
      pythonCmd,
      args,
      {
        cwd: scraperDir,
        env: { ...process.env, CORRELATION_ID: correlationId },
        stdio: "ignore",
        detached: true,
      }
    );
    child.unref();

    logger.info("Login window launched successfully", { correlationId, pid: child.pid });
    logger.apiResponse("POST", "/api/login", 200, { correlationId });

    return NextResponse.json({
      ok: true,
      message: "Login window launched. Complete login and close it to save auth.json.",
    });
  } catch (err: any) {
    logger.error("Failed to launch login window", { correlationId }, err);
    logger.apiResponse("POST", "/api/login", 500, { correlationId });
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
