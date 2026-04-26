import { CSVUploader } from "../../components/CSVUploader";
import { requireServerSession } from "../../lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function UploadPage() {
  await requireServerSession("/upload");
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
      <div className="card">
        <CSVUploader />
      </div>
    </div>
  );
}
