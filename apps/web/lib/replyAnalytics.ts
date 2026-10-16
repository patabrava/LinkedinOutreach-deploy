import type { CampaignAnalyticsLead, CampaignAnalyticsEvent, CampaignAnalyticsFollowup } from './campaignAnalytics';

export type ReplyLead = CampaignAnalyticsLead & { first_name?: string | null; last_name?: string | null };
export type ReplyRecord = CampaignAnalyticsFollowup & {
  followup_type?: string | null; reply_timestamp?: string | null; reply_snippet?: string | null;
  last_message_from?: string | null; last_message_text?: string | null; reply_intent?: string | null;
};
export type ReplyCounts = { peopleReplied: number; openReplies: number; periodPeople: number };
export type OpenReply = {
  id: string; leadId: string; name: string; campaign: string; sender: string; status: string;
  receivedAt: string | null; text: string | null;
};
export type ReplyAnalytics = ReplyCounts & {
  periodPositivePeople: number;
  accounts: (ReplyCounts & { accountId: string; label: string })[];
  campaigns: (ReplyCounts & { sequenceId: number | null; batchId: number | null; label: string; sender: string })[];
  daily: { date: string; replies: number; positiveReplies: number }[];
  openItems?: OpenReply[];
  historyItems?: { leadId: string; name: string; campaign: string; sender: string; open: boolean;
    messages: { id: string; receivedAt: string | null; text: string | null }[] }[];
};

const timestamp = (value?: string | null): number => Date.parse(value || '');
const text = (value?: string | null): string | null => value?.trim() || null;
const openStatuses = new Set(['PENDING_REVIEW', 'APPROVED', 'FAILED', 'RETRY_LATER', 'PROCESSING']);

