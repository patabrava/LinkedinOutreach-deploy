import { NextResponse } from "next/server";

import { isAllowed } from "./allowlist";
import { isSupabaseAuthConfigured } from "./authConfig";
import { logger } from "./logger";
import { supabaseRouteHandler } from "./supabaseServer";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const parseHost = (request: Request): string => {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost || request.headers.get("host") || "";
  return host.split(",")[0]?.trim().split(":")[0]?.toLowerCase() || "";
};

const parseClientIp = (request: Request): string => {
  const forwardedFor = request.headers.get("x-forwarded-for") || "";
  const first = forwardedFor.split(",")[0]?.trim();
  return first || "";
};

const isLoopbackIp = (ip: string): boolean => {
  if (!ip) return true;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
};

export const readOperatorToken = (request: Request): string => {
  const authHeader = request.headers.get("authorization") || "";
  const fallbackToken = request.headers.get("x-api-token") || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : fallbackToken.trim();
};

const allowLoopbackOnly = (
  request: Request,
  routePath: string,
  correlationId: string
): NextResponse | null => {
  const host = parseHost(request);
  const ip = parseClientIp(request);
  const allowedHost = LOOPBACK_HOSTS.has(host);
  const allowedIp = isLoopbackIp(ip);

  if (allowedHost && allowedIp) {
    return null;
  }

  logger.warn("Rejected operator API request (non-loopback origin)", {
    correlationId,
    path: routePath,
    host,
    ip,
  });

  return NextResponse.json(
    { ok: false, error: "Forbidden. Configure API_OPERATOR_TOKEN for remote access." },
    { status: 403 }
  );
};

export const requireOperatorAccess = async (
  request: Request,
  routePath: string,
  correlationId: string
): Promise<NextResponse | null> => {
  const expectedToken = (process.env.API_OPERATOR_TOKEN || "").trim();
  const providedToken = readOperatorToken(request);

  // Optional machine token for remote control; keep as an explicit override.
  if (providedToken && expectedToken && providedToken === expectedToken) {
    return null;
  }

  if (providedToken && expectedToken && providedToken !== expectedToken) {
    logger.warn("Operator API token mismatch; falling back to session auth", {
      correlationId,
      path: routePath,
    });
  }

  // First-class path for Mission Control UI: allow authenticated/allowlisted users.
  if (isSupabaseAuthConfigured()) {
    try {
      const { data, error } = await supabaseRouteHandler().auth.getUser();
      if (!error && data?.user && isAllowed(data.user.email ?? "")) {
        return null;
      }
    } catch {
      logger.warn("Operator API session auth check failed", { correlationId, path: routePath });
    }

    // If a machine token is configured, remote requests without valid session auth
    // should fail closed unless they present the token.
    if (expectedToken) {
      logger.warn("Rejected operator API request (missing auth)", { correlationId, path: routePath });
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    return allowLoopbackOnly(request, routePath, correlationId);
  }

  if (expectedToken) {
    logger.warn("Rejected operator API request (missing token)", { correlationId, path: routePath });
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  return allowLoopbackOnly(request, routePath, correlationId);
};
