export type OutreachMode = "connect_message" | "connect_only";
export type LegacyOutreachMode = OutreachMode | "message_only";
export type BatchIntent = OutreachMode | "custom_outreach";

export const OUTREACH_MODE_LABELS: Record<OutreachMode, string> = {
  connect_message: "Connect + Message",
  connect_only: "Connect Only",
};

export const BATCH_INTENT_LABELS: Record<BatchIntent, string> = {
  connect_message: "Connect + Message",
  connect_only: "Connect Only",
  custom_outreach: "Custom Outreach",
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

export function normalizeBatchIntent(intent: BatchIntent | LegacyOutreachMode | "custom_outreach" | undefined): BatchIntent {
  if (intent === "message_only") {
    return "connect_only";
  }
  if (intent === "custom_outreach") {
    return "custom_outreach";
  }
  return normalizeOutreachMode((intent ?? "connect_message") as LegacyOutreachMode);
}
