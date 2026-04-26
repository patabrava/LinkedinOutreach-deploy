import { LeadList } from "../../components/LeadList";
import { LeadRunControls } from "../../components/LeadRunControls";
import { SenderMessageOnlyControl } from "../../components/SenderMessageOnlyControl";
import { TriggerButton } from "../../components/TriggerButton";
import { WorkerControlPanel } from "../../components/WorkerControlPanel";
import { requireServerSession } from "../../lib/auth";
import { fetchLeadList, fetchOutreachSequences, triggerFollowupSender } from "../actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams?: { page?: string; status?: string; company?: string; name?: string; linkedin?: string };
}) {
  await requireServerSession("/leads");
  const sequences = await fetchOutreachSequences();
  const currentPage = Math.max(1, Number(searchParams?.page) || 1);
  const filters = {
    status: (searchParams?.status || "").trim(),
    company: (searchParams?.company || "").trim(),
    name: (searchParams?.name || "").trim(),
    linkedin: (searchParams?.linkedin || "").trim(),
  };
  // Slightly larger slice makes the batch dashboard more useful without adding new endpoints.
  const leads = await fetchLeadList(currentPage, 150, filters);

  return (
    <div className="page">
      <div className="dashboard-grid">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <h1 className="page-title">LEADS OPERATIONS</h1>
            <span className="pill">Batch Operations</span>
          </div>
          <div className="muted" style={{ maxWidth: 620 }}>Upload leads, pick a batch, and run the next step for that batch&apos;s intent.</div>
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10 }}>
            <a className="btn secondary" href="/upload">
              UPLOAD NEW BATCH
            </a>
            <a className="btn secondary" href="/settings">
              SETTINGS
            </a>
          </div>
        </div>
        <LeadRunControls sequences={sequences} />

        <div className="card" style={{ padding: 20, borderLeft: "none", borderTop: "none", borderBottom: "none" }}>
          <div className="pill">Follow-Ups</div>
          <h3 className="page-title">SEND DUE FOLLOW-UPS</h3>
          <div className="muted">Approved follow-ups still run independently of the sequence selector.</div>
          <div style={{ marginTop: 12 }}>
            <TriggerButton
              action={triggerFollowupSender}
              label="SEND DUE FOLLOW-UPS"
              pendingLabel="SENDING…"
              successMessage="Follow-up sender started."
              variant="secondary"
            />
          </div>
        </div>

        <SenderMessageOnlyControl />
      </div>

      <div style={{ marginTop: 20 }}>
        <WorkerControlPanel
          title="STOP MESSAGING WORKERS"
          description="Stops post-acceptance first-message sends, sequence sends, and draft-generation runs from Mission Control."
          kinds={["sender_outreach", "draft_agent"]}
          stopLabel="STOP MESSAGING"
        />
      </div>

      <div style={{ marginTop: 20 }}>
        <WorkerControlPanel
          title="STOP INVITATION OUTREACH"
          description="Stops the active LinkedIn invitation worker for connect + message or connect-only runs."
          kinds={["scraper_outreach"]}
          stopLabel="STOP INVITES"
        />
      </div>

      <LeadList
        leads={leads.leads}
        total={leads.total}
        page={leads.page}
        totalPages={leads.totalPages}
        pageSize={leads.pageSize}
        basePath="/leads"
        showPagination
      />
    </div>
  );
}
