"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { approveAndSendAllDrafts, approveDraft, fetchDraftFeed, regenerateDraft, rejectDraft, triggerDraftGeneration, sendLeadNow, sendAllApproved } from "../app/actions";
import { OUTREACH_MODE_LABELS } from "../lib/outreachModes";
import type { OutreachMode } from "../lib/outreachModes";
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
  initialOutreachMode?: OutreachMode;
};

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

const STATUS_PILL_META: Record<string, { label: string; background: string; color: string }> = {
  APPROVED: { label: "Approved (unsent)", background: "rgba(34,197,94,0.18)", color: "#bbf7d0" },
  DRAFT_READY: { label: "Draft Ready", background: "rgba(129,140,248,0.18)", color: "#c7d2fe" },
  MESSAGE_ONLY_READY: { label: "Message Draft Ready", background: "rgba(59,130,246,0.15)", color: "#bfdbfe" },
  MESSAGE_ONLY_APPROVED: { label: "Message Approved", background: "rgba(16,185,129,0.18)", color: "#a7f3d0" },
  CONNECT_ONLY_SENT: { label: "Pending Connection", background: "rgba(248,250,252,0.04)", color: "#f8fafc" },
  SENT: { label: "Sent", background: "rgba(148,163,184,0.2)", color: "#e2e8f0" },
  DEFAULT: { label: "Draft", background: "rgba(148,163,184,0.2)", color: "#e2e8f0" },
};

const MESSAGE_ONLY_STATUSES = ["CONNECT_ONLY_SENT", "MESSAGE_ONLY_READY", "MESSAGE_ONLY_APPROVED"];

function getStatusMeta(status?: string) {
  if (!status) {
    return STATUS_PILL_META.DEFAULT;
  }
  return STATUS_PILL_META[status] ?? STATUS_PILL_META.DEFAULT;
}

