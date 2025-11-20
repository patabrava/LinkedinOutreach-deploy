"use client";

import { useState } from "react";

export function StartEnrichmentButton() {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string>("");

  const start = async () => {
    setRunning(true);
    setMsg("");
    try {
      const res = await fetch("/api/enrich", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data?.error || "Failed to start scraper.");
      } else {
        setMsg("Scraper started. A browser window should appear.");
      }
    } catch (e: any) {
      setMsg(e?.message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <button
        onClick={start}
        disabled={running}
        style={{
          padding: "8px 12px",
          borderRadius: 6,
          background: running ? "#374151" : "#10b981",
          color: "white",
          border: "none",
          cursor: running ? "not-allowed" : "pointer",
        }}
      >
        {running ? "Starting..." : "Start Enrichment (opens browser)"}
      </button>
      {msg ? (
        <div style={{ marginTop: 8, fontSize: 13, color: "#cbd5e1" }}>{msg}</div>
      ) : null}
    </div>
  );
}
