import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(name, imports) {
  const filename = fileURLToPath(new URL(name, import.meta.url));
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => {
    assert.ok(id in imports, `Unexpected import ${id}`);
    return imports[id];
  }, Date, Map, Set }, { filename });
  return module.exports;
}

test("shared campaign queries include both senders while rejecting mismatched event ownership", async () => {
  const now = new Date().toISOString();
  const rows = {
    linkedin_accounts: ["owner", "second", "empty"].map((id) => ({ id, display_name: id === "owner" ? "Katharina" : id === "second" ? "Sandra" : "Empty sender", is_active: true })),
    lead_batches: [30, 31, 32].map((id) => ({ id, sequence_id: id - 23, linkedin_account_id: "owner" })),
    outreach_sequences: [7, 8, 9].map((id) => ({ id, linkedin_account_id: "owner", delivery_mode: "standard_connect_message" })),
    leads: ["owner", "second"].map((account) => ({ id: account, batch_id: 30, sequence_id: 7, linkedin_account_id: account, status: "SENT", connection_sent_at: now, sent_at: now })),
    followups: [{ id: "fu-second", lead_id: "second", linkedin_account_id: "second", status: "SENT", sent_at: now, attempt: 1, leads: { batch_id: 30, sequence_id: 7 } },
      { id: "open-reply", lead_id: "owner", linkedin_account_id: "owner", status: "PENDING_REVIEW", sent_at: null, followup_type: "REPLY", reply_timestamp: now, leads: { batch_id: 30, sequence_id: 7 } }],
    outreach_events: ["owner", "second"].map((account) => ({ lead_id: account, sequence_id: 7, linkedin_account_id: account, event_type: "touch_sent", touch_number: 1, occurred_at: now })).concat([
      { lead_id: "owner", sequence_id: 7, linkedin_account_id: "second", event_type: "reply_received", occurred_at: now },
      { lead_id: "outside", sequence_id: 7, linkedin_account_id: "second", event_type: "reply_received", occurred_at: now },
      { lead_id: "second", sequence_id: 7, linkedin_account_id: "second", event_type: "touch_sent", touch_number: 2, occurred_at: now, metadata: { followup_id: "fu-second" } },
    ]),
  };
  const client = { from(table) {
    let data = rows[table];
    const query = {
      select() { return query; },
      returns() { return query; },
      eq(key, value) { data = data.filter((row) => key.split(".").reduce((part, field) => part?.[field], row) === value); return query; },
      in(key, values) { data = data.filter((row) => values.includes(row[key])); return query; },
      gte(key, value) { data = data.filter((row) => row[key] >= value); return query; },
      lt(key, value) { data = data.filter((row) => row[key] < value); return query; },
      order() { return query; },
      range(from, to) { return Promise.resolve({ data: data.slice(from, to + 1), error: null }); },
      then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject); },
    };
    return query;
  } };
  const aggregation = load("./campaignAnalytics.ts", {});
  const { fetchCampaignAnalytics } = load("./campaignAnalyticsServer.ts", {
    "server-only": {}, "./supabaseAdmin": { supabaseAdmin: () => client }, "./campaignAnalytics": aggregation, "./campaignRecipients": load("./campaignRecipients.ts", {}), "./replyAnalytics": load("./replyAnalytics.ts", {}),
  });
  const result = await fetchCampaignAnalytics("regular", 30);
  const tracked = await fetchCampaignAnalytics("regular", 30, true);
  assert.equal(tracked.recipients.length, 2);
  assert.equal(tracked.recipients.find(r => r.id === "second").messages.length, 2);
  assert.equal(tracked.firstTouchesSent, result.firstTouchesSent);
  assert.equal(result.leadCount, 2);
  assert.equal(result.firstTouchesSent, 2);
  assert.equal(result.invitesSent, 2);
  assert.equal(result.followupTouchesSent, 1);
  assert.equal(result.repliesReceived, 1);
  assert.equal(tracked.repliesReceived, result.repliesReceived);
  assert.deepEqual(JSON.parse(JSON.stringify(result.accounts.map((row) => [row.label, row.leadCount, row.invitesSent, row.firstTouchesSent, row.followupTouchesSent, row.messagesSent]))), [
    ["Empty sender", 0, 0, 0, 0, 0], ["Katharina", 1, 1, 1, 0, 1], ["Sandra", 1, 1, 1, 1, 2],
  ]);
  for (const metric of ["leadCount", "invitesSent", "firstTouchesSent", "followupTouchesSent", "repliesReceived"]) {
    assert.equal(result.accounts.reduce((sum, row) => sum + row[metric], 0), result[metric]);
  }
  const { fetchReplyAnalytics } = load("./campaignAnalyticsServer.ts", {
    "server-only": {}, "./supabaseAdmin": { supabaseAdmin: () => client }, "./campaignAnalytics": aggregation,
    "./campaignRecipients": load("./campaignRecipients.ts", {}), "./replyAnalytics": load("./replyAnalytics.ts", {}),
  });
  Object.assign(rows.leads[0], { first_name: 'Open', last_name: 'Contact' });
  rows.followups.find(row => row.id === 'open-reply').reply_snippet = 'Please send details.';
  rows.leads.push({ ...rows.leads[0], id: 'answered', first_name: 'Closed', last_name: 'Contact' });
  rows.followups.push({ id: 'answered-reply', lead_id: 'answered', linkedin_account_id: 'owner',
    followup_type: 'REPLY', status: 'SENT', sent_at: now, reply_timestamp: now, reply_snippet: 'Private archived reply.' });
  const publicReplies = await fetchReplyAnalytics(30, false, 'regular');
  assert.equal(publicReplies.peopleReplied, 2);
  assert.equal(publicReplies.openReplies, 1);
  assert.equal(publicReplies.openItems.length, 1);
  assert.equal(publicReplies.openItems[0].name, 'Open Contact');
  assert.equal(publicReplies.openItems[0].text, 'Please send details.');
  assert.equal(publicReplies.historyItems, undefined);
  assert.ok(!JSON.stringify(publicReplies).includes('Private archived reply.'));
  assert.ok(!JSON.stringify(publicReplies).includes('Closed Contact'));
  const privateReplies = await fetchReplyAnalytics(30, true, 'regular');
  assert.equal(privateReplies.openItems.length, 1);
  assert.equal(privateReplies.historyItems.length, 2);
});

