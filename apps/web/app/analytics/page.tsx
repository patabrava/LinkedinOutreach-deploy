import { AnalyticsDashboard } from "../../components/AnalyticsDashboard";
import {
    fetchOutreachAnalytics,
    fetchDailyMetrics,
    fetchDeguraEventAnalytics,
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

    const variant = Number(searchParams?.variant || 0) || undefined;
    const [analytics, dailyMetrics, deguraRows] = await Promise.all([
        fetchOutreachAnalytics(validDays),
        fetchDailyMetrics(validDays),
        fetchDeguraEventAnalytics(validDays, searchParams?.account, variant),
    ]);
    const funnel = buildConversionFunnel(analytics);

    return (
        <div className="page">
            <div style={{ marginBottom: 24 }}>
                <div className="pill">Analytics</div>
                <h1 className="page-title" style={{ textTransform: "uppercase" }}>
                    Outreach Performance
                </h1>
            </div>

            <AnalyticsDashboard
                analytics={analytics}
                dailyMetrics={dailyMetrics}
                funnel={funnel}
                days={validDays}
            />
            <div className="card" style={{ marginTop: 24 }}>
                <div className="pill">DEGURA Events</div>
                <h3 className="section-title-tight">ACCOUNT × VARIANT</h3>
                <p className="muted">Only persisted campaign events are shown; bookings and show outcomes are never inferred.</p>
                <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead><tr><th align="left">ACCOUNT</th><th align="left">VARIANT</th><th align="left">EVENT COUNTS</th></tr></thead>
                        <tbody>
                            {deguraRows.map((row) => (
                                <tr key={`${row.accountId}-${row.variantId}`}>
                                    <td>{row.accountId}</td>
                                    <td>{row.variantId ?? "—"}</td>
                                    <td>{Object.entries(row.counts).map(([event, count]) => `${event}: ${count}`).join(" · ")}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
