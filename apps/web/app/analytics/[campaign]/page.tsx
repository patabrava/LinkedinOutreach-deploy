import type { CSSProperties } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireServerSession } from "../../../lib/auth";
import {
  CAMPAIGN_ANALYTICS_SCOPES,
  type CampaignAnalytics,
  type CampaignAnalyticsKind,
} from "../../../lib/campaignAnalytics";
import { fetchCampaignAnalytics } from "../../../lib/campaignAnalyticsServer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  params: { campaign: string };
  searchParams?: { days?: string };
};

const isCampaign = (value: string): value is CampaignAnalyticsKind =>
  value === "regular" || value === "sales-navigator";

const number = (value: number): string => value.toLocaleString("en-US");
const percent = (value: number): string => `${value.toFixed(1)}%`;

function Metric({ label, value, note, emphasis = false }: { label: string; value: string; note?: string; emphasis?: boolean }) {
  return (
    <div className={`campaign-metric${emphasis ? " campaign-metric--emphasis" : ""}`}>
      <span className="campaign-metric__label">{label}</span>
      <strong className="campaign-metric__value">{value}</strong>
      {note ? <span className="campaign-metric__note">{note}</span> : null}
    </div>
  );
}

function ActivityLedger({ analytics }: { analytics: CampaignAnalytics }) {
  const visible = analytics.dailyActivity.slice(-14);
  const maximum = Math.max(...visible.map((row) => row.invites + row.touches + row.replies), 1);

  return (
    <section className="campaign-panel campaign-activity" aria-labelledby="activity-heading">
      <div className="campaign-panel__heading">
        <div>
          <span className="campaign-kicker">Event ledger</span>
          <h2 id="activity-heading">RECORDED ACTIVITY</h2>
        </div>
        <span className="campaign-panel__aside">Last 14 active days</span>
      </div>
      {visible.length ? (
        <div className="campaign-activity__rows">
          {visible.map((row) => {
            const total = row.invites + row.touches + row.replies;
            return (
              <div className="campaign-activity__row" key={row.date}>
                <time dateTime={row.date}>{row.date.slice(5)}</time>
                <div className="campaign-activity__track" aria-hidden="true">
                  <span style={{ "--activity-scale": total / maximum } as CSSProperties} />
                </div>
                <div className="campaign-activity__counts">
                  <span>{row.invites} INV</span>
                  <span>{row.touches} MSG</span>
                  <strong>{row.replies} REP</strong>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="campaign-empty">
          <strong>NO RECORDED EVENTS IN THIS WINDOW</strong>
          <span>The campaign cohort remains visible above; activity appears only after a persisted event is written.</span>
        </div>
      )}
    </section>
  );
}

export default async function CampaignAnalyticsPage({ params, searchParams }: PageProps) {
  if (!isCampaign(params.campaign)) notFound();
  const campaign = params.campaign;
  await requireServerSession(`/analytics/${campaign}`);
  const parsedDays = Number(searchParams?.days || 30);
  const validDays = [7, 30, 90].includes(parsedDays) ? parsedDays : 30;
  const analytics = await fetchCampaignAnalytics(campaign, validDays);
  const scope = CAMPAIGN_ANALYTICS_SCOPES[campaign];

  return (
    <main className="page campaign-analytics">
      <div className="campaign-breadcrumbs">
        <Link href="/analytics">← ANALYTICS OVERVIEW</Link>
        <span aria-hidden="true">/</span>
        <span>{scope.shortTitle}</span>
      </div>

      <nav className="campaign-tabs" aria-label="Campaign analytics">
        {(Object.keys(CAMPAIGN_ANALYTICS_SCOPES) as CampaignAnalyticsKind[]).map((kind) => (
          <Link
            key={kind}
            href={`/analytics/${kind}?days=${validDays}`}
            className={kind === campaign ? "campaign-tab campaign-tab--active" : "campaign-tab"}
            aria-current={kind === campaign ? "page" : undefined}
          >
            {CAMPAIGN_ANALYTICS_SCOPES[kind].shortTitle}
          </Link>
        ))}
      </nav>

      <header className="campaign-hero">
        <div>
          <span className="campaign-kicker">{scope.eyebrow}</span>
          <h1>{scope.title}</h1>
          <p>{scope.description}</p>
        </div>
        <dl className="campaign-hero__facts">
          <div><dt>CHANNEL</dt><dd>{scope.channel}</dd></div>
          <div><dt>COHORT</dt><dd>Batches {scope.sequences.map((sequence) => sequence.batchId).join(" / ")}</dd></div>
          <div><dt>ACTIVITY WINDOW</dt><dd>{validDays} days · UTC</dd></div>
        </dl>
      </header>

      <div className="campaign-range" aria-label="Activity window">
        {[7, 30, 90].map((days) => (
          <Link
            key={days}
            href={`/analytics/${campaign}?days=${days}`}
            className={days === validDays ? "period-btn period-btn--active" : "period-btn"}
            aria-current={days === validDays ? "true" : undefined}
          >
            {days} DAYS
          </Link>
        ))}
      </div>

      <section className="campaign-metrics" aria-label="Campaign performance">
        <Metric label="Campaign leads" value={number(analytics.leadCount)} note="Exact batch cohort" />
        <Metric label="Invites sent" value={number(analytics.invitesSent)} note="Unique recorded leads" />
        <Metric label="First touches" value={number(analytics.firstTouchesSent)} note="Verified touch 1" />
        <Metric label="Replies" value={number(analytics.repliesReceived)} note="Unique recorded leads" />
        <Metric label="Reply rate" value={percent(analytics.responseRate)} note="Replies / first touches" emphasis />
      </section>

      <section className="campaign-panel" aria-labelledby="sequence-heading">
        <div className="campaign-panel__heading">
          <div>
            <span className="campaign-kicker">Campaign structure</span>
            <h2 id="sequence-heading">SEQUENCE PERFORMANCE</h2>
          </div>
          <span className="campaign-panel__aside">Exact batch × sequence × account scope</span>
        </div>
        <div className="campaign-table-wrap">
          <table className="campaign-table">
            <thead>
              <tr><th>SEQUENCE</th><th>BATCH</th><th>LEADS</th><th>INVITES</th><th>FIRST TOUCH</th><th>FOLLOW-UPS</th><th>REPLIES</th><th>REPLY RATE</th></tr>
            </thead>
            <tbody>
              {analytics.sequences.map((sequence) => (
                <tr key={sequence.key}>
                  <th scope="row">{sequence.label}</th>
                  <td>#{sequence.batchId}</td>
                  <td>{number(sequence.leadCount)}</td>
                  <td>{number(sequence.invitesSent)}</td>
                  <td>{number(sequence.firstTouchesSent)}</td>
                  <td>{number(sequence.followupTouchesSent)}</td>
                  <td>{number(sequence.repliesReceived)}</td>
                  <td><strong>{percent(sequence.responseRate)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="campaign-lower-grid">
        <ActivityLedger analytics={analytics} />
        <section className="campaign-panel" aria-labelledby="outcomes-heading">
          <div className="campaign-panel__heading">
            <div>
              <span className="campaign-kicker">Verified outcomes</span>
              <h2 id="outcomes-heading">OUTCOME LEDGER</h2>
            </div>
          </div>
          <dl className="campaign-outcomes">
            <div><dt>FOLLOW-UP TOUCHES</dt><dd>{number(analytics.followupTouchesSent)}</dd></div>
            <div><dt>HUMAN HANDOFFS</dt><dd>{number(analytics.humanHandoffs)}</dd></div>
            <div><dt>GUIDES SENT</dt><dd>{number(analytics.guidesSent)}</dd></div>
            <div><dt>BOOKING LINKS SENT</dt><dd>{number(analytics.bookingLinksSent)}</dd></div>
            <div><dt>APPOINTMENTS BOOKED</dt><dd>{number(analytics.appointmentsBooked)}</dd></div>
            <div><dt>APPOINTMENTS SHOWED</dt><dd>{number(analytics.appointmentsShowed)}</dd></div>
            <div><dt>SEQUENCES STOPPED</dt><dd>{number(analytics.sequenceStops)}</dd></div>
          </dl>
          <p className="campaign-ledger-note">Only persisted campaign events are shown. Booking and attendance outcomes require their own recorded events.</p>
        </section>
      </div>

      <section className="campaign-panel" aria-labelledby="status-heading">
        <div className="campaign-panel__heading">
          <div>
            <span className="campaign-kicker">Current cohort state</span>
            <h2 id="status-heading">LEAD STATUS</h2>
          </div>
        </div>
        <div className="campaign-statuses">
          {Object.entries(analytics.statusCounts).sort(([, a], [, b]) => b - a).map(([status, count]) => (
            <div key={status}><span>{status.replaceAll("_", " ")}</span><strong>{number(count)}</strong></div>
          ))}
        </div>
      </section>
    </main>
  );
}
