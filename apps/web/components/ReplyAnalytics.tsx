import Link from 'next/link';
import type { ReplyAnalytics as ReplyReport } from '../lib/replyAnalytics';

const number = (value: number) => value.toLocaleString('en-US');
const date = (value: string | null) => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/Berlin' }) : 'Date not recorded';

export default function ReplyAnalytics({ report, days, scoped = false }: { report: ReplyReport; days: number; scoped?: boolean }) {
  return (
    <section className="campaign-panel" aria-labelledby="reply-overview-heading">
      <div className="campaign-panel__heading">
        <div>
          <span className="campaign-kicker">{scoped ? 'This campaign · both senders' : 'All campaigns · current and historical'}</span>
          <h2 id="reply-overview-heading">REPLIES & OPEN WORK</h2>
        </div>
        <Link href="/followups">REVIEW REPLIES →</Link>
      </div>
      <div className="campaign-metrics">
        <div className="campaign-metric"><span className="campaign-metric__label">People who replied · all time</span><strong className="campaign-metric__value">{number(report.peopleReplied)}</strong><span className="campaign-metric__note">Unique contacts with captured inbound evidence</span></div>
        <div className="campaign-metric campaign-metric--emphasis"><span className="campaign-metric__label">Open replies · all dates</span><strong className="campaign-metric__value">{number(report.openReplies)}</strong><span className="campaign-metric__note">Unique contacts with an unresolved reply record</span></div>
        <div className="campaign-metric"><span className="campaign-metric__label">People who replied · {days} days</span><strong className="campaign-metric__value">{number(report.periodPeople)}</strong><span className="campaign-metric__note">Captured reply timestamp inside the UTC window</span></div>
      </div>
      <p className="campaign-ledger-note">All-time replies and open work remain visible when the activity window changes. Counts reconcile captured reply records, lead timestamps and reply events by contact and sender. A later recorded sent response closes older pending work. Inbox captures may be incomplete; these are stored records, not a fresh LinkedIn inbox scan.</p>
      <div className="campaign-table-wrap">
        <table className="campaign-table">
          <caption className="campaign-kicker">Reply totals by sender</caption>
          <thead><tr><th>SENDER</th><th>REPLIED · ALL TIME</th><th>OPEN · ALL DATES</th><th>REPLIED · {days} DAYS</th></tr></thead>
          <tbody>{report.accounts.map(row => <tr key={row.accountId}><th scope="row">{row.label}</th><td>{number(row.peopleReplied)}</td><td>{number(row.openReplies)}</td><td>{number(row.periodPeople)}</td></tr>)}</tbody>
          <tfoot><tr><th scope="row">TOTAL · ALL SENDERS</th><td>{number(report.peopleReplied)}</td><td>{number(report.openReplies)}</td><td>{number(report.periodPeople)}</td></tr></tfoot>
        </table>
      </div>
      <details>
        <summary>Reply totals by campaign and sender</summary>
        <div className="campaign-table-wrap">
          <table className="campaign-table">
            <thead><tr><th>CAMPAIGN</th><th>BATCH</th><th>SENDER</th><th>REPLIED · ALL TIME</th><th>OPEN · ALL DATES</th><th>REPLIED · {days} DAYS</th></tr></thead>
            <tbody>{report.campaigns.map(row => <tr key={`${row.batchId}:${row.sequenceId}:${row.sender}`}><th scope="row">{row.label}</th><td>{row.batchId === null ? 'Unassigned' : `#${row.batchId}`}</td><td>{row.sender}</td><td>{number(row.peopleReplied)}</td><td>{number(row.openReplies)}</td><td>{number(row.periodPeople)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
      <h3>OPEN REPLIES</h3>
      {report.openItems ? (
        report.openItems.length ? report.openItems.map(row => (
          <details key={row.id}>
            <summary>{row.name} · {row.campaign} · {row.sender} · {row.status.replaceAll('_', ' ')}</summary>
            <p className="campaign-ledger-note">Captured reply: {date(row.receivedAt)}{row.receivedAt ? ' · Berlin' : ''}</p>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.text || 'Reply text not recorded'}</p>
            <Link href="/followups">Open reply management →</Link>
          </details>
        )) : <p className="campaign-ledger-note">No unresolved reply records in this scope.</p>
      ) : <p className="campaign-ledger-note"><Link href="/login?next=%2Fanalytics">Sign in</Link> to view open reply names and captured text. Aggregate counts are shown above.</p>}
      {report.historyItems ? <details>
        <summary>All recorded replies · all time · {number(report.peopleReplied)} contacts</summary>
        {report.historyItems.map(person => <details key={person.leadId}>
          <summary>{person.name} · {person.campaign} · {person.sender} · {person.open ? 'Open reply' : 'No open reply record'}</summary>
          {person.messages.map(message => <div key={message.id}>
            <p className="campaign-ledger-note">Captured reply: {date(message.receivedAt)}{message.receivedAt ? ' · Berlin' : ''}</p>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.text || 'Reply text not recorded'}</p>
          </div>)}
        </details>)}
      </details> : null}
    </section>
  );
}
