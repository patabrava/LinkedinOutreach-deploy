import { fetchFollowups, triggerInboxScan, triggerFollowupSender } from "../actions";
import FollowupsList from "../../components/FollowupsList";

export const dynamic = "force-dynamic";

export default async function FollowupsPage() {
  const initial = await fetchFollowups(["PENDING_REVIEW", "APPROVED"], 100);
  return (
    <main className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        {/* Server Actions forms */}
        <form action={triggerInboxScan}>
          <button className="btn" type="submit">Check Inbox</button>
        </form>
        <form action={triggerFollowupSender}>
          <button className="btn secondary" type="submit">Send Approved</button>
        </form>
      </div>
      <FollowupsList initial={initial} />
    </main>
  );
}
