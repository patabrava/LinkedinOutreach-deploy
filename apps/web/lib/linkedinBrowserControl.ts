import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

import { isAllowed } from "./allowlist";
import { isSupabaseAuthConfigured } from "./authConfig";
import { logger } from "./logger";
import { supabaseRouteHandler } from "./supabaseServer";

const remoteBrowserPath = (slot: 1 | 2) => `/linkedin-browser-${slot}/vnc.html?autoconnect=1&resize=remote`;
const localRemoteBrowserUrl = (slot: 1 | 2) => `http://127.0.0.1:${slot === 1 ? 6080 : 6081}/vnc.html?autoconnect=1&resize=remote`;

const resolveScraperDir = () => {
  const runtimeScraperDir = process.env.LINKEDIN_SCRAPER_DIR?.trim();
  if (
    runtimeScraperDir &&
    fs.existsSync(runtimeScraperDir) &&
    fs.existsSync(path.join(runtimeScraperDir, "scraper.py"))
  ) {
    return runtimeScraperDir;
  }

  const candidates = [
    path.resolve(process.cwd(), "workers", "scraper"),
    path.resolve(process.cwd(), "..", "..", "workers", "scraper"),
  ];

  return (
    candidates.find((candidate) => fs.existsSync(path.join(candidate, "scraper.py"))) ??
    path.resolve(process.cwd(), "..", "..", "workers", "scraper")
  );
};

const resolvePythonCommand = (scraperDir: string) => {
  const venvPython = path.join(scraperDir, "venv", "bin", "python");
  const systemPython = "/opt/local/bin/python3";

  if (fs.existsSync(venvPython)) {
    return venvPython;
  }

  if (fs.existsSync(systemPython)) {
    return systemPython;
  }

  return "python3";
};

const getRemoteBrowserUrlCandidates = (slot: 1 | 2): string[] => {
  const configured = (slot === 1
    ? process.env.NEXT_PUBLIC_LINKEDIN_REMOTE_BROWSER_URL_1 || process.env.NEXT_PUBLIC_LINKEDIN_REMOTE_BROWSER_URL
    : process.env.NEXT_PUBLIC_LINKEDIN_REMOTE_BROWSER_URL_2)?.trim() || "";
  const candidates = [
    configured,
    process.env.NODE_ENV === "production" ? "" : localRemoteBrowserUrl(slot),
    remoteBrowserPath(slot),
  ];

  return [...new Set(candidates.filter(Boolean))];
};

const buildReachabilityProbeUrl = (browserUrl: string): string | null => {
  if (browserUrl.startsWith("http://") || browserUrl.startsWith("https://")) {
    return browserUrl;
  }

  if (process.env.NODE_ENV !== "production") {
    return null;
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!siteUrl) {
    return null;
  }

  try {
    return new URL(browserUrl, siteUrl).toString();
  } catch {
    return null;
  }
};

const isRemoteBrowserReachable = async (browserUrl: string): Promise<boolean> => {
  const probeUrl = buildReachabilityProbeUrl(browserUrl);
  if (!probeUrl) {
    return false;
  }

  try {
    const response = await fetch(probeUrl, {
      method: "HEAD",
      redirect: "follow",
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
};

export const resolveRemoteBrowserUrl = async (slot: 1 | 2): Promise<string | null> => {
  for (const candidate of getRemoteBrowserUrlCandidates(slot)) {
    if (await isRemoteBrowserReachable(candidate)) {
      return candidate;
    }
  }

  return null;
};

export const getRemoteBrowserUrl = (slot: 1 | 2) => getRemoteBrowserUrlCandidates(slot)[0] || remoteBrowserPath(slot);

const readOperatorToken = (request: Request): string => {
  const authHeader = request.headers.get("authorization") || "";
  const fallbackToken = request.headers.get("x-api-token") || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : fallbackToken.trim();
};

export const requireStrictOperatorSessionOrToken = async (
  request: Request,
  routePath: string,
  correlationId: string,
): Promise<NextResponse | null> => {
  const expectedToken = (process.env.API_OPERATOR_TOKEN || "").trim();
  const providedToken = readOperatorToken(request);

  if (expectedToken && providedToken === expectedToken) {
    return null;
  }

  if (providedToken && expectedToken && providedToken !== expectedToken) {
    logger.warn("Strict operator token mismatch", { correlationId, path: routePath });
  }

  if (isSupabaseAuthConfigured()) {
    try {
      const { data, error } = await supabaseRouteHandler().auth.getUser();
      if (!error && data?.user && isAllowed(data.user.email ?? "")) {
        return null;
      }
    } catch {
      logger.warn("Strict operator session auth check failed", { correlationId, path: routePath });
    }
  }

  logger.warn("Rejected remote browser control request (strict auth required)", {
    correlationId,
    path: routePath,
    hasExpectedToken: Boolean(expectedToken),
    hasProvidedToken: Boolean(providedToken),
    hasSupabaseAuth: isSupabaseAuthConfigured(),
  });

  return NextResponse.json(
    { ok: false, error: "Unauthorized. Provide a valid operator token or sign in with an authorized app session." },
    { status: 401 },
  );
};

export const spawnScraperCommand = (args: string[], correlationId: string, accountId: string, browserSlot: 1 | 2) => {
  const scraperDir = resolveScraperDir();
  const scraperEntry = path.join(scraperDir, "scraper.py");
  if (!fs.existsSync(scraperEntry)) {
    throw new Error(`Scraper entrypoint not found at ${scraperEntry}`);
  }

  const pythonCmd = resolvePythonCommand(scraperDir);

  const cdpUrl = browserSlot === 1
    ? process.env.LINKEDIN_BROWSER_CDP_URL_1 || process.env.LINKEDIN_BROWSER_CDP_URL
    : process.env.LINKEDIN_BROWSER_CDP_URL_2;
  return spawn(pythonCmd, [scraperEntry, ...args, "--account-id", accountId], {
    cwd: scraperDir,
    env: {
      ...process.env,
      CORRELATION_ID: correlationId,
      LINKEDIN_ACCOUNT_ID: accountId,
      ...(cdpUrl ? { LINKEDIN_BROWSER_CDP_URL: cdpUrl } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
};
