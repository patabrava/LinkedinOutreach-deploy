import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../lib/apiGuard";
import {
  getRemoteBrowserUrl,
  requireStrictOperatorSessionOrToken,
} from "../../../lib/linkedinBrowserControl";
import { readLinkedinAuthStatus } from "../../../lib/linkedinAuthSession";
import { logger } from "../../../lib/logger";

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/login");
  const guardResponse = await requireOperatorAccess(request, "/api/login", correlationId);
  if (guardResponse) return guardResponse;
  const strictAuthResponse = await requireStrictOperatorSessionOrToken(request, "/api/login", correlationId);
  if (strictAuthResponse) return strictAuthResponse;
  
  try {
    const browserUrl = getRemoteBrowserUrl();
    const status = readLinkedinAuthStatus();

    logger.info("LinkedIn login redirected to remote browser", { correlationId }, { browserUrl, sessionState: status.session_state });
    logger.apiResponse("POST", "/api/login", 200, { correlationId });

    return NextResponse.json({
      ok: true,
      browserUrl,
      status,
      message: "Open the remote LinkedIn browser, complete login there, then click Capture Session.",
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
