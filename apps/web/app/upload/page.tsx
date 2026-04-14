import { CSVUploader } from "../../components/CSVUploader";

export default function UploadPage() {
  return (
    <div className="page">
      <div className="pill">Import</div>
      <h1 style={{ margin: "16px 0 8px 0" }}>BATCH INTAKE</h1>
      <div className="muted" style={{ marginBottom: 16 }}>
        1) Pick a batch intent. 2) Upload your CSV. 3) Go to the lead list to start the next step.
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
