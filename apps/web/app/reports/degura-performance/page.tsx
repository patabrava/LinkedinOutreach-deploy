import type { Metadata } from "next";

import { getDeguraPerformanceReport } from "../../../lib/deguraPerformanceReport";

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

export default function DeguraPerformanceReportPage() {
  const report = getDeguraPerformanceReport();
  const maxCount = Math.max(...report.funnel.map((step) => step.count), 1);

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
            <strong>Follow-ups jetzt sauber tracken</strong>
            <p>
              Das operative Reporting trennt ab jetzt Anfragevolumen, Antworten und gesendete Follow-ups auf Tages-, Wochen- und Monatsbasis.
            </p>
          </aside>
        </div>
        <div className="report-source-row">
          <span>{report.campaignWindow}</span>
          <span>{report.sourceLabel}</span>
        </div>
      </header>

      <section className="report-kpi-grid" aria-label="Kernzahlen">
        {report.kpis.map((kpi) => (
          <article key={kpi.label} className={`report-kpi report-kpi--${kpi.accent || "default"}`}>
            <div className="metric-card__label">{kpi.label}</div>
            <div className="report-kpi__value">{kpi.value}</div>
            <div className="metric-card__subtext">{kpi.detail}</div>
          </article>
        ))}
      </section>

      <section className="report-section report-section--today">
        <div className="report-section__header">
          <div>
            <span className="pill status-sent">Heute</span>
            <h2 className="section-title">17. Juli: was wirklich passiert ist</h2>
          </div>
          <p>
            Der wichtigste Fix im Report: Follow-ups werden nach <strong>sent_at</strong> gezählt und nicht mehr nur als Reply-Follow-ups gelesen.
          </p>
        </div>
        <div className="report-today-grid">
          {report.todayMetrics.map((metric) => (
            <article key={metric.label} className={`report-today-card report-today-card--${metric.accent || "default"}`}>
              <div className="metric-card__label">{metric.label}</div>
              <strong>{metric.value}</strong>
              <p>{metric.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="report-section report-section--tracking">
        <div className="report-section__header">
          <div>
            <span className="pill">Wochen-Tracking</span>
            <h2 className="section-title">Wöchentlich steuerbar</h2>
          </div>
          <p>
            Diese Ansicht ist für operative Steuerung: Wo entsteht Volumen, wo entstehen Annahmen, und wann werden Follow-ups wirklich gesendet?
          </p>
        </div>
        <div className="report-period-grid">
          {report.weeklyTracking.map((period) => (
            <article key={period.label} className="report-period">
              <div className="report-period__header">
                <div>
                  <h3>{period.label}</h3>
                  <span>{period.range}</span>
                </div>
                <strong>{formatNumber(period.followupsSent)} Follow-ups</strong>
              </div>
              <div className="report-period__metrics">
                <span><strong>{formatNumber(period.connectionRequests)}</strong>Anfragen</span>
                <span><strong>{formatNumber(period.acceptedContacts)}</strong>Angenommen</span>
                <span><strong>{formatNumber(period.replySignals)}</strong>Reply-Signale</span>
                <span><strong>{formatNumber(period.positiveReplies)}</strong>Positiv</span>
                <span><strong>{formatNumber(period.nudgeFollowupsSent)}</strong>Nudges</span>
                <span><strong>{formatNumber(period.replyFollowupsSent)}</strong>Reply-FU</span>
              </div>
              <p>{period.note}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="report-section report-section--tracking">
        <div className="report-section__header">
          <div>
            <span className="pill">Monats-Tracking</span>
            <h2 className="section-title">Monatlich reportbar</h2>
          </div>
          <p>{report.planningAssumption}</p>
        </div>
        <div className="report-period-grid report-period-grid--monthly">
          {report.monthlyTracking.map((period) => (
            <article key={period.label} className="report-period">
              <div className="report-period__header">
                <div>
                  <h3>{period.label}</h3>
                  <span>{period.range}</span>
                </div>
                <strong>{formatRate(period.positiveReplies, period.readableReplies)} Positiv</strong>
              </div>
              <div className="report-period__metrics">
                <span><strong>{formatNumber(period.connectionRequests)}</strong>Anfragen</span>
                <span><strong>{formatNumber(period.firstMessages)}</strong>Nachrichten</span>
                <span><strong>{formatNumber(period.replySignals)}</strong>Reply-Signale</span>
                <span><strong>{formatNumber(period.followupsSent)}</strong>Follow-ups</span>
                <span><strong>{formatNumber(period.nudgeFollowupsSent)}</strong>Nudges</span>
                <span><strong>{formatNumber(period.replyFollowupsSent)}</strong>Reply-FU</span>
              </div>
              <p>{period.note}</p>
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
            Die Funnel-Ansicht bleibt bewusst kurz. Für Reporting-Entscheidungen sind die Follow-up- und Periodenblöcke wichtiger.
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
            <h2 className="section-title">Nur die Gespräche, die das Reporting erklären</h2>
          </div>
          <p>
            Einzelgespräche bleiben im Report, aber nur als Kontext für die Zahlen. Dennis Proll ist als Beispiel für vollständige Nurture-Abdeckung bewusst hervorgehoben.
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
