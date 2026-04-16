import { DraftFeed } from "../components/DraftFeed";
import { SequenceEditor } from "../components/SequenceEditor";
import { fetchDraftFeed, fetchLeadBatches, fetchOutreachSequences } from "./actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MissionControlPage() {
  // Mission Control is intentionally post-acceptance only.
  // Under the hood, the post-acceptance queue is represented by the "connect_only" mode.
  const [drafts, sequences, batches] = await Promise.all([
    fetchDraftFeed("connect_only"),
    fetchOutreachSequences(),
    fetchLeadBatches(),
  ]);

  return (
    <div className="page">
      <div style={{ display: "grid", gap: 10, marginBottom: 24, maxWidth: 920 }}>
        <div>
          <div className="pill">Mission Control</div>
          <h1 className="page-title">POST-ACCEPTANCE</h1>
          <div className="muted">
            Review and approve messages that go out <strong>after</strong> a connection is accepted, and manage post-acceptance sequences.
          </div>
          <div style={{ marginTop: 8 }}>
            <a className="muted" href="/leads">
              Lead Intake (batch progress) →
            </a>
          </div>
          <div style={{ marginTop: 4 }}>
            <a className="muted" href="/settings">
              Set LinkedIn credentials →
            </a>
          </div>
        </div>
      </div>

      <SequenceEditor sequences={sequences} batches={batches} />

      <DraftFeed drafts={drafts} variant="mission_control" />
    </div>
  );
}
