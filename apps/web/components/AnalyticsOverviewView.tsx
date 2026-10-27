"use client";
import Link from 'next/link';
import { AnalyticsDashboard } from './AnalyticsDashboard';
import ReplyAnalytics from './ReplyAnalytics';
import type { AnalyticsSnapshot } from '../lib/analyticsLiveServer';
import { useAnalyticsLive, AnalyticsLiveStatus } from './AnalyticsLive';
export default function AnalyticsOverviewView({ initial }: { initial: AnalyticsSnapshot }) {
    const live = useAnalyticsLive(initial);
    const { snapshot } = live;
    if (snapshot.view !== 'overview') return null;
    const { analytics, dailyMetrics, funnel, replies } = snapshot;
    const validDays = snapshot.days;
    return (
        <div className="page">
            <AnalyticsLiveStatus live={live} />
            <div style={{ marginBottom: 24 }}>
                <div className="pill">Analytics</div>
                <h1 className="page-title" style={{ textTransform: "uppercase" }}>
                    Campaign Overview
                </h1>
                <p className="muted">Choose an isolated campaign ledger, or continue to the historical all-outreach snapshot below.</p>
            </div>

            <section className="analytics-campaign-index" aria-label="Campaign analytics pages">
                <Link href="/analytics/regular" className="analytics-campaign-card">
                    <span className="campaign-kicker">Campaign 01</span>
                    <strong>REGULAR · A/B/C</strong>
                    <span>Three DEGURA sequences · direct LinkedIn outreach</span>
                    <span className="analytics-campaign-card__cta">OPEN OVERVIEW →</span>
                </Link>
                <Link href="/analytics/sales-navigator" className="analytics-campaign-card analytics-campaign-card--dark">
                    <span className="campaign-kicker">Campaign 02</span>
                    <strong>SALES NAVIGATOR · COP</strong>
                    <span>InMail and invite campaign · isolated delivery surface</span>
                    <span className="analytics-campaign-card__cta">OPEN OVERVIEW →</span>
                </Link>
            </section>

            <ReplyAnalytics report={replies} days={validDays} />

            <div className="analytics-legacy-heading">
                <span className="campaign-kicker">Historical view</span>
                <h2>ALL OUTREACH ACTIVITY</h2>
            </div>

            <AnalyticsDashboard
                analytics={analytics}
                dailyMetrics={dailyMetrics}
                funnel={funnel}
                days={validDays}
            />
        </div>
    );
}
