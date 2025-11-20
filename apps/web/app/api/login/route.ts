import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

export async function POST() {
  try {
    const webDir = process.cwd();
    const repoRoot = path.resolve(webDir, "..", "..");
    const scraperDir = path.join(repoRoot, "workers", "scraper");
    const authPath = path.join(scraperDir, "auth.json");

    if (!fs.existsSync(scraperDir)) {
      return NextResponse.json({ ok: false, error: "Scraper directory not found" }, { status: 500 });
    }

    // Prefer venv python if present
    const venvPython = path.join(scraperDir, "venv", "bin", "python");
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";

    // Spawn Playwright codegen to create auth.json via LinkedIn login
    const child = spawn(pythonCmd, [
      "-m",
      "playwright",
      "codegen",
      "--save-storage=auth.json",
      "https://www.linkedin.com/login",
    ], {
      cwd: scraperDir,
      env: { ...process.env },
      stdio: "ignore",
      detached: true,
    });
    child.unref();

    // If an old auth.json exists, user will overwrite it after closing the browser
    return NextResponse.json({ ok: true, message: "Login window launched. Complete login and close it to save auth.json." });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
