import { CSVUploader } from "../../components/CSVUploader";
import { DeguraCampaignImporter } from "../../components/DeguraCampaignImporter";
import { fetchLinkedinAccounts } from "../actions";
import { requireServerSession } from "../../lib/auth";
import { fetchDeguraCampaignStatus } from "../actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function UploadPage() {
  await requireServerSession("/upload");
  const [accounts, campaign] = await Promise.all([
    fetchLinkedinAccounts(),
    fetchDeguraCampaignStatus(),
  ]);
  return (
    <div className="page">
      <div className="pill">Import</div>
      <h1 className="page-title">BATCH INTAKE</h1>
      <div className="muted" style={{ marginBottom: 16 }}>
        1) Pick a batch intent. 2) Upload your CSV. 3) Mission Control handles automation, while Custom Outreach keeps manual review separate.
      </div>
      <div style={{ marginBottom: 12 }}>
        <a className="muted" href="/leads">
          View lead list →
        </a>
      </div>
      <DeguraCampaignImporter readinessCodes={campaign.codes} />
      <div className="card" style={{ marginTop: 20 }}>
        <div className="pill">Standard Import</div>
        <h3 className="section-title-tight">OTHER WORKFLOWS</h3>
        <CSVUploader accounts={accounts} />
      </div>
    </div>
  );
}
