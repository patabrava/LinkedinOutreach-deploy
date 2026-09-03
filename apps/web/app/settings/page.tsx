import { LoginLauncher } from "../../components/LoginLauncher";
import { LinkedinCredentialsForm } from "../../components/LinkedinCredentialsForm";
import { DeguraCampaignSettingsForm } from "../../components/DeguraCampaignSettingsForm";
import { OperatorTokenForm } from "../../components/OperatorTokenForm";
import { requireServerSession } from "../../lib/auth";
import { readLinkedinAuthStatus } from "../../lib/linkedinAuthSession";
import { fetchDeguraCampaignStatus, fetchLinkedinAccounts } from "../actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const EMPTY_CAMPAIGN_STATUS: Awaited<ReturnType<typeof fetchDeguraCampaignStatus>> = {
  ready: false,
  codes: [],
  accounts: [],
  variantCount: 0,
  bookingUrl: "",
  privacyUrl: "",
  guideUrl: "",
  guideAssetPath: "",
};

export default async function SettingsPage() {
  await requireServerSession("/settings");
  const [accounts, campaign] = await Promise.all([
    fetchLinkedinAccounts(),
    fetchDeguraCampaignStatus(),
  ]);

  return (
    <div className="page">
      <div className="pill">Settings</div>
      <h1 className="page-title">SYSTEM SETTINGS</h1>

      <div style={{ maxWidth: 860 }}>
        <OperatorTokenForm />
        <DeguraCampaignSettingsForm
          bookingUrl={campaign.bookingUrl}
          privacyUrl={campaign.privacyUrl}
          guideUrl={campaign.guideUrl}
          guideAssetPath={campaign.guideAssetPath}
        />
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="pill">Activation</div>
          <h3 className="section-title-tight">{campaign.ready ? "READY" : "BLOCKED"}</h3>
          <div className="muted">
            {campaign.ready ? "Two accounts, isolated sessions, six variants and campaign assets are ready." : campaign.codes.join(" · ")}
          </div>
        </div>
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
