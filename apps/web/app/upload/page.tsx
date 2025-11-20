import { CSVUploader } from "../../components/CSVUploader";

export default function UploadPage() {
  return (
    <div className="page">
      <div className="pill">Import</div>
      <h1 style={{ margin: "12px 0 6px 0" }}>CSV Uploader</h1>
      <div className="muted" style={{ marginBottom: 16 }}>
        Drag & drop leads. Dedupe runs on linkedin_url.
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
