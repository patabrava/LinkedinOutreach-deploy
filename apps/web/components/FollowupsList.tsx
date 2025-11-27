"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowserClient } from "../lib/supabaseClient";
import type { FollowupRow } from "../app/actions";
import { approveFollowup, skipFollowup } from "../app/actions";

type Props = {
  initial: FollowupRow[];
};

const formatDate = (iso?: string | null) => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US");
};

const statusStyle: Record<string, { bg: string; color: string }> = {
  PENDING_REVIEW: { bg: "rgba(245, 158, 11, 0.16)", color: "#fcd34d" },
  APPROVED: { bg: "rgba(52, 211, 153, 0.18)", color: "#a7f3d0" },
  SENT: { bg: "rgba(79, 70, 229, 0.18)", color: "#c7d2fe" },
  SKIPPED: { bg: "rgba(148, 163, 184, 0.16)", color: "#cbd5e1" },
};

export default function FollowupsList({ initial }: Props) {
  const [rows, setRows] = useState<FollowupRow[]>(() => initial || []);
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setRows(initial || []);
  }, [initial]);

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

  const onApprove = async (row: FollowupRow) => {
    const id = row.id;
    const text = draftEdits[id] ?? row.draft_text ?? row.reply_snippet ?? "";
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

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div className="pill">Follow-ups</div>
          <h3 style={{ margin: "10px 0 6px 0" }}>Replies needing review</h3>
          <div className="muted">Draft, approve, and send the next touchpoint.</div>
        </div>
        <div className="muted">
          Pending: {pending.length} • Approved: {approved.length}
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
                <th>Reply</th>
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
                const draft = draftEdits[row.id] ?? row.draft_text ?? row.reply_snippet ?? "";
                const statusKey = (row.status || "").toUpperCase();
                const style = statusStyle[statusKey] || { bg: "rgba(255,255,255,0.1)", color: "#cbd5e1" };

                return (
                  <tr key={row.id}>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200 }}>
                        <strong>{name}</strong>
                        <span className="muted">{company || "Company N/A"}</span>
                        {link ? (
                          <a className="muted" href={link} target="_blank" rel="noreferrer">
                            {link}
                          </a>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 380 }}>
                        <div className="pill" style={{ background: "rgba(255,255,255,0.06)", color: "#cbd5e1", width: "fit-content" }}>
                          {formatDate(row.reply_timestamp)}
                        </div>
                        <div style={{ lineHeight: 1.5 }}>{row.reply_snippet || "—"}</div>
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
                    </td>
                    <td>
                      <textarea
                        className="textarea"
                        value={draft}
                        onChange={(e) => setDraftEdits((m) => ({ ...m, [row.id]: e.target.value }))}
                        placeholder="Edit follow-up draft..."
                        rows={4}
                        style={{ width: 380 }}
                      />
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <button className="btn" disabled={busy[row.id]} onClick={() => onApprove(row)}>
                          {busy[row.id] ? "Sending..." : "Approve & Send"}
                        </button>
                        <button className="btn secondary" disabled={busy[row.id]} onClick={() => onSkip(row)}>
                          Skip
                        </button>
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
