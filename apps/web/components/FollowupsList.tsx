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

const statusStyle: Record<string, { bg: string; color: string }> = {
  PENDING_REVIEW: { bg: "rgba(245, 158, 11, 0.16)", color: "#fcd34d" },
  APPROVED: { bg: "rgba(52, 211, 153, 0.18)", color: "#a7f3d0" },
  PROCESSING: { bg: "rgba(59, 130, 246, 0.18)", color: "#93c5fd" },
  SENT: { bg: "rgba(79, 70, 229, 0.18)", color: "#c7d2fe" },
  SKIPPED: { bg: "rgba(148, 163, 184, 0.16)", color: "#cbd5e1" },
  FAILED: { bg: "rgba(239, 68, 68, 0.18)", color: "#fca5a5" },
  RETRY_LATER: { bg: "rgba(251, 146, 60, 0.18)", color: "#fdba74" },
};

const typeStyle: Record<string, { bg: string; color: string; label: string }> = {
  REPLY: { bg: "rgba(34, 197, 94, 0.18)", color: "#86efac", label: "Reply" },
  NUDGE: { bg: "rgba(168, 85, 247, 0.18)", color: "#d8b4fe", label: "Nudge" },
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="pill">Follow-ups</div>
          <h3 style={{ margin: "10px 0 6px 0" }}>Follow-ups needing review</h3>
          <div className="muted">Review replies and nudge opportunities, then draft and send your response.</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
          <div className="muted" style={{ textAlign: "right" }}>
            <div>Pending: {pending.length} • Approved: {approved.length}</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>
              Replies: {replies.length} • Nudges: {nudges.length}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="btn warn"
              onClick={onBulkApproveAndSend}
              disabled={bulkPending || pending.filter(r => r.draft_text).length === 0}
            >
              {bulkPending ? "Sending..." : "Approve & Send All"}
            </button>
            <button
              className="btn secondary"
              onClick={onSendApproved}
              disabled={bulkPending}
            >
              Send Approved
            </button>
            <button
              className="btn"
              onClick={onGenerateAllDrafts}
              disabled={genPending || pending.length === 0}
              style={{
                background: "linear-gradient(135deg, #8b5cf6, #6366f1)",
                minWidth: 140,
              }}
            >
              {genPending ? "Generating..." : "Generate Drafts"}
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
        <div className="muted" style={{ marginTop: 12 }}>
          No follow-ups yet.
        </div>
      ) : (
        <div
          className="table-wrapper"
          style={{
            marginTop: 12,
            maxHeight: 520,
            overflowY: "auto",
            borderRadius: 12,
          }}
        >
          <table className="lead-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>Lead</th>
                <th>Type</th>
                <th>Message</th>
                <th>Status</th>
                <th>Draft</th>
                <th style={{ width: 160 }}>Actions</th>
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
                const style = statusStyle[statusKey] || { bg: "rgba(255,255,255,0.1)", color: "#cbd5e1" };
                const followupTypeKey = (row.followup_type || "REPLY").toUpperCase();
                const typeInfo = typeStyle[followupTypeKey] || typeStyle.REPLY;

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
                      <span
                        className="status-chip"
                        style={{ background: typeInfo.bg, color: typeInfo.color, minWidth: 60, textAlign: "center" }}
                      >
                        {typeInfo.label}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 320 }}>
                        <div className="pill" style={{ background: "rgba(255,255,255,0.06)", color: "#cbd5e1", width: "fit-content" }}>
                          {formatDate(row.reply_timestamp)}
                        </div>
                        <div style={{ lineHeight: 1.5, fontSize: 13 }}>
                          {followupTypeKey === "NUDGE"
                            ? <span className="muted" style={{ fontStyle: "italic" }}>No reply yet - consider a follow-up</span>
                            : (row.reply_snippet || "—")
                          }
                        </div>
                      </div>
                    </td>
                    <td>
                      <span
                        className="status-chip"
                        style={{ background: style.bg, color: style.color, minWidth: 110, textAlign: "center" }}
                      >
                        {row.status.replace(/_/g, " ")}
                      </span>
                      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                        Attempt {row.attempt || 1}
                      </div>
                      {row.last_error && (
                        <div className="muted" style={{ marginTop: 4, fontSize: 11, color: "#fca5a5", maxWidth: 140 }}>
                          {row.last_error.slice(0, 60)}...
                        </div>
                      )}
                      {row.next_send_at && (
                        <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>
                          Next: {formatDate(row.next_send_at)}
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
                          style={{ width: 340 }}
                        />
                        <div className="muted" style={{ fontSize: 11 }}>
                          {draft.length}/300 chars
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
                              style={{ background: "linear-gradient(135deg, #8b5cf6, #6366f1)", fontSize: 12 }}
                            >
                              {busy[row.id] ? "Generating..." : "Draft with AI"}
                            </button>
                            <button className="btn" disabled={busy[row.id]} onClick={() => onApprove(row)}>
                              {busy[row.id] ? "Sending..." : "Approve & Send"}
                            </button>
                            <button className="btn secondary" disabled={busy[row.id]} onClick={() => onSkip(row)}>
                              Skip
                            </button>
                          </>
                        )}
                        {row.status === "APPROVED" && (
                          <>
                            <button className="btn" disabled={busy[row.id]} onClick={() => onApprove(row)}>
                              {busy[row.id] ? "Sending..." : "Send Now"}
                            </button>
                            <button className="btn secondary" disabled={busy[row.id]} onClick={() => onSkip(row)}>
                              Cancel
                            </button>
                          </>
                        )}
                        {(row.status === "FAILED" || row.status === "RETRY_LATER") && (
                          <>
                            <button className="btn" disabled={busy[row.id]} onClick={() => onRetry(row)}>
                              {busy[row.id] ? "Retrying..." : "Retry"}
                            </button>
                            <button className="btn secondary" disabled={busy[row.id]} onClick={() => onStopFollowups(row)}>
                              Stop
                            </button>
                          </>
                        )}
                        {row.status === "PROCESSING" && (
                          <span className="muted" style={{ fontSize: 12 }}>Processing...</span>
                        )}
                        {(row.status === "SENT" || row.status === "SKIPPED") && (
                          <span className="muted" style={{ fontSize: 12 }}>Completed</span>
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
