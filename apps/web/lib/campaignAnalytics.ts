export type CampaignAnalyticsKind = "regular" | "sales-navigator";

export type CampaignSequenceScope = {
  batchId: number;
  sequenceId: number;
  key: string;
  label: string;
};

export type CampaignAnalyticsScope = {
  kind: CampaignAnalyticsKind;
  eyebrow: string;
  title: string;
  shortTitle: string;
  channel: string;
  description: string;
  sequences: readonly CampaignSequenceScope[];
};

export type CampaignAnalyticsLead = {
  id: string;
  batch_id: number | null;
  sequence_id: number | null;
  linkedin_account_id: string;
  status: string;
  connection_sent_at?: string | null;
  sent_at?: string | null;
  last_reply_at?: string | null;
};

export type CampaignAnalyticsFollowup = {
  id: string;
  lead_id: string;
  linkedin_account_id: string | null;
  status: string;
  sent_at: string | null;
  attempt: number | null;
};

export type CampaignAnalyticsEvent = {
  lead_id: string;
  sequence_id: number | null;
  linkedin_account_id: string;
  event_type: string;
  touch_number: number | null;
  occurred_at: string;
  metadata?: { followup_id?: string | null } | null;
};

export type CampaignSequenceAnalytics = CampaignSequenceScope & {
  leadCount: number;
  invitesSent: number;
  firstTouchesSent: number;
  followupTouchesSent: number;
  repliesReceived: number;
  responseRate: number;
};

export type CampaignDailyActivity = {
  date: string;
  invites: number;
  touches: number;
  replies: number;
};

export type CampaignAnalytics = {
  scope: CampaignAnalyticsScope;
  days: number;
  leadCount: number;
  invitesSent: number;
  firstTouchesSent: number;
  followupTouchesSent: number;
  repliesReceived: number;
  responseRate: number;
  humanHandoffs: number;
  guidesSent: number;
  bookingLinksSent: number;
  appointmentsBooked: number;
  appointmentsShowed: number;
  sequenceStops: number;
  statusCounts: Record<string, number>;
  sequences: CampaignSequenceAnalytics[];
  dailyActivity: CampaignDailyActivity[];
};

export const CAMPAIGN_ANALYTICS_SCOPES: Record<CampaignAnalyticsKind, CampaignAnalyticsScope> = {
  regular: {
    kind: "regular",
    eyebrow: "Campaign 01",
    title: "DEGURA REGULAR OUTREACH",
    shortTitle: "Regular · A/B/C",
    channel: "LinkedIn connection + direct message",
    description: "Three coordinated sequences for Rentenreform and the bAV guide, reported as one campaign with a sequence-level breakdown.",
    sequences: [
      { batchId: 30, sequenceId: 7, key: "DEGURA_A", label: "A · Rentenreform" },
      { batchId: 31, sequenceId: 8, key: "DEGURA_B", label: "B · bAV Leitfaden Du" },
      { batchId: 32, sequenceId: 9, key: "DEGURA_C", label: "C · bAV Leitfaden Sie" },
    ],
  },
  "sales-navigator": {
    kind: "sales-navigator",
    eyebrow: "Campaign 02",
    title: "COP SALES NAVIGATOR",
    shortTitle: "Sales Navigator · COP",
    channel: "LinkedIn Sales Navigator InMail + invite",
    description: "COP outreach is isolated to its verified Sales Navigator delivery path; direct-message substitutions never enter this overview.",
    sequences: [
      { batchId: 33, sequenceId: 10, key: "COP", label: "COP · bAV InMail" },
    ],
  },
};

const roundedRate = (numerator: number, denominator: number): number =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;

// Reconcile reporting in memory. Never backfill or mutate the outreach ledger.
export function reconcileCampaignEvents(input: {
  leads: CampaignAnalyticsLead[];
  events: CampaignAnalyticsEvent[];
  followups: CampaignAnalyticsFollowup[];
  since: string;
  until: string;
}): CampaignAnalyticsEvent[] {
  const owners = new Map(input.leads.map((lead) => [lead.id, lead]));
  const start = Date.parse(input.since);
  const end = Date.parse(input.until);
  const inWindow = (value?: string | null) => {
    const time = Date.parse(value || "");
    return Number.isFinite(time) && time >= start && time < end;
  };
  const validTimestamp = (value?: string | null) => Number.isFinite(Date.parse(value || ""));
  const deliveries = new Map<string, CampaignAnalyticsEvent>();
  const eventKey = (event: CampaignAnalyticsEvent) => {
    if (event.event_type === "invite_sent") return `invite:${event.lead_id}`;
    if (event.event_type === "touch_sent" && event.touch_number === 1) return `first:${event.lead_id}`;
    if (event.metadata?.followup_id) return `followup:${event.lead_id}:${event.metadata.followup_id}`;
    return `${event.lead_id}:${event.event_type}:${event.touch_number}:${event.occurred_at}`;
  };
  for (const event of input.events) {
    const lead = owners.get(event.lead_id);
    // Touch 99 is the explicit COP InMail test override, not a sequence follow-up.
    if (!lead || event.sequence_id !== lead.sequence_id || event.linkedin_account_id !== lead.linkedin_account_id ||
      !inWindow(event.occurred_at) || (event.event_type === "touch_sent" && event.touch_number === 99)) continue;
    deliveries.set(eventKey(event), event);
  }
  const record = (lead: CampaignAnalyticsLead, eventType: string, timestamp: string, touch: number | null, key: string) => {
    deliveries.delete(key);
    if (inWindow(timestamp)) deliveries.set(key, {
      lead_id: lead.id, sequence_id: lead.sequence_id, linkedin_account_id: lead.linkedin_account_id,
      event_type: eventType, touch_number: touch, occurred_at: new Date(timestamp).toISOString(),
    });
  };
  for (const lead of input.leads) {
    if (validTimestamp(lead.connection_sent_at)) record(lead, "invite_sent", lead.connection_sent_at!, 1, `invite:${lead.id}`);
    if (validTimestamp(lead.sent_at)) record(lead, "touch_sent", lead.sent_at!, 1, `first:${lead.id}`);
    if (inWindow(lead.last_reply_at) && ![...deliveries.values()].some((event) => event.lead_id === lead.id && event.event_type === "reply_received")) {
      record(lead, "reply_received", lead.last_reply_at!, null, `reply:${lead.id}`);
    }
  }
  for (const followup of input.followups) {
    const lead = owners.get(followup.lead_id);
    // Legacy null account rows inherit the owning lead; explicit mismatches fail closed.
    if (!lead || (followup.linkedin_account_id && followup.linkedin_account_id !== lead.linkedin_account_id) ||
      followup.status !== "SENT" || !validTimestamp(followup.sent_at)) continue;
    record(lead, "touch_sent", followup.sent_at!, Math.max(2, (followup.attempt || 1) + 1), `followup:${lead.id}:${followup.id}`);
  }
  return [...deliveries.values()];
}

