import fs from "fs";
import path from "path";

export type LinkedinAuthSessionState =
  | "no_credentials"
  | "credentials_saved"
  | "session_active"
  | "session_expired"
  | "login_required";

export type LinkedinAuthStatus = {
  credentials_saved: boolean;
  session_state: LinkedinAuthSessionState;
  auth_file_present: boolean;
  last_verified_at: string | null;
  last_login_attempt_at: string | null;
  last_login_result: "success" | "failed" | "verification_required" | null;
  last_error: string | null;
};

const SESSION_STATES = new Set<LinkedinAuthSessionState>([
  "no_credentials",
  "credentials_saved",
  "session_active",
  "session_expired",
  "login_required",
]);

const LOGIN_RESULTS = new Set<NonNullable<LinkedinAuthStatus["last_login_result"]>>([
  "success",
  "failed",
  "verification_required",
]);

const DEFAULT_STATUS: LinkedinAuthStatus = {
  credentials_saved: false,
  session_state: "no_credentials",
  auth_file_present: false,
  last_verified_at: null,
  last_login_attempt_at: null,
  last_login_result: null,
  last_error: null,
};

const getScraperDir = () => {
  const candidates = [
    process.env.LINKEDIN_SCRAPER_DIR?.trim(),
    path.resolve(process.cwd(), "workers", "scraper"),
    path.resolve(process.cwd(), "..", "..", "workers", "scraper"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
};

const getAuthStatePath = (scraperDir: string | null) => (scraperDir ? path.join(scraperDir, "auth.json") : null);

const getAuthStatusPath = (scraperDir: string | null) => (scraperDir ? path.join(scraperDir, "auth_status.json") : null);
const getAuthStatusBackupPath = (scraperDir: string | null) => (scraperDir ? path.join(scraperDir, "auth_status.json.bak") : null);

const toStringOrNull = (value: unknown): string | null => {
  return typeof value === "string" && value.trim() ? value : null;
};

const serializeStatus = (status: LinkedinAuthStatus): string => JSON.stringify(status, null, 2) + "\n";

const persistStatusSnapshot = (scraperDir: string, status: LinkedinAuthStatus): void => {
  const statusPath = getAuthStatusPath(scraperDir);
  const backupPath = getAuthStatusBackupPath(scraperDir);
  if (!statusPath || !backupPath) return;

  const json = serializeStatus(status);
  const tmpPath = `${statusPath}.tmp`;
  fs.writeFileSync(tmpPath, json, "utf8");
  fs.renameSync(tmpPath, statusPath);
  fs.writeFileSync(backupPath, json, "utf8");
};

const buildStatusFromAuthFile = (authPath: string): LinkedinAuthStatus => {
  const now = new Date().toISOString();
  const authFilePresent = fs.existsSync(authPath);
  return {
    ...DEFAULT_STATUS,
    credentials_saved: false,
    session_state: authFilePresent ? "session_active" : "no_credentials",
    auth_file_present: authFilePresent,
    last_verified_at: authFilePresent ? now : null,
    last_login_attempt_at: authFilePresent ? now : null,
    last_login_result: authFilePresent ? "success" : null,
    last_error: null,
  };
};

const ensureAuthStatusSnapshot = (scraperDir: string): void => {
  const statusPath = getAuthStatusPath(scraperDir);
  const backupPath = getAuthStatusBackupPath(scraperDir);
  const authPath = getAuthStatePath(scraperDir);
  if (!statusPath || !backupPath || !authPath) return;

  const authFilePresent = fs.existsSync(authPath);
  const hasStatus = fs.existsSync(statusPath) || fs.existsSync(backupPath);
  if (!authFilePresent || hasStatus) return;

  persistStatusSnapshot(scraperDir, buildStatusFromAuthFile(authPath));
};

const normalizeStatus = (
  payload: Record<string, unknown> | null | undefined,
  scraperDir: string | null,
): LinkedinAuthStatus => {
  const authPath = getAuthStatePath(scraperDir);
  const sessionState = payload?.session_state;
  const lastLoginResult = payload?.last_login_result;

  return {
    credentials_saved: Boolean(payload?.credentials_saved),
    session_state:
      typeof sessionState === "string" && SESSION_STATES.has(sessionState as LinkedinAuthSessionState)
        ? (sessionState as LinkedinAuthSessionState)
        : DEFAULT_STATUS.session_state,
    auth_file_present:
      typeof payload?.auth_file_present === "boolean"
        ? payload.auth_file_present
        : Boolean(authPath && fs.existsSync(authPath)),
    last_verified_at: toStringOrNull(payload?.last_verified_at),
    last_login_attempt_at: toStringOrNull(payload?.last_login_attempt_at),
    last_login_result:
      typeof lastLoginResult === "string" &&
      LOGIN_RESULTS.has(lastLoginResult as NonNullable<LinkedinAuthStatus["last_login_result"]>)
        ? (lastLoginResult as NonNullable<LinkedinAuthStatus["last_login_result"]>)
        : null,
    last_error: toStringOrNull(payload?.last_error),
  };
};

export function readLinkedinAuthStatus(): LinkedinAuthStatus {
  const scraperDir = getScraperDir();
  if (!scraperDir) {
    return {
      ...DEFAULT_STATUS,
      session_state: "login_required",
      last_error: "LinkedIn scraper directory was not found. Configure the worker path and reconnect LinkedIn.",
    };
  }

  const statusPath = getAuthStatusPath(scraperDir);
  const backupPath = getAuthStatusBackupPath(scraperDir);
  const authPath = getAuthStatePath(scraperDir);
  const hadStatusFile = Boolean(
    (statusPath && fs.existsSync(statusPath)) || (backupPath && fs.existsSync(backupPath)),
  );
  const hasAuthFile = Boolean(authPath && fs.existsSync(authPath));
  ensureAuthStatusSnapshot(scraperDir);
  const fallback = {
    ...DEFAULT_STATUS,
    auth_file_present: hasAuthFile,
  };

  if (!hadStatusFile && hasAuthFile) {
    return {
      ...fallback,
      session_state: "session_active",
      last_login_result: "success",
    };
  }

  for (const candidate of [statusPath, backupPath]) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return normalizeStatus(parsed, scraperDir);
    } catch {
      continue;
    }
  }

  if (hadStatusFile) {
    return {
      ...fallback,
      last_error: "LinkedIn auth status file could not be read. Reconnect LinkedIn from Settings.",
    };
  }

  return fallback;
}
