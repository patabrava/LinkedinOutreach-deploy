import { LoginLauncher } from "../../components/LoginLauncher";
import { LinkedinCredentialsForm } from "../../components/LinkedinCredentialsForm";
import { fetchLinkedinCredentials } from "../actions";

export default async function SettingsPage() {
  const creds = await fetchLinkedinCredentials();

  return (
    <div className="page">
      <div className="pill">Settings</div>
      <h1 style={{ margin: "16px 0 8px 0" }}>SYSTEM SETTINGS</h1>
      <div className="muted" style={{ marginBottom: 16 }}>
        Provide LinkedIn credentials so the scraper can log in and cache auth.json automatically.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 420px", gap: 0, alignItems: "flex-start" }}>
        <LinkedinCredentialsForm existing={creds} />
        <LoginLauncher existingCreds={creds} />
      </div>
    </div>
  );
}
