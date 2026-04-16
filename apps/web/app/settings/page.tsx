import { LoginLauncher } from "../../components/LoginLauncher";
import { fetchLinkedinCredentials } from "../actions";

export default async function SettingsPage() {
  const creds = await fetchLinkedinCredentials();

  return (
    <div className="page">
      <div className="pill">Settings</div>
      <h1 className="page-title">SYSTEM SETTINGS</h1>

      <div style={{ maxWidth: 540 }}>
        <LoginLauncher existingCreds={creds} />
      </div>
    </div>
  );
}
