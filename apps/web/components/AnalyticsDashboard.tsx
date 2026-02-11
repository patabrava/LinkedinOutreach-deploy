"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type {
    OutreachAnalytics,
    DailyMetrics,
    FunnelStats,
} from "../app/actions";

type Props = {
    analytics: OutreachAnalytics;
    dailyMetrics: DailyMetrics[];
    funnel: FunnelStats;
    days: number;
};

function MetricCard({
    label,
    value,
    subtext,
    highlight,
}: {
    label: string;
    value: string | number;
    subtext?: string;
    highlight?: boolean;
}) {
    return (
        <div className={`metric-card ${highlight ? "metric-card--highlight" : ""}`}>
            <div className="metric-card__label">{label}</div>
            <div className="metric-card__value">{value}</div>
            {subtext && <div className="metric-card__subtext">{subtext}</div>}
        </div>
    );
}

function formatNumber(n: number): string {
    if (n >= 1000) {
        return (n / 1000).toFixed(1) + "k";
    }
    return n.toLocaleString();
}

function formatPercent(n: number): string {
    return n.toFixed(1) + "%";
}

function ConversionFunnel({ stages }: { stages: FunnelStats["stages"] }) {
    const maxCount = Math.max(...stages.map((s) => s.count), 1);

    // Calculate overall conversion rate (replied / outreach sent)
    const outreachSent = stages[1]?.count || 0;
    const replied = stages[stages.length - 1]?.count || 0;
    const overallConversion = outreachSent > 0 ? (replied / outreachSent) * 100 : 0;

    // Labels for what each percentage means
    const percentageLabels = [
        "",  // Leads Added - base, no percentage
        "OF LEADS",  // Outreach Sent
        "OF LEADS",  // Connection Requests
        "OF REQUESTS",  // Connections Accepted
        "REPLY RATE",  // Replied
    ];

    return (
        <div className="funnel">
            <div className="funnel__header">
                <h3 className="section-title">CONVERSION FUNNEL</h3>
                {outreachSent > 0 && (
                    <div className="funnel__summary">
                        <span className="funnel__summary-value">{formatPercent(overallConversion)}</span>
                        <span className="funnel__summary-label">OVERALL REPLY RATE</span>
                    </div>
                )}
            </div>
            <div className="funnel__stages">
                {stages.map((stage, i) => {
                    const widthPercent = (stage.count / maxCount) * 100;
                    return (
                        <div key={stage.name} className="funnel__stage">
                            <div className="funnel__stage-header">
                                <span className="funnel__stage-name">{stage.name}</span>
                                <span className="funnel__stage-count">{formatNumber(stage.count)}</span>
                            </div>
                            <div className="funnel__bar-container">
                                <div
                                    className={`funnel__bar ${i === stages.length - 1 ? "funnel__bar--highlight" : ""}`}
                                    style={{ width: `${Math.max(widthPercent, 2)}%` }}
                                />
                            </div>
                            {i > 0 && (
                                <div className={`funnel__stage-rate ${stage.percentage > 0 ? "" : "funnel__stage-rate--zero"}`}>
                                    {formatPercent(stage.percentage)} {percentageLabels[i] || ""}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}


function DailyChart({
    data,
    metric,
    label,
    days
}: {
    data: DailyMetrics[];
    metric: keyof DailyMetrics;
    label: string;
    days: number;
}) {
    // For 30+ days, aggregate into weeks to avoid overcrowding
    const shouldAggregate = days > 14;

    type ChartDataPoint = { label: string; value: number; tooltip: string };

    let chartData: ChartDataPoint[];

    if (shouldAggregate) {
        // Group data into weeks
        const weeklyData: ChartDataPoint[] = [];
        const chunkSize = 7;

        for (let i = 0; i < data.length; i += chunkSize) {
            const week = data.slice(i, i + chunkSize);
            const weekSum = week.reduce((sum, d) => sum + (d[metric] as number), 0);
            const startDate = new Date(week[0].date);
            const endDate = new Date(week[week.length - 1].date);

            const weekLabel = startDate.toLocaleDateString("en", { month: "short", day: "numeric" });
            const tooltip = `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}: ${weekSum}`;

            weeklyData.push({
                label: weekLabel,
                value: weekSum,
                tooltip,
            });
        }
        chartData = weeklyData;
    } else {
        // Show daily data for 7-14 day ranges
        chartData = data.map((d) => {
            const date = new Date(d.date);
            return {
                label: date.toLocaleDateString("en", { weekday: "short" }),
                value: d[metric] as number,
                tooltip: `${d.date}: ${d[metric]}`,
            };
        });
    }

    const values = chartData.map((d) => d.value);
    const maxValue = Math.max(...values, 1);
    const total = values.reduce((sum, v) => sum + v, 0);

    return (
        <div className="daily-chart">
            <div className="daily-chart__header">
                <h4 className="daily-chart__title">{label}</h4>
                <span className="daily-chart__total">{total} TOTAL</span>
            </div>
            <div className="daily-chart__bars">
                {chartData.map((d, i) => {
                    const height = (d.value / maxValue) * 100;
                    return (
                        <div key={i} className="daily-chart__bar-wrapper" title={d.tooltip}>
                            <div className="daily-chart__bar-value">{d.value > 0 ? d.value : ""}</div>
                            <div
                                className="daily-chart__bar"
                                style={{ height: `${Math.max(height, d.value > 0 ? 8 : 2)}%` }}
                            />
                            <div className="daily-chart__bar-label">{d.label}</div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}


export function AnalyticsDashboard({ analytics, dailyMetrics, funnel, days }: Props) {
    const router = useRouter();
    const searchParams = useSearchParams();

    const handleDaysChange = (newDays: number) => {
        const params = new URLSearchParams(searchParams?.toString() || "");
        params.set("days", String(newDays));
        router.push(`/analytics?${params.toString()}`);
    };

    // Calculate today's metrics (last item in dailyMetrics)
    const today = dailyMetrics[dailyMetrics.length - 1];
    const todayMessages = today?.messagesSent || 0;
    const todayReplies = today?.replies || 0;

    return (
        <div className="analytics-dashboard">
            {/* Time Period Selector */}
            <div className="period-selector">
                {[7, 30, 90].map((d) => (
                    <button
                        key={d}
                        className={`period-btn ${days === d ? "period-btn--active" : ""}`}
                        onClick={() => handleDaysChange(d)}
                    >
                        {d} DAYS
                    </button>
                ))}
            </div>

            {/* Key Metrics Grid */}
            <div className="metrics-grid">
                <MetricCard
                    label="TOTAL LEADS"
                    value={formatNumber(analytics.totalLeads)}
                    subtext={`${formatNumber(analytics.statusCounts["NEW"] || 0)} PENDING`}
                />
                <MetricCard
                    label="MESSAGES SENT"
                    value={formatNumber(analytics.messagesSent)}
                    subtext={`+${todayMessages} TODAY`}
                />
                <MetricCard
                    label="REPLIES RECEIVED"
                    value={formatNumber(analytics.repliesReceived)}
                    subtext={`+${todayReplies} TODAY`}
                />
                <MetricCard
                    label="RESPONSE RATE"
                    value={formatPercent(analytics.messageResponseRate)}
                    highlight={analytics.messageResponseRate > 10}
                />
            </div>

            {/* Secondary Metrics */}
            <div className="metrics-grid metrics-grid--secondary">
                <MetricCard
                    label="CONNECTION REQUESTS"
                    value={formatNumber(analytics.connectionRequestsSent)}
                />
                <MetricCard
                    label="CONNECTIONS ACCEPTED"
                    value={formatNumber(analytics.connectionsAccepted)}
                    subtext={formatPercent(analytics.connectionAcceptanceRate) + " ACCEPT RATE"}
                />
                <MetricCard
                    label="FOLLOW-UPS SENT"
                    value={formatNumber(analytics.followupsSent)}
                />
                <MetricCard
                    label="RESPONSE FOLLOW-UPS"
                    value={formatNumber(analytics.followupReplies)}
                />
            </div>

            {/* Conversion Funnel */}
            <ConversionFunnel stages={funnel.stages} />

            {/* Daily Charts */}
            <div className="charts-section">
                <h3 className="section-title">
                    {days <= 14 ? `DAILY ACTIVITY (LAST ${days} DAYS)` : `WEEKLY ACTIVITY (LAST ${days} DAYS)`}
                </h3>
                <div className="charts-grid">
                    <DailyChart data={dailyMetrics} metric="messagesSent" label="MESSAGES SENT" days={days} />
                    <DailyChart data={dailyMetrics} metric="replies" label="REPLIES" days={days} />
                    <DailyChart data={dailyMetrics} metric="connectionsSent" label="CONNECTIONS SENT" days={days} />
                </div>
            </div>

            {/* Status Breakdown */}
            <div className="status-breakdown">
                <h3 className="section-title">LEAD STATUS BREAKDOWN</h3>
                <div className="status-grid">
                    {Object.entries(analytics.statusCounts)
                        .filter(([, count]) => count > 0)
                        .sort(([, a], [, b]) => b - a)
                        .map(([status, count]) => (
                            <div key={status} className="status-item">
                                <span className="status-badge">
                                    {status.replace(/_/g, " ")}
                                </span>
                                <span className="status-count">{formatNumber(count)}</span>
                            </div>
                        ))}
                </div>
            </div>
        </div>
    );
}
