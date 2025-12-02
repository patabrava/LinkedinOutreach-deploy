export type OutreachMode = "connect_message" | "message_only";

export const OUTREACH_MODE_LABELS: Record<OutreachMode, string> = {
  connect_message: "Connection + Message",
  message_only: "Message Only",
};

export const OUTREACH_MODE_TO_DB: Record<OutreachMode, "message" | "connect_only"> = {
  connect_message: "message",
  message_only: "connect_only",
};