const { buildCampaignRecipients, buildCampaignConversationHighlights, recipientsCsv } = load('./campaignRecipients.ts', {});
const scope = load('./campaignAnalytics.ts', {}).CAMPAIGN_ANALYTICS_SCOPES.regular;
const baseline = { scope, since: '2026-10-03T00:00:00Z', until: '2026-10-10T00:00:00Z', accounts: [{ id: 'owner', label: 'Sender A' }], followups: [], events: [] };
const person = { id: 'person', first_name: 'Ada', last_name: 'Example', company_name: 'Example', batch_id: 30, sequence_id: 7, linkedin_account_id: 'owner', status: 'SENT', sent_at: '2026-10-05T12:00:00Z' };
test('recipient history preserves earlier contacts, rejects wrong ownership and isolates replies from sequence progress', () => {
  const result = buildCampaignRecipients({ ...baseline, leads: [{ ...person, sent_at: '2026-09-01T12:00:00Z' }], events: [
    { lead_id: 'person', sequence_id: 7, linkedin_account_id: 'owner', event_type: 'touch_sent', touch_number: 1, occurred_at: '2026-09-01T12:00:00Z', metadata: { sent_text: 'Original\nFirst text' } },
    { lead_id: 'person', sequence_id: 7, linkedin_account_id: 'owner', event_type: 'touch_sent', touch_number: 2, occurred_at: person.sent_at, metadata: { followup_id: 'nudge' } },
    { lead_id: 'person', sequence_id: 7, linkedin_account_id: 'wrong', event_type: 'touch_sent', touch_number: 3, occurred_at: person.sent_at, metadata: { sent_text: 'Wrong sender' } },
  ], followups: [
    { id: 'nudge', lead_id: 'person', linkedin_account_id: 'owner', status: 'SENT', attempt: 1, followup_type: 'NUDGE', sent_at: person.sent_at, sent_text: 'Actual second' },
    { id: 'reply', lead_id: 'person', linkedin_account_id: 'owner', status: 'SENT', attempt: 2, followup_type: 'REPLY', sent_at: person.sent_at, sent_text: 'Human reply', reply_timestamp: person.sent_at, reply_snippet: 'Thanks' },
    { id: 'queued', lead_id: 'person', linkedin_account_id: 'owner', status: 'APPROVED', attempt: 2, followup_type: 'NUDGE', sent_at: null, sent_text: 'Unsent' },
  ] });
  assert.equal(result.length, 1);
  assert.equal(result[0].messages.length, 3);
  assert.equal(result[0].messages[0].text, 'Original\nFirst text');
  assert.equal(result[0].messages[1].text, 'Actual second');
  assert.equal(result[0].steps.join(','), '1,2');
  assert.equal(result[0].replyStatus, 'Replied');
});
test('window boundaries, campaign isolation, invitation-only contacts and inbox freshness are explicit', () => {
  const result = buildCampaignRecipients({ ...baseline, leads: [person,
    { ...person, id: 'invited', sent_at: null, connection_sent_at: baseline.since, last_inbox_scan_at: baseline.since },
    { ...person, id: 'old', sent_at: '2026-10-02T23:59:59Z' },
    { ...person, id: 'future', sent_at: baseline.until },
    { ...person, id: 'cop', batch_id: 33, sequence_id: 10 },
  ] });
  assert.equal(result.length, 2);
  assert.equal(result[0].replyStatus, 'Not checked since last contact');
  assert.equal(result[0].messages[0].text, null);
  assert.equal(result[1].messages.length, 0);
  assert.equal(result[1].replyStatus, 'No reply recorded');
});
test('CSV exports complete multiline message history and neutralizes formula cells', () => {
  const rows = buildCampaignRecipients({ ...baseline, leads: [{ ...person, first_name: '=FORMULA', last_name: '', company_name: 'Comma, quote"' }], followups: [
    { id: 'second', lead_id: person.id, linkedin_account_id: 'owner', status: 'SENT', sent_at: person.sent_at, attempt: 1, followup_type: 'NUDGE', sent_text: 'Line one\nLine two' },
  ] });
  const csv = recipientsCsv(rows);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=FORMULA"'));
  assert.ok(csv.includes('"Comma, quote"""'));
  assert.ok(csv.includes('"Line one\nLine two"'));
  assert.ok(csv.includes('Text not recorded'));
});

