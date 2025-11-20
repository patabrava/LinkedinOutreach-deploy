import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

export async function POST() {
  try {
    // Compute repo root from apps/web
    const webDir = process.cwd();
    const repoRoot = path.resolve(webDir, "..", "..");
    const scraperDir = path.join(repoRoot, "workers", "scraper");
    const senderDir = path.join(repoRoot, "workers", "sender");
    const authPath = path.join(scraperDir, "auth.json");
    const senderAuthPath = path.join(senderDir, "auth.json");

    if (!fs.existsSync(scraperDir)) {
      return NextResponse.json({ ok: false, error: "Scraper directory not found" }, { status: 500 });
    }

    if (!fs.existsSync(authPath)) {
      return NextResponse.json({ ok: false, error: "Missing workers/scraper/auth.json. Run Playwright login first." }, { status: 400 });
    }

    // If sender auth is missing but scraper auth exists, copy it so both workers are ready
    try {
      if (fs.existsSync(authPath) && !fs.existsSync(senderAuthPath)) {
        fs.copyFileSync(authPath, senderAuthPath);
      }
    } catch (_) {}

    // Prefer venv python if present
    const venvPython = path.join(scraperDir, "venv", "bin", "python");
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";

    // Spawn the scraper in foreground browser (scraper.py already launches with headless=False)
    const child = spawn(pythonCmd, ["-u", "scraper.py"], {
      cwd: scraperDir,
      env: { ...process.env },
      stdio: "ignore",
      detached: true,
    });
    child.unref();

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
