import Link from "next/link";

import type { LeadListRow } from "../app/actions";

type Props = {
  leads: LeadListRow[];
  total?: number;
  page?: number;
  totalPages?: number;
  pageSize?: number;
  basePath?: string;
  showPagination?: boolean;
  condensed?: boolean;
  maxRows?: number;
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

export function LeadList({
  leads,
  total,
  page = 1,
  totalPages = 1,
  pageSize = 50,
  basePath = "/leads",
  showPagination = false,
  condensed = false,
  maxRows,
}: Props) {
  const leadArray = Array.isArray(leads) ? leads : [];
  const hasData = leadArray.length > 0;

  const rows = leadArray.map((lead) => {
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

  const displayRows = typeof maxRows === "number" && maxRows >= 0 ? rows.slice(0, maxRows) : rows;
  const shownCount = displayRows.length;
  const totalCount = rows.length;

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div className="pill">Lead Intake</div>
          <h3 style={{ margin: "10px 0 6px 0" }}>Latest Leads</h3>
          <div className="muted">Newest uploads appear at the top.</div>
        </div>
        <div className="muted">
          {hasData
            ? showPagination && total
              ? `${shownCount} shown • ${total} total`
              : maxRows && totalCount > maxRows
              ? `${shownCount} shown • ${totalCount} total`
              : `${shownCount} loaded`
            : null}
        </div>
      </div>

      {hasData ? (
        <div
          className="table-wrapper"
          style={
            condensed
              ? { maxHeight: 320, overflowY: "auto", marginTop: 12 }
              : { marginTop: 12 }
          }
        >
          <table className="lead-table" style={condensed ? { fontSize: 13, lineHeight: 1.4 } : undefined}>
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
              {displayRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: condensed ? 2 : 4,
                      }}
                    >
                      <strong style={condensed ? { fontSize: 14 } : undefined}>{row.name}</strong>
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

      {showPagination && hasData ? (
        <div className="pager">
          <div className="muted">
            {total
              ? `Showing ${Math.min((page - 1) * pageSize + 1, total)}-${Math.min(
                  page * pageSize,
                  total
                )} of ${total}`
              : `Page ${page}`}
          </div>
          <div className="pager-controls">
            <Link
              className={`pager-btn${page <= 1 ? " disabled" : ""}`}
              href={`${basePath}?page=${Math.max(1, page - 1)}`}
              prefetch
              aria-disabled={page <= 1}
            >
              ← Prev
            </Link>
            <span className="muted">
              Page {page} / {totalPages || 1}
            </span>
            <Link
              className={`pager-btn${page >= (totalPages || 1) ? " disabled" : ""}`}
              href={`${basePath}?page=${Math.min(totalPages || 1, page + 1)}`}
              prefetch
              aria-disabled={page >= (totalPages || 1)}
            >
              Next →
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}
