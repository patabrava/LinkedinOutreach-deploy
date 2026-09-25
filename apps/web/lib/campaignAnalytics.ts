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
};

export type CampaignAnalyticsEvent = {
  lead_id: string;
  sequence_id: number | null;
  linkedin_account_id: string;
  event_type: string;
  touch_number: number | null;
  occurred_at: string;
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
