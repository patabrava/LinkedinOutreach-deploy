import Link from "next/link";

import { AnalyticsDashboard } from "../../components/AnalyticsDashboard";
import {
    fetchOutreachAnalytics,
    fetchDailyMetrics,
} from "../actions";
import { buildConversionFunnel } from "../../lib/analyticsFunnel";
import { requireServerSession } from "../../lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
    searchParams?: {
        days?: string;
        account?: string;
        variant?: string;
    };
};

export default async function AnalyticsPage({ searchParams }: PageProps) {
    await requireServerSession("/analytics");
    const daysParam = searchParams?.days;
    const days = daysParam ? parseInt(daysParam, 10) : 7;
    const validDays = [7, 30, 90].includes(days) ? days : 7;

    const [analytics, dailyMetrics] = await Promise.all([
        fetchOutreachAnalytics(validDays),
        fetchDailyMetrics(validDays),
    ]);
    const funnel = buildConversionFunnel(analytics);

    return (
        <div className="page">
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
