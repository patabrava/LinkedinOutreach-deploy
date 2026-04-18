import { NextResponse } from "next/server";

import { requireOperatorAccess } from "../../../../lib/apiGuard";
import {
  requireStrictOperatorSessionOrToken,
  spawnScraperCommand,
} from "../../../../lib/linkedinBrowserControl";
import { readLinkedinAuthStatus } from "../../../../lib/linkedinAuthSession";
import { logger } from "../../../../lib/logger";

type RemoteSessionAction = "sync" | "reset";

const collectOutput = (stream: NodeJS.ReadableStream | null) =>
  new Promise<string>((resolve) => {
    if (!stream) {
      resolve("");
      return;
    }

    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
    });
    stream.on("end", () => resolve(buffer.trim()));
    stream.on("close", () => resolve(buffer.trim()));
  });

export async function POST(request: Request) {
  const correlationId = logger.apiRequest("POST", "/api/linkedin-auth/remote-session");
  const guardResponse = await requireOperatorAccess(
    request,
    "/api/linkedin-auth/remote-session",
    correlationId,
  );
  if (guardResponse) return guardResponse;
  const strictAuthResponse = await requireStrictOperatorSessionOrToken(
    request,
    "/api/linkedin-auth/remote-session",
    correlationId,
  );
  if (strictAuthResponse) return strictAuthResponse;

  try {
    const body = (await request.json().catch(() => ({}))) as { action?: string };
    const action: RemoteSessionAction = body?.action === "reset" ? "reset" : "sync";
    const args = action === "reset" ? ["--reset-remote-session"] : ["--sync-remote-session"];

    logger.workerSpawn("scraper-remote-session", args, { correlationId, action });

    const child = spawnScraperCommand(args, correlationId);
    const [stdout, stderr, exitCode] = await Promise.all([
      collectOutput(child.stdout),
      collectOutput(child.stderr),
      new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => resolve(code ?? 1));
      }),
    ]);

    if (stdout) {
      logger.info("Remote session stdout", { correlationId }, { action, output: stdout });
    }

    if (stderr) {
      logger.warn("Remote session stderr", { correlationId }, { action, output: stderr });
    }

    if (exitCode !== 0) {
      const status = readLinkedinAuthStatus();
      const message =
        status.session_state === "login_required" || status.session_state === "session_expired"
          ? "Remote session sync failed. Complete LinkedIn login in the remote browser and retry sync."
          : action === "reset"
            ? "Remote session reset failed. If the browser still holds the old session, restart the linkedin-browser service and retry."
            : "Remote session sync failed. If LinkedIn is already open, retry sync or restart the linkedin-browser service.";

      logger.error(
        "Remote session command failed",
        { correlationId },
        undefined,
        { action, exitCode, stderr: stderr || undefined },
      );
      logger.apiResponse("POST", "/api/linkedin-auth/remote-session", 500, { correlationId });
      return NextResponse.json(
        {
          ok: false,
          action,
          status,
          error: `Remote session ${action} failed.`,
          message,
          exitCode,
          stdout: stdout || null,
          stderr: stderr || null,
        },
        { status: 500 },
      );
    }

    const status = readLinkedinAuthStatus();
    logger.apiResponse("POST", "/api/linkedin-auth/remote-session", 200, { correlationId });
    return NextResponse.json({
      ok: true,
      action,
      status,
      message:
        action === "reset"
          ? "Remote LinkedIn session was reset. Open the remote browser and sign in again before syncing."
          : "Remote LinkedIn session captured. Recheck the session card for the latest state.",
    });
  } catch (err: unknown) {
    const status = readLinkedinAuthStatus();
    logger.error(
      "Remote session command threw before completion",
      { correlationId },
      err instanceof Error ? err : undefined,
    );
    logger.apiResponse("POST", "/api/linkedin-auth/remote-session", 500, { correlationId });
    return NextResponse.json(
      {
        ok: false,
        status,
        error: err instanceof Error ? err.message : "Unknown error",
        message: "Remote session command could not start. Verify the scraper worker path and retry.",
      },
      { status: 500 },
    );
  }
}
