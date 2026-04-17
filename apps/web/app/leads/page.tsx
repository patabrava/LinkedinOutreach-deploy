import { LeadList } from "../../components/LeadList";
import { StartEnrichmentButton } from "../../components/StartEnrichmentButton";
import { TriggerButton } from "../../components/TriggerButton";
import { requireServerSession } from "../../lib/auth";
import { fetchLeadList, triggerFollowupSender } from "../actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams?: { page?: string; status?: string; company?: string; name?: string; linkedin?: string };
}) {
  await requireServerSession("/leads");
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
            <h1 className="page-title">BATCHES</h1>
            <span className="pill">Batch Dashboard</span>
          </div>
          <div className="muted" style={{ maxWidth: 620 }}>Upload leads, pick a batch, run the next step for that batch&apos;s intent.</div>
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10 }}>
            <a className="btn secondary" href="/upload">
              UPLOAD NEW BATCH
            </a>
            <a className="btn secondary" href="/settings">
              SETTINGS
            </a>
          </div>
        </div>
        <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, borderLeft: "none", borderTop: "none", borderBottom: "none" }}>
          <div>
            <div className="pill">Next Actions</div>
            <h3 className="page-title">RUN WHAT&apos;S NEXT</h3>
            <div className="muted">These actions run across all eligible leads (across batches) for the selected intent.</div>
          </div>

          <div className="action-stack">
            <div className="action-stack__row action-stack__row--primary">
              <div className="action-stack__header">
                <strong>CONNECT + MESSAGE</strong>
                <div className="muted">Step 1: Enrich NEW leads so they&apos;re ready for messaging after acceptance.</div>
              </div>
              <StartEnrichmentButton mode="message" variant="dashboard" />
            </div>

            <div className="action-stack__row">
              <div className="action-stack__header">
                <strong>CONNECT ONLY</strong>
                <div className="muted">Send connection requests without a note for connect-only batches.</div>
              </div>
              <StartEnrichmentButton mode="connect_only" variant="dashboard" />
            </div>

            <div className="action-stack__row">
              <div className="action-stack__header">
                <strong>MESSAGING + SEQUENCES</strong>
                <div className="muted">Review drafts, approvals, and post-acceptance sequences.</div>
              </div>
              <a className="btn secondary" href="/">OPEN MESSAGING</a>
            </div>

            <div className="action-stack__row">
              <div className="action-stack__header">
                <strong>FOLLOW-UPS</strong>
                <div className="muted">Send all approved follow-up messages to due leads.</div>
              </div>
              <TriggerButton
                action={triggerFollowupSender}
                label="SEND DUE FOLLOW-UPS"
                pendingLabel="SENDING…"
                successMessage="Follow-up sender started."
                variant="secondary"
              />
            </div>
          </div>

          <div className="muted" style={{ marginTop: 12 }}>Tip: use the Batch selector below to focus on one upload at a time.</div>
        </div>
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
