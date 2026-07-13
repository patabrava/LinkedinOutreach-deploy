import assert from "node:assert/strict";
import test from "node:test";

import { buildConversionFunnel } from "./analyticsFunnel";
import type { OutreachAnalytics } from "../app/actions";

test("includes positive replies as a distinct conversion stage", () => {
  const analytics: OutreachAnalytics = {
    totalLeads: 100,
    connectionRequestsSent: 80,
    connectionsAccepted: 40,
    messagesSent: 50,
    repliesReceived: 10,
    positiveReplies: 3,
    followupsSent: 7,
    followupReplies: 2,
    connectionAcceptanceRate: 50,
    messageResponseRate: 20,
    positiveReplyRate: 6,
    overallConversionRate: 10,
    statusCounts: {},
  };

  const funnel = buildConversionFunnel(analytics);
  const positiveStage = funnel.stages.at(-1);

  assert.equal(positiveStage?.name, "Positive Replies");
  assert.equal(positiveStage?.count, 3);
  assert.equal(positiveStage?.percentage, 30);
});
