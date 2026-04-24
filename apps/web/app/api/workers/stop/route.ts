import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../../lib/apiGuard";
import { logger } from "../../../../lib/logger";
import { stopWorkers, type WorkerKind } from "../../../../lib/workerControl";

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/workers/stop");
  const guardResponse = await requireOperatorAccess(request, "/api/workers/stop", correlationId);
  if (guardResponse) return guardResponse;

  try {
    const payload = (await request.json().catch(() => ({}))) as { kinds?: WorkerKind[] };
    const kinds = Array.isArray(payload.kinds) && payload.kinds.length ? payload.kinds : undefined;
    const result = stopWorkers({ kinds });

    logger.info("Worker stop requested", { correlationId }, {
      kinds,
      stopped: result.stopped.map((worker) => ({ kind: worker.kind, pid: worker.pid })),
      notRunning: result.notRunning.map((worker) => ({ kind: worker.kind, pid: worker.pid })),
    });
    logger.apiResponse("POST", "/api/workers/stop", 200, { correlationId }, { stopped: result.stopped.length });

    return NextResponse.json({
      ok: true,
      stopped: result.stopped.length,
      notRunning: result.notRunning.length,
      message:
        result.stopped.length > 0
          ? `Stop requested for ${result.stopped.length} worker${result.stopped.length === 1 ? "" : "s"}.`
          : "No active workers matched the stop request.",
    });
  } catch (error: unknown) {
    logger.error(
      "Failed to stop workers",
      { correlationId },
      error instanceof Error ? error : new Error(String(error))
    );
    logger.apiResponse("POST", "/api/workers/stop", 500, { correlationId });
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to stop workers." },
      { status: 500 }
    );
  }
}
