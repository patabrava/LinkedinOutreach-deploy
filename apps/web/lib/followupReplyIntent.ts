export type ReplyIntent = "positive" | "negative";

type IntentView = {
  label: string;
  className: string;
  title: string;
};

export function getReplyIntentView(
  followupType?: string | null,
  replyIntent?: string | null,
): IntentView | null {
  if ((followupType || "REPLY").toUpperCase() !== "REPLY") {
    return null;
  }

  if (replyIntent === "positive") {
    return {
      label: "POSITIVE",
      className: "status-approved",
      title: "Interested reply. Draft should keep the booking link.",
    };
  }

  if (replyIntent === "negative") {
    return {
      label: "NEGATIVE",
      className: "status-pending",
      title: "No-interest or ambiguous reply. Draft should keep the website link.",
    };
  }

  return null;
}
