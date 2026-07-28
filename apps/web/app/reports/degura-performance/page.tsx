import type { Metadata } from "next";
import Link from "next/link";

import { getDeguraPerformanceReport } from "../../../lib/deguraPerformanceReport";
import type { PeriodMetric, ReportKpi, TrackingMode } from "../../../lib/deguraPerformanceReport";

export const metadata: Metadata = {
  title: "Degura Outreach Performance",
  description: "Einfacher Performance-Report zur Degura LinkedIn-Outreach-Strecke.",
};

const numberFormatter = new Intl.NumberFormat("de-DE");

function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function formatRate(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0,0%";
  return `${((numerator / denominator) * 100).toFixed(1).replace(".", ",")}%`;
}

const trackingModeLabels: Record<TrackingMode, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

function normalizeTrackingMode(value: string | string[] | undefined): TrackingMode {
  const mode = Array.isArray(value) ? value[0] : value;

  if (mode === "weekly" || mode === "monthly") return mode;
  return "daily";
}

function buildPeriodKpis(period: PeriodMetric): ReportKpi[] {
  return [
    { label: "Kontaktanfragen", value: formatNumber(period.connectionRequests), detail: period.range },
    { label: "Angenommen", value: formatNumber(period.acceptedContacts), detail: "im gewählten Zeitraum", accent: "yellow" },
    { label: "Erste Nachrichten", value: formatNumber(period.firstMessages), detail: "nach Annahme gesendet" },
    { label: "Lesbare Replies", value: formatNumber(period.readableReplies), detail: `${formatNumber(period.replySignals)} Reply-Signale`, accent: "yellow" },
    {
      label: "Interessierte Replies",
      value: formatNumber(period.positiveReplies),
      detail: `${formatRate(period.positiveReplies, period.readableReplies)} der lesbaren Replies`,
      accent: "red",
    },
    { label: "Follow-ups", value: formatNumber(period.followupsSent), detail: "gesamt gesendet", accent: "red" },
    { label: "Nudges", value: formatNumber(period.nudgeFollowupsSent), detail: "zweite/dritte Sequenznachricht" },
    { label: "Reply-Follow-ups", value: formatNumber(period.replyFollowupsSent), detail: "Antworten nachgefasst" },
  ];
}

