import { fetchFollowups, triggerInboxScan, triggerFollowupSender } from "../actions";
import FollowupsList from "../../components/FollowupsList";

export const dynamic = "force-dynamic";

export default async function FollowupsPage() {
  const initial = await fetchFollowups(["PENDING_REVIEW", "APPROVED"], 100);
  return (
    <main className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, gap: 0 }}>
        {/* Server Actions forms */}
        <form action={triggerInboxScan}>
          <button className="btn" type="submit">CHECK INBOX</button>
        </form>
        <form action={triggerFollowupSender}>
          <button className="btn secondary" type="submit">SEND APPROVED</button>
        </form>
      </div>
      <FollowupsList initial={initial} />
    </main>
  );
}
