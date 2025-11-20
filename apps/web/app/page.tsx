import { CSVUploader } from "../components/CSVUploader";
import { DraftFeed } from "../components/DraftFeed";
import { LeadList } from "../components/LeadList";
import { fetchDraftFeed, fetchLeadList } from "./actions";

export default async function MissionControlPage() {
  const [drafts, leads] = await Promise.all([fetchDraftFeed(), fetchLeadList()]);

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
        </div>
        <div className="card" style={{ width: 320 }}>
          <div className="muted" style={{ marginBottom: 8 }}>
            CSV Uploader
          </div>
          <CSVUploader />
        </div>
      </div>

      <LeadList leads={leads} />

      <DraftFeed drafts={drafts} />
    </div>
  );
}
