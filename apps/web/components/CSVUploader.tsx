"use client";

import { useRef, useState, DragEvent } from "react";
import Papa, { type ParseStepResult } from "papaparse";

import { importLeads } from "../app/actions";
import type { OutreachMode } from "../lib/outreachModes";

type Props = {
  afterImport?: () => void;
  defaultMode?: OutreachMode;
  onModeChange?: (mode: OutreachMode) => void;
};

const HEADER_ALIASES = [
  "linkedin_url",
  "linkedin url",
  "legacy linkedin url",
  "first name",
  "last name",
  "company name",
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

function rowsToObjects(rows: string[][]) {
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
      return {
        linkedin_url:
          record.linkedin_url ||
          record["LinkedIn URL"] ||
          record["Legacy LinkedIn URL"] ||
          record.LinkedIn ||
          record.linkedin ||
          "",
        first_name: record.first_name || record.firstName || record["First Name"] || "",
        last_name: record.last_name || record.lastName || record["Last Name"] || "",
        company_name:
          record.company_name ||
          record["Current Company"] ||
          record["Legacy Current Company"] ||
          record.Company ||
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
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string>("SELECT BATCH INTENT TO START");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<OutreachMode | null>(defaultMode ?? null);
  const [progress, setProgress] = useState<{ current: number; total: number; phase: "idle" | "parsing" | "uploading" | "done" | "error" }>({
    current: 0,
    total: 0,
    phase: "idle",
  });

  const setModeAndNotify = (next: OutreachMode) => {
    setMode(next);
    onModeChange?.(next);
  };

  const handleFiles = (file?: File | null) => {
    if (!file) return;
    if (!mode) {
      setStatus("SELECT BATCH INTENT FIRST");
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
          const rows = Array.isArray(sourceRows[0]) ? rowsToObjects(sourceRows) : [];
          if (!rows.length) {
            setStatus("NO LEADS FOUND. CHECK THE HEADER ROW.");
            setProgress({ current: 0, total: 0, phase: "error" });
            return;
          }
          setProgress({ current: rows.length, total: rows.length, phase: "uploading" });
          setStatus(`UPLOADING… 0 OF ${rows.length}`);
          const response = await importLeads(rows, file.name, selectedMode);
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
    if (!mode) {
      setStatus("SELECT BATCH INTENT FIRST");
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
          </div>
        </div>
        <div>{mode ? `Selected: ${mode === "connect_only" ? "Connect Only" : "Connect + Message"}` : "Selected: -"}</div>
        <div aria-live="polite">{status}</div>
      </div>
      <button
        className="btn"
        type="button"
        disabled={!mode || loading}
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
