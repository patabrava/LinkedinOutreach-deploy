import { LoginLauncher } from "../../components/LoginLauncher";
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

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 420px", gap: 18, alignItems: "flex-start" }}>
        <LinkedinCredentialsForm existing={creds} />
        <LoginLauncher existingCreds={creds} />
      </div>
    </div>
  );
}
