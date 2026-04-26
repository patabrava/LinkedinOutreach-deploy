import { CustomOutreachWorkspace } from "../../components/CustomOutreachWorkspace";
import { requireServerSession } from "../../lib/auth";
import { fetchCustomOutreachBatchSummaries } from "../actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CustomOutreachPage() {
  await requireServerSession("/custom-outreach");
  const batches = await fetchCustomOutreachBatchSummaries();

  return (
    <div className="page">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "space-between", alignItems: "baseline", marginBottom: 18 }}>
        <div>
          <div className="pill">Custom Outreach</div>
          <h1 className="page-title">MANUAL DRAFT REVIEW</h1>
          <div className="muted" style={{ maxWidth: 720 }}>
            Operator-reviewed outreach lives here. Import a batch as Custom Outreach, generate drafts per lead, and send only the
            messages that survive human review.
          </div>
        </div>
        <a className="btn secondary" href="/upload">
          IMPORT CUSTOM BATCH
        </a>
      </div>

      <CustomOutreachWorkspace batches={batches} />
    </div>
  );
}