export default function DeguraPerformanceReportPage({
  searchParams,
}: {
  searchParams?: { period?: string | string[] };
}) {
  const report = getDeguraPerformanceReport();
  const maxCount = Math.max(...report.funnel.map((step) => step.count), 1);
  const selectedMode = normalizeTrackingMode(searchParams?.period);
  const selectedPeriod = report.periodFilters[selectedMode];
  const periodKpis = buildPeriodKpis(selectedPeriod);

  return (
    <div className="report-page">
      <header className="report-hero">
        <div className="report-hero__meta">
          <span className="pill">{report.hero.eyebrow}</span>
          <span className="pill">Snapshot: {report.snapshotAt}</span>
        </div>
        <div className="report-hero__grid">
          <div>
            <h1 className="report-title">{report.hero.title}</h1>
            <p className="report-summary">{report.hero.summary}</p>
          </div>
          <aside className="report-callout report-callout--red" aria-label="Zentrale Lesart">
            <div className="report-callout__label">Kurzfassung</div>
            <strong>20 Replies heute, 2 interessiert</strong>
            <p>
              Die separaten Daily- und Weekly-Blöcke sind raus. Die Hauptansicht wird direkt über Daily, Weekly oder Monthly gefiltert.
            </p>
          </aside>
        </div>
        <div className="report-source-row">
          <span>{report.campaignWindow}</span>
          <span>{report.sourceLabel}</span>
        </div>
      </header>

      <section className="report-section report-section--main-view">
        <div className="report-section__header">
          <div>
            <span className="pill">Hauptansicht</span>
            <h2 className="section-title">{selectedPeriod.label}</h2>
          </div>
          <p>{selectedPeriod.note}</p>
        </div>
        <div className="report-filter-tabs" aria-label="Tracking-Zeitraum">
          {(Object.keys(trackingModeLabels) as TrackingMode[]).map((mode) => (
            <Link
              key={mode}
              className={`report-filter-tab${selectedMode === mode ? " report-filter-tab--active" : ""}`}
              href={`?period=${mode}`}
              aria-current={selectedMode === mode ? "page" : undefined}
            >
              {trackingModeLabels[mode]}
            </Link>
          ))}
        </div>
        <div className="report-main-view__meta">
          <span>{selectedPeriod.range}</span>
          <strong>
            {formatNumber(selectedPeriod.positiveReplies)} interessiert / {formatNumber(selectedPeriod.readableReplies)} lesbare Replies
          </strong>
        </div>
        <div className="report-kpi-grid report-kpi-grid--period" aria-label={`${trackingModeLabels[selectedMode]} Kernzahlen`}>
          {periodKpis.map((kpi) => (
            <article key={kpi.label} className={`report-kpi report-kpi--${kpi.accent || "default"}`}>
              <div className="metric-card__label">{kpi.label}</div>
              <div className="report-kpi__value">{kpi.value}</div>
              <div className="metric-card__subtext">{kpi.detail}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="report-section report-section--totals">
        <div className="report-section__header">
          <div>
            <span className="pill">Gesamtstand</span>
            <h2 className="section-title">Bis 28. Juli</h2>
          </div>
          <p>{report.planningAssumption}</p>
        </div>
        <div className="report-kpi-grid" aria-label="Gesamtzahlen">
          {report.kpis.map((kpi) => (
            <article key={kpi.label} className={`report-kpi report-kpi--${kpi.accent || "default"}`}>
              <div className="metric-card__label">{kpi.label}</div>
              <div className="report-kpi__value">{kpi.value}</div>
              <div className="metric-card__subtext">{kpi.detail}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="report-section report-section--funnel">
        <div className="report-section__header">
          <div>
            <span className="pill">Funnel</span>
            <h2 className="section-title">Einfacher Funnel</h2>
          </div>
          <p>
            Die Funnel-Ansicht bleibt bewusst kurz. Für Reporting-Entscheidungen zählen vor allem interessierte Replies und gesendete Follow-ups.
          </p>
        </div>
        <div className="report-funnel">
          {report.funnel.map((step, index) => {
            const scale = Math.max(step.count / maxCount, 0.04);
            return (
              <article key={step.label} className="report-funnel__step">
                <div className="report-funnel__topline">
                  <span>{index + 1}. {step.label}</span>
                  <strong>{formatNumber(step.count)}</strong>
                </div>
                <div className="report-funnel__bar" aria-hidden="true">
                  <span style={{ ["--bar-scale" as string]: scale }} />
                </div>
                <div className="report-funnel__rate">{step.rateLabel}</div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="report-two-column">
        <article className="report-section">
          <span className="pill">Lesart</span>
          <h2 className="section-title">Was jetzt zählt</h2>
          <ul className="report-list">
            {report.keyLearnings.map((learning) => (
              <li key={learning}>{learning}</li>
            ))}
          </ul>
        </article>

        <article className="report-section">
          <span className="pill">Methodik</span>
          <h2 className="section-title">Wie gezählt wird</h2>
          <ul className="report-list">
            {report.methodology.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="report-section report-section--conversations">
        <div className="report-section__header">
          <div>
            <span className="pill status-sent">Beispiele</span>
            <h2 className="section-title">Replies mit echtem Interesse</h2>
          </div>
          <p>
            Nur positive, lesbare Reply-Signale. Zielgruppen-Mismatch und reine Nurture-Verläufe sind aus diesem Abschnitt entfernt.
          </p>
        </div>
        <div className="report-conversation-list">
          {report.conversationHighlights.map((conversation) => (
            <article
              key={`${conversation.name}-${conversation.category}`}
              className={`report-conversation${conversation.emphasis ? " report-conversation--emphasis" : ""}`}
            >
              <div className="report-conversation__topline">
                <div>
                  <h3>{conversation.name}</h3>
                  <span>{conversation.company}</span>
                </div>
                <strong>{conversation.category}</strong>
              </div>
              <p>{conversation.note}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
