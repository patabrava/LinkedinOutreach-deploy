"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import type { LeadListRow } from "../app/actions";
import { isSupabaseBrowserConfigured, supabaseBrowserClient } from "../lib/supabaseClient";

type LeadFilters = {
  status?: string;
  company?: string;
  name?: string;
  linkedin?: string;
  batch?: string;
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

type LeadDisplayRow = {
  id: string;
  name: string;
  company: string;
  headline: string | null;
  linkedinUrl: string;
  batchKey: string;
  batchId: number | null;
  batchName: string | null;
  sequenceId: number | null;
  sequenceName: string | null;
  batchSequenceId: number | null;
  status: string;
  statusLabel: string;
  statusClass: string;
  followupCount: number;
  lastReplyAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  recentActivity: any[];
  connectionSentAt: string | null;
  connectionAcceptedAt: string | null;
  sentAt: string | null;
  sequenceStep: number;
};

const SEQUENCES_STORAGE_KEY = "outreach_sequences_v1";
const BATCH_ASSIGNMENTS_STORAGE_KEY = "csv_batch_sequence_assignments_v1";
const UPDATE_EVENT = "outreach-sequences-updated";
const UNASSIGNED_BATCH = "unassigned";

const statusClasses: Record<string, string> = {
  NEW: "status-new",
  ENRICHED: "status-enriched",
  CONNECT_SENT: "status-pending",
  CONNECT_ONLY_SENT: "status-pending",
  CONNECTED: "status-approved",
  DRAFT_READY: "status-draft",
  APPROVED: "status-approved",
  MESSAGE_ONLY_READY: "status-draft",
  MESSAGE_ONLY_APPROVED: "status-approved",
  REJECTED: "status-rejected",
  SENT: "status-sent",
  PENDING_REVIEW: "status-pending",
  PROCESSING: "status-processing",
  FAILED: "status-failed",
};

const statusOrder: Record<string, number> = {
  NEW: 0,
  ENRICHED: 10,
  CONNECT_SENT: 20,
  CONNECT_ONLY_SENT: 20,
  CONNECTED: 30,
  DRAFT_READY: 40,
  APPROVED: 50,
  MESSAGE_ONLY_READY: 60,
  MESSAGE_ONLY_APPROVED: 70,
  SENT: 80,
  REJECTED: 90,
};

const STATUS_LABELS: Record<string, string> = {
  NEW: "New",
  ENRICHED: "Enriched",
  CONNECT_SENT: "Invite sent",
  CONNECT_ONLY_SENT: "Invite sent (no note)",
  CONNECTED: "Accepted",
  DRAFT_READY: "Draft ready",
  APPROVED: "Approved",
  MESSAGE_ONLY_READY: "Post-acceptance draft ready",
  MESSAGE_ONLY_APPROVED: "Post-acceptance approved",
  REJECTED: "Rejected",
  SENT: "Sent",
};

const formatStatus = (status?: string | null) => {
  const key = (status || "NEW").toUpperCase();
  return STATUS_LABELS[key] || key.replace(/_/g, " ");
};

const formatLifecycleStatus = (lead: LeadListRow) => {
  if (lead.sent_at) {
    if ((lead.sequence_step ?? 0) <= 1) {
      return "First message sent";
    }
    return "Message sent";
  }

  if (lead.connection_accepted_at) {
    return "Accepted";
  }

  if (lead.connection_sent_at) {
    return "Invite sent";
  }

  return formatStatus(lead.status);
};

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

const getSequenceLabel = (
  row: LeadDisplayRow,
  sequenceById: Record<string, SequenceDefinition>,
  assignmentByBatch: Record<string, string>,
  batchKey: string
) => {
  if (row.sequenceName?.trim()) {
    return row.sequenceName.trim();
  }

  if (typeof row.sequenceId === "number") {
    const serverSequence = sequenceById[String(row.sequenceId)]?.name;
    if (serverSequence) {
      return serverSequence;
    }
  }

  if (typeof row.batchSequenceId === "number") {
    const batchSequence = sequenceById[String(row.batchSequenceId)]?.name;
    if (batchSequence) {
      return batchSequence;
    }
  }

  const localSequenceId = assignmentByBatch[batchKey];
  if (localSequenceId && sequenceById[localSequenceId]?.name) {
    return sequenceById[localSequenceId].name;
  }

  return null;
};

const inferBatchIntent = (label: string): "connect_only" | "connect_message" | null => {
  const normalized = (label || "").toLowerCase();
  if (normalized.includes("connect only")) return "connect_only";
  if (normalized.includes("connect + message")) return "connect_message";
  if (normalized.includes("connect+message")) return "connect_message";
  return null;
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
    batch: "",
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
        batch: prev.batch || "",
      };
      const isSame =
        prev.status === next.status &&
        prev.company === next.company &&
        prev.name === next.name &&
        prev.linkedin === next.linkedin &&
        prev.batch === next.batch;
      return isSame ? prev : next;
    });
  }, [initialFilters?.status, initialFilters?.company, initialFilters?.name, initialFilters?.linkedin]);

  const mapLeadToRow = (lead: LeadListRow): LeadDisplayRow => {
    const statusKey = (lead.status || "NEW").toUpperCase();
    const lifecycleStatus = formatLifecycleStatus(lead);
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
      batchId: lead.batch_id ?? null,
      batchName: lead.batch_name ?? null,
      sequenceId: lead.sequence_id ?? null,
      sequenceName: lead.sequence_name ?? null,
      batchSequenceId: lead.batch_sequence_id ?? null,
      status: statusKey,
      statusLabel: lifecycleStatus,
      statusClass: statusClasses[statusKey] || "status-new",
      followupCount: typeof lead.followup_count === "number" ? lead.followup_count : 0,
      lastReplyAt: lead.last_reply_at || null,
      createdAt: lead.created_at || null,
      updatedAt: lead.updated_at || null,
      recentActivity,
      connectionSentAt: lead.connection_sent_at || null,
      connectionAcceptedAt: lead.connection_accepted_at || null,
      sentAt: lead.sent_at || null,
      sequenceStep: lead.sequence_step ?? 0,
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
    if (filters.batch && row.batchKey !== filters.batch) return false;
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

  const [allRows, setAllRows] = useState(() => (Array.isArray(leads) ? leads.map(mapLeadToRow) : []));

  // Keep local state in sync when server data changes
  useEffect(() => {
    const mapped = Array.isArray(leads) ? leads.map(mapLeadToRow) : [];
    setAllRows(mapped);
  }, [leads]);

  const filteredRows = useMemo(() => {
    return allRows.filter(matchesFilters);
  }, [allRows, filters.batch, filters.status, filters.company, filters.linkedin, filters.name]);

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
    if (!isSupabaseBrowserConfigured()) {
      return;
    }
    const supabase = supabaseBrowserClient();
    if (!supabase) {
      return;
    }
    const channel = supabase
      .channel("leads-status-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leads" },
        (payload) => {
          const updated = payload.new as LeadListRow | null;
          if (!updated) return;

          setAllRows((current) => {
            const incoming = mapLeadToRow(updated);
            const existingIdx = current.findIndex((row) => row.id === incoming.id);
            if (existingIdx === -1) {
              if (showPagination) {
                // Keep paged views stable; don't inject leads that aren't part of the current slice.
                return current;
              }
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
  }, [maxRows, showPagination]);

  const displayRows = useMemo(() => {
    const working = [...filteredRows];
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
  }, [filteredRows, sort, maxRows]);

  const shownCount = displayRows.length;
  const totalCount = filteredRows.length;
  const hasData = shownCount > 0;

  const batchOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of allRows) {
      counts.set(row.batchKey, (counts.get(row.batchKey) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => ({ key, label: formatBatchLabel(key), count }));
  }, [allRows]);

  const selectedBatchLabel = filters.batch ? formatBatchLabel(filters.batch) : "All batches";
  const selectedIntent = filters.batch ? inferBatchIntent(selectedBatchLabel) : null;

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const row of filteredRows) {
      counts[row.status] = (counts[row.status] || 0) + 1;
    }
    return counts;
  }, [filteredRows]);

  const statusSummary = useMemo(() => {
    const invitesSent = allRows.filter((row) => row.connectionSentAt).length;
    const accepted = allRows.filter((row) => row.connectionAcceptedAt).length;
    const draftsReady = (statusCounts.DRAFT_READY || 0) + (statusCounts.MESSAGE_ONLY_READY || 0);
    const approved = (statusCounts.APPROVED || 0) + (statusCounts.MESSAGE_ONLY_APPROVED || 0);
    return {
      newCount: statusCounts.NEW || 0,
      enriched: statusCounts.ENRICHED || 0,
      invitesSent,
      accepted,
      draftsReady,
      approved,
      sent: allRows.filter((row) => row.sentAt).length,
      failed: statusCounts.FAILED || 0,
    };
  }, [allRows, statusCounts]);

  const nextStepHint = useMemo(() => {
    if (!filters.batch) return "Pick a batch to see the most relevant next step.";
    if (selectedIntent === "connect_only") return "Next step: Send invites (no note).";
    if (selectedIntent === "connect_message") return "Next step: Run enrichment for Connect + Message.";
    return "Next step depends on this batch intent (set at upload).";
  }, [filters.batch, selectedIntent]);

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 260 }}>
          <div className="pill">Batch Progress</div>
          <h3 className="section-title-tight">LEADS</h3>
          <div className="muted">{nextStepHint}</div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label htmlFor="batch-filter" className="muted" style={{ fontSize: 12 }}>
            Batch
          </label>
          <select
            id="batch-filter"
            value={filters.batch || ""}
            onChange={(e) => setFilters((prev) => ({ ...prev, batch: e.target.value }))}
            className="input"
            style={{ minWidth: 240, height: 40 }}
          >
            <option value="">{`All batches (${allRows.length})`}</option>
            {batchOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {`${opt.label} (${opt.count})`}
              </option>
            ))}
          </select>

          <div className="muted" style={{ whiteSpace: "nowrap" }}>
          {hasData
            ? showPagination && total
              ? `${shownCount} shown • ${total} total`
              : maxRows && totalCount > maxRows
              ? `${shownCount} shown • ${totalCount} total`
              : `${shownCount} loaded`
            : null}
          </div>
        </div>
      </div>

      {hasData ? (
        <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="status-chip">Scope: {selectedBatchLabel}</span>
          {selectedIntent ? (
            <span className="status-chip status-approved">Intent: {selectedIntent === "connect_only" ? "Connect Only" : "Connect + Message"}</span>
          ) : null}
          <span className="status-chip">New: {statusSummary.newCount}</span>
          <span className="status-chip">Enriched: {statusSummary.enriched}</span>
          <span className="status-chip status-pending">Invites sent: {statusSummary.invitesSent}</span>
          <span className="status-chip status-approved">Accepted: {statusSummary.accepted}</span>
          <span className="status-chip status-draft">Drafts ready: {statusSummary.draftsReady}</span>
          <span className="status-chip status-approved">Approved: {statusSummary.approved}</span>
          <span className="status-chip status-sent">Sent: {statusSummary.sent}</span>
          {statusSummary.failed ? <span className="status-chip status-failed">Failed: {statusSummary.failed}</span> : null}
        </div>
      ) : null}

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
                <th scope="col">
                  {renderSortButton("LEAD", "name", "lead name")}
                </th>
                <th scope="col">
                  {renderSortButton("COMPANY", "company")}
                </th>
                <th scope="col">
                  {renderSortButton("STATUS", "status")}
                </th>
                <th scope="col">
                  {renderSortButton("FOLLOW-UPS", "followupCount", "follow-ups")}
                </th>
                <th scope="col">
                  {renderSortButton("ADDED", "createdAt", "added date")}
                </th>
                <th scope="col">
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
                        {getSequenceLabel(row, sequenceById, assignmentByBatch, row.batchKey) ? (
                          <span className="status-chip status-approved">
                            Sequence: {getSequenceLabel(row, sequenceById, assignmentByBatch, row.batchKey)}
                          </span>
                        ) : (
                          <span className="status-chip status-pending">No sequence</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>{row.company}</td>
                  <td>
                    <span
                      className={`status-chip ${row.statusClass}`}
                      title={row.statusLabel}
                      style={{ minWidth: 132, justifyContent: "center", whiteSpace: "nowrap" }}
                    >
                      {row.statusLabel || formatStatus(row.status)}
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
            {page <= 1 ? (
              <span className="pager-btn disabled">← PREV</span>
            ) : (
              <Link
                className="pager-btn"
                href={`${basePath}?page=${Math.max(1, page - 1)}`}
                prefetch
              >
                ← PREV
              </Link>
            )}
            <span className="muted" style={{ padding: "0 16px" }}>
              PAGE {page} / {totalPages || 1}
            </span>
            {page >= (totalPages || 1) ? (
              <span className="pager-btn disabled">NEXT →</span>
            ) : (
              <Link
                className="pager-btn"
                href={`${basePath}?page=${Math.min(totalPages || 1, page + 1)}`}
                prefetch
              >
                NEXT →
              </Link>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
