import { LeadList } from "../../components/LeadList";
import { StartEnrichmentButton } from "../../components/StartEnrichmentButton";
import { TriggerButton } from "../../components/TriggerButton";
import { fetchLeadList, triggerFollowupSender } from "../actions";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams?: { page?: string; status?: string; company?: string; name?: string; linkedin?: string };
}) {
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
          <div className="pill">Batch Dashboard</div>
          <h1 style={{ margin: "16px 0 8px 0" }}>BATCHES</h1>
          <div className="muted">
            Upload leads, pick a batch, then run the next step for that batch intent. Connect-only sends invites without a note. Connect + Message prepares leads for messaging after acceptance.
          </div>
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
            <h3 style={{ margin: "12px 0 8px 0" }}>RUN WHAT'S NEXT</h3>
            <div className="muted">These actions run across all eligible leads (across batches) for the selected intent.</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, border: "3px solid #000", padding: 16 }}>
            <div>
              <strong>CONNECT + MESSAGE</strong>
              <div className="muted" style={{ marginTop: 4 }}>Step 1: Enrich NEW leads so they're ready for messaging after acceptance.</div>
            </div>
            <StartEnrichmentButton mode="message" variant="dashboard" />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, border: "3px solid #000", padding: 16 }}>
            <div>
              <strong>CONNECT ONLY</strong>
              <div className="muted" style={{ marginTop: 4 }}>Send connection requests without a note for connect-only batches.</div>
            </div>
            <StartEnrichmentButton mode="connect_only" variant="dashboard" />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, border: "3px solid #000", padding: 16 }}>
            <div>
              <strong>MESSAGING + SEQUENCES</strong>
              <div className="muted" style={{ marginTop: 4 }}>Review drafts, approvals, and post-acceptance sequences.</div>
            </div>
            <a className="btn secondary" href="/">
              OPEN MESSAGING
            </a>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, border: "3px solid #000", padding: 16 }}>
            <div>
              <strong>FOLLOW-UPS</strong>
              <div className="muted" style={{ marginTop: 4 }}>Send all approved follow-up messages to due leads.</div>
            </div>
            <TriggerButton
              action={triggerFollowupSender}
              label="SEND DUE FOLLOW-UPS"
              pendingLabel="SENDING…"
              successMessage="Follow-up sender started."
              variant="secondary"
            />
          </div>

          <div className="muted" style={{ marginTop: 4 }}>Tip: use the Batch selector below to focus on one upload at a time.</div>
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
