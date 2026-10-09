'use client';

import { useState } from 'react';
import { recipientsCsv, type CampaignConversationHighlight, type CampaignRecipient } from '../lib/campaignRecipients';

const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC' : 'Not recorded';
export default function CampaignRecipients({ rows, highlights, days, campaign }: { rows: CampaignRecipient[]; highlights: CampaignConversationHighlight[]; days: number; campaign: string }) {
  const [search, setSearch] = useState(''), [sender, setSender] = useState(''), [sequence, setSequence] = useState(''), [reply, setReply] = useState(''), [page, setPage] = useState(0);
  const filtered = rows.filter(row => `${row.name} ${row.company}`.toLowerCase().includes(search.toLowerCase()) && (!sender || row.sender === sender) && (!sequence || row.sequence === sequence) && (!reply || row.replyStatus === reply));
  const pages = Math.max(1, Math.ceil(filtered.length / 25)), current = Math.min(page, pages - 1);
  const change = (setter: (v: string) => void, value: string) => { setter(value); setPage(0); };
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([recipientsCsv(filtered)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${campaign}-recipients-${days}days.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Keep the object URL alive until the browser has started its download.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="campaign-panel campaign-recipients" aria-labelledby="recipients-heading">
    <div className="campaign-panel__heading"><div><span className="campaign-kicker">People contacted · {days} days</span><h2 id="recipients-heading">RECIPIENT TRACKING</h2></div><button type="button" onClick={exportCsv} disabled={!filtered.length}>Export CSV ({filtered.length})</button></div>
    <p className="campaign-ledger-note">People with an invitation or sent message in the selected UTC window. Expand a person to see all recorded sent messages, including earlier contacts. Sent records do not establish delivery or reading. Reply status reflects stored inbox evidence.</p>
    <section className="campaign-highlights" aria-labelledby="conversation-highlights-heading">
      <div className="campaign-highlights__heading">
        <div><span className="campaign-kicker">Replies recorded · {days} days · UTC</span><h3 id="conversation-highlights-heading">CONVERSATION HIGHLIGHTS</h3></div>
        <span>{highlights.length} {highlights.length === 1 ? 'reply record' : 'reply records'}</span>
      </div>
      <div className="campaign-highlights__sentiment" aria-label="Recorded reply sentiment totals">
        <div><strong>{highlights.filter(reply => reply.sentiment === 'positive').length}</strong><span>POSITIVE</span></div>
        <div><strong>{highlights.filter(reply => reply.sentiment === 'negative').length}</strong><span>NEGATIVE</span></div>
        <div><strong>{highlights.filter(reply => !reply.sentiment).length}</strong><span>NOT CLASSIFIED</span></div>
      </div>
      <p className="campaign-ledger-note">Sentiment and routing use stored classifications. Reply excerpts are shown as captured so you can review the conversation evidence behind campaign decisions. One person can have multiple reply records; the campaign reply KPI counts unique people.</p>
      {highlights.length ? <div className="campaign-highlights__list">{highlights.map(reply => <article className="campaign-highlight" key={reply.id}>
        <div className="campaign-highlight__topline">
          <div><h4>{reply.name}</h4><span>{[reply.company, reply.sequence, reply.sender].filter(Boolean).join(' · ')}</span></div>
          <div className={`campaign-highlight__sentiment campaign-highlight__sentiment--${reply.sentiment || 'unknown'}`}>{reply.sentiment || 'Not classified'}</div>
        </div>
        <blockquote>{reply.replyText || 'Reply text not recorded.'}</blockquote>
        <div className="campaign-highlight__meta"><time dateTime={reply.repliedAt}>{date(reply.repliedAt)}</time>
          {reply.sourceTouch !== null && <span>After {[null, 'first message', 'second message', 'third message'][reply.sourceTouch] || `message ${reply.sourceTouch}`}</span>}
          {reply.confidence !== null && <span>Classification confidence {Math.round(reply.confidence * 100)}%</span>}
          {reply.route && <span>Stored route: {reply.route.replaceAll('_', ' ')}</span>}
        </div>
      </article>)}</div> : <div className="campaign-empty"><strong>NO CAPTURED REPLIES IN THIS WINDOW</strong><span>Highlights appear when the campaign has a reply timestamp and captured inbox record in the selected period.</span></div>}
    </section>
    <div className="campaign-recipient-filters">
      <label>Find a person or company<input type="search" value={search} onChange={e => change(setSearch,e.target.value)} /></label>
      <label>Sender<select value={sender} onChange={e => change(setSender,e.target.value)}><option value="">All senders</option>{[...new Set(rows.map(r => r.sender))].sort().map(s => <option key={s}>{s}</option>)}</select></label>
      <label>Sequence<select value={sequence} onChange={e => change(setSequence,e.target.value)}><option value="">All sequences</option>{[...new Set(rows.map(r => r.sequence))].sort().map(s => <option key={s}>{s}</option>)}</select></label>
      <label>Reply status<select value={reply} onChange={e => change(setReply,e.target.value)}><option value="">All reply states</option>{['Replied','No reply recorded','Not checked since last contact'].map(s => <option key={s}>{s}</option>)}</select></label>
    </div>
    <p className="campaign-ledger-note" role="status">{filtered.length} {filtered.length === 1 ? 'person' : 'people'} · Page {current + 1} of {pages}</p>
    <div className="campaign-table-wrap" tabIndex={0} role="region" aria-label="Recipient tracking table"><table className="campaign-table"><thead><tr><th>PERSON / HISTORY</th><th>SENDER / SEQUENCE</th><th>INVITATION</th><th>FIRST MESSAGE</th><th>SECOND MESSAGE</th><th>THIRD MESSAGE</th><th>REPLY STATUS</th></tr></thead><tbody>
      {filtered.slice(current * 25,current * 25 + 25).map(row => <tr key={row.id}>
        <th scope="row"><details><summary>{row.name} <span>({row.messages.length} messages)</span></summary><p>{row.company}</p>{row.profileUrl && <a href={row.profileUrl} target="_blank" rel="noopener noreferrer">LinkedIn profile ↗</a>}
          <ol className="campaign-message-history">{row.messages.map(message => <li key={message.key}><strong>{message.label}</strong><div>{date(message.sentAt)}</div><p>{message.text || 'Text not recorded'}</p></li>)}</ol>
          {!row.messages.length && <p>No message send recorded. Invitation only.</p>}
          {row.replyAt && <div><strong>Latest recorded reply · {date(row.replyAt)}</strong><p className="campaign-message-text">{row.replyText || 'Reply text not recorded'}</p></div>}
        </details></th>
        <td>{row.sender}<br />{row.sequence}</td><td>{row.inviteAt ? date(row.inviteAt) : 'Not recorded'}</td>
        {[1,2,3].map(step => <td key={step}>{row.steps.includes(step) ? <>Sent<br />{date(row.messages.find(m => m.step === step)?.sentAt || null)}</> : 'Not recorded'}</td>)}
        <td><strong>{row.replyStatus}</strong><br />Inbox checked: {date(row.scannedAt)}</td>
      </tr>)}
      {!filtered.length && <tr><td colSpan={7}>No contacted people match this window and these filters.</td></tr>}
    </tbody></table></div>
    <div className="campaign-recipient-pagination"><button type="button" disabled={!current} onClick={() => setPage(current - 1)}>Previous</button><button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Next</button></div>
  </section>;
}
