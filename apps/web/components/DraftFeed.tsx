"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { approveDraft, fetchDraftFeed, regenerateDraft, rejectDraft, triggerDraftGeneration } from "../app/actions";
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
};

type Props = {
  drafts: DraftWithLead[];
};

export function DraftFeed({ drafts }: Props) {
  const [localDrafts, setLocalDrafts] = useState<DraftWithLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [genPending, setGenPending] = useState(false);
  const [genMessage, setGenMessage] = useState<string | null>(null);

  // Fetch all DRAFT_READY leads with their drafts using server action
  const fetchDrafts = async () => {
    setLoading(true);
    try {
      const mapped = await fetchDraftFeed();
      setLocalDrafts(mapped);
    } catch (err) {
      console.error("Failed to fetch drafts:", err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch existing drafts on mount
  useEffect(() => {
    fetchDrafts();
  }, []);

  // Subscribe to real-time updates on leads table
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
  }, []);

  const handleGenerateDrafts = async () => {
    setGenMessage(null);
    setGenPending(true);
    try {
      await triggerDraftGeneration();
      setGenMessage("Draft generation started. This may take a moment – drafts will appear here when ready.");
    } catch (err: any) {
      setGenMessage(err?.message || "Failed to start draft generation.");
    } finally {
      setGenPending(false);
    }
  };

  if (!localDrafts.length && !loading) {
    return (
      <div className="card" style={{ marginTop: 20 }}>
        <div className="pill">Draft Feed</div>
        <h3 style={{ margin: "10px 0 6px 0" }}>No drafts ready.</h3>
        <div className="muted">When the agent generates drafts, they will appear here.</div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn" onClick={handleGenerateDrafts} disabled={genPending}>
            {genPending ? "Starting…" : "Generate Drafts for ENRICHED Leads"}
          </button>
          {genMessage ? (
            <span className="muted" style={{ marginLeft: 6 }}>{genMessage}</span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card" style={{ marginTop: 20, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div className="pill">Draft Feed</div>
            <h3 style={{ margin: "10px 0 6px 0" }}>Review and approve drafts</h3>
            <div className="muted">Manually trigger draft generation for ENRICHED leads when you are ready.</div>
          </div>
          <div>
            <button className="btn" onClick={handleGenerateDrafts} disabled={genPending}>
              {genPending ? "Starting…" : "Generate Drafts"}
            </button>
          </div>
        </div>
        {genMessage ? (
          <div className="muted" style={{ marginTop: 8 }}>{genMessage}</div>
        ) : null}
      </div>

      <div className="grid">
        {loading && !localDrafts.length ? (
          <div className="card">
            <div className="muted">Loading drafts...</div>
          </div>
        ) : (
          localDrafts.map((draft) => (
            <DraftCard key={draft.draftId || draft.leadId} draft={draft} onAction={fetchDrafts} />
          ))
        )}
      </div>
    </>
  );
}

function DraftCard({ draft, onAction }: { draft: DraftWithLead; onAction?: () => void }) {
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

  const run = (action: () => Promise<void>) => {
    startTransition(async () => {
      setMessage(null);
      try {
        await action();
        setMessage("Done");
        // Refresh the draft list after action
        if (onAction) {
          setTimeout(onAction, 500);
        }
      } catch (err: any) {
        setMessage(err?.message || "Action failed");
      }
    });
  };

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div className="pill">Draft Ready</div>
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
        onChange={(e) => setLocalDraft((d) => ({ ...d, opener: e.target.value }))}
      />

      <label className="muted">Body</label>
      <textarea
        className="textarea"
        value={localDraft.body}
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
          onChange={(e) => setLocalDraft((d) => ({ ...d, cta: e.target.value }))}
        />
      </div>

      <div className="muted" style={{ margin: "10px 0 6px 0" }}>
        Preview
      </div>
      <div className="preview">{preview || "Your preview will appear here."}</div>

      <div className="button-row">
        <button
          className="btn"
          disabled={pending}
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
          {pending ? "Saving..." : "Approve"}
        </button>
        <button className="btn secondary" disabled={pending} onClick={() => run(() => rejectDraft(draft.leadId))}>
          {pending ? "..." : "Reject"}
        </button>
        <button className="btn warn" disabled={pending} onClick={() => run(() => regenerateDraft(draft.leadId))}>
          {pending ? "..." : "Regenerate"}
        </button>
        {message ? (
          <span className="muted" style={{ marginLeft: 8 }}>
            {message}
          </span>
        ) : null}
      </div>
    </section>
  );
}

