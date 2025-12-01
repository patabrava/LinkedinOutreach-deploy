"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import { approveAndSendAllDrafts, approveDraft, fetchDraftFeed, regenerateDraft, rejectDraft, triggerDraftGeneration, sendLeadNow, sendAllApproved } from "../app/actions";
import { PROMPT_TYPE_LABELS } from "../lib/promptTypes";
import type { PromptType } from "../lib/promptTypes";
import { supabaseBrowserClient } from "../lib/supabaseClient";

export type DraftWithLead = {
  leadId: string;
  draftId?: number;
  opener: string;
  body: string;
  cta: string;
  finalMessage?: string;
  ctaType?: string;
  profile: Record<string, any>;
  activity: any[];
  name: string;
  headline: string;
  company?: string;
  linkedinUrl: string;
  regenerating?: boolean;
  status?: string;
  sentAt?: string | null;
};

type Props = {
  drafts: DraftWithLead[];
};

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

export function DraftFeed({ drafts }: Props) {
  const [localDrafts, setLocalDrafts] = useState<DraftWithLead[]>([]);
  const localDraftsRef = useRef<DraftWithLead[]>(drafts);
  const [loading, setLoading] = useState(true);
  const [genPending, setGenPending] = useState(false);
  const [genMessage, setGenMessage] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<Set<string>>(new Set());
  const [isPolling, setIsPolling] = useState(false);
  const [promptType, setPromptType] = useState<PromptType>(1);
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastDraftCountRef = useRef<number>(drafts.length || 0);
  const isPollingRef = useRef(false);
  const regeneratingRef = useRef(regenerating);

  const fetchDrafts = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setLoading(true);
    }
    try {
      const mapped = await fetchDraftFeed();
      const previousCount = lastDraftCountRef.current;
      lastDraftCountRef.current = mapped.length;

      const regenIds = new Set(regeneratingRef.current);
      const mappedIds = new Set(mapped.map((d) => d.leadId));
      // Any lead that returned in the mapped list is no longer regenerating
      mapped.forEach((d) => regenIds.delete(d.leadId));
      const prevMap = new Map(localDraftsRef.current.map((d) => [d.leadId, d]));

      const placeholders: DraftWithLead[] = [];
      regenIds.forEach((id) => {
        if (!mappedIds.has(id)) {
          const existing = prevMap.get(id);
          if (existing) {
            placeholders.push({ ...existing, regenerating: true });
          }
        }
      });

      const merged = [
        ...mapped.map((d) => (regenIds.has(d.leadId) ? { ...d, regenerating: true } : d)),
        ...placeholders,
      ];

      setRegenerating(regenIds);

      localDraftsRef.current = merged;
      setLocalDrafts(merged);

      if (isPollingRef.current && mapped.length > previousCount) {
        setGenMessage("New drafts are ready. Review them below.");
        isPollingRef.current = false;
        setIsPolling(false);
      }
    } catch (err) {
      console.error("Failed to fetch drafts:", err);
      if (isPollingRef.current) {
        setGenMessage("Unable to refresh drafts automatically. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch existing drafts on mount
  useEffect(() => {
    fetchDrafts(true);
  }, [fetchDrafts]);

  useEffect(() => {
    localDraftsRef.current = localDrafts;
  }, [localDrafts]);

  useEffect(() => {
    isPollingRef.current = isPolling;
  }, [isPolling]);

  useEffect(() => {
    regeneratingRef.current = regenerating;
  }, [regenerating]);

  useEffect(() => {
    if (!isPolling) {
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current);
        pollingTimeoutRef.current = null;
      }
      return;
    }

    fetchDrafts();
    const interval = setInterval(() => fetchDrafts(), POLL_INTERVAL_MS);

    pollingTimeoutRef.current = setTimeout(() => {
      if (isPollingRef.current) {
        setGenMessage((msg) => msg || "Stopped polling for new drafts. Refresh if you're expecting more.");
        isPollingRef.current = false;
        setIsPolling(false);
      }
    }, POLL_TIMEOUT_MS);

    return () => {
      clearInterval(interval);
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current);
        pollingTimeoutRef.current = null;
      }
    };
  }, [fetchDrafts, isPolling]);

  // Subscribe to real-time updates on leads/drafts table
  useEffect(() => {
    const supabase = supabaseBrowserClient();
    const channel = supabase
      .channel("draft-feed-updates")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "leads",
          filter: "status=eq.DRAFT_READY",
        },
        () => {
          fetchDrafts();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "leads",
          filter: "status=eq.APPROVED",
        },
        () => {
          fetchDrafts();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "leads",
          filter: "status=eq.SENT",
        },
        () => {
          fetchDrafts();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "drafts",
        },
        () => {
          fetchDrafts();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchDrafts]);

  useEffect(() => {
    return () => {
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current);
      }
    };
  }, []);

  const handleGenerateDrafts = async () => {
    setGenMessage(null);
    setGenPending(true);
    setIsPolling(true);
    try {
      await triggerDraftGeneration(promptType);
      lastDraftCountRef.current = localDraftsRef.current.length;
      const promptName = PROMPT_TYPE_LABELS[promptType];
      setGenMessage(`Draft generation started with "${promptName}" style. Drafts will appear here automatically.`);
    } catch (err: any) {
      setGenMessage(err?.message || "Failed to start draft generation.");
      setIsPolling(false);
    } finally {
      setGenPending(false);
    }
  };

  const isGenerating = genPending || isPolling;
  const disableBulkSend = bulkPending || isGenerating || !localDrafts.length;

  const handleSendAllApproved = async () => {
    setBulkMessage(null);
    setBulkPending(true);
    try {
      const result = await sendAllApproved();
      const msg = result?.senderTriggered
        ? "Triggered sender for approved leads."
        : "No approved leads to send.";
      setBulkMessage(msg);
    } catch (err: any) {
      setBulkMessage(err?.message || "Failed to trigger sending for approved leads.");
    } finally {
      setBulkPending(false);
      fetchDrafts(true);
    }
  };

  const handleRegenerateStart = (leadId: string) => {
    setGenMessage(null);
    setBulkMessage(null);
    setRegenerating((prev) => {
      const next = new Set(prev);
      next.add(leadId);
      return next;
    });
    setLocalDrafts((prev) => {
      const next = prev.map((d) => (d.leadId === leadId ? { ...d, regenerating: true } : d));
      localDraftsRef.current = next;
      return next;
    });
  };

  const handleRegenerateError = (leadId: string) => {
    setRegenerating((prev) => {
      const next = new Set(prev);
      next.delete(leadId);
      return next;
    });
    setLocalDrafts((prev) => {
      const next = prev.map((d) => (d.leadId === leadId ? { ...d, regenerating: false } : d));
      localDraftsRef.current = next;
      return next;
    });
  };

  const handleBulkApproveSend = async () => {
    if (!localDraftsRef.current.length) return;
    setBulkMessage(null);
    const count = localDraftsRef.current.length;
    const confirmText = `Approve and send all ${count} draft${count === 1 ? "" : "s"} now?\nThis will immediately trigger outreach via LinkedIn.`;
    if (typeof window !== "undefined" && !window.confirm(confirmText)) return;
    setBulkPending(true);
    try {
      const result = await approveAndSendAllDrafts();
      const sentNote = result.senderTriggered
        ? "Sender worker started; outreach will go out up to the daily cap."
        : "Sender worker not started (check logs).";
      const msg =
        result.approvedCount > 0
          ? `Approved ${result.approvedCount}/${result.attempted} drafts. ${sentNote}`
          : "No drafts were approved. They may have changed status.";
      setBulkMessage(msg);
      if (result.errors?.length) {
        console.error("Bulk approve errors", result.errors);
      }
    } catch (err: any) {
      setBulkMessage(err?.message || "Failed to approve and send drafts.");
    } finally {
      setBulkPending(false);
      fetchDrafts(true);
    }
  };

  if (!localDrafts.length && !loading) {
    return (
      <div className="card" style={{ marginTop: 20 }}>
        <div className="pill">Draft Feed</div>
        <h3 style={{ margin: "10px 0 6px 0" }}>No drafts ready.</h3>
        <div className="muted">When the agent generates drafts, they will appear here.</div>
        <div style={{ marginTop: 12, marginBottom: 12 }}>
          <label className="muted" style={{ marginRight: 8, fontSize: 13 }}>Message Style:</label>
          <select
            value={promptType}
            onChange={(e) => setPromptType(Number(e.target.value) as PromptType)}
            disabled={isGenerating}
            style={{
              maxWidth: 240,
              padding: "8px 12px",
              fontSize: 13,
              backgroundColor: "rgba(30, 41, 59, 0.95)",
              color: "#e2e8f0",
              border: "1px solid rgba(148, 163, 184, 0.2)",
              borderRadius: 6,
              cursor: "pointer",
              outline: "none",
              appearance: "none",
              WebkitAppearance: "none",
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M2 4l4 4 4-4'/%3E%3C/svg%3E")`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 10px center",
              paddingRight: 32,
            }}
          >
            <option value={1} style={{ backgroundColor: "#1e293b", color: "#e2e8f0" }}>{PROMPT_TYPE_LABELS[1]}</option>
            <option value={2} style={{ backgroundColor: "#1e293b", color: "#e2e8f0" }}>{PROMPT_TYPE_LABELS[2]}</option>
            <option value={3} style={{ backgroundColor: "#1e293b", color: "#e2e8f0" }}>{PROMPT_TYPE_LABELS[3]}</option>
          </select>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={handleGenerateDrafts} disabled={isGenerating}>
            {genPending ? "Starting…" : isPolling ? "Generating…" : "Generate Drafts for ENRICHED Leads"}
          </button>
          <button className="btn warn" onClick={handleBulkApproveSend} disabled={disableBulkSend}>
            {bulkPending ? "Sending…" : "Approve & Send All"}
          </button>
          {genMessage ? (
            <span className="muted" style={{ marginLeft: 6 }} aria-live="polite">
              {genMessage}
            </span>
          ) : null}
          {bulkMessage ? (
            <span className="muted" style={{ marginLeft: 6 }} aria-live="polite">
              {bulkMessage}
            </span>
          ) : null}
          {isGenerating && !genMessage ? (
            <span className="muted" style={{ marginLeft: 6 }} aria-live="polite">
              Drafts are being generated…
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card" style={{ marginTop: 20, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="pill">Draft Feed</div>
            <h3 style={{ margin: "10px 0 6px 0" }}>Review and approve drafts</h3>
            <div className="muted">Manually trigger draft generation for ENRICHED leads when you are ready.</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label className="muted" style={{ fontSize: 13 }}>Message Style:</label>
              <select
                value={promptType}
                onChange={(e) => setPromptType(Number(e.target.value) as PromptType)}
                disabled={isGenerating}
                style={{
                  maxWidth: 220,
                  padding: "8px 12px",
                  fontSize: 13,
                  backgroundColor: "rgba(30, 41, 59, 0.95)",
                  color: "#e2e8f0",
                  border: "1px solid rgba(148, 163, 184, 0.2)",
                  borderRadius: 6,
                  cursor: "pointer",
                  outline: "none",
                  appearance: "none",
                  WebkitAppearance: "none",
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2394a3b8' d='M2 4l4 4 4-4'/%3E%3C/svg%3E")`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "right 10px center",
                  paddingRight: 32,
                }}
              >
                <option value={1} style={{ backgroundColor: "#1e293b", color: "#e2e8f0" }}>{PROMPT_TYPE_LABELS[1]}</option>
                <option value={2} style={{ backgroundColor: "#1e293b", color: "#e2e8f0" }}>{PROMPT_TYPE_LABELS[2]}</option>
                <option value={3} style={{ backgroundColor: "#1e293b", color: "#e2e8f0" }}>{PROMPT_TYPE_LABELS[3]}</option>
              </select>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn warn" onClick={handleBulkApproveSend} disabled={disableBulkSend}>
                {bulkPending ? "Sending…" : "Approve & Send All"}
              </button>
              <button className="btn secondary" onClick={handleSendAllApproved} disabled={bulkPending}>
                {bulkPending ? "Triggering…" : "Send All Approved"}
              </button>
              <button className="btn" onClick={handleGenerateDrafts} disabled={isGenerating}>
                {genPending ? "Starting…" : isPolling ? "Generating…" : "Generate Drafts"}
              </button>
            </div>
          </div>
        </div>
        {(genMessage || bulkMessage || isGenerating || bulkPending) ? (
          <div className="muted" style={{ marginTop: 8 }} aria-live="polite">
            {bulkPending
              ? "Approving & sending all drafts…"
              : bulkMessage
              ? bulkMessage
              : isGenerating
              ? "Drafts are being generated… We will auto-refresh as they are ready."
              : genMessage}
          </div>
        ) : null}
      </div>

      <div className="grid">
        {loading && !localDrafts.length ? (
          <div className="card">
            <div className="muted">Loading drafts...</div>
          </div>
        ) : (
          localDrafts.map((draft) => (
            <DraftCard
              key={draft.draftId || draft.leadId}
              draft={draft}
              onAction={fetchDrafts}
              onRegenerateStart={handleRegenerateStart}
              onRegenerateError={handleRegenerateError}
            />
          ))
        )}
      </div>
    </>
  );
}

function DraftCard({
  draft,
  onAction,
  onRegenerateStart,
  onRegenerateError,
}: {
  draft: DraftWithLead;
  onAction?: () => void;
  onRegenerateStart?: (leadId: string, draft: DraftWithLead) => void;
  onRegenerateError?: (leadId: string) => void;
}) {
  const [localDraft, setLocalDraft] = useState({
    opener: draft.opener,
    body: draft.body,
    cta: draft.cta,
    ctaType: draft.ctaType || "Low Friction",
  });
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const preview = useMemo(
    () => [localDraft.opener, localDraft.body, localDraft.cta].filter(Boolean).join("\n\n"),
    [localDraft]
  );

  const activity = draft.activity?.[0];
  const locked = pending || !!draft.regenerating;

  const run = (
    action: () => Promise<void>,
    hooks?: { onStart?: () => void; onError?: () => void; onFinally?: () => void }
  ) => {
    startTransition(async () => {
      setMessage(null);
      hooks?.onStart?.();
      try {
        await action();
        setMessage("Done");
        // Refresh the draft list after action
        if (onAction) {
          setTimeout(onAction, 500);
        }
      } catch (err: any) {
        setMessage(err?.message || "Action failed");
        hooks?.onError?.();
      } finally {
        hooks?.onFinally?.();
      }
    });
  };

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div className="pill">{draft.status === "APPROVED" ? "Approved (unsent)" : "Draft Ready"}</div>
          <h3 style={{ margin: "10px 0 4px 0" }}>{draft.name || "Unknown lead"}</h3>
          <div style={{ color: "#a5b4fc", marginBottom: 8 }}>{draft.headline}</div>
        </div>
        <a className="muted" href={draft.linkedinUrl} target="_blank" rel="noreferrer">
          View profile ↗
        </a>
      </div>

      <div className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
        {draft.company || draft.profile?.current_company || "Company N/A"}
      </div>

      <div className="muted" style={{ marginBottom: 6 }}>
        Bio
      </div>
      <div style={{ marginBottom: 14, lineHeight: 1.5 }}>
        {draft.profile?.about || "No about section scraped yet."}
      </div>

      {activity ? (
        <div style={{ marginBottom: 14 }}>
          <div className="pill" style={{ background: "rgba(168, 85, 247, 0.16)", color: "#f3e8ff" }}>
            Quoted Post
          </div>
          <div style={{ marginTop: 8 }}>{activity.text}</div>
          <div className="muted" style={{ marginTop: 4 }}>
            {activity.date} • {activity.likes || "0"} likes
          </div>
        </div>
      ) : null}

      <label className="muted">Opener</label>
      <textarea
        className="textarea"
        value={localDraft.opener}
        disabled={draft.regenerating}
        onChange={(e) => setLocalDraft((d) => ({ ...d, opener: e.target.value }))}
      />

      <label className="muted">Body</label>
      <textarea
        className="textarea"
        value={localDraft.body}
        disabled={draft.regenerating}
        onChange={(e) => setLocalDraft((d) => ({ ...d, body: e.target.value }))}
      />

      <div style={{ marginTop: 12, marginBottom: 6 }} className="muted">
        CTA
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <select
          className="input"
          style={{ maxWidth: 240 }}
          value={localDraft.ctaType}
          disabled={draft.regenerating}
          onChange={(e) => setLocalDraft((d) => ({ ...d, ctaType: e.target.value }))}
        >
          <option value="Low Friction">Low Friction</option>
          <option value="High Friction">High Friction</option>
          <option value="Case Study">Case Study</option>
        </select>
        <input
          className="input"
          placeholder="CTA text"
          value={localDraft.cta}
          disabled={draft.regenerating}
          onChange={(e) => setLocalDraft((d) => ({ ...d, cta: e.target.value }))}
        />
      </div>

      <div className="muted" style={{ margin: "10px 0 6px 0" }}>
        Preview
      </div>
      <div className="preview">{preview || "Your preview will appear here."}</div>

      {draft.regenerating ? (
        <div className="muted" style={{ marginTop: 8 }}>
          Regenerating draft… We will refresh this card when the new draft arrives.
        </div>
      ) : null}

      <div className="button-row">
        <button
          className="btn"
          disabled={locked || draft.status === "APPROVED"}
          onClick={() =>
            run(() =>
              approveDraft({
                leadId: draft.leadId,
                draftId: draft.draftId,
                opener: localDraft.opener,
                body: localDraft.body,
                cta: localDraft.cta,
                ctaType: localDraft.ctaType,
              })
            )
          }
        >
          {pending ? "Saving..." : draft.regenerating ? "Pending..." : "Approve"}
        </button>
        <button className="btn secondary" disabled={locked} onClick={() => run(() => rejectDraft(draft.leadId))}>
          {pending ? "..." : draft.regenerating ? "Pending..." : "Reject"}
        </button>
        {draft.status === "APPROVED" ? (
          <button
            className="btn warn"
            disabled={locked}
            onClick={() =>
              run(() => sendLeadNow(draft.leadId))
            }
          >
            {pending ? "Sending..." : "Send Now"}
          </button>
        ) : (
        <button
          className="btn warn"
          disabled={locked}
          onClick={() => {
            onRegenerateStart?.(draft.leadId, draft);
            run(
              () => regenerateDraft(draft.leadId),
              {
                onError: () => onRegenerateError?.(draft.leadId),
              }
            );
          }}
        >
          {pending || draft.regenerating ? "Regenerating..." : "Regenerate"}
        </button>
        )}
        {message ? (
          <span className="muted" style={{ marginLeft: 8 }}>
            {message}
          </span>
        ) : null}
      </div>
    </section>
  );
}
