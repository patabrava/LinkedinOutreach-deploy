import { DraftFeed } from "../components/DraftFeed";
import { LeadList } from "../components/LeadList";
import { fetchDraftFeed, fetchLeadList } from "./actions";

export default async function MissionControlPage() {
  // Only show enriched leads in the mission control table to reduce noise.
  const [drafts, leadResult] = await Promise.all([
    fetchDraftFeed(),
    fetchLeadList(1, 50, { status: "ENRICHED" }),
  ]);

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18, gap: 14 }}>
        <div>
          <div className="pill">Draft Feed</div>
          <h1 style={{ margin: "12px 0 6px 0", fontSize: 32, letterSpacing: "-0.5px" }}>
            Mission Control
          </h1>
          <div className="muted">Review, edit, and approve AI-generated outreach.</div>
          <div style={{ marginTop: 6 }}>
            <a className="muted" href="/leads">
              View all leads →
            </a>
          </div>
          <div style={{ marginTop: 4 }}>
            <a className="muted" href="/settings">
              Set LinkedIn credentials →
            </a>
          </div>
        </div>
      </div>

      <LeadList leads={leadResult.leads} condensed maxRows={8} initialFilters={{ status: "ENRICHED" }} />

      <DraftFeed drafts={drafts} />
    </div>
  );
}
