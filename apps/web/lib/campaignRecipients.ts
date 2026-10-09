import type { CampaignAnalyticsLead, CampaignAnalyticsEvent, CampaignAnalyticsFollowup, CampaignAnalyticsScope } from './campaignAnalytics';

export type RecipientLead = CampaignAnalyticsLead & {
  first_name?: string | null; last_name?: string | null; company_name?: string | null;
  linkedin_url?: string | null; last_inbox_scan_at?: string | null;
};
export type RecipientFollowup = CampaignAnalyticsFollowup & {
  sent_text?: string | null; followup_type?: string | null; source_touch?: number | null;
  reply_timestamp?: string | null; reply_snippet?: string | null; reply_intent?: string | null;
  reply_intent_confidence?: number | null; reply_route?: string | null;
  last_message_text?: string | null; last_message_from?: string | null;
};
export type CampaignConversationHighlight = {
  id: string; name: string; company: string; sender: string; sequence: string;
  repliedAt: string; replyText: string | null; sentiment: 'positive' | 'negative' | null;
  confidence: number | null; route: string | null; sourceTouch: number | null;
};
export type RecipientMessage = { key: string; label: string; step: number | null; sentAt: string | null; text: string | null };
export type CampaignRecipient = {
  id: string; name: string; company: string; profileUrl: string | null; sender: string; sequence: string;
  inviteAt: string | null; messages: RecipientMessage[]; steps: number[];
  replyStatus: 'Replied' | 'No reply recorded' | 'Not checked since last contact';
  replyAt: string | null; replyText: string | null; scannedAt: string | null; lastContactAt: string;
};
const time = (value?: string | null) => Date.parse(value || '');
const valid = (value?: string | null): value is string => Number.isFinite(time(value));
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const label = (step: number | null) => step === 1 ? 'First message' : step === 2 ? 'Second message' : step === 3 ? 'Third message' : 'Other sent message';

// Use only persisted reply evidence; this view does not infer intent from message text.
export function buildCampaignConversationHighlights(input: {
  scope: CampaignAnalyticsScope; leads: RecipientLead[]; followups: RecipientFollowup[];
  accounts: { id: string; label: string }[]; since: string; until: string;
}): CampaignConversationHighlight[] {
  const pairs = new Set(input.scope.sequences.map(s => `${s.batchId}:${s.sequenceId}`));
  const leads = new Map(input.leads.filter(lead => pairs.has(`${lead.batch_id}:${lead.sequence_id}`)).map(lead => [lead.id, lead]));
  const owners = new Map(input.accounts.map(account => [account.id, account.label]));
  const start = time(input.since), end = time(input.until);
  return input.followups.flatMap(row => {
    const lead = leads.get(row.lead_id), repliedAt = row.reply_timestamp;
    if (!lead || !valid(repliedAt) || time(repliedAt) < start || time(repliedAt) >= end ||
      row.linkedin_account_id && row.linkedin_account_id !== lead.linkedin_account_id ||
      (row.followup_type !== 'REPLY' && !text(row.reply_snippet) && !text(row.reply_intent) && row.last_message_from !== 'lead')) return [];
    const sentiment: CampaignConversationHighlight['sentiment'] = row.reply_intent === 'positive' || row.reply_intent === 'negative' ? row.reply_intent : null;
    const confidence = typeof row.reply_intent_confidence === 'number' && Number.isFinite(row.reply_intent_confidence)
      ? Math.max(0, Math.min(1, row.reply_intent_confidence)) : null;
    return [{
      id: row.id, name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Name not recorded',
      company: lead.company_name || '', sender: owners.get(lead.linkedin_account_id) || 'Unlabelled sender',
      sequence: input.scope.sequences.find(sequence => sequence.sequenceId === lead.sequence_id)?.label || '',
      repliedAt, replyText: text(row.reply_snippet) || (row.last_message_from === 'lead' ? text(row.last_message_text) : null), sentiment, confidence, route: text(row.reply_route),
      sourceTouch: row.source_touch && row.source_touch > 0 ? row.source_touch : null,
    }];
  }).sort((a, b) => time(b.repliedAt) - time(a.repliedAt) || a.name.localeCompare(b.name));
}

