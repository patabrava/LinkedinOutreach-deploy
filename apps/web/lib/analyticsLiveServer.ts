import 'server-only';
import { createServerComponentClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { isAllowed } from './allowlist';
import { isSupabaseAuthConfigured } from './authConfig';
import { supabaseAdmin } from './supabaseAdmin';
import { fetchCampaignAnalytics, fetchReplyAnalytics } from './campaignAnalyticsServer';
import { fetchOutreachAnalytics, fetchDailyMetrics } from '../app/actions';
import { buildConversionFunnel } from './analyticsFunnel';

export type AnalyticsScope = 'all' | 'regular' | 'sales-navigator';
export async function analyticsAccess() {
  if (!isSupabaseAuthConfigured()) return false;
  const client = createServerComponentClient({ cookies });
  const { data: { user }, error } = await client.auth.getUser();
  return !error && Boolean(user && isAllowed(user.email || ''));
}
export async function analyticsRevision(scope: AnalyticsScope, privateDetails: boolean) {
  const { data, error } = await supabaseAdmin().from('analytics_revisions').select('revision').eq('scope', scope).single();
  if (error) throw error;
  // Read before the report: a concurrent commit must cause the next check to catch up.
  return `${new Date().toISOString().slice(0, 10)}:${privateDetails ? 'private' : 'public'}:${data.revision}`;
}
export async function analyticsSnapshot(scope: AnalyticsScope, days: number, privateDetails: boolean, revision: string) {
  const replies = fetchReplyAnalytics(days, privateDetails, scope === 'all' ? undefined : scope);
  if (scope !== 'all') {
    const [analytics, replyReport] = await Promise.all([fetchCampaignAnalytics(scope, days, privateDetails), replies]);
    return { view: 'campaign' as const, scope, days, revision, refreshedAt: new Date().toISOString(), analytics, replies: replyReport };
  }
  const [original, daily, replyReport] = await Promise.all([fetchOutreachAnalytics(days), fetchDailyMetrics(days), replies]);
  const analytics = { ...original, repliesReceived: replyReport.periodPeople, positiveReplies: replyReport.periodPositivePeople,
    messageResponseRate: original.messagesSent ? Math.round(replyReport.periodPeople / original.messagesSent * 1000) / 10 : 0,
    positiveReplyRate: original.messagesSent ? Math.round(replyReport.periodPositivePeople / original.messagesSent * 1000) / 10 : 0,
    overallConversionRate: original.totalLeads ? Math.round(replyReport.periodPeople / original.totalLeads * 1000) / 10 : 0 };
  return { view: 'overview' as const, scope, days, revision, refreshedAt: new Date().toISOString(), analytics,
    replies: replyReport, dailyMetrics: daily.map(row => ({ ...row,
      replies: replyReport.daily.find(day => day.date === row.date)?.replies || 0,
      positiveReplies: replyReport.daily.find(day => day.date === row.date)?.positiveReplies || 0 })),
    funnel: buildConversionFunnel(analytics) };
}
export type AnalyticsSnapshot = Awaited<ReturnType<typeof analyticsSnapshot>>;
