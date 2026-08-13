import { LoginLauncher } from "../../components/LoginLauncher";
import { LinkedinCredentialsForm } from "../../components/LinkedinCredentialsForm";
import { OperatorTokenForm } from "../../components/OperatorTokenForm";
import { requireServerSession } from "../../lib/auth";
import { readLinkedinAuthStatus } from "../../lib/linkedinAuthSession";
import { fetchLinkedinAccounts } from "../actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SettingsPage() {
  await requireServerSession("/settings");
  const accounts = await fetchLinkedinAccounts();

  return (
    <div className="page">
      <div className="pill">Settings</div>
      <h1 className="page-title">SYSTEM SETTINGS</h1>

      <div style={{ maxWidth: 860 }}>
        <OperatorTokenForm />
        <div style={{ display: "grid", gap: 20 }}>
          {accounts.map((account) => (
            <LoginLauncher
              key={account.id}
              accountId={account.id}
              existingCreds={account}
              authStatus={readLinkedinAuthStatus(account.id, account.isPrimary)}
            />
          ))}
          <LinkedinCredentialsForm existing={{ hasPassword: false, is_active: true }} />
        </div>
      </div>
    </div>
  );
}
