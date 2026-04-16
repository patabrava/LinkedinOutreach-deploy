function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isAllowed(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) return false;

  const domains = parseList(process.env.ALLOWED_EMAIL_DOMAINS);
  const emails = parseList(process.env.ALLOWED_EMAILS);

  if (emails.includes(normalized)) return true;
  const domain = normalized.split("@")[1];
  return Boolean(domain) && domains.includes(domain);
}
