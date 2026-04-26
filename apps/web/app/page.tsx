import { SequenceEditor } from "../components/SequenceEditor";
import { requireServerSession } from "../lib/auth";
import { fetchLeadBatches, fetchOutreachSequences } from "./actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MissionControlPage() {
  const session = await requireServerSession("/");
  const [sequences, batches] = await Promise.all([
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
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10 }}>
            <a className="btn secondary" href="/leads">LEAD INTAKE</a>
            <a className="btn secondary" href="/settings">LINKEDIN CREDENTIALS</a>
          </div>
          {session?.user.email ? (
            <div className="pill status-approved" style={{ marginTop: 12 }}>
              Signed in as {session.user.email}
            </div>
          ) : null}
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
    </div>
  );
}
