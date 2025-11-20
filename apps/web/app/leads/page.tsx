import { CSVUploader } from "../../components/CSVUploader";
import { LeadList } from "../../components/LeadList";
import { fetchLeadList } from "../actions";

export default async function LeadsPage() {
  const leads = await fetchLeadList(250);

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 18, gap: 14 }}>
        <div>
          <div className="pill">Leads</div>
          <h1 style={{ margin: "12px 0 6px 0", fontSize: 32, letterSpacing: "-0.5px" }}>Lead Intake</h1>
          <div className="muted">Upload a CSV and review everything that landed.</div>
        </div>
        <div className="card" style={{ width: 320 }}>
          <div className="muted" style={{ marginBottom: 8 }}>
            Import
          </div>
          <CSVUploader />
        </div>
      </div>

      <LeadList leads={leads} />
    </div>
  );
}
