import { fetchFollowups, triggerInboxScan, triggerFollowupSender } from "../actions";
import FollowupsList from "../../components/FollowupsList";
import { TriggerButton } from "../../components/TriggerButton";
import { WorkerControlPanel } from "../../components/WorkerControlPanel";
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
      <div style={{ marginBottom: 24 }}>
        <WorkerControlPanel
          title="STOP FOLLOW-UP WORKERS"
          description="Stops inbox scans and approved follow-up sends that are currently running."
          kinds={["scraper_inbox", "sender_followup"]}
          stopLabel="STOP FOLLOW-UPS"
        />
      </div>
      <FollowupsList initial={initial} />
    </main>
  );
}
