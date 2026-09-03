"use client";

import { useRef, useState } from "react";
import Papa, { type ParseStepResult } from "papaparse";

import {
  importDeguraLeads,
  previewDeguraImport,
} from "../app/actions";
import { csvRowsToLeadRows } from "./CSVUploader";

type LeadRow = ReturnType<typeof csvRowsToLeadRows>[number];
type Preview = Awaited<ReturnType<typeof previewDeguraImport>>;

export function DeguraCampaignImporter({ readinessCodes }: { readinessCodes: string[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<LeadRow[]>([]);
  const [eligible, setEligible] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState(readinessCodes.length ? `BLOCKED: ${readinessCodes.join(", ")}` : "SELECT CSV");
  const [busy, setBusy] = useState(false);
  const blocked = readinessCodes.length > 0;

  const parseFile = (file?: File | null) => {
    if (!file || blocked) return;
    const parsedRows: string[][] = [];
    setBusy(true);
    setPreview(null);
    setStatus("PARSING…");
    Papa.parse(file, {
      skipEmptyLines: true,
      worker: true,
      step: (result: ParseStepResult<string[]>) => {
        if (Array.isArray(result.data)) parsedRows.push(result.data);
      },
      complete: (results) => {
        const fallback = Array.isArray((results as { data?: unknown }).data)
          ? ((results as { data?: string[][] }).data || [])
          : [];
        const parsed = csvRowsToLeadRows(parsedRows.length ? parsedRows : fallback);
        setRows(parsed);
        setFileName(file.name);
        setStatus(parsed.length ? `${parsed.length} ROWS READY FOR PREVIEW` : "NO LEADS FOUND");
        setBusy(false);
      },
      error: (error: { message: string }) => {
        setStatus(`PARSE ERROR: ${error.message}`);
        setBusy(false);
      },
    });
  };

  const runPreview = async () => {
    setBusy(true);
    try {
      const result = await previewDeguraImport(rows, eligible);
      setPreview(result);
      setStatus(`${result.accepted} ACCEPTED · ${result.rejected.length} REJECTED`);
    } catch (error) {
      setStatus(`BLOCKED: ${error instanceof Error ? error.message : "Preview failed"}`);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    setBusy(true);
    try {
      const result = await importDeguraLeads(rows, fileName, eligible);
      setStatus(`IMPORTED ${result.inserted} LEADS · ${result.batches.length} BATCHES`);
      setPreview(null);
      setRows([]);
    } catch (error) {
      setStatus(`FAILED: ${error instanceof Error ? error.message : "Import failed"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="pill">Balanced 2 × 2</div>
      <h3 className="section-title-tight">DEGURA CAMPAIGN IMPORT</h3>
      <p className="muted">URLs are canonicalized, globally deduplicated and assigned deterministically across both accounts and both variants.</p>
      <p className="muted">HubSpot sequence IDs route each row automatically to Rentenreform Du, Leitfaden Du, or Leitfaden Sie. Most recent activity is prioritized within each family.</p>
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 16 }}>
        <input type="checkbox" checked={eligible} onChange={(event) => { setEligible(event.target.checked); setPreview(null); }} disabled={busy || blocked} />
        <span>I confirm these contacts are eligible for this LinkedIn outreach campaign.</span>
      </label>
      <input ref={fileRef} type="file" accept=".csv" hidden onChange={(event) => parseFile(event.target.files?.[0])} />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="btn secondary" type="button" onClick={() => fileRef.current?.click()} disabled={busy || blocked}>CHOOSE CSV</button>
        <button className="btn" type="button" onClick={runPreview} disabled={busy || blocked || !eligible || !rows.length}>PREVIEW DISTRIBUTION</button>
        <button className="btn accent" type="button" onClick={runImport} disabled={busy || !preview?.canImport}>IMPORT BATCH</button>
      </div>
      <div aria-live="polite" style={{ marginTop: 16 }}>{busy ? "WORKING…" : status}</div>
      {preview ? (
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          FAMILIES: {Object.entries(preview.byFamily).map(([family, count]) => `${family} ${count}`).join(" / ")} · ACCOUNTS: {Object.values(preview.byAccount).join(" / ")} · VARIANTS: {Object.values(preview.byVariant).join(" / ")}
          {preview.rejected.length ? ` · REJECTED: ${preview.rejected.map((row) => row.reason).join(", ")}` : ""}
        </div>
      ) : null}
    </div>
  );
}
