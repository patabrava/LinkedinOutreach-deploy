import fs from "fs";
import path from "path";
import process from "process";
import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../../lib/apiGuard";
import { logger } from "../../../../lib/logger";
import { listActiveWorkers, stopWorkers } from "../../../../lib/workerControl";

const PID_FILENAME = "enrichment.pid";

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/enrich/stop");
  const guardResponse = await requireOperatorAccess(request, "/api/enrich/stop", correlationId);
  if (guardResponse) return guardResponse;

  try {
    const webDir = process.cwd();
    const repoRoot = path.resolve(webDir, "..", "..");
    const scraperDir = path.join(repoRoot, "workers", "scraper");
    const pidFile = path.join(scraperDir, PID_FILENAME);
    const trackedWorkers = listActiveWorkers({ kinds: ["scraper_outreach"] });

    if (!fs.existsSync(pidFile)) {
      if (trackedWorkers.length > 0) {
        const result = stopWorkers({ kinds: ["scraper_outreach"] });
        const stopped = result.stopped.length > 0;
        logger.info("Enrichment process stop requested via registry only", {
          correlationId,
          stopped,
          pids: result.stopped.map((worker) => worker.pid),
        });
        logger.apiResponse("POST", "/api/enrich/stop", 200, { correlationId }, { stopped });
        return NextResponse.json({
          ok: true,
          stopped,
          message: stopped ? "Enrichment stopped." : "Process not running.",
        });
      }

      logger.warn("No enrichment PID file present", { correlationId }, { pidFile });
      logger.apiResponse("POST", "/api/enrich/stop", 200, { correlationId }, { stopped: false });
      return NextResponse.json({ ok: true, stopped: false, message: "No enrichment process found." });
    }

    const rawPid = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number(rawPid);

    if (!pid || Number.isNaN(pid)) {
      logger.warn("Invalid PID in enrichment file", { correlationId }, { pidFile, rawPid });
      fs.unlinkSync(pidFile);
      logger.apiResponse("POST", "/api/enrich/stop", 200, { correlationId }, { stopped: false });
      return NextResponse.json({ ok: true, stopped: false, message: "Invalid PID, file removed." });
    }

    let stopped = false;
    try {
      const result = stopWorkers({ kinds: ["scraper_outreach"] });
      stopped = result.stopped.some((worker) => worker.pid === pid);
      if (!stopped && result.notRunning.some((worker) => worker.pid === pid)) {
        stopped = false;
      } else if (!stopped) {
        process.kill(pid, "SIGTERM");
        stopped = true;
      }
    } catch (killErr: any) {
      if (killErr?.code !== "ESRCH") {
        logger.error("Failed to stop enrichment process", { correlationId, pid }, killErr as Error);
        logger.apiResponse("POST", "/api/enrich/stop", 500, { correlationId });
        return NextResponse.json(
          { ok: false, error: killErr?.message || "Failed to stop enrichment." },
          { status: 500 }
        );
      }
    }

    try {
      fs.unlinkSync(pidFile);
    } catch (unlinkErr) {
      logger.warn("Failed to remove enrichment PID file", { correlationId, pid }, {
        pidFile,
        error: (unlinkErr as Error)?.message || String(unlinkErr),
      });
    }

    logger.info("Enrichment process stop requested", { correlationId, pid, stopped });
    logger.apiResponse("POST", "/api/enrich/stop", 200, { correlationId }, { stopped });

    return NextResponse.json({ ok: true, stopped, message: stopped ? "Enrichment stopped." : "Process not running." });
  } catch (error: any) {
    logger.error("Failed to stop enrichment process", { correlationId }, error);
    logger.apiResponse("POST", "/api/enrich/stop", 500, { correlationId });
    return NextResponse.json({ ok: false, error: error?.message || "Unknown error" }, { status: 500 });
  }
}
