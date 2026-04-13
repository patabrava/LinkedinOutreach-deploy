"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import type { LeadListRow } from "../app/actions";
import { supabaseBrowserClient } from "../lib/supabaseClient";

type LeadFilters = {
  status?: string;
  company?: string;
  name?: string;
  linkedin?: string;
};

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
  initialFilters?: LeadFilters;
};

type SortKey = "name" | "company" | "status" | "followupCount" | "createdAt" | "updatedAt";

type SequenceDefinition = {
  id: string;
  name: string;
};

const SEQUENCES_STORAGE_KEY = "outreach_sequences_v1";
const BATCH_ASSIGNMENTS_STORAGE_KEY = "csv_batch_sequence_assignments_v1";
const UPDATE_EVENT = "outreach-sequences-updated";
const UNASSIGNED_BATCH = "unassigned";

const statusClasses: Record<string, string> = {
  NEW: "status-new",
  ENRICHED: "status-enriched",
  DRAFT_READY: "status-draft",
  APPROVED: "status-approved",
  REJECTED: "status-rejected",
  SENT: "status-sent",
  PENDING_REVIEW: "status-pending",
  PROCESSING: "status-processing",
  FAILED: "status-failed",
};

const statusOrder: Record<string, number> = {
  NEW: 0,
  ENRICHED: 1,
  DRAFT_READY: 2,
  APPROVED: 3,
  REJECTED: 4,
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

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const safeParseJson = <T,>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const getBatchKey = (lead: LeadListRow): string => {
  const raw = lead.batch_name || lead.batch_id || lead.profile_data?.csv_batch_name || lead.profile_data?.csv_filename;

  if ((typeof raw !== "string" && typeof raw !== "number") || `${raw}`.trim() === "") {
    return UNASSIGNED_BATCH;
  }
  return `${raw}`.trim();
};

const formatBatchLabel = (batchKey: string): string => {
  if (batchKey === UNASSIGNED_BATCH) return "Unassigned";
  return batchKey;
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
  initialFilters,
}: Props) {
  const [filters, setFilters] = useState<LeadFilters>({
    status: initialFilters?.status || "",
    company: initialFilters?.company || "",
    name: initialFilters?.name || "",
    linkedin: initialFilters?.linkedin || "",
  });
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" } | null>(null);
  const [sequenceById, setSequenceById] = useState<Record<string, SequenceDefinition>>({});
  const [assignmentByBatch, setAssignmentByBatch] = useState<Record<string, string>>({});

  useEffect(() => {
    setFilters((prev) => {
      const next = {
        status: initialFilters?.status || "",
        company: initialFilters?.company || "",
        name: initialFilters?.name || "",
        linkedin: initialFilters?.linkedin || "",
      };
      const isSame =
        prev.status === next.status &&
        prev.company === next.company &&
        prev.name === next.name &&
        prev.linkedin === next.linkedin;
      return isSame ? prev : next;
    });
  }, [initialFilters?.status, initialFilters?.company, initialFilters?.name, initialFilters?.linkedin]);

  const mapLeadToRow = (lead: LeadListRow) => {
    const statusKey = (lead.status || "NEW").toUpperCase();
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || "Name pending";
    const company = lead.company_name || lead.profile_data?.current_company || "Company pending";
    const headline =
      lead.profile_data?.headline ||
      lead.profile_data?.current_title ||
      lead.profile_data?.about ||
      "";
    const recentActivity = Array.isArray(lead.recent_activity) ? lead.recent_activity : [];

    return {
      id: lead.id,
      name,
      company,
      headline: headline || null,
      linkedinUrl: lead.linkedin_url || "",
      batchKey: getBatchKey(lead),
      status: statusKey,
      statusClass: statusClasses[statusKey] || "status-new",
      followupCount: typeof lead.followup_count === "number" ? lead.followup_count : 0,
      lastReplyAt: lead.last_reply_at || null,
      createdAt: lead.created_at,
      updatedAt: lead.updated_at,
      recentActivity,
    };
  };

  const headerButtonStyle = {
    background: "none",
    border: "none",
    color: "inherit",
    padding: 0,
    margin: 0,
    font: "inherit",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  };

  const toggleSort = (key: SortKey) => {
    setSort((current) => {
      if (!current || current.key !== key) return { key, direction: "asc" };
      if (current.direction === "asc") return { key, direction: "desc" };
      return null;
    });
  };

  const renderSortButton = (label: string, key: SortKey, ariaLabel?: string) => {
    const isActive = sort?.key === key;
    const icon = isActive ? (sort.direction === "asc" ? "↑" : "↓") : "↕";
    return (
      <button
        type="button"
        onClick={() => toggleSort(key)}
        style={headerButtonStyle}
        aria-label={`Sort by ${ariaLabel || label}${isActive ? ` (${sort.direction})` : ""}`}
        aria-pressed={isActive}
      >
        {label}
        <span aria-hidden style={{ fontSize: 10, opacity: isActive ? 1 : 0.5, lineHeight: 1 }}>
          {icon}
        </span>
      </button>
    );
  };

  const getSortValue = (row: ReturnType<typeof mapLeadToRow>, key: SortKey) => {
    switch (key) {
      case "name":
        return (row.name || "").toLowerCase();
      case "company":
        return (row.company || "").toLowerCase();
      case "status":
        return statusOrder[row.status] ?? Number.MAX_SAFE_INTEGER;
      case "followupCount":
        return row.followupCount || 0;
      case "createdAt": {
        const ts = row.createdAt ? Date.parse(row.createdAt) : NaN;
        return Number.isNaN(ts) ? 0 : ts;
      }
      case "updatedAt": {
        const ts = row.updatedAt ? Date.parse(row.updatedAt) : NaN;
        return Number.isNaN(ts) ? 0 : ts;
      }
      default:
        return 0;
    }
  };

  const matchesFilters = (row: ReturnType<typeof mapLeadToRow>) => {
    if (filters.status && row.status !== filters.status.toUpperCase()) return false;
    if (filters.company && !row.company.toLowerCase().includes(filters.company.toLowerCase())) return false;
    if (filters.linkedin && !row.linkedinUrl.toLowerCase().includes(filters.linkedin.toLowerCase())) return false;
    if (filters.name) {
      const target = filters.name.toLowerCase();
      const fullName = row.name.toLowerCase();
      if (!fullName.includes(target)) return false;
    }
    return true;
  };

  const [rows, setRows] = useState(() => (Array.isArray(leads) ? leads.map(mapLeadToRow) : []));

  // Keep local state in sync when server data changes
  useEffect(() => {
    const mapped = Array.isArray(leads) ? leads.map(mapLeadToRow) : [];
    setRows(mapped.filter(matchesFilters));
  }, [leads, filters.status, filters.company, filters.linkedin, filters.name]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncSequenceConfig = () => {
      const sequences = safeParseJson<SequenceDefinition[]>(
        window.localStorage.getItem(SEQUENCES_STORAGE_KEY),
        []
      );
      const assignments = safeParseJson<Record<string, string>>(
        window.localStorage.getItem(BATCH_ASSIGNMENTS_STORAGE_KEY),
        {}
      );
      setSequenceById(Object.fromEntries(sequences.map((sequence) => [sequence.id, sequence])));
      setAssignmentByBatch(assignments);
    };

    syncSequenceConfig();
    window.addEventListener("storage", syncSequenceConfig);
    window.addEventListener(UPDATE_EVENT, syncSequenceConfig);
    return () => {
      window.removeEventListener("storage", syncSequenceConfig);
      window.removeEventListener(UPDATE_EVENT, syncSequenceConfig);
    };
  }, []);

  // Subscribe to realtime lead updates so status bar and enrichment details stay fresh
  useEffect(() => {
    const supabase = supabaseBrowserClient();
    const channel = supabase
      .channel("leads-status-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leads" },
        (payload) => {
          const updated = payload.new as LeadListRow | null;
          if (!updated) return;

          setRows((current) => {
            const incoming = mapLeadToRow(updated);
            if (!matchesFilters(incoming)) {
              // Remove rows that no longer match filters
              return current.filter((r) => r.id !== incoming.id);
            }
            const existingIdx = current.findIndex((row) => row.id === incoming.id);
            if (existingIdx === -1) {
              // Only add new rows to the top if we are showing the newest slice
              const next = [incoming, ...current];
              return typeof maxRows === "number" && maxRows >= 0 ? next.slice(0, maxRows) : next;
            }
            const next = [...current];
            next[existingIdx] = incoming;
            // Keep newest first by createdAt if available
            return next.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [maxRows, filters.status, filters.company, filters.linkedin, filters.name]);

  const displayRows = useMemo(() => {
    const working = [...rows];
    if (sort) {
      working.sort((a, b) => {
        const aVal = getSortValue(a, sort.key);
        const bVal = getSortValue(b, sort.key);
        if (typeof aVal === "string" && typeof bVal === "string") {
          return sort.direction === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        }
        const diff = (aVal as number) - (bVal as number);
        return sort.direction === "asc" ? diff : -diff;
      });
    }
    return typeof maxRows === "number" && maxRows >= 0 ? working.slice(0, maxRows) : working;
  }, [rows, sort, maxRows]);

  const shownCount = displayRows.length;
  const totalCount = rows.length;
  const hasData = shownCount > 0;

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div className="pill">Lead Intake</div>
          <h3 style={{ margin: "12px 0 8px 0" }}>LATEST LEADS</h3>
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
              ? { maxHeight: 320, overflowY: "auto", marginTop: 16 }
              : { marginTop: 16 }
          }
        >
          <table className="lead-table" style={condensed ? { fontSize: 12, lineHeight: 1.4 } : undefined}>
            <thead>
              <tr>
                <th>
                  {renderSortButton("LEAD", "name", "lead name")}
                </th>
                <th>
                  {renderSortButton("COMPANY", "company")}
                </th>
                <th>
                  {renderSortButton("STATUS", "status")}
                </th>
                <th>
                  {renderSortButton("FOLLOW-UPS", "followupCount", "follow-ups")}
                </th>
                <th>
                  {renderSortButton("ADDED", "createdAt", "added date")}
                </th>
                <th>
                  {renderSortButton("UPDATED", "updatedAt", "updated date")}
                </th>
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
                      <strong style={condensed ? { fontSize: 13 } : undefined}>{row.name}</strong>
                      <a
                        className="muted"
                        href={row.linkedinUrl?.trim() || undefined}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {row.linkedinUrl?.trim() || "LinkedIn pending"}
                      </a>
                      {row.headline ? (
                        <span className="muted" style={{ fontSize: condensed ? 11 : 12 }}>
                          {row.headline}
                        </span>
                      ) : null}
                      {row.lastReplyAt ? (
                        <span className="muted" style={{ fontSize: condensed ? 11 : 12 }}>
                          Last reply: {formatDate(row.lastReplyAt)}
                        </span>
                      ) : null}
                      {row.recentActivity?.[0]?.text ? (
                        <span className="muted" style={{ fontSize: condensed ? 11 : 12 }}>
                          Recent: {row.recentActivity[0].text.slice(0, 140)}
                          {row.recentActivity[0].text.length > 140 ? "…" : ""}
                        </span>
                      ) : null}
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                        <span className="status-chip">Batch: {formatBatchLabel(row.batchKey)}</span>
                        {assignmentByBatch[row.batchKey] && sequenceById[assignmentByBatch[row.batchKey]]?.name ? (
                          <span className="status-chip status-approved">
                            Sequence: {sequenceById[assignmentByBatch[row.batchKey]]?.name}
                          </span>
                        ) : (
                          <span className="status-chip status-pending">No sequence</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>{row.company}</td>
                  <td>
                    <span className={`status-chip ${row.statusClass}`}>
                      {formatStatus(row.status)}
                    </span>
                  </td>
                  <td>
                    {row.followupCount > 0 ? (
                      <span className="status-chip">
                        {row.followupCount}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{formatDate(row.createdAt)}</td>
                  <td>{formatDate(row.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted" style={{ marginTop: 16 }}>
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
              ← PREV
            </Link>
            <span className="muted" style={{ padding: "0 16px" }}>
              PAGE {page} / {totalPages || 1}
            </span>
            <Link
              className={`pager-btn${page >= (totalPages || 1) ? " disabled" : ""}`}
              href={`${basePath}?page=${Math.min(totalPages || 1, page + 1)}`}
              prefetch
              aria-disabled={page >= (totalPages || 1)}
            >
              NEXT →
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}
