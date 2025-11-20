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
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to start scraper.");
      }
      setMsg(data?.message || "Scraper started. A browser window should appear.");
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
        className="btn"
        style={{ background: running ? "#374151" : "#10b981", color: "white" }}
      >
        {running ? "Starting..." : "Start Enrichment (opens browser)"}
      </button>
      {msg ? (
        <div style={{ marginTop: 8, fontSize: 13, color: "#cbd5e1" }}>{msg}</div>
      ) : null}
    </div>
  );
}
