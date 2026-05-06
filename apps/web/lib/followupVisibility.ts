export type FollowupLeadState = {
  status?: string | null;
  sent_at?: string | null;
  connection_accepted_at?: string | null;
  sequence_step?: number | null;
  sequence_last_sent_at?: string | null;
};

export type FollowupVisibilityRow = {
  followup_type?: string | null;
  lead?: FollowupLeadState | null;
};

export const hasFirstMessageBeenSent = (lead?: FollowupLeadState | null): boolean => {
  if (!lead) return false;
  const status = (lead.status || "").toUpperCase();
  return Boolean(
    lead.sent_at ||
      lead.connection_accepted_at ||
      lead.sequence_last_sent_at ||
      status === "SENT" ||
      (lead.sequence_step ?? 0) >= 1,
  );
};

export const isVisibleFollowup = (row: FollowupVisibilityRow): boolean => {
  const followupType = (row.followup_type || "REPLY").toUpperCase();
  if (followupType !== "NUDGE") {
    return true;
  }

  return hasFirstMessageBeenSent(row.lead);
};
