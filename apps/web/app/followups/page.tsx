import { fetchFollowups, triggerInboxScan, triggerFollowupSender } from "../actions";
import FollowupsList from "../../components/FollowupsList";
import { TriggerButton } from "../../components/TriggerButton";
import { requireServerSession } from "../../lib/auth";

export const dynamic = "force-dynamic";

export default async function FollowupsPage() {
  await requireServerSession("/followups");
  const initial = await fetchFollowups(["PENDING_REVIEW", "APPROVED"], 100);
  return (
    <main className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, gap: 0 }}>
        {/* Server Actions forms */}
        <TriggerButton
          action={triggerInboxScan}
          label="CHECK INBOX"
          pendingLabel="SCANNING INBOX…"
          successMessage="Inbox scan started — watch the list for new replies."
        />
        <TriggerButton
          action={triggerFollowupSender}
          label="SEND APPROVED"
          pendingLabel="SENDING…"
          successMessage="Follow-up sender started."
          variant="secondary"
        />
      </div>
      <FollowupsList initial={initial} />
    </main>
  );
}
