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

const getScraperDir = () => path.resolve(process.cwd(), "..", "..", "workers", "scraper");

const getAuthStatePath = () => path.join(getScraperDir(), "auth.json");

const getAuthStatusPath = () => path.join(getScraperDir(), "auth_status.json");

const toStringOrNull = (value: unknown): string | null => {
  return typeof value === "string" && value.trim() ? value : null;
};

const normalizeStatus = (payload: Record<string, unknown> | null | undefined): LinkedinAuthStatus => {
  const sessionState = payload?.session_state;
  const lastLoginResult = payload?.last_login_result;

  return {
    credentials_saved: Boolean(payload?.credentials_saved),
    session_state:
      typeof sessionState === "string" && SESSION_STATES.has(sessionState as LinkedinAuthSessionState)
        ? (sessionState as LinkedinAuthSessionState)
        : DEFAULT_STATUS.session_state,
    auth_file_present:
      typeof payload?.auth_file_present === "boolean" ? payload.auth_file_present : fs.existsSync(getAuthStatePath()),
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
  const statusPath = getAuthStatusPath();
  if (!fs.existsSync(statusPath)) {
    return {
      ...DEFAULT_STATUS,
      auth_file_present: fs.existsSync(getAuthStatePath()),
    };
  }

  try {
    const raw = fs.readFileSync(statusPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeStatus(parsed);
  } catch {
    return {
      ...DEFAULT_STATUS,
      auth_file_present: fs.existsSync(getAuthStatePath()),
    };
  }
}
