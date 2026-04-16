import { NextResponse } from "next/server";

import { logger } from "./logger";

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

export const requireOperatorAccess = (
  request: Request,
  routePath: string,
  correlationId: string
): NextResponse | null => {
  const expectedToken = (process.env.API_OPERATOR_TOKEN || "").trim();
  const providedToken = readOperatorToken(request);

  if (expectedToken) {
    if (providedToken && providedToken === expectedToken) {
      return null;
    }
    logger.warn("Rejected operator API request (invalid token)", { correlationId, path: routePath });
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

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
