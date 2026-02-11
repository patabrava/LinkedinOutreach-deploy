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

const STATUS_PILL_META: Record<string, { label: string; className: string }> = {
  APPROVED: { label: "Approved (unsent)", className: "status-approved" },
  DRAFT_READY: { label: "Draft Ready", className: "status-draft" },
  MESSAGE_ONLY_READY: { label: "Message Draft Ready", className: "status-draft" },
  MESSAGE_ONLY_APPROVED: { label: "Message Approved", className: "status-approved" },
  CONNECT_ONLY_SENT: { label: "Pending Connection", className: "status-pending" },
  SENT: { label: "Sent", className: "status-sent" },
  DEFAULT: { label: "Draft", className: "status-new" },
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
      <div className="card" style={{ marginTop: 24 }}>
        <div className="pill">Draft Feed</div>
        <h3 style={{ margin: "12px 0 8px 0" }}>
          {outreachMode === "message_only" ? "NO PENDING CONNECTIONS" : "NO DRAFTS READY"}
        </h3>
        <div className="muted">
          {outreachMode === "message_only" 
            ? "When connections are accepted, leads will appear here for messaging."
            : "When the agent generates drafts, they will appear here."}
        </div>
        <div style={{ marginTop: 16, marginBottom: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, margin: 0 }}>Outreach Style:</label>
            <select
              value={outreachMode}
              onChange={(e) => handleOutreachModeChange(e.target.value as OutreachMode)}
              disabled={isGenerating}
              className="input"
              style={{ maxWidth: 200, padding: "8px 12px", fontSize: 12 }}
            >
              <option value="connect_message">{OUTREACH_MODE_LABELS.connect_message}</option>
              <option value="message_only">{OUTREACH_MODE_LABELS.message_only}</option>
            </select>
          </div>
          {outreachMode === "connect_message" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 12, margin: 0 }}>Message Style:</label>
              <select
                value={promptType}
                onChange={(e) => setPromptType(Number(e.target.value) as PromptType)}
                disabled={isGenerating}
                className="input"
                style={{ maxWidth: 200, padding: "8px 12px", fontSize: 12 }}
              >
                <option value={1}>{PROMPT_TYPE_LABELS[1]}</option>
                <option value={2}>{PROMPT_TYPE_LABELS[2]}</option>
                <option value={3}>{PROMPT_TYPE_LABELS[3]}</option>
              </select>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 0, flexWrap: "wrap" }}>
          <button className="btn" onClick={handleGenerateDrafts} disabled={isGenerating}>
            {genPending ? "STARTING…" : isPolling ? "GENERATING…" : generateButtonLabel}
          </button>
          <button className="btn warn" onClick={handleBulkApproveSend} disabled={disableBulkSend}>
            {bulkPending ? "SENDING…" : "Approve & Send All"}
          </button>
          <button className="btn secondary" onClick={handleSendAllApproved} disabled={bulkPending}>
            {bulkPending ? "TRIGGERING…" : outreachMode === "message_only" ? "Send to Accepted" : "Send All Approved"}
          </button>
          {genMessage ? (
            <span className="muted" style={{ marginLeft: 12, alignSelf: "center" }} aria-live="polite">
              {genMessage}
            </span>
          ) : null}
          {bulkMessage ? (
            <span className="muted" style={{ marginLeft: 12, alignSelf: "center" }} aria-live="polite">
              {bulkMessage}
            </span>
          ) : null}
          {isGenerating && !genMessage ? (
            <span className="muted" style={{ marginLeft: 12, alignSelf: "center" }} aria-live="polite">
              Drafts are being generated…
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card" style={{ marginTop: 24, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
          <div>
            <div className="pill">Draft Feed</div>
            <h3 style={{ margin: "12px 0 8px 0" }}>REVIEW AND APPROVE DRAFTS</h3>
            <div className="muted">Manually trigger draft generation for ENRICHED leads when you are ready.</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ fontSize: 11, margin: 0 }}>Outreach Style:</label>
                <select
                  value={outreachMode}
                  onChange={(e) => handleOutreachModeChange(e.target.value as OutreachMode)}
                  disabled={isGenerating}
                  className="input"
                  style={{ maxWidth: 200, padding: "8px 12px", fontSize: 11 }}
                >
                  <option value="connect_message">{OUTREACH_MODE_LABELS.connect_message}</option>
                  <option value="message_only">{OUTREACH_MODE_LABELS.message_only}</option>
                </select>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ fontSize: 11, margin: 0 }}>Message Style:</label>
                <select
                  value={promptType}
                  onChange={(e) => setPromptType(Number(e.target.value) as PromptType)}
                  disabled={isGenerating || outreachMode === "message_only"}
                  className="input"
                  style={{ maxWidth: 200, padding: "8px 12px", fontSize: 11 }}
                >
                  <option value={1}>{PROMPT_TYPE_LABELS[1]}</option>
                  <option value={2}>{PROMPT_TYPE_LABELS[2]}</option>
                  <option value={3}>{PROMPT_TYPE_LABELS[3]}</option>
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: 0 }}>
              <button className="btn warn" onClick={handleBulkApproveSend} disabled={disableBulkSend}>
                {bulkPending ? "SENDING…" : "Approve & Send All"}
              </button>
              <button className="btn secondary" onClick={handleSendAllApproved} disabled={bulkPending}>
                {bulkPending ? "TRIGGERING…" : "Send All Approved"}
              </button>
              <button className="btn" onClick={handleGenerateDrafts} disabled={isGenerating}>
                {genPending ? "STARTING…" : isPolling ? "GENERATING…" : generateButtonLabel}
              </button>
            </div>
          </div>
        </div>
        {(genMessage || bulkMessage || isGenerating || bulkPending) ? (
          <div className="muted" style={{ marginTop: 12, padding: 8, border: "2px solid #000" }} aria-live="polite">
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
        <div className="card" style={{ marginTop: 24 }}>
          <div className="pill" style={{ marginBottom: 12 }}>Pending Connections</div>
          <h3 style={{ margin: "0 0 8px 0" }}>WAITING FOR ACCEPTANCE</h3>
          <div className="muted" style={{ marginBottom: 16 }}>
            These leads still show "Ausstehend" on LinkedIn. We will automatically attempt messaging as soon as the connection is accepted.
          </div>
          <div className="grid">
            {pendingDrafts.map((draft) => (
              <div key={draft.leadId} className="card" style={{ opacity: 0.7 }}>
                <div className="pill status-pending">Pending Connection</div>
                <h3 style={{ margin: "12px 0 4px 0" }}>{draft.name || "Unknown lead"}</h3>
                <div className="muted" style={{ fontSize: 12 }}>{draft.headline}</div>
                <div className="muted" style={{ marginTop: 8 }}>
                  {draft.company || draft.profile?.current_company || "Company N/A"}
                </div>
                <a className="muted" href={draft.linkedinUrl} target="_blank" rel="noreferrer" style={{ display: "block", marginTop: 8 }}>
                  View profile ↗
                </a>
              </div>
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div className={`pill ${statusMeta.className}`}>
            {statusMeta.label}
          </div>
          <h3 style={{ margin: "12px 0 4px 0" }}>{draft.name || "Unknown lead"}</h3>
          <div style={{ color: "var(--muted)", marginBottom: 8, fontSize: 12 }}>{draft.headline}</div>
        </div>
        <a className="muted" href={draft.linkedinUrl} target="_blank" rel="noreferrer">
          View profile ↗
        </a>
      </div>

      <div className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
        {draft.company || draft.profile?.current_company || "Company N/A"}
      </div>

      <label>Bio</label>
      <div style={{ marginBottom: 16, lineHeight: 1.5, padding: 12, border: "2px solid #000" }}>
        {draft.profile?.about || "No about section scraped yet."}
      </div>

      {activity ? (
        <div style={{ marginBottom: 16 }}>
          <div className="pill">Quoted Post</div>
          <div style={{ marginTop: 8, padding: 12, border: "2px solid #000" }}>{activity.text}</div>
          <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>
            {activity.date} • {activity.likes || "0"} likes
          </div>
        </div>
      ) : null}

      <label>Opener</label>
      <textarea
        className="textarea"
        value={localDraft.opener}
        disabled={draft.regenerating}
        onChange={(e) => setLocalDraft((d) => ({ ...d, opener: e.target.value }))}
      />

      <label>Body</label>
      <textarea
        className="textarea"
        value={localDraft.body}
        disabled={draft.regenerating}
        onChange={(e) => setLocalDraft((d) => ({ ...d, body: e.target.value }))}
      />

      <label>CTA</label>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <select
          className="input"
          style={{ maxWidth: 200 }}
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

      <label>Preview</label>
      <div className="preview">{preview || "Your preview will appear here."}</div>

      {draft.regenerating ? (
        <div className="muted" style={{ marginTop: 12, padding: 8, border: "2px solid #000" }}>
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
          {pending ? "SAVING…" : draft.regenerating ? "PENDING…" : "APPROVE"}
        </button>
        <button className="btn secondary" disabled={locked} onClick={() => run(() => rejectDraft(draft.leadId))}>
          {pending ? "…" : draft.regenerating ? "PENDING…" : "REJECT"}
        </button>
        {canSendNow ? (
          <button
            className="btn warn"
            disabled={locked}
            onClick={() =>
              run(() => sendLeadNow(draft.leadId, outreachMode))
            }
          >
            {pending ? "SENDING…" : "SEND NOW"}
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
            {pending || draft.regenerating ? "REGENERATING…" : "REGENERATE"}
          </button>
        )}
        {message ? (
          <span className="muted" style={{ marginLeft: 12, alignSelf: "center" }}>
            {message}
          </span>
        ) : null}
      </div>
    </section>
  );
}