// Historical evidence only. Never reconstruct a sent body from a current template.
export function buildCampaignRecipients(input: {
  scope: CampaignAnalyticsScope; leads: RecipientLead[]; events: CampaignAnalyticsEvent[];
  followups: RecipientFollowup[]; accounts: { id: string; label: string }[]; since: string; until: string;
}): CampaignRecipient[] {
  const pairs = new Set(input.scope.sequences.map(s => `${s.batchId}:${s.sequenceId}`));
  const names = new Map(input.accounts.map(a => [a.id, a.label]));
  const events = new Map<string, CampaignAnalyticsEvent[]>(), followups = new Map<string, RecipientFollowup[]>();
  for (const event of input.events) events.set(event.lead_id, [...(events.get(event.lead_id) || []), event]);
  for (const row of input.followups) followups.set(row.lead_id, [...(followups.get(row.lead_id) || []), row]);
  const result: CampaignRecipient[] = [];
  for (const lead of input.leads) {
    if (!pairs.has(`${lead.batch_id}:${lead.sequence_id}`)) continue;
    const ownEvents = (events.get(lead.id) || []).filter(e => e.sequence_id === lead.sequence_id && e.linkedin_account_id === lead.linkedin_account_id && valid(e.occurred_at) && time(e.occurred_at) < time(input.until));
    const ownFollowups = (followups.get(lead.id) || []).filter(f => !f.linkedin_account_id || f.linkedin_account_id === lead.linkedin_account_id);
    const messages = new Map<string, RecipientMessage>();
    for (const event of ownEvents) {
      if (event.event_type !== 'touch_sent' || event.touch_number === 99) continue;
      const metadata = event.metadata as Record<string, unknown> | null;
      const followupId = text(metadata?.followup_id);
      const step = event.touch_number && event.touch_number >= 1 && event.touch_number <= 3 ? event.touch_number : null;
      const key = followupId ? `fu:${followupId}` : `event:${event.touch_number}:${event.occurred_at}`;
      messages.set(key, { key, label: label(step), step, sentAt: event.occurred_at, text: text(metadata?.sent_text) });
    }
    if (valid(lead.sent_at) && time(lead.sent_at) < time(input.until)) {
      const recorded = [...messages.values()].find(m => m.step === 1 && time(m.sentAt) === time(lead.sent_at));
      const key = recorded?.key || 'first';
      messages.set(key, { key, label: 'First message', step: 1, sentAt: lead.sent_at, text: recorded?.text || null });
    }
    for (const row of ownFollowups) {
      if (row.status !== 'SENT' || valid(row.sent_at) && time(row.sent_at) >= time(input.until)) continue;
      const key = `fu:${row.id}`;
      const event = messages.get(key) || [...messages.values()].find(m => row.followup_type === 'NUDGE' && m.key.startsWith('event:') && valid(row.sent_at) && time(m.sentAt) === time(row.sent_at) && m.step === (row.attempt || 0) + 1);
      if (event && event.key !== key) messages.delete(event.key);
      // Replies and asset delivery are not sequence second/third messages.
      const step = row.followup_type === 'NUDGE' && (row.attempt === 1 || row.attempt === 2) ? row.attempt + 1 : !row.followup_type || row.followup_type === 'NUDGE' ? event?.step ?? null : null;
      messages.set(key, { key, label: row.followup_type === 'REPLY' ? 'Reply sent' : label(step), step: row.followup_type === 'REPLY' ? null : step,
        sentAt: valid(row.sent_at) ? row.sent_at : event?.sentAt || null, text: text(row.sent_text) || event?.text || null });
    }
    const inviteEvent = ownEvents.find(e => e.event_type === 'invite_sent');
    const inviteAt = valid(lead.connection_sent_at) && time(lead.connection_sent_at) < time(input.until) ? lead.connection_sent_at : inviteEvent?.occurred_at || null;
    const contacts = [inviteAt, ...Array.from(messages.values()).map(m => m.sentAt)].filter(valid);
    if (!contacts.some(date => time(date) >= time(input.since) && time(date) < time(input.until))) continue;
    const replyEvents = ownEvents.filter(e => e.event_type === 'reply_received').map(e => e.occurred_at);
    const replies = ownFollowups.filter(f => valid(f.reply_timestamp) && (f.followup_type === 'REPLY' || f.reply_snippet));
    const replyDates = [lead.last_reply_at, ...replyEvents, ...replies.map(r => r.reply_timestamp)].filter(valid).sort((a,b) => time(b)-time(a));
    const lastContactAt = contacts.sort((a,b) => time(b)-time(a))[0];
    const replyAt = replyDates[0] || null;
    const latestReply = replies.sort((a,b) => time(b.reply_timestamp)-time(a.reply_timestamp))[0];
    const profileUrl = lead.linkedin_url && /^https:\/\/(www\.)?linkedin\.com\//i.test(lead.linkedin_url) ? lead.linkedin_url : null;
    const sorted = Array.from(messages.values()).sort((a,b) => (time(a.sentAt) || 0)-(time(b.sentAt) || 0));
    result.push({ id: lead.id, name: [lead.first_name,lead.last_name].filter(Boolean).join(' ') || 'Name not recorded', company: lead.company_name || '', profileUrl,
      sender: names.get(lead.linkedin_account_id) || 'Unlabelled sender', sequence: input.scope.sequences.find(s => s.sequenceId === lead.sequence_id)?.label || '',
      inviteAt, messages: sorted, steps: [...new Set(sorted.map(m => m.step).filter((s): s is number => s !== null))],
      replyStatus: replyAt ? 'Replied' : valid(lead.last_inbox_scan_at) && time(lead.last_inbox_scan_at) >= time(lastContactAt) ? 'No reply recorded' : 'Not checked since last contact',
      replyAt, replyText: text(latestReply?.reply_snippet), scannedAt: lead.last_inbox_scan_at || null, lastContactAt });
  }
  return result.sort((a,b) => time(b.lastContactAt)-time(a.lastContactAt) || a.name.localeCompare(b.name));
}

export function recipientsCsv(rows: CampaignRecipient[]): string {
  const cell = (value: unknown) => {
    let str = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(str)) str = "'" + str;
    return '"' + str.replaceAll('"', '""') + '"';
  };
  const data: unknown[][] = [['Name','Company','Sender','Sequence','LinkedIn URL','Invite sent','First message sent','Second message sent','Third message sent','Reply status','Last reply','Recorded reply text','Inbox checked','Message type','Message sent at','Recorded sent text']];
  for (const row of rows) for (const message of row.messages.length ? row.messages : [null]) data.push([
    row.name,row.company,row.sender,row.sequence,row.profileUrl,row.inviteAt,...[1,2,3].map(s => row.steps.includes(s) ? 'Yes' : 'Not recorded'),
    row.replyStatus,row.replyAt,row.replyText,row.scannedAt,message?.label || 'Invitation only',message?.sentAt,message?.text || (message ? 'Text not recorded' : '')
  ]);
  return '\uFEFF' + data.map(row => row.map(cell).join(',')).join('\r\n');
}
