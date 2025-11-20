import { LeadList } from "../../components/LeadList";
import { LoginLauncher } from "../../components/LoginLauncher";
import { StartEnrichmentButton } from "../../components/StartEnrichmentButton";
import { fetchLeadList, fetchLinkedinCredentials } from "../actions";
export default async function LeadsPage({
  searchParams,
}: {
  searchParams?: { page?: string };
}) {
  const currentPage = Math.max(1, Number(searchParams?.page) || 1);
  const [leads, creds] = await Promise.all([fetchLeadList(currentPage, 50), fetchLinkedinCredentials()]);

  return (
    <div className="page">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 380px",
          gap: 18,
          alignItems: "flex-start",
          marginBottom: 18,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="pill">Leads</div>
          <h1 style={{ margin: "12px 0 6px 0", fontSize: 32, letterSpacing: "-0.5px" }}>Lead Intake</h1>
          <div className="muted">Upload a CSV and review everything that landed.</div>
          <div style={{ marginTop: 6 }}>
            <a className="muted" href="/settings">
              Set LinkedIn credentials →
            </a>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <LoginLauncher existingCreds={creds} />
          <div className="card" style={{ padding: 16 }}>
            <div className="pill">Automation Control</div>
            <h3 style={{ margin: "12px 0 6px 0" }}>Lead enrichment</h3>
            <div className="muted" style={{ marginBottom: 12 }}>
              Kick off scraping when you are ready. Progress updates live as leads are enriched.
            </div>
            <StartEnrichmentButton />
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
