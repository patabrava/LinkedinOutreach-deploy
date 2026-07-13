import type { FunnelStats, OutreachAnalytics } from "../app/actions";

export function buildConversionFunnel(analytics: OutreachAnalytics): FunnelStats {
  const total = analytics.totalLeads;
  const connSent = analytics.connectionRequestsSent;
  const connAccepted = analytics.connectionsAccepted;
  const msgSent = analytics.messagesSent;
  const replyCount = analytics.repliesReceived;
  const positiveReplyCount = analytics.positiveReplies;

  return {
    stages: [
      {
        name: "Leads Added",
        count: total,
        percentage: 100,
      },
      {
        name: "Outreach Sent",
        count: msgSent,
        percentage: total > 0 ? Math.round((msgSent / total) * 1000) / 10 : 0,
      },
      {
        name: "Connection Requests",
        count: connSent,
        percentage: total > 0 ? Math.round((connSent / total) * 1000) / 10 : 0,
      },
      {
        name: "Connections Accepted",
        count: connAccepted,
        percentage: connSent > 0 ? Math.round((connAccepted / connSent) * 1000) / 10 : 0,
      },
      {
        name: "Replied",
        count: replyCount,
        percentage: msgSent > 0 ? Math.round((replyCount / msgSent) * 1000) / 10 : 0,
      },
      {
        name: "Positive Replies",
        count: positiveReplyCount,
        percentage: replyCount > 0 ? Math.round((positiveReplyCount / replyCount) * 1000) / 10 : 0,
      },
    ],
  };
}