const uniqueLeadCount = (events: CampaignAnalyticsEvent[], eventType: string, touchNumber?: number): number => {
  const leadIds = new Set(
    events
      .filter((event) => event.event_type === eventType && (touchNumber === undefined || event.touch_number === touchNumber))
      .map((event) => event.lead_id),
  );
  return leadIds.size;
};

export function aggregateCampaignAnalytics(input: {
  scope: CampaignAnalyticsScope;
  leads: CampaignAnalyticsLead[];
  events: CampaignAnalyticsEvent[];
  days: number;
}): CampaignAnalytics {
  const pairKeys = new Set(input.scope.sequences.map((sequence) => `${sequence.batchId}:${sequence.sequenceId}`));
  const scopedLeads = input.leads.filter((lead) => pairKeys.has(`${lead.batch_id}:${lead.sequence_id}`));
  const leadOwnership = new Map(scopedLeads.map((lead) => [lead.id, lead]));
  const scopedEvents = input.events.filter((event) => {
    const lead = leadOwnership.get(event.lead_id);
    return Boolean(
      lead &&
      event.sequence_id === lead.sequence_id &&
      event.linkedin_account_id === lead.linkedin_account_id,
    );
  });

  const statusCounts = scopedLeads.reduce<Record<string, number>>((counts, lead) => {
    counts[lead.status] = (counts[lead.status] || 0) + 1;
    return counts;
  }, {});

  const firstTouchesSent = uniqueLeadCount(scopedEvents, "touch_sent", 1);
  const repliesReceived = uniqueLeadCount(scopedEvents, "reply_received");
  const daily = new Map<string, CampaignDailyActivity>();
  for (const event of scopedEvents) {
    if (!["invite_sent", "touch_sent", "reply_received"].includes(event.event_type)) continue;
    const date = event.occurred_at.slice(0, 10);
    const row = daily.get(date) || { date, invites: 0, touches: 0, replies: 0 };
    if (event.event_type === "invite_sent") row.invites += 1;
    if (event.event_type === "touch_sent") row.touches += 1;
    if (event.event_type === "reply_received") row.replies += 1;
    daily.set(date, row);
  }

  const sequences = input.scope.sequences.map((sequence) => {
    const sequenceLeads = scopedLeads.filter(
      (lead) => lead.batch_id === sequence.batchId && lead.sequence_id === sequence.sequenceId,
    );
    const sequenceLeadIds = new Set(sequenceLeads.map((lead) => lead.id));
    const sequenceEvents = scopedEvents.filter((event) => sequenceLeadIds.has(event.lead_id));
    const sequenceFirstTouches = uniqueLeadCount(sequenceEvents, "touch_sent", 1);
    const sequenceReplies = uniqueLeadCount(sequenceEvents, "reply_received");
    return {
      ...sequence,
      leadCount: sequenceLeads.length,
      invitesSent: uniqueLeadCount(sequenceEvents, "invite_sent"),
      firstTouchesSent: sequenceFirstTouches,
      followupTouchesSent: sequenceEvents.filter(
        (event) => event.event_type === "touch_sent" && (event.touch_number || 0) > 1,
      ).length,
      repliesReceived: sequenceReplies,
      responseRate: roundedRate(sequenceReplies, sequenceFirstTouches),
    };
  });

  return {
    scope: input.scope,
    days: input.days,
    leadCount: scopedLeads.length,
    invitesSent: uniqueLeadCount(scopedEvents, "invite_sent"),
    firstTouchesSent,
    followupTouchesSent: scopedEvents.filter(
      (event) => event.event_type === "touch_sent" && (event.touch_number || 0) > 1,
    ).length,
    repliesReceived,
    responseRate: roundedRate(repliesReceived, firstTouchesSent),
    humanHandoffs: uniqueLeadCount(scopedEvents, "human_handoff"),
    guidesSent: uniqueLeadCount(scopedEvents, "guide_sent"),
    bookingLinksSent: uniqueLeadCount(scopedEvents, "booking_link_sent"),
    appointmentsBooked: uniqueLeadCount(scopedEvents, "appointment_booked"),
    appointmentsShowed: uniqueLeadCount(scopedEvents, "appointment_showed"),
    sequenceStops: uniqueLeadCount(scopedEvents, "sequence_stopped"),
    statusCounts,
    sequences,
    dailyActivity: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