// Read-only reconciliation: a reply is inbound evidence, independent of whether we answered it.
// Period activity uses captured reply dates; current open work deliberately spans all dates.
export function buildReplyAnalytics(input: {
  leads: ReplyLead[]; followups: ReplyRecord[]; events: CampaignAnalyticsEvent[];
  accounts: { id: string; label: string }[]; sequences: { id: number; name: string }[];
  since: string; until: string; includeDetails?: boolean;
  pairs?: readonly { batchId: number; sequenceId: number }[];
}): ReplyAnalytics {
  const pairs = input.pairs && new Set(input.pairs.map(p => `${p.batchId}:${p.sequenceId}`));
  const leads = new Map(input.leads.filter(l => !pairs || pairs.has(`${l.batch_id}:${l.sequence_id}`)).map(l => [l.id, l]));
  const accountNames = new Map(input.accounts.map(a => [a.id, a.label]));
  const sequenceNames = new Map(input.sequences.map(s => [s.id, s.name]));
  const start = timestamp(input.since), end = timestamp(input.until);
  const evidence = new Map<string, { dates: Set<string>; rows: ReplyRecord[]; positiveDates: Set<string> }>();
  const add = (id: string, date?: string | null) => {
    const state = evidence.get(id) || { dates: new Set<string>(), rows: [], positiveDates: new Set<string>() };
    if (Number.isFinite(timestamp(date)) && timestamp(date) < end) state.dates.add(new Date(date!).toISOString());
    evidence.set(id, state);
    return state;
  };
  for (const lead of leads.values()) {
    if (Number.isFinite(timestamp(lead.last_reply_at)) && timestamp(lead.last_reply_at) < end) add(lead.id, lead.last_reply_at);
  }
  for (const event of input.events) {
    const lead = leads.get(event.lead_id);
    if (lead && event.event_type === 'reply_received' && event.sequence_id === lead.sequence_id &&
      event.linkedin_account_id === lead.linkedin_account_id && Number.isFinite(timestamp(event.occurred_at)) && timestamp(event.occurred_at) < end) add(lead.id, event.occurred_at);
  }
  for (const row of input.followups) {
    const lead = leads.get(row.lead_id);
    if (!lead || row.followup_type !== 'REPLY' || row.linkedin_account_id && row.linkedin_account_id !== lead.linkedin_account_id) continue;
    const dated = Number.isFinite(timestamp(row.reply_timestamp));
    const inbound = text(row.reply_snippet) || row.last_message_from === 'lead' && text(row.last_message_text);
    if ((!dated && !inbound) || dated && timestamp(row.reply_timestamp) >= end) continue;
    const state = add(lead.id, row.reply_timestamp);
    if (!state.rows.some(r => r.id === row.id)) state.rows.push(row);
    if (row.reply_intent === 'positive' && dated) state.positiveDates.add(new Date(row.reply_timestamp!).toISOString());
  }

  const empty = (): ReplyCounts => ({ peopleReplied: 0, openReplies: 0, periodPeople: 0 });
  const result: ReplyAnalytics = { ...empty(), periodPositivePeople: 0, accounts: [], campaigns: [], daily: [], ...(input.includeDetails ? { openItems: [], historyItems: [] } : {}) };
  const accounts = new Map(input.accounts.map(a => [a.id, { ...empty(), accountId: a.id, label: a.label }]));
  const campaigns = new Map<string, ReplyAnalytics['campaigns'][number]>();
  const daily = new Map<string, ReplyAnalytics['daily'][number]>();
  for (const [id, state] of evidence) {
    const lead = leads.get(id)!;
    const periodDates = [...state.dates].filter(d => timestamp(d) >= start && timestamp(d) < end).sort();
    const periodDate = periodDates.at(-1);
    const positiveDate = [...state.positiveDates].filter(d => timestamp(d) >= start && timestamp(d) < end).sort().at(-1);
    const latestReply = Math.max(...[...state.dates].map(timestamp));
    const answeredAt = Math.max(...state.rows.filter(r => r.status === 'SENT').map(r => timestamp(r.sent_at)).filter(Number.isFinite));
    const open = state.rows.filter(r => openStatuses.has(r.status) &&
      (!Number.isFinite(timestamp(r.reply_timestamp)) || !Number.isFinite(answeredAt) || timestamp(r.reply_timestamp) > answeredAt));
    // A later captured inbound timestamp can reopen a thread; an old pending row cannot override a later response.
    const isOpen = open.length > 0 && (!Number.isFinite(answeredAt) || !Number.isFinite(latestReply) || latestReply > answeredAt || open.some(r => !Number.isFinite(timestamp(r.reply_timestamp))));
    const sender = accountNames.get(lead.linkedin_account_id) || 'Unlabelled sender';
    const account = accounts.get(lead.linkedin_account_id) || { ...empty(), accountId: lead.linkedin_account_id, label: sender };
    accounts.set(lead.linkedin_account_id, account);
    const key = `${lead.batch_id}:${lead.sequence_id}:${lead.linkedin_account_id}`;
    const campaign = campaigns.get(key) || { ...empty(), sequenceId: lead.sequence_id, batchId: lead.batch_id,
      label: sequenceNames.get(lead.sequence_id!) || 'Unassigned campaign', sender };
    campaigns.set(key, campaign);
    for (const counts of [result, account, campaign]) {
      counts.peopleReplied += 1;
      counts.openReplies += Number(isOpen);
      counts.periodPeople += Number(Boolean(periodDate));
    }
    if (positiveDate) result.periodPositivePeople += 1;
    for (const [date, metric] of [[periodDate, 'replies'], [positiveDate, 'positiveReplies']] as const) {
      if (!date) continue;
      const day = date.slice(0, 10);
      const row = daily.get(day) || { date: day, replies: 0, positiveReplies: 0 };
      row[metric] += 1;
      daily.set(day, row);
    }
    if (isOpen && result.openItems) {
      const row = open.sort((a, b) => (timestamp(b.reply_timestamp) || 0) - (timestamp(a.reply_timestamp) || 0) || a.id.localeCompare(b.id))[0];
      result.openItems.push({ id: row.id, leadId: id, name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Name not recorded',
        campaign: campaign.label, sender, status: row.status, receivedAt: Number.isFinite(timestamp(row.reply_timestamp)) ? row.reply_timestamp! : null,
        text: text(row.reply_snippet) || (row.last_message_from === 'lead' ? text(row.last_message_text) : null) });
    }
    if (result.historyItems) result.historyItems.push({ leadId: id,
      name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Name not recorded',
      campaign: campaign.label, sender, open: isOpen,
      messages: state.rows.length ? state.rows.map(row => ({ id: row.id,
        receivedAt: Number.isFinite(timestamp(row.reply_timestamp)) ? row.reply_timestamp! : null,
        text: text(row.reply_snippet) || (row.last_message_from === 'lead' ? text(row.last_message_text) : null),
      })).sort((a, b) => (timestamp(b.receivedAt) || 0) - (timestamp(a.receivedAt) || 0)) :
        [{ id: `evidence:${id}`, receivedAt: [...state.dates].sort().at(-1) || null, text: null }],
    });
  }
  result.accounts = [...accounts.values()].sort((a, b) => a.label.localeCompare(b.label));
  result.campaigns = [...campaigns.values()].sort((a, b) => a.label.localeCompare(b.label) || a.sender.localeCompare(b.sender));
  result.daily = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  result.openItems?.sort((a, b) => (timestamp(b.receivedAt) || 0) - (timestamp(a.receivedAt) || 0));
  result.historyItems?.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
