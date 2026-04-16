export type OutreachMode = "connect_message" | "connect_only";
export type LegacyOutreachMode = OutreachMode | "message_only";

export const OUTREACH_MODE_LABELS: Record<OutreachMode, string> = {
  connect_message: "Connect + Message",
  connect_only: "Connect Only",
};

export const OUTREACH_MODE_TO_DB: Record<OutreachMode, "message" | "connect_only"> = {
  connect_message: "message",
  connect_only: "connect_only",
};

export function normalizeOutreachMode(mode: LegacyOutreachMode): OutreachMode {
  return mode === "message_only" ? "connect_only" : mode;
}

export function normalizeWorkerMode(mode: OutreachMode | "message") {
  return mode === "connect_message" ? "connect_message" : "connect_only";
}
