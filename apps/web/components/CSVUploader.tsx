"use client";

import { useRef, useState, DragEvent } from "react";
import Papa from "papaparse";

import { importLeads } from "../app/actions";

type Row = {
  linkedin_url: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
};

type Props = {
  afterImport?: () => void;
};

export function CSVUploader({ afterImport }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string>("Drop CSV or click to upload");
  const [loading, setLoading] = useState(false);

  const handleFiles = (file?: File | null) => {
    if (!file) return;
    setLoading(true);
    setStatus("Parsing...");
    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          const rows = (results.data || []).map((r) => ({
            linkedin_url: r.linkedin_url || r["LinkedIn"] || r["linkedin"] || "",
            first_name: r.first_name || r["firstName"] || r["First Name"],
            last_name: r.last_name || r["lastName"] || r["Last Name"],
            company_name:
              r.company_name ||
              r["Company"] ||
              r["company"] ||
              r["organization_name"] ||
              r["organization"],
          }));
          const response = await importLeads(rows);
          setStatus(`Inserted ${response.inserted} leads`);
          if (afterImport) {
            afterImport();
          } else if (typeof window !== "undefined") {
            window.location.reload();
          }
        } catch (err: any) {
          setStatus(`Failed: ${err?.message || "Unknown error"}`);
        } finally {
          setLoading(false);
        }
      },
      error: (err) => {
        setStatus(`Parse error: ${err.message}`);
        setLoading(false);
      },
    });
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files?.[0]);
  };

  return (
    <div
      className="csv-drop"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      style={{ cursor: "pointer" }}
    >
      {status}
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        style={{ display: "none" }}
        onChange={(e) => handleFiles(e.target.files?.[0])}
      />
      <div style={{ marginTop: 8, fontSize: 12, color: "#cbd5e1" }}>
        Columns: linkedin_url, first_name, last_name, company_name
      </div>
      {loading ? <div className="muted" style={{ marginTop: 6 }}>Working...</div> : null}
    </div>
  );
}
