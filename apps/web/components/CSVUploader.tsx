"use client";

import { useRef, useState, DragEvent } from "react";
import Papa, { type ParseStepResult } from "papaparse";

import { importLeads } from "../app/actions";
import { normalizeDeguraCsvRecord } from "../lib/deguraCampaign";
import type { BatchIntent } from "../lib/outreachModes";
import type { LinkedinAccountSummary } from "../lib/linkedinAccounts";

type Props = {
  afterImport?: () => void;
  defaultMode?: BatchIntent;
  onModeChange?: (mode: BatchIntent) => void;
  accounts: LinkedinAccountSummary[];
};

const HEADER_ALIASES = [
  "linkedin_url",
  "linkedin url",
  "linkedin-url",
  "legacy linkedin url",
  "first name",
  "vorname",
  "last name",
  "nachname",
  "company name",
  "unternehmensname",
  "current company",
  "legacy current company",
];

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function findHeaderRow(rows: string[][]) {
  return rows.findIndex((row) =>
    row.some((cell) => HEADER_ALIASES.includes(normalizeHeader(cell)))
  );
}

export function csvRowsToLeadRows(rows: string[][]) {
  const headerIndex = findHeaderRow(rows);
  if (headerIndex === -1) {
    return [];
  }

  const headers = rows[headerIndex].map((cell) => cell.trim());
  const dataRows = rows.slice(headerIndex + 1);

  return dataRows
    .filter((row) => row.some((cell) => cell.trim()))
    .map((row) => {
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        const key = header || `column_${index}`;
        record[key] = row[index]?.trim() || "";
      });
      const normalized = normalizeDeguraCsvRecord(record);
      return {
        ...normalized,
        linkedin_url: normalized.linkedin_url || record.linkedin || "",
        company_name:
          normalized.company_name ||
          record.company ||
          record.organization_name ||
          record.organization ||
          "",
      };
    });
}

