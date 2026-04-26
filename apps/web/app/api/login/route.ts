import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../lib/apiGuard";
import {
  requireStrictOperatorSessionOrToken,
  resolveRemoteBrowserUrl,
  spawnScraperCommand,
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
    const body = (await request.json().catch(() => ({}))) as { mode?: string };
    const mode = body?.mode === "manual" ? "manual" : "check";
    const status = readLinkedinAuthStatus();
    const browserUrl = await resolveRemoteBrowserUrl();

    if (mode === "manual") {
      if (browserUrl) {
        logger.info("Manual LinkedIn browser routed to remote browser", {
          correlationId,
          browserUrl,
          sessionState: status.session_state,
        });
        logger.apiResponse("POST", "/api/login", 200, { correlationId });
        return NextResponse.json({
          ok: true,
          mode,
          browserUrl,
          status,
          message:
            "Manual browser is already available. Open it and move around freely; click Capture Session only when you want to sync the state back to the worker.",
        });
      }

      if (process.env.NODE_ENV !== "production") {
        logger.workerSpawn("scraper-manual-browser", ["--manual-browser"], { correlationId });
        const child = spawnScraperCommand(["--manual-browser"], correlationId);
        child.stdout?.resume();
        child.stderr?.resume();

        child.on("error", (error) => {
          logger.error("Manual LinkedIn browser failed to start", { correlationId }, error);
        });

        logger.info("Manual LinkedIn browser started locally", { correlationId }, {
          sessionState: status.session_state,
        });
        logger.apiResponse("POST", "/api/login", 200, { correlationId });
        return NextResponse.json({
          ok: true,
          mode,
          browserUrl: null,
          status,
          message:
            "Manual Playwright browser was launched locally. Keep the browser window open and use Capture Session when you are ready to sync.",
        });
      }

      logger.warn("Manual LinkedIn browser blocked because remote browser is unreachable", {
        correlationId,
      });
      logger.apiResponse("POST", "/api/login", 503, { correlationId });
      return NextResponse.json(
        {
          ok: false,
          mode,
          status,
          error: "Remote LinkedIn browser is not running.",
          message:
            "Start the LinkedIn remote browser service first. In local dev this should be reachable at http://127.0.0.1:6080 and CDP at http://127.0.0.1:9222.",
        },
        { status: 503 },
      );
    }

    if (!browserUrl) {
      if (process.env.NODE_ENV !== "production") {
        logger.workerSpawn("scraper-login-local", ["--login-only"], { correlationId });
        const child = spawnScraperCommand(["--login-only"], correlationId);
        child.stdout?.resume();
        child.stderr?.resume();

        child.on("error", (error) => {
          logger.error("Local LinkedIn login bootstrap failed to start", { correlationId }, error);
        });

        logger.info("LinkedIn login started in local browser fallback", { correlationId }, {
          sessionState: status.session_state,
        });
        logger.apiResponse("POST", "/api/login", 200, { correlationId });
        return NextResponse.json({
          ok: true,
          browserUrl: null,
          status,
          message:
            "Remote browser is not running locally, so a local Playwright login attempt was started instead. If LinkedIn opens a visible browser window, complete the login there.",
        });
      }

      logger.warn("LinkedIn login blocked because remote browser is unreachable", {
        correlationId,
      });
      logger.apiResponse("POST", "/api/login", 503, { correlationId });
      return NextResponse.json(
        {
          ok: false,
          status,
          error: "Remote LinkedIn browser is not running.",
          message:
            "Start the LinkedIn remote browser service first. In local dev this should be reachable at http://127.0.0.1:6080 and CDP at http://127.0.0.1:9222.",
        },
        { status: 503 },
      );
    }

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
