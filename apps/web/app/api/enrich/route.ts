import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const webDir = process.cwd();
    const repoRoot = path.resolve(webDir, "..", "..");
    const scraperDir = path.join(repoRoot, "workers", "scraper");

    if (!fs.existsSync(scraperDir)) {
      return NextResponse.json({ ok: false, error: "Scraper directory not found" }, { status: 500 });
    }

    const venvPython = path.join(scraperDir, "venv", "bin", "python");
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : "python3";

    const { limit } = (await request.json().catch(() => ({}))) as { limit?: number };
    const limitArg = typeof limit === "number" && limit > 0 ? ["--limit", String(limit)] : [];

    const child = spawn(pythonCmd, ["scraper.py", "--run", ...limitArg], {
      cwd: scraperDir,
      env: { ...process.env },
      stdio: "ignore",
      detached: true,
    });
    child.unref();

    return NextResponse.json({ ok: true, message: "Scraper started. Watch .logs/scraper.log for progress." });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}
