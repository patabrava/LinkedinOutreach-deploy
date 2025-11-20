import { LinkedinCredentialsForm } from "../../components/LinkedinCredentialsForm";
import { fetchLinkedinCredentials } from "../actions";

export default async function SettingsPage() {
  const creds = await fetchLinkedinCredentials();

  return (
    <div className="page">
      <div className="pill">Settings</div>
      <h1 style={{ margin: "12px 0 6px 0", fontSize: 32, letterSpacing: "-0.5px" }}>System Settings</h1>
      <div className="muted" style={{ marginBottom: 16 }}>
        Provide LinkedIn credentials so the scraper can log in and cache auth.json automatically.
      </div>

      <LinkedinCredentialsForm existing={creds} />
    </div>
  );
}
