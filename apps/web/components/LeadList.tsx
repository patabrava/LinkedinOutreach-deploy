import type { LeadListRow } from "../app/actions";

type Props = {
  leads: LeadListRow[];
};

const statusStyle: Record<string, { bg: string; color: string }> = {
  NEW: { bg: "rgba(34, 211, 238, 0.18)", color: "#67e8f9" },
  ENRICHED: { bg: "rgba(168, 85, 247, 0.18)", color: "#e9d5ff" },
  DRAFT_READY: { bg: "rgba(132, 204, 22, 0.18)", color: "#d9f99d" },
  APPROVED: { bg: "rgba(52, 211, 153, 0.18)", color: "#a7f3d0" },
  REJECTED: { bg: "rgba(248, 113, 113, 0.18)", color: "#fecdd3" },
};

const formatStatus = (status?: string | null) => (status || "NEW").replace(/_/g, " ");

const formatDate = (iso?: string | null) => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export function LeadList({ leads }: Props) {
  const hasData = leads && leads.length > 0;

  const rows = (leads || []).map((lead) => {
    const statusKey = (lead.status || "NEW").toUpperCase();
    const style = statusStyle[statusKey] || { bg: "rgba(255,255,255,0.08)", color: "#cbd5e1" };
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || "Name pending";
    const company = lead.company_name || "Company pending";

    return {
      id: lead.id,
      name,
      company,
      linkedinUrl: lead.linkedin_url || "",
      status: statusKey,
      style,
      createdAt: lead.created_at,
      updatedAt: lead.updated_at,
    };
  });

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div className="pill">Lead Intake</div>
          <h3 style={{ margin: "10px 0 6px 0" }}>Latest Leads</h3>
          <div className="muted">Newest uploads appear at the top.</div>
        </div>
        <div className="muted">{hasData ? `${leads.length} loaded` : null}</div>
      </div>

      {hasData ? (
        <div className="table-wrapper">
          <table className="lead-table">
            <thead>
              <tr>
                <th>Lead</th>
                <th>Company</th>
                <th>Status</th>
                <th>Added</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <strong>{row.name}</strong>
                      <a
                        className="muted"
                        href={row.linkedinUrl?.trim() || undefined}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {row.linkedinUrl?.trim() || "LinkedIn pending"}
                      </a>
                    </div>
                  </td>
                  <td>{row.company}</td>
                  <td>
                    <span
                      className="status-chip"
                      style={{ background: row.style.bg, color: row.style.color }}
                    >
                      {formatStatus(row.status)}
                    </span>
                  </td>
                  <td>{formatDate(row.createdAt)}</td>
                  <td>{formatDate(row.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted" style={{ marginTop: 12 }}>
          Upload a CSV to see leads populate instantly.
        </div>
      )}
    </section>
  );
}
