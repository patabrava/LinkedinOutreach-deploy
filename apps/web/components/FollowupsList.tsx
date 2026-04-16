"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowserClient } from "../lib/supabaseClient";
import type { FollowupRow } from "../app/actions";
import { approveFollowup, skipFollowup, generateFollowupDraft, generateAllFollowupDrafts, approveAndSendAllFollowups, triggerFollowupSender, stopFollowups, retryFollowup } from "../app/actions";

type Props = {
  initial: FollowupRow[];
};

const formatDate = (iso?: string | null) => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
};

const statusClasses: Record<string, string> = {
  PENDING_REVIEW: "status-draft",
  APPROVED: "status-approved",
  PROCESSING: "status-processing",
  SENT: "status-sent",
  SKIPPED: "status-pending",
  FAILED: "status-rejected",
  RETRY_LATER: "status-draft",
};

const typeClasses: Record<string, { className: string; label: string }> = {
  REPLY: { className: "status-approved", label: "REPLY" },
  NUDGE: { className: "status-draft", label: "NUDGE" },
};

export default function FollowupsList({ initial }: Props) {
  const [rows, setRows] = useState<FollowupRow[]>(() => initial || []);
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [genPending, setGenPending] = useState(false);
  const [genMessage, setGenMessage] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);

  useEffect(() => {
    setRows(initial || []);
  }, [initial]);

  useEffect(() => {
    // Client-side hydration fetch to recover if server fetch returned empty (e.g., env/config issue)
    (async () => {
      try {
        const supabase = supabaseBrowserClient();
        const { data, error } = await supabase
          .from("followups")
          .select("*, lead:leads(id, first_name, last_name, company_name, linkedin_url, last_reply_at, followup_count, profile_data)")
          .in("status", ["PENDING_REVIEW", "APPROVED"])
          .order("updated_at", { ascending: false })
          .limit(100);
        if (error) {
          console.warn("Followups client fetch error", error);
          return;
        }
        if (data && data.length) {
          setRows(data as any);
        }
      } catch (err) {
        console.warn("Followups client fetch failed", err);
      }
    })();
  }, []);

  useEffect(() => {
    const supabase = supabaseBrowserClient();
    const channel = supabase
      .channel("followups-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "followups" },
        (payload) => {
          const updated = (payload.new || payload.old) as FollowupRow | null;
          if (!updated) return;
          setRows((curr) => {
            const idx = curr.findIndex((r) => r.id === updated.id);
            let next = [...curr];
            if (payload.eventType === "DELETE") {
              if (idx !== -1) next.splice(idx, 1);
            } else {
              if (idx === -1) next.unshift(updated as any);
              else next[idx] = { ...(next[idx] as any), ...(updated as any) };
            }
            return next;
          });
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const at = new Date(a.reply_timestamp || a.created_at || "").getTime();
        const bt = new Date(b.reply_timestamp || b.created_at || "").getTime();
        return bt - at;
      }),
    [rows]
  );
  const pending = useMemo(() => rows.filter((r) => r.status === "PENDING_REVIEW"), [rows]);
  const approved = useMemo(() => rows.filter((r) => r.status === "APPROVED"), [rows]);
  const replies = useMemo(() => rows.filter((r) => r.followup_type === "REPLY" || !r.followup_type), [rows]);
  const nudges = useMemo(() => rows.filter((r) => r.followup_type === "NUDGE"), [rows]);

  const onApprove = async (row: FollowupRow) => {
    const id = row.id;
    const text = draftEdits[id] ?? row.draft_text ?? "";
    if (!text.trim()) {
      alert("Please enter a draft message before approving.");
      return;
    }
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await approveFollowup(id, text);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const onSkip = async (row: FollowupRow) => {
    const id = row.id;
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await skipFollowup(id);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const onGenerateDraft = async (row: FollowupRow) => {
    const id = row.id;
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const result = await generateFollowupDraft(id);
      if (result.success && result.draft) {
        setDraftEdits((m) => ({ ...m, [id]: result.draft! }));
      } else {
        alert(result.error || "Failed to generate draft");
      }
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const onStopFollowups = async (row: FollowupRow) => {
    if (!confirm("Stop all followups for this lead?")) return;
    const leadId = row.lead_id;
    setBusy((b) => ({ ...b, [row.id]: true }));
    try {
      await stopFollowups(leadId);
    } finally {
      setBusy((b) => ({ ...b, [row.id]: false }));
    }
  };

  const onRetry = async (row: FollowupRow) => {
    const id = row.id;
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await retryFollowup(id);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const onGenerateAllDrafts = async () => {
    setGenMessage(null);
    setGenPending(true);
    try {
      const result = await generateAllFollowupDrafts();
      if (result.total === 0) {
        setGenMessage("No followups need draft generation.");
      } else if (result.failed === 0) {
        setGenMessage(`Successfully generated ${result.generated} draft${result.generated === 1 ? "" : "s"}.`);
      } else {
        setGenMessage(`Generated ${result.generated}/${result.total} drafts. ${result.failed} failed.`);
      }
    } catch (err: any) {
      setGenMessage(err?.message || "Failed to generate drafts.");
    } finally {
      setGenPending(false);
    }
  };

  const onBulkApproveAndSend = async () => {
    const readyCount = pending.filter(r => r.draft_text).length;
    if (readyCount === 0) {
      alert("No pending followups have drafts to approve.");
      return;
    }
    if (!confirm(`Approve and send ${readyCount} drafts?`)) return;

    setBulkMessage(null);
    setBulkPending(true);
    try {
      const res = await approveAndSendAllFollowups();
      setBulkMessage(`Approved ${res.approved} drafts. ${res.triggered ? "Sender triggered." : ""}`);
    } catch (err: any) {
      setBulkMessage(err.message || "Failed to bulk approve.");
    } finally {
      setBulkPending(false);
    }
  };

  const onSendApproved = async () => {
    setBulkMessage(null);
    setBulkPending(true);
    try {
      await triggerFollowupSender();
      setBulkMessage("Sender triggered for approved followups.");
    } catch (err: any) {
      setBulkMessage(err.message || "Failed to trigger sender.");
    } finally {
      setBulkPending(false);
    }
  };

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
        <div>
          <div className="pill">Follow-ups</div>
          <h3 className="section-title-tight">FOLLOW-UPS NEEDING REVIEW</h3>
          <div className="muted">Review replies and nudge opportunities, then draft and send your response.</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end" }}>
          <div className="muted" style={{ textAlign: "right" }}>
            <div>PENDING: {pending.length} • APPROVED: {approved.length}</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>
              REPLIES: {replies.length} • NUDGES: {nudges.length}
            </div>
          </div>
          <div style={{ display: "flex", gap: 0, alignItems: "center" }}>
            <button
              className="btn warn"
              onClick={onBulkApproveAndSend}
              disabled={bulkPending || pending.filter(r => r.draft_text).length === 0}
            >
              {bulkPending ? "SENDING…" : "APPROVE & SEND ALL"}
            </button>
            <button
              className="btn secondary"
              onClick={onSendApproved}
              disabled={bulkPending}
            >
              SEND APPROVED
            </button>
            <button
              className="btn"
              onClick={onGenerateAllDrafts}
              disabled={genPending || pending.length === 0}
            >
              {genPending ? "GENERATING…" : "GENERATE DRAFTS"}
            </button>
          </div>
          {(genMessage || bulkMessage) && (
            <span className="muted" style={{ fontSize: 12 }} aria-live="polite">
              {genMessage || bulkMessage}
            </span>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="muted" style={{ marginTop: 16 }}>
          No follow-ups yet.
        </div>
      ) : (
        <div
          className="table-wrapper"
          style={{
            marginTop: 16,
            maxHeight: 520,
            overflowY: "auto",
          }}
        >
          <table className="lead-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th scope="col">LEAD</th>
                <th scope="col">TYPE</th>
                <th scope="col">MESSAGE</th>
                <th scope="col">STATUS</th>
                <th scope="col">DRAFT</th>
                <th scope="col" style={{ width: 180 }}>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const lead = row.lead || ({} as any);
                const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unknown";
                const company = lead.company_name || "";
                const link = lead.linkedin_url || "";
                const draft = draftEdits[row.id] ?? row.draft_text ?? "";
                const statusKey = (row.status || "").toUpperCase();
                const statusClass = statusClasses[statusKey] || "status-new";
                const followupTypeKey = (row.followup_type || "REPLY").toUpperCase();
                const typeInfo = typeClasses[followupTypeKey] || typeClasses.REPLY;

                return (
                  <tr key={row.id}>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 180 }}>
                        <strong>{name}</strong>
                        <span className="muted">{company || "Company N/A"}</span>
                        {link ? (
                          <a className="muted" href={link} target="_blank" rel="noreferrer" style={{ fontSize: 11, wordBreak: "break-all" }}>
                            {link.replace("https://www.linkedin.com/in/", "").slice(0, 25)}...
                          </a>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <span className={`status-chip ${typeInfo.className}`} style={{ minWidth: 60, textAlign: "center" }}>
                        {typeInfo.label}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 320 }}>
                        <div className="pill" style={{ width: "fit-content" }}>
                          {formatDate(row.reply_timestamp)}
                        </div>
                        {/* Show last message with sender badge */}
                        {row.last_message_text ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <span className="status-chip" style={{ fontSize: 10, padding: "2px 6px", width: "fit-content" }}>
                              {row.last_message_from === "lead" ? name : "YOU"}
                            </span>
                            <div style={{ lineHeight: 1.5, fontSize: 12 }}>
                              {row.last_message_text.length > 150
                                ? `${row.last_message_text.slice(0, 150)}...`
                                : row.last_message_text}
                            </div>
                          </div>
                        ) : (
                          <div style={{ lineHeight: 1.5, fontSize: 12 }}>
                            {followupTypeKey === "NUDGE"
                              ? <span className="muted" style={{ fontStyle: "italic" }}>No reply yet - consider a follow-up</span>
                              : (row.reply_snippet || "—")
                            }
                          </div>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`status-chip ${statusClass}`} style={{ minWidth: 110, textAlign: "center" }}>
                        {row.status.replace(/_/g, " ")}
                      </span>
                      <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
                        ATTEMPT {row.attempt || 1}
                      </div>
                      {row.last_error && (
                        <div className="muted" style={{ marginTop: 4, fontSize: 10, color: "var(--accent)", maxWidth: 140 }}>
                          {row.last_error.length > 60 ? `${row.last_error.slice(0, 60)}...` : row.last_error}
                        </div>
                      )}
                      {row.next_send_at && (
                        <div className="muted" style={{ marginTop: 4, fontSize: 10 }}>
                          NEXT: {formatDate(row.next_send_at)}
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <textarea
                          className="textarea"
                          value={draft}
                          onChange={(e) => setDraftEdits((m) => ({ ...m, [row.id]: e.target.value }))}
                          placeholder="Enter follow-up message..."
                          rows={4}
                          style={{ width: 320, minHeight: 80 }}
                        />
                        <div className="muted" style={{ fontSize: 10 }}>
                          {draft.length}/300 CHARS
                        </div>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {row.status === "PENDING_REVIEW" && (
                          <>
                            <button
                              className="btn"
                              disabled={busy[row.id]}
                              onClick={() => onGenerateDraft(row)}
                              style={{ fontSize: 11, padding: "8px 12px" }}
                            >
                              {busy[row.id] ? "GENERATING…" : "DRAFT WITH AI"}
                            </button>
                            <button className="btn" disabled={busy[row.id]} onClick={() => onApprove(row)}>
                              {busy[row.id] ? "SENDING…" : "APPROVE & SEND"}
                            </button>
                            <button className="btn secondary" disabled={busy[row.id]} onClick={() => onSkip(row)}>
                              SKIP
                            </button>
                          </>
                        )}
                        {row.status === "APPROVED" && (
                          <>
                            <button className="btn" disabled={busy[row.id]} onClick={() => onApprove(row)}>
                              {busy[row.id] ? "SENDING…" : "SEND NOW"}
                            </button>
                            <button className="btn secondary" disabled={busy[row.id]} onClick={() => onSkip(row)}>
                              CANCEL
                            </button>
                          </>
                        )}
                        {(row.status === "FAILED" || row.status === "RETRY_LATER") && (
                          <>
                            <button className="btn" disabled={busy[row.id]} onClick={() => onRetry(row)}>
                              {busy[row.id] ? "RETRYING…" : "RETRY"}
                            </button>
                            <button className="btn secondary" disabled={busy[row.id]} onClick={() => onStopFollowups(row)}>
                              STOP
                            </button>
                          </>
                        )}
                        {row.status === "PROCESSING" && (
                          <span className="muted" style={{ fontSize: 11 }}>PROCESSING…</span>
                        )}
                        {(row.status === "SENT" || row.status === "SKIPPED") && (
                          <span className="muted" style={{ fontSize: 11 }}>COMPLETED</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
