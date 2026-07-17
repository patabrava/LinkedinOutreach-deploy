import type { Metadata } from "next";

import { getDeguraPerformanceReport } from "../../../lib/deguraPerformanceReport";

export const metadata: Metadata = {
  title: "Degura Outreach Performance",
  description: "Deutschsprachiger Performance-Report zur Degura LinkedIn-Outreach-Strecke.",
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
          <aside className="report-callout report-callout--red" aria-label="Zentrale Empfehlung">
            <div className="report-callout__label">Empfehlung</div>
            <strong>Volumen kontrolliert erhöhen</strong>
            <p>
              Mehr qualifizierte Kontakte, eine klarere Kontextzeile und wöchentliche Gesprächsauswertung. So wird aus den Reply-Signalen eine belastbare Marketingentscheidung.
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

      <section className="report-section report-section--funnel">
        <div className="report-section__header">
          <div>
            <span className="pill">Funnel</span>
            <h2 className="section-title">Vom Kontakt zur positiven Antwort</h2>
          </div>
          <p>
            Die Raten zeigen jeweils den relevanten Nenner. Antwortsignale kommen aus Lead-Status und Inbox-Erkennung; lesbare Reply-Snippets sind die Grundlage der qualitativen Gesprächsauswertung.
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

      <section className="report-section report-section--tracking">
        <div className="report-section__header">
          <div>
            <span className="pill">Wochen-Tracking</span>
            <h2 className="section-title">Wie sich Volumen und Antworten pro Woche entwickeln</h2>
          </div>
          <p>
            Die Wochenansicht trennt Anfragevolumen, angenommene Kontakte, erste Nachrichten, Reply-Signale und positive Gespräche. Dadurch wird sichtbar, ob ein schwacher Zeitraum an wenig Volumen, wenigen Annahmen oder an der Nachricht selbst liegt.
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
                <strong>{formatRate(period.replySignals, period.firstMessages)} Reply</strong>
              </div>
              <div className="report-period__metrics">
                <span><strong>{formatNumber(period.connectionRequests)}</strong>Anfragen</span>
                <span><strong>{formatNumber(period.acceptedContacts)}</strong>Angenommen</span>
                <span><strong>{formatNumber(period.firstMessages)}</strong>Nachrichten</span>
                <span><strong>{formatNumber(period.replySignals)}</strong>Reply-Signale</span>
                <span><strong>{formatNumber(period.positiveReplies)}</strong>Positiv</span>
                <span><strong>{formatNumber(period.followupsSent)}</strong>Follow-ups</span>
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
            <h2 className="section-title">Monatliche Steuerung für Reporting und Planung</h2>
          </div>
          <p>
            Die Monatsansicht ist die bessere Reporting-Ebene für Management und Budget: sie glättet LinkedIn-Wochenlimits, Annahmeverzug und nachgelagerte Follow-ups.
          </p>
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
                <span><strong>{formatNumber(period.acceptedContacts)}</strong>Angenommen</span>
                <span><strong>{formatNumber(period.firstMessages)}</strong>Nachrichten</span>
                <span><strong>{formatNumber(period.replySignals)}</strong>Reply-Signale</span>
                <span><strong>{formatNumber(period.readableReplies)}</strong>Lesbar</span>
                <span><strong>{formatNumber(period.positiveReplies)}</strong>Positiv</span>
              </div>
              <p>{period.note}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="report-section">
        <div className="report-section__header">
          <div>
            <span className="pill">Antwortanalyse</span>
            <h2 className="section-title">Was die Antworten wirklich zeigen</h2>
          </div>
          <p>
            Die Cluster verdichten echte Antwortmuster. Sie trennen Interesse, Rückfragen, Sprachhürden und Zielgruppenfehler, damit die nächste Kampagne nicht aus Einzelbeispielen abgeleitet wird.
          </p>
        </div>
        <div className="report-cluster-grid">
          {report.responseClusters.map((cluster) => (
            <article key={cluster.title} className="report-cluster">
              <div className="report-cluster__numbers">
                <span>{cluster.count} Antworten</span>
                <strong>{cluster.positive} positiv</strong>
              </div>
              <h3>{cluster.title}</h3>
              <p>{cluster.interpretation}</p>
              <div className="report-cluster__implication">{cluster.implication}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="report-section report-section--signals">
        <div className="report-section__header">
          <div>
            <span className="pill">Positive Signale</span>
            <h2 className="section-title">Welche Antworten weiterverfolgt werden sollten</h2>
          </div>
          <p>
            Die Beispiele sind bewusst verdichtet. Entscheidend ist nicht der einzelne Wortlaut, sondern das Muster für Marketing und Follow-up.
          </p>
        </div>
        <div className="report-signal-list">
          {report.positiveSignals.map((signal) => (
            <article key={signal.label} className="report-signal">
              <div className="status-chip status-approved">{signal.label}</div>
              <p className="report-signal__example">{signal.example}</p>
              <p><strong>Bedeutung:</strong> {signal.meaning}</p>
              <p><strong>Follow-up:</strong> {signal.followUp}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="report-section report-section--call-potential">
        <div className="report-section__header">
          <div>
            <span className="pill status-approved">Call-Potenzial</span>
            <h2 className="section-title">{report.callPotential.title}</h2>
          </div>
          <p>{report.callPotential.summary}</p>
        </div>
        <div className="report-call-grid">
          {report.callPotential.items.map((item) => (
            <article
              key={item.label}
              className={`report-call-card${item.emphasis ? " report-call-card--emphasis" : ""}`}
            >
              <div className="report-call-card__label">{item.label}</div>
              <div className="report-call-card__value">{item.value}</div>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
        <p className="report-call-note">{report.callPotential.note}</p>
      </section>

      <section className="report-section report-section--conversations">
        <div className="report-section__header">
          <div>
            <span className="pill status-sent">Gesprächsbeispiele</span>
            <h2 className="section-title">Welche Konversationen besonders wichtig sind</h2>
          </div>
          <p>
            Diese Fälle zeigen die Spannweite der Kampagne: harter Meeting-Intent, qualifizierte Unsicherheit, bestätigter Zuschuss, Kontextreibung und ein vollständiges Outbound-Nurture-Beispiel wie Dennis Proll.
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
              <div className="report-conversation__timeline">{conversation.timeline}</div>
              <div className="report-conversation__grid">
                <p><strong>Signal:</strong> {conversation.inbound}</p>
                <p><strong>Handling:</strong> {conversation.handling}</p>
                <p><strong>Warum wichtig:</strong> {conversation.whyItMatters}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="report-two-column">
        <article className="report-section">
          <span className="pill">Nachrichten-Learning</span>
          <h2 className="section-title">Was wir für die nächste Nachricht lernen</h2>
          <ul className="report-list">
            {report.copyLearnings.map((learning) => (
              <li key={learning}>{learning}</li>
            ))}
          </ul>
        </article>

        <article className="report-section report-section--cta">
          <span className="pill status-sent">Nächster Schritt</span>
          <h2 className="section-title">Warum mehr kontrolliertes Volumen nötig ist</h2>
          <p>
            Die bisherigen Antworten zeigen echtes Interesse, vor allem bei Personen, die ihre aktuelle bAV-Situation nicht genau einschätzen können, nach einem Arbeitgeberwechsel unsicher sind oder ihren bestehenden Zuschuss prüfen möchten.
          </p>
          <p>
            Der limitierende Faktor ist aktuell die verfügbare Kontaktmenge. Für die operative Planung rechnen wir konservativ mit etwa 50 Kontaktanfragen pro LinkedIn-Account und Woche.
          </p>
          <strong>Degura sollte den nächsten Test mit höherem, aber sauber begrenztem Volumen fahren.</strong>
        </article>
      </section>

      <section className="report-section">
        <div className="report-section__header">
          <div>
            <span className="pill">Volumenmodell</span>
            <h2 className="section-title">Konservativer Wochenplan</h2>
          </div>
          <p>{report.planningAssumption}</p>
        </div>
        <div className="report-volume-grid">
          {report.volumeScenarios.map((scenario) => (
            <article key={scenario.label} className="report-volume">
              <div className="report-volume__label">{scenario.label}</div>
              <div className="report-volume__value">{formatNumber(scenario.weeklyInvites)}</div>
              <div className="metric-card__subtext">Kontaktanfragen pro Woche</div>
              <p>{scenario.note}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="report-two-column">
        <article className="report-section">
          <span className="pill">Testplan</span>
          <h2 className="section-title">Empfohlene nächste Aktionen</h2>
          <ol className="report-list report-list--ordered">
            {report.nextActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ol>
        </article>

        <article className="report-section">
          <span className="pill">Methodik</span>
          <h2 className="section-title">Wie die Zahlen gelesen werden</h2>
          <ul className="report-list">
            {report.methodology.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      </section>
    </div>
  );
}
