import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateCampaignAnalytics,
  CAMPAIGN_ANALYTICS_SCOPES,
  type CampaignAnalyticsEvent,
  type CampaignAnalyticsLead,
} from "./campaignAnalytics";

const accountId = "account-1";

const leads: CampaignAnalyticsLead[] = [
  { id: "a-1", batch_id: 30, sequence_id: 7, linkedin_account_id: accountId, status: "SENT" },
  { id: "a-2", batch_id: 30, sequence_id: 7, linkedin_account_id: accountId, status: "REPLIED" },
  { id: "b-1", batch_id: 31, sequence_id: 8, linkedin_account_id: accountId, status: "NEW" },
  { id: "legacy", batch_id: 25, sequence_id: 7, linkedin_account_id: accountId, status: "SENT" },
  { id: "cross-join", batch_id: 30, sequence_id: 8, linkedin_account_id: accountId, status: "SENT" },
];

const events: CampaignAnalyticsEvent[] = [
  { lead_id: "a-1", sequence_id: 7, linkedin_account_id: accountId, event_type: "invite_sent", touch_number: 1, occurred_at: "2026-09-24T10:00:00Z" },
  { lead_id: "a-1", sequence_id: 7, linkedin_account_id: accountId, event_type: "touch_sent", touch_number: 1, occurred_at: "2026-09-24T10:05:00Z" },
  { lead_id: "a-1", sequence_id: 7, linkedin_account_id: accountId, event_type: "touch_sent", touch_number: 2, occurred_at: "2026-09-25T10:00:00Z" },
  { lead_id: "a-2", sequence_id: 7, linkedin_account_id: accountId, event_type: "touch_sent", touch_number: 1, occurred_at: "2026-09-24T11:00:00Z" },
  { lead_id: "a-2", sequence_id: 7, linkedin_account_id: accountId, event_type: "reply_received", touch_number: 1, occurred_at: "2026-09-25T11:00:00Z" },
  { lead_id: "a-2", sequence_id: 7, linkedin_account_id: accountId, event_type: "human_handoff", touch_number: 1, occurred_at: "2026-09-25T11:01:00Z" },
  { lead_id: "a-2", sequence_id: 7, linkedin_account_id: accountId, event_type: "sequence_stopped", touch_number: 1, occurred_at: "2026-09-26T11:01:00Z" },
  { lead_id: "legacy", sequence_id: 7, linkedin_account_id: accountId, event_type: "touch_sent", touch_number: 1, occurred_at: "2026-09-24T12:00:00Z" },
  { lead_id: "cross-join", sequence_id: 8, linkedin_account_id: accountId, event_type: "reply_received", touch_number: 1, occurred_at: "2026-09-25T12:00:00Z" },
];

test("defines the regular and Sales Navigator campaigns as exact batch and sequence scopes", () => {
  assert.deepEqual(
    CAMPAIGN_ANALYTICS_SCOPES.regular.sequences.map(({ batchId, sequenceId }) => [batchId, sequenceId]),
    [[30, 7], [31, 8], [32, 9]],
  );
  assert.deepEqual(
    CAMPAIGN_ANALYTICS_SCOPES["sales-navigator"].sequences.map(({ batchId, sequenceId }) => [batchId, sequenceId]),
    [[33, 10]],
  );
});

test("aggregates only leads and persisted events belonging to exact campaign triples", () => {
  const result = aggregateCampaignAnalytics({
    scope: CAMPAIGN_ANALYTICS_SCOPES.regular,
    leads,
    events,
    days: 30,
  });

  assert.equal(result.leadCount, 3);
  assert.equal(result.invitesSent, 1);
  assert.equal(result.firstTouchesSent, 2);
  assert.equal(result.followupTouchesSent, 1);
  assert.equal(result.repliesReceived, 1);
  assert.equal(result.humanHandoffs, 1);
  assert.equal(result.responseRate, 50);
  assert.deepEqual(result.statusCounts, { SENT: 1, REPLIED: 1, NEW: 1 });
  assert.equal(result.sequences[0].leadCount, 2);
  assert.equal(result.sequences[0].repliesReceived, 1);
  assert.equal(result.sequences[1].leadCount, 1);
  assert.equal(result.sequences[2].leadCount, 0);
  assert.deepEqual(result.dailyActivity, [
    { date: "2026-09-24", invites: 1, touches: 2, replies: 0 },
    { date: "2026-09-25", invites: 0, touches: 1, replies: 1 },
  ]);
});

test("counts only recorded appointment outcomes and keeps zero denominators safe", () => {
  const result = aggregateCampaignAnalytics({
    scope: CAMPAIGN_ANALYTICS_SCOPES["sales-navigator"],
    leads: [{ id: "cop-1", batch_id: 33, sequence_id: 10, linkedin_account_id: accountId, status: "NEW" }],
    events: [
      { lead_id: "cop-1", sequence_id: 10, linkedin_account_id: accountId, event_type: "appointment_booked", touch_number: null, occurred_at: "2026-09-25T13:00:00Z" },
      { lead_id: "cop-1", sequence_id: 10, linkedin_account_id: accountId, event_type: "appointment_showed", touch_number: null, occurred_at: "2026-09-25T14:00:00Z" },
    ],
    days: 7,
  });

  assert.equal(result.appointmentsBooked, 1);
  assert.equal(result.appointmentsShowed, 1);
  assert.equal(result.responseRate, 0);
});
