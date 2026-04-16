import { LoginLauncher } from "../../components/LoginLauncher";
import { OperatorTokenForm } from "../../components/OperatorTokenForm";
import { fetchLinkedinCredentials } from "../actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SettingsPage() {
  const creds = await fetchLinkedinCredentials();

  return (
    <div className="page">
      <div className="pill">Settings</div>
      <h1 className="page-title">SYSTEM SETTINGS</h1>

      <div style={{ maxWidth: 540 }}>
        <OperatorTokenForm />
        <LoginLauncher existingCreds={creds} />
      </div>
    </div>
  );
}
