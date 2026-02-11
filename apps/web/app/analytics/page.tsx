import { AnalyticsDashboard } from "../../components/AnalyticsDashboard";
import {
    fetchOutreachAnalytics,
    fetchDailyMetrics,
    fetchConversionFunnel,
} from "../actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
    searchParams?: {
        days?: string;
    };
};

export default async function AnalyticsPage({ searchParams }: PageProps) {
    const daysParam = searchParams?.days;
    const days = daysParam ? parseInt(daysParam, 10) : 7;
    const validDays = [7, 30, 90].includes(days) ? days : 7;

    const [analytics, dailyMetrics, funnel] = await Promise.all([
        fetchOutreachAnalytics(),
        fetchDailyMetrics(validDays),
        fetchConversionFunnel(),
    ]);

    return (
        <div className="page">
            <div style={{ marginBottom: 24 }}>
                <div className="pill">Analytics</div>
                <h1 style={{ margin: "16px 0 8px 0" }}>
                    OUTREACH PERFORMANCE
                </h1>
                <div className="muted">
                    Track your LinkedIn outreach metrics, response rates, and conversion funnel.
                </div>
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
