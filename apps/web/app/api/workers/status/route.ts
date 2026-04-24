import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../../lib/apiGuard";
import { logger } from "../../../../lib/logger";
import { listActiveWorkers, type WorkerKind } from "../../../../lib/workerControl";

const KIND_LABELS: Record<WorkerKind, string> = {
  scraper_outreach: "Invitation outreach",
  scraper_inbox: "Inbox scan",
  draft_agent: "Draft generation",
  sender_outreach: "Messaging sender",
  sender_followup: "Follow-up sender",
};

export async function GET(request: Request) {
  const correlationId = logger.apiRequest("GET", "/api/workers/status");
  const guardResponse = await requireOperatorAccess(request, "/api/workers/status", correlationId);
  if (guardResponse) return guardResponse;

  const url = new URL(request.url);
  const requestedKinds = url.searchParams.getAll("kind").filter(Boolean) as WorkerKind[];

  try {
    const workers = listActiveWorkers({
      kinds: requestedKinds.length ? requestedKinds : undefined,
    });

    const kinds = Array.from(new Set(workers.map((worker) => worker.kind)));
    const groups = kinds.map((kind) => {
      const items = workers
        .filter((worker) => worker.kind === kind)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return {
        kind,
        label: KIND_LABELS[kind],
        count: items.length,
        items,
      };
    });

    logger.apiResponse("GET", "/api/workers/status", 200, { correlationId }, { groups: groups.length });
    return NextResponse.json({
      ok: true,
      total: workers.length,
      groups,
    });
  } catch (error: unknown) {
    logger.error(
      "Failed to fetch worker status",
      { correlationId },
      error instanceof Error ? error : new Error(String(error))
    );
    logger.apiResponse("GET", "/api/workers/status", 500, { correlationId });
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to fetch worker status." },
      { status: 500 }
    );
  }
}
