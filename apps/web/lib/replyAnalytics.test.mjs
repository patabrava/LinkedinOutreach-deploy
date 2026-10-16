import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function load() {
  const filename = fileURLToPath(new URL('./replyAnalytics.ts', import.meta.url));
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Date, Map, Set }, { filename });
  return module.exports.buildReplyAnalytics;
}
const since = '2026-10-10T00:00:00Z', until = '2026-10-17T00:00:00Z';
const lead = (id, sequence_id = 10, batch_id = 33, owner = 'k') => ({ id, sequence_id, batch_id, linkedin_account_id: owner, last_reply_at: null, first_name: 'Private', last_name: id });
const reply = (id, lead_id, status = 'PENDING_REVIEW', date = '2026-10-05T10:00:00Z') => ({
  id, lead_id, linkedin_account_id: 'k', followup_type: 'REPLY', status, reply_timestamp: date, reply_snippet: 'Private inbound text', last_message_from: 'lead', sent_at: null,
});
const input = () => ({
  leads: [lead('cop'), lead('legacy', 4, 21), lead('regular', 9, 32, 's'), lead('other-batch', 10, 99)],
  followups: [reply('cop-1', 'cop'), reply('cop-duplicate', 'cop'), reply('legacy-1', 'legacy', 'FAILED'),
    { ...reply('regular-1', 'regular', 'SENT', '2026-10-12T10:00:00Z'), linkedin_account_id: null, sent_at: '2026-10-13T10:00:00Z', reply_intent: 'positive' }],
  events: [{ lead_id: 'cop', linkedin_account_id: 'k', sequence_id: 10, event_type: 'reply_received', occurred_at: '2026-10-05T10:00:00Z' }],
  accounts: [{ id: 'k', label: 'Katharina' }, { id: 's', label: 'Sandra' }],
  sequences: [{ id: 4, name: 'Legacy campaign' }, { id: 9, name: 'DEGURA C' }, { id: 10, name: 'COP' }], since, until,
});

test('all-time reply people and open backlog include legacy campaigns, deduplicate records and ignore date filters', () => {
  const result = load()(input());
  assert.equal(result.peopleReplied, 3);
  assert.equal(result.openReplies, 2);
  assert.equal(result.periodPeople, 1);
  assert.equal(result.periodPositivePeople, 1);
  assert.equal(result.campaigns.find(row => row.sequenceId === 4).openReplies, 1);
  assert.equal(result.accounts.find(row => row.accountId === 'k').openReplies, 2);
  assert.equal(result.accounts.find(row => row.accountId === 's').peopleReplied, 1);
  assert.equal(result.daily.reduce((n, row) => n + row.replies, 0), result.periodPeople);
  assert.equal(result.openItems, undefined);
  assert.equal(result.historyItems, undefined);
  assert.ok(!JSON.stringify(result).includes('Private'));
});

test('explicit ownership mismatches, nudges, orphan records and unsupported evidence cannot create replies', () => {
  const data = input();
  data.followups.push(
    { ...reply('wrong', 'other-batch'), linkedin_account_id: 's' },
    { ...reply('nudge', 'other-batch'), followup_type: 'NUDGE' },
    { ...reply('empty', 'other-batch'), reply_timestamp: null, reply_snippet: null, last_message_from: 'us' },
    reply('orphan', 'missing'),
  );
  data.events.push({ lead_id: 'other-batch', sequence_id: 10, linkedin_account_id: 's', event_type: 'reply_received', occurred_at: since });
  const result = load()(data);
  assert.equal(result.peopleReplied, 3);
  assert.equal(result.openReplies, 2);
});

test('campaign pages use exact pairs and signed-in users can see captured open replies from before the selected window', () => {
  const data = input();
  data.followups.push(reply('unrelated', 'other-batch'));
  const result = load()({ ...data, pairs: [{ batchId: 33, sequenceId: 10 }], includeDetails: true });
  assert.equal(result.peopleReplied, 1);
  assert.equal(result.periodPeople, 0);
  assert.equal(result.openReplies, 1);
  assert.equal(result.openItems.length, 1);
  assert.equal(result.openItems[0].text, 'Private inbound text');
  assert.equal(result.openItems[0].campaign, 'COP');
  assert.equal(result.historyItems.length, 1);
  assert.equal(result.historyItems[0].messages.length, 2);
});

test('a later sent response closes an older open record; a newer inbound reply reopens it', () => {
  const data = input();
  data.followups.push({ ...reply('answered', 'cop', 'SENT'), sent_at: '2026-10-06T10:00:00Z' });
  assert.equal(load()(data).openReplies, 1);
  data.followups.push(reply('new-inbound', 'cop', 'PENDING_REVIEW', '2026-10-12T10:00:00Z'));
  assert.equal(load()(data).openReplies, 2);
});

test('received timestamps determine period totals, not record creation or response send dates', () => {
  const data = input();
  data.followups[0].created_at = '2026-10-12T10:00:00Z';
  data.followups[0].reply_timestamp = '2026-09-01T10:00:00Z';
  data.followups.push(reply('at-end', 'other-batch', 'PENDING_REVIEW', until));
  assert.equal(load()(data).periodPeople, 1);
  data.followups.push(reply('at-start', 'legacy', 'PENDING_REVIEW', since));
  const result = load()(data);
  assert.equal(result.periodPeople, 2);
  assert.equal(result.daily.reduce((n, row) => n + row.replies, 0), 2);
});

test('unknown-date replies remain visible all-time without inventing a receipt date or exposing outbound text', () => {
  const data = input();
  data.followups.push({ ...reply('undated', 'other-batch'), reply_timestamp: null, last_message_from: 'us', last_message_text: 'Outbound' });
  const result = load()({ ...data, includeDetails: true });
  assert.equal(result.peopleReplied, 4);
  assert.equal(result.openReplies, 3);
  const item = result.openItems.find(item => item.leadId === 'other-batch');
  assert.equal(item.receivedAt, null);
  assert.equal(item.text, 'Private inbound text');
});
