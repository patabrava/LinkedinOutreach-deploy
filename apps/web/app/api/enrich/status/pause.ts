const WEEKLY_LIMIT_PATTERNS = [
  "weekly limit",
  "weekly invitation limit",
  "invitation limit",
  "contact request limit",
  "contact requests",
  "invite limit",
  "invite limit reached",
  "too many invitations",
  "too many contact requests",
  "reached a limit",
  "wöchentliche limit",
  "wöchentliche kontaktanfragen",
  "kontaktanfragen",
  "kontaktanfrage",
  "kontaktanfragen erreicht",
  "nächste woche",
  "next week",
];

const detectWeeklyLimit = (text: string | null | undefined) => {
  const normalized = (text || "").toLowerCase();
  return WEEKLY_LIMIT_PATTERNS.some((pattern) => normalized.includes(pattern));
};

export const hasConnectOnlyLimitMarker = (profileData: unknown) => {
  if (!profileData || typeof profileData !== "object") return false;
  const meta = (profileData as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") return false;
  const metaRecord = meta as Record<string, unknown>;
  return metaRecord.connect_only_limit_reached === true;
};

export const detectConnectOnlyLimitPause = (
  recentFailed: Array<{ error_message?: string | null; profile_data?: unknown }> | null | undefined,
) => {
  return (recentFailed || []).some((row) => {
    if (hasConnectOnlyLimitMarker(row.profile_data)) {
      return true;
    }
    return detectWeeklyLimit(row.error_message);
  });
};