export function CSVUploader({
  afterImport,
  defaultMode,
  onModeChange,
  accounts,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string>("SELECT BATCH INTENT TO START");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<BatchIntent | null>(defaultMode ?? null);
  const [accountId, setAccountId] = useState(accounts.find((account) => account.is_active)?.id || "");
  const [progress, setProgress] = useState<{ current: number; total: number; phase: "idle" | "parsing" | "uploading" | "done" | "error" }>({
    current: 0,
    total: 0,
    phase: "idle",
  });

  const setModeAndNotify = (next: BatchIntent) => {
    setMode(next);
    onModeChange?.(next);
  };

  const handleFiles = (file?: File | null) => {
    if (!file) return;
    if (!mode || !accountId) {
      setStatus("SELECT SENDER AND BATCH INTENT FIRST");
      setProgress({ current: 0, total: 0, phase: "error" });
      return;
    }
    const selectedMode = mode;
    setLoading(true);
    setStatus("PARSING…");
    setProgress({ current: 0, total: 0, phase: "parsing" });
    const stepCount = { current: 0 };
    const parsedRows: string[][] = [];
    Papa.parse(file, {
      skipEmptyLines: true,
      worker: true,
      step: (result: ParseStepResult<string[]>) => {
        if (Array.isArray(result.data)) {
          parsedRows.push(result.data);
        }
        stepCount.current += 1;
        setProgress({
          current: stepCount.current,
          total: 0,
          phase: "parsing",
        });
        setStatus(`PARSING… ${stepCount.current} ROWS`);
      },
      complete: async (results) => {
        try {
          const fallbackRows = Array.isArray((results as { data?: unknown })?.data)
            ? ((results as { data?: string[][] }).data ?? [])
            : [];
          const sourceRows = parsedRows.length ? parsedRows : fallbackRows;
          const rows = Array.isArray(sourceRows[0]) ? csvRowsToLeadRows(sourceRows) : [];
          if (!rows.length) {
            setStatus("NO LEADS FOUND. CHECK THE HEADER ROW.");
            setProgress({ current: 0, total: 0, phase: "error" });
            return;
          }
          setProgress({ current: rows.length, total: rows.length, phase: "uploading" });
          setStatus(`UPLOADING… 0 OF ${rows.length}`);
          const response = await importLeads(rows, file.name, selectedMode, accountId);
          if (response.inserted === 0) {
            setStatus("NO NEW LEADS INSERTED");
            setProgress({ current: 0, total: rows.length, phase: "done" });
            return;
          }
          setStatus(`INSERTED ${response.inserted} LEADS`);
          setProgress({ current: response.inserted, total: rows.length, phase: "done" });
          if (afterImport) {
            afterImport();
          } else if (typeof window !== "undefined") {
            window.location.reload();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setStatus(`FAILED: ${message}`);
          setProgress({ current: 0, total: 0, phase: "error" });
        } finally {
          setLoading(false);
        }
      },
      error: (err: { message: string }) => {
        setStatus(`PARSE ERROR: ${err.message}`);
        setProgress({ current: 0, total: 0, phase: "error" });
        setLoading(false);
      },
    });
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!mode || !accountId) {
      setStatus("SELECT SENDER AND BATCH INTENT FIRST");
      return;
    }
    handleFiles(e.dataTransfer.files?.[0]);
  };

  return (
    <div
      className="csv-drop"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <label htmlFor="csv-sender-account"><strong>Sender Account</strong></label>
          <select id="csv-sender-account" className="input" value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
            <option value="">Select sender</option>
            {accounts.filter((account) => account.is_active).map((account) => (
              <option key={account.id} value={account.id}>{account.label} — {account.display_name}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          <strong>Batch Intent</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            Required. Choose how this batch should run before importing.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`btn ${mode === "connect_message" ? "accent" : "secondary"}`}
              aria-pressed={mode === "connect_message"}
              onClick={() => setModeAndNotify("connect_message")}
            >
              Connect + Message
            </button>
            <button
              type="button"
              className={`btn ${mode === "connect_only" ? "accent" : "secondary"}`}
              aria-pressed={mode === "connect_only"}
              onClick={() => setModeAndNotify("connect_only")}
            >
              Connect Only
            </button>
            <button
              type="button"
              className={`btn ${mode === "custom_outreach" ? "accent" : "secondary"}`}
              aria-pressed={mode === "custom_outreach"}
              onClick={() => setModeAndNotify("custom_outreach")}
            >
              Custom Outreach
            </button>
          </div>
        </div>
        <div>
          {mode
            ? `Selected: ${mode === "connect_only" ? "Connect Only" : mode === "custom_outreach" ? "Custom Outreach" : "Connect + Message"}`
            : "Selected: -"}
        </div>
        <div aria-live="polite">{status}</div>
      </div>
      <button
        className="btn"
        type="button"
        disabled={!mode || !accountId || loading}
        onClick={() => inputRef.current?.click()}
        style={{ marginTop: 12 }}
      >
        Choose CSV
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        style={{ display: "none" }}
        onChange={(e) => handleFiles(e.target.files?.[0])}
      />
      <div style={{ marginTop: 12, fontSize: 11, color: "var(--muted)", fontWeight: 400 }}>
        COLUMNS: linkedin_url, first_name, last_name, company_name
      </div>
      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        <div className="muted" style={{ fontSize: 11 }}>
          {progress.phase === "parsing"
            ? `Parsing ${progress.current}${progress.total ? ` / ${progress.total}` : ""}`
            : progress.phase === "uploading"
              ? `Uploading ${progress.current}${progress.total ? ` / ${progress.total}` : ""}`
              : progress.phase === "done"
                ? `Done ${progress.total ? `(${progress.current} processed)` : ""}`
                : loading
                  ? "Working…"
                  : " "}
        </div>
        <div
          style={{
            width: "100%",
            height: 12,
            border: "2px solid var(--border-color)",
            background: "var(--bg)",
            overflow: "hidden",
          }}
          aria-hidden="true"
        >
          <div
            style={{
              height: "100%",
              width: progress.total
                ? `${Math.max(6, Math.min(100, Math.round((progress.current / progress.total) * 100)))}%`
                : progress.phase === "parsing"
                  ? `${Math.max(6, Math.min(92, (progress.current % 100) || 6))}%`
                : loading
                  ? "45%"
                  : "0%",
              background: progress.phase === "error" ? "var(--accent)" : "var(--fg)",
              transition: "width 140ms linear",
            }}
          />
        </div>
      </div>
    </div>
  );
}
