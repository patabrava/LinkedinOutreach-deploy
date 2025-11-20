"use client";

import { useMemo, useState } from "react";

type Draft = {
  opener: string;
  body: string;
  cta: string;
};

const CTA_TEMPLATES = [
  { label: "Low Friction – 10 mins?", value: "Low Friction" },
  { label: "Case Study Share", value: "Case Study" },
  { label: "High Intent – Book Time", value: "High Friction" },
];

const SAMPLE_CONTEXT = {
  name: "Jordan Blake",
  headline: "Ops leader | Building resilient supply chains",
  about:
    "Scaling ops teams that keep margins healthy. Curious about workflow automation and vendor resilience.",
  post: {
    text: "Shared a post about cutting fulfillment time by 22% with better routing.",
    date: "2d",
    likes: 134,
  },
};

export default function MissionControlPage() {
  const [draft, setDraft] = useState<Draft>({
    opener: "Saw your post on trimming fulfillment time—loved the focus on ops debt.",
    body: "We helped RoOut consolidate carrier data into one pane and auto-routed exceptions, shrinking turnaround time by 18%. Happy to show the playbook if you're exploring similar levers.",
    cta: "Can I share 2 screenshots of how teams triage exceptions in under 30s?",
  });

  const [ctaType, setCtaType] = useState<string>(CTA_TEMPLATES[0].value);

  const preview = useMemo(
    () => [draft.opener, draft.body, draft.cta].filter(Boolean).join("\n\n"),
    [draft]
  );

  const onAction = (action: "approve" | "reject" | "regenerate") => {
    // Wire this to Supabase mutations.
    console.log(`Action requested: ${action}`);
  };

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <div className="pill">Draft Feed</div>
          <h1 style={{ margin: "12px 0 6px 0", fontSize: 32, letterSpacing: "-0.5px" }}>
            Mission Control
          </h1>
          <div className="muted">Review, edit, and approve AI-generated outreach.</div>
        </div>
        <div className="card" style={{ width: 260 }}>
          <div className="muted" style={{ marginBottom: 8 }}>
            CSV Uploader
          </div>
          <div className="csv-drop">
            Drag & drop CSV to import leads
            <div style={{ marginTop: 8, fontSize: 12 }}>Dedupes by LinkedIn URL</div>
          </div>
        </div>
      </div>

      <div className="grid">
        <section className="card">
          <div className="muted" style={{ marginBottom: 8 }}>
            Context
          </div>
          <h3 style={{ margin: "4px 0 4px 0" }}>{SAMPLE_CONTEXT.name}</h3>
          <div style={{ color: "#a5b4fc", marginBottom: 10 }}>{SAMPLE_CONTEXT.headline}</div>
          <div style={{ marginBottom: 14 }}>{SAMPLE_CONTEXT.about}</div>

          <div className="pill" style={{ background: "rgba(168, 85, 247, 0.16)", color: "#f3e8ff" }}>
            Quoted Post
          </div>
          <div style={{ marginTop: 10, lineHeight: 1.5 }}>
            {SAMPLE_CONTEXT.post.text}
            <div className="muted" style={{ marginTop: 6 }}>
              {SAMPLE_CONTEXT.post.date} • {SAMPLE_CONTEXT.post.likes} likes
            </div>
          </div>
        </section>

        <section className="card">
          <div className="muted" style={{ marginBottom: 8 }}>
            Draft Editor
          </div>

          <label className="muted">Opener</label>
          <textarea
            className="textarea"
            value={draft.opener}
            onChange={(e) => setDraft((d) => ({ ...d, opener: e.target.value }))}
          />

          <label className="muted">Body</label>
          <textarea
            className="textarea"
            value={draft.body}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          />

          <div style={{ marginTop: 12, marginBottom: 6 }} className="muted">
            CTA
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <select
              className="input"
              style={{ maxWidth: 220 }}
              value={ctaType}
              onChange={(e) => setCtaType(e.target.value)}
            >
              {CTA_TEMPLATES.map((cta) => (
                <option key={cta.value} value={cta.value}>
                  {cta.label}
                </option>
              ))}
            </select>
            <input
              className="input"
              placeholder="CTA text"
              value={draft.cta}
              onChange={(e) => setDraft((d) => ({ ...d, cta: e.target.value }))}
            />
          </div>

          <div className="muted" style={{ margin: "10px 0 6px 0" }}>
            Preview
          </div>
          <div className="preview">{preview || "Your preview will appear here."}</div>

          <div className="button-row">
            <button className="btn" onClick={() => onAction("approve")}>
              Approve & Send
            </button>
            <button className="btn secondary" onClick={() => onAction("reject")}>
              Reject
            </button>
            <button className="btn warn" onClick={() => onAction("regenerate")}>
              Regenerate
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
