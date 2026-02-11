import { LeadList } from "../../components/LeadList";
import { StartEnrichmentButton } from "../../components/StartEnrichmentButton";
import { fetchLeadList } from "../actions";

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
  const leads = await fetchLeadList(currentPage, 50, filters);

  return (
    <div className="page">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 380px",
          gap: 0,
          alignItems: "flex-start",
          marginBottom: 24,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="pill">Leads</div>
          <h1 style={{ margin: "16px 0 8px 0" }}>LEAD INTAKE</h1>
          <div className="muted">Upload a CSV and review everything that landed.</div>
          <div style={{ marginTop: 8 }}>
            <a className="muted" href="/settings">
              Set LinkedIn credentials →
            </a>
          </div>
        </div>
        <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, borderLeft: "none", borderTop: "none", borderBottom: "none" }}>
          <div>
            <div className="pill">Automation Control</div>
            <h3 style={{ margin: "12px 0 8px 0" }}>LEAD ENRICHMENT</h3>
            <div className="muted">
              Run enrichment in two modes: prepare message drafts (standard) or send a connection request without a
              note for leads flagged as connect-only.
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              border: "3px solid #000",
              padding: 16,
            }}
          >
            <div>
              <strong>STANDARD ENRICHMENT + DRAFTS</strong>
              <div className="muted" style={{ marginTop: 4 }}>
                Enrich NEW leads and move them toward draft generation.
              </div>
            </div>
            <StartEnrichmentButton mode="message" />
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              border: "3px solid #000",
              padding: 16,
            }}
          >
            <div>
              <strong>ENRICH + CONNECT (NO NOTE)</strong>
              <div className="muted" style={{ marginTop: 4 }}>
                Targets leads whose outreach_mode is set to connect_only. After enrichment, a connection
                request is sent without drafting a message.
              </div>
            </div>
            <StartEnrichmentButton mode="connect_only" />
          </div>

          <div className="muted" style={{ marginTop: 4 }}>
            Manage LinkedIn login & credentials in <a href="/settings">Settings</a>.
          </div>
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
