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

    logger.debug("Preparing to launch login window", { correlationId }, { scraperDir, authPath });

    if (!fs.existsSync(scraperDir)) {
      logger.error("Scraper directory not found", { correlationId }, undefined, { scraperDir });
      return NextResponse.json({ ok: false, error: "Scraper directory not found" }, { status: 500 });
    }

    const venvPython = path.join(scraperDir, "venv", "bin", "python");
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";
    const statusPath = path.join(scraperDir, "auth_status.json");
    const backupPath = path.join(scraperDir, "auth_status.json.bak");

    const args = ["-m", "playwright", "codegen", `--save-storage=${authPath}`, "https://www.linkedin.com/login"];
    logger.workerSpawn("playwright-codegen", args, { correlationId });

    const launchScript = `
const { spawn } = require("child_process");
const fs = require("fs");

const pythonCmd = ${JSON.stringify(pythonCmd)};
const args = ${JSON.stringify(args)};
const cwd = ${JSON.stringify(scraperDir)};
const authPath = ${JSON.stringify(authPath)};
const statusPath = ${JSON.stringify(statusPath)};
const backupPath = ${JSON.stringify(backupPath)};
const env = { ...process.env, CORRELATION_ID: ${JSON.stringify(correlationId)} };

const child = spawn(pythonCmd, args, { cwd, env, stdio: "ignore" });

child.on("exit", (code) => {
  try {
    if (code === 0 && fs.existsSync(authPath)) {
      const now = new Date().toISOString();
      const payload = {
        credentials_saved: true,
        session_state: "session_active",
        auth_file_present: true,
        last_verified_at: now,
        last_login_attempt_at: now,
        last_login_result: "success",
        last_error: null,
      };
      const json = JSON.stringify(payload, null, 2) + "\\n";
      fs.writeFileSync(statusPath, json, "utf8");
      fs.writeFileSync(backupPath, json, "utf8");
    } else if (!fs.existsSync(authPath)) {
      const now = new Date().toISOString();
      const payload = {
        credentials_saved: false,
        session_state: "login_required",
        auth_file_present: false,
        last_verified_at: null,
        last_login_attempt_at: now,
        last_login_result: "failed",
        last_error: "LinkedIn login window closed without saving a session.",
      };
      const json = JSON.stringify(payload, null, 2) + "\\n";
      fs.writeFileSync(statusPath, json, "utf8");
      fs.writeFileSync(backupPath, json, "utf8");
    }
  } catch (error) {
    // Best-effort status persistence only.
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

    logger.info("Login window launched successfully", { correlationId, pid: wrapper.pid });
    logger.apiResponse("POST", "/api/login", 200, { correlationId });

    return NextResponse.json({
      ok: true,
      message: "Login window launched. Complete login, then return to Settings to recheck session state.",
    });
  } catch (err: any) {
    logger.error("Failed to launch login window", { correlationId }, err);
    logger.apiResponse("POST", "/api/login", 500, { correlationId });
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
