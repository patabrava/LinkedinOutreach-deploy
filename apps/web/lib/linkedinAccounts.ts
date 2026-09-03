import fs from "fs";
import path from "path";

export const LINKEDIN_ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LinkedinAccountSummary = {
  id: string;
  label: string;
  email: string;
  display_name: string;
  browser_slot: 1 | 2;
  daily_invite_limit: number;
  daily_message_limit: number;
  is_active: boolean;
  hasPassword: boolean;
  has_password?: boolean;
  session_active?: boolean;
  isPrimary: boolean;
};

export function requireLinkedinAccountId(value: unknown): string {
  const accountId = typeof value === "string" ? value.trim() : "";
  if (!LINKEDIN_ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("A valid LinkedIn account id is required.");
  }
  return accountId;
}

export function getLinkedinAccountsRoot(): string {
  const configured = process.env.LINKEDIN_ACCOUNTS_DIR?.trim();
  if (configured) return path.resolve(configured);
  if (fs.existsSync("/data")) return "/data/linkedin-accounts";
  return path.resolve(process.cwd(), "..", "..", ".linkedin-accounts");
}

export function getLinkedinAccountDir(accountId: string): string {
  return path.join(getLinkedinAccountsRoot(), requireLinkedinAccountId(accountId));
}

export function ensureLinkedinAccountDir(accountId: string): string {
  const accountDir = getLinkedinAccountDir(accountId);
  fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  return accountDir;
}

export function getLinkedinAccountAuthPath(accountId: string): string {
  return path.join(getLinkedinAccountDir(accountId), "auth.json");
}

export function getLinkedinAccountLockPath(accountId: string, workerKind: string): string {
  const safeKind = workerKind.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  if (!safeKind) throw new Error("A worker kind is required.");
  return path.join(ensureLinkedinAccountDir(accountId), `${safeKind}.pid`);
}