test('conversation highlights use only current campaign reply evidence in the selected window', () => {
  const highlights = buildCampaignConversationHighlights({ ...baseline, leads: [
    { ...person, first_name: 'Ada', last_name: 'Example' },
    { ...person, id: 'cop', batch_id: 33, sequence_id: 10, first_name: 'Cop', last_name: 'Lead' },
  ], followups: [
    { id: 'positive', lead_id: person.id, linkedin_account_id: 'owner', followup_type: 'REPLY', reply_timestamp: baseline.since, reply_snippet: 'Can you share the details?', reply_intent: 'positive', reply_intent_confidence: 0.91, reply_route: 'clear_yes', source_touch: 2 },
    { id: 'unknown', lead_id: person.id, linkedin_account_id: null, followup_type: 'REPLY', reply_timestamp: '2026-10-06T12:00:00Z', last_message_text: 'Please contact me next quarter.', last_message_from: 'lead' },
    { id: 'outbound-only', lead_id: person.id, linkedin_account_id: 'owner', followup_type: 'REPLY', reply_timestamp: '2026-10-06T12:00:00Z', last_message_text: 'Our sent follow-up', last_message_from: 'us' },
    { id: 'outside', lead_id: person.id, linkedin_account_id: 'owner', followup_type: 'REPLY', reply_timestamp: baseline.until, reply_snippet: 'Outside window', reply_intent: 'negative' },
    { id: 'wrong-owner', lead_id: person.id, linkedin_account_id: 'other', followup_type: 'REPLY', reply_timestamp: person.sent_at, reply_snippet: 'Wrong account' },
    { id: 'cop', lead_id: 'cop', linkedin_account_id: 'owner', followup_type: 'REPLY', reply_timestamp: person.sent_at, reply_snippet: 'Other campaign' },
  ] });
  assert.equal(highlights.length, 3);
  assert.equal(highlights[0].id, 'unknown');
  assert.equal(highlights[0].sentiment, null);
  assert.equal(highlights[0].replyText, 'Please contact me next quarter.');
  assert.equal(highlights.find(reply => reply.id === 'outbound-only').replyText, null);
  const positive = highlights.find(reply => reply.id === 'positive');
  assert.equal(positive.sentiment, 'positive');
  assert.equal(positive.replyText, 'Can you share the details?');
  assert.equal(positive.route, 'clear_yes');
  assert.equal(positive.sourceTouch, 2);

  const copHighlights = buildCampaignConversationHighlights({
    ...baseline,
    scope: load('./campaignAnalytics.ts', {}).CAMPAIGN_ANALYTICS_SCOPES['sales-navigator'],
    leads: [{ ...person, id: 'cop-only', batch_id: 33, sequence_id: 10 }],
    followups: [{ id: 'cop-reply', lead_id: 'cop-only', linkedin_account_id: 'owner', followup_type: 'REPLY', reply_timestamp: person.sent_at, reply_snippet: 'Please send more information.' }],
  });
  assert.equal(copHighlights.length, 1);
  assert.equal(copHighlights[0].sequence, 'COP · bAV InMail');
});

test('distinct sent records and first-message resends remain visible even with shared timestamps', () => {
  const result = buildCampaignRecipients({ ...baseline, leads: [person], events: [
    {lead_id: person.id, sequence_id: 7, linkedin_account_id: 'owner', event_type:'touch_sent', touch_number:1, occurred_at:'2026-10-04T00:00:00Z', metadata:{sent_text:'Earlier initial'}},
  ], followups: Array.from({length:135}, (_,i) => ({id:String(i), lead_id:person.id, linkedin_account_id:'owner', status:'SENT', sent_at:person.sent_at, attempt:1, followup_type:'NUDGE', sent_text:'Recorded '+i})) });
  assert.equal(result[0].messages.length, 137);
});