export function DraftFeed({ drafts, initialOutreachMode = "connect_message" }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
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
  const [outreachMode, setOutreachMode] = useState<OutreachMode>(initialOutreachMode);
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastDraftCountRef = useRef<number>(drafts.length || 0);
  const isPollingRef = useRef(false);
  const regeneratingRef = useRef(regenerating);

  const isMessageOnly = outreachMode === "message_only";

  const fetchDrafts = useCallback(async (showLoading = false, mode?: OutreachMode) => {
    if (showLoading) {
      setLoading(true);
    }
    try {
      const mapped = await fetchDraftFeed(mode ?? outreachMode);
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
  }, [outreachMode]);

  // Keep outreachMode in sync with server-provided initial value
  useEffect(() => {
    setOutreachMode(initialOutreachMode);
  }, [initialOutreachMode]);

  // Fetch existing drafts on mount and when outreach mode changes
  useEffect(() => {
    fetchDrafts(true, outreachMode);
  }, [fetchDrafts, outreachMode]);

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
    const channel = supabase.channel(`draft-feed-updates-${outreachMode}`);

    const leadStatuses = isMessageOnly
      ? ["CONNECT_ONLY_SENT", "MESSAGE_ONLY_READY", "MESSAGE_ONLY_APPROVED", "SENT"]
      : ["DRAFT_READY", "APPROVED", "SENT"];

    leadStatuses.forEach((status) => {
      channel.on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "leads",
          filter: `status=eq.${status}`,
        },
        () => fetchDrafts()
      );
    });

    channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "drafts",
      },
      () => fetchDrafts()
    );

    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchDrafts, outreachMode, isMessageOnly]);

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
      await triggerDraftGeneration(promptType, outreachMode);
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
  const pendingDrafts = useMemo(
    () => (isMessageOnly ? localDrafts.filter((d) => d.status === "CONNECT_ONLY_SENT") : []),
    [localDrafts, isMessageOnly]
  );
  const actionableDrafts = useMemo(
    () => (isMessageOnly ? localDrafts.filter((d) => d.status !== "CONNECT_ONLY_SENT") : localDrafts),
    [localDrafts, isMessageOnly]
  );
  const actionableCount = actionableDrafts.length;

  const disableBulkSend = bulkPending || isGenerating || actionableCount === 0;

  const generateButtonLabel = outreachMode === "message_only" ? "Prepare Message Drafts" : "Generate Drafts";

  const updateUrlOutreachMode = (mode: OutreachMode) => {
    const params = new URLSearchParams(searchParams?.toString() || "");
    if (mode === "connect_message") {
      params.delete("outreachMode");
    } else {
      params.set("outreachMode", mode);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const handleOutreachModeChange = (mode: OutreachMode) => {
    setOutreachMode(mode);
    updateUrlOutreachMode(mode);
  };

  const handleSendAllApproved = async () => {
    setBulkMessage(null);
    setBulkPending(true);
    try {
      const result = await sendAllApproved(outreachMode);
      const msg = result?.senderTriggered
        ? outreachMode === "message_only" 
          ? "Triggered sender for pending connections (message-only mode)."
          : "Triggered sender for approved leads."
        : "No leads to send.";
      setBulkMessage(msg);
    } catch (err: any) {
      setBulkMessage(err?.message || "Failed to trigger sending.");
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

  const getActionableDraftSnapshot = () => {
    const list = localDraftsRef.current;
    if (outreachMode === "message_only") {
      return list.filter((d) => d.status !== "CONNECT_ONLY_SENT");
    }
    return list;
  };

  const handleBulkApproveSend = async () => {
    const actionable = getActionableDraftSnapshot();
    if (!actionable.length) return;
    setBulkMessage(null);
    const count = actionable.length;
    const confirmText = `Approve and send all ${count} draft${count === 1 ? "" : "s"} now?\nThis will immediately trigger outreach via LinkedIn.`;
    if (typeof window !== "undefined" && !window.confirm(confirmText)) return;
    setBulkPending(true);
    try {
      const result = await approveAndSendAllDrafts(outreachMode);
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
        <h3 style={{ margin: "10px 0 6px 0" }}>
          {outreachMode === "message_only" ? "No pending connections." : "No drafts ready."}
        </h3>
        <div className="muted">
          {outreachMode === "message_only" 
            ? "When connections are accepted, leads will appear here for messaging."
            : "When the agent generates drafts, they will appear here."}
        </div>
        <div style={{ marginTop: 12, marginBottom: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label className="muted" style={{ fontSize: 13 }}>Outreach Style:</label>
            <select
              value={outreachMode}
              onChange={(e) => handleOutreachModeChange(e.target.value as OutreachMode)}
              disabled={isGenerating}
              style={{
                maxWidth: 200,
                padding: "8px 12px",
                fontSize: 13,
                backgroundColor: outreachMode === "message_only" ? "rgba(59, 130, 246, 0.2)" : "rgba(30, 41, 59, 0.95)",
                color: "#e2e8f0",
                border: outreachMode === "message_only" ? "1px solid rgba(59, 130, 246, 0.5)" : "1px solid rgba(148, 163, 184, 0.2)",
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
              <option value="connect_message" style={{ backgroundColor: "#1e293b", color: "#e2e8f0" }}>{OUTREACH_MODE_LABELS.connect_message}</option>
              <option value="message_only" style={{ backgroundColor: "#1e293b", color: "#e2e8f0" }}>{OUTREACH_MODE_LABELS.message_only}</option>
            </select>
          </div>
          {outreachMode === "connect_message" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label className="muted" style={{ fontSize: 13 }}>Message Style:</label>
              <select
                value={promptType}
                onChange={(e) => setPromptType(Number(e.target.value) as PromptType)}
                disabled={isGenerating}
                style={{
                  maxWidth: 200,
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
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" onClick={handleGenerateDrafts} disabled={isGenerating}>
            {genPending ? "Starting…" : isPolling ? "Generating…" : generateButtonLabel}
          </button>
          <button className="btn warn" onClick={handleBulkApproveSend} disabled={disableBulkSend}>
            {bulkPending ? "Sending…" : "Approve & Send All"}
          </button>
          <button className="btn secondary" onClick={handleSendAllApproved} disabled={bulkPending}>
            {bulkPending ? "Triggering…" : outreachMode === "message_only" ? "Send to Accepted" : "Send All Approved"}
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
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label className="muted" style={{ fontSize: 13 }}>Outreach Style:</label>
                <select
                  value={outreachMode}
                  onChange={(e) => handleOutreachModeChange(e.target.value as OutreachMode)}
                  disabled={isGenerating}
                  style={{
                    maxWidth: 200,
                    padding: "8px 12px",
                    fontSize: 13,
                    backgroundColor: outreachMode === "message_only" ? "rgba(59, 130, 246, 0.2)" : "rgba(30, 41, 59, 0.95)",
                    color: "#e2e8f0",
                    border: outreachMode === "message_only" ? "1px solid rgba(59, 130, 246, 0.5)" : "1px solid rgba(148, 163, 184, 0.2)",
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
                  <option value="connect_message" style={{ backgroundColor: "#1e293b", color: "#e2e8f0" }}>{OUTREACH_MODE_LABELS.connect_message}</option>
                  <option value="message_only" style={{ backgroundColor: "#1e293b", color: "#e2e8f0" }}>{OUTREACH_MODE_LABELS.message_only}</option>
                </select>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label className="muted" style={{ fontSize: 13 }}>Message Style:</label>
                <select
                  value={promptType}
                  onChange={(e) => setPromptType(Number(e.target.value) as PromptType)}
                  disabled={isGenerating || outreachMode === "message_only"}
                  style={{
                    maxWidth: 200,
                    padding: "8px 12px",
                    fontSize: 13,
                    backgroundColor: "rgba(30, 41, 59, 0.95)",
                    color: outreachMode === "message_only" ? "#64748b" : "#e2e8f0",
                    border: "1px solid rgba(148, 163, 184, 0.2)",
                    borderRadius: 6,
                    cursor: outreachMode === "message_only" ? "not-allowed" : "pointer",
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
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn warn" onClick={handleBulkApproveSend} disabled={disableBulkSend}>
                {bulkPending ? "Sending…" : "Approve & Send All"}
              </button>
              <button className="btn secondary" onClick={handleSendAllApproved} disabled={bulkPending}>
                {bulkPending ? "Triggering…" : "Send All Approved"}
              </button>
              <button className="btn" onClick={handleGenerateDrafts} disabled={isGenerating}>
                {genPending ? "Starting…" : isPolling ? "Generating…" : generateButtonLabel}
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
          actionableDrafts.map((draft) => (
            <DraftCard
              key={draft.draftId || draft.leadId}
              draft={draft}
              outreachMode={outreachMode}
              onAction={fetchDrafts}
              onRegenerateStart={handleRegenerateStart}
              onRegenerateError={handleRegenerateError}
            />
          ))
        )}
      </div>

      {isMessageOnly && pendingDrafts.length ? (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="pill" style={{ marginBottom: 8 }}>Pending Connections</div>
          <h3 style={{ margin: "0 0 6px 0" }}>Waiting for acceptance</h3>
          <div className="muted" style={{ marginBottom: 16 }}>
            These leads still show "Ausstehend" on LinkedIn. We will automatically attempt messaging as soon as the connection is accepted.
          </div>
          <div className="grid">
            {pendingDrafts.map((draft) => (
              <PendingConnectionCard key={draft.leadId} draft={draft} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

function DraftCard({
  draft,
  outreachMode,
  onAction,
  onRegenerateStart,
  onRegenerateError,
}: {
  draft: DraftWithLead;
  outreachMode: OutreachMode;
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

  const preview = useMemo(() => {
    const normalize = (segment: string) => segment.replace(/[\n\r]+/g, " ").replace(/\s{2,}/g, " ").trim();
    return [localDraft.opener, localDraft.body, localDraft.cta]
      .map((part) => normalize(part || ""))
      .filter(Boolean)
      .join(" ");
  }, [localDraft]);

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

  const statusMeta = getStatusMeta(draft.status);
  const isApprovedStatus = draft.status === "APPROVED" || draft.status === "MESSAGE_ONLY_APPROVED";
  const canSendNow = isApprovedStatus;

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div
            className="pill"
            style={{
              background: statusMeta.background,
              color: statusMeta.color,
            }}
          >
            {statusMeta.label}
          </div>
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
          disabled={locked || isApprovedStatus}
          onClick={() =>
            run(() =>
              approveDraft({
                leadId: draft.leadId,
                draftId: draft.draftId,
                opener: localDraft.opener,
                body: localDraft.body,
                cta: localDraft.cta,
                ctaType: localDraft.ctaType,
                outreachMode,
              })
            )
          }
        >
          {pending ? "Saving..." : draft.regenerating ? "Pending..." : "Approve"}
        </button>
        <button className="btn secondary" disabled={locked} onClick={() => run(() => rejectDraft(draft.leadId))}>
          {pending ? "..." : draft.regenerating ? "Pending..." : "Reject"}
        </button>
        {canSendNow ? (
          <button
            className="btn warn"
            disabled={locked}
            onClick={() =>
              run(() => sendLeadNow(draft.leadId, outreachMode))
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
                () => regenerateDraft(draft.leadId, outreachMode),
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
