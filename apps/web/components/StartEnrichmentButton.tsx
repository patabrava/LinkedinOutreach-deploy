"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowserClient } from "../lib/supabaseClient";

type StatusCounts = Record<string, number>;

type StatusResponse = {
  ok: boolean;
  counts: StatusCounts;
  remaining: number;
  completed: number;
  nextLead: {
    id: string;
    linkedin_url: string;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
  } | null;
};

const POLL_INTERVAL_MS = 5_000;

export function StartEnrichmentButton() {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState<boolean>(false);
  const [polling, setPolling] = useState<boolean>(false);
  const [stopping, setStopping] = useState<boolean>(false);

  const refreshStatus = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setStatusLoading(true);
    }
    try {
      const res = await fetch("/api/enrich/status", { cache: "no-store" });
      const data = (await res.json()) as StatusResponse & { error?: string };
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to fetch enrichment status.");
      }
      setStatus(data);
      setError("");
      if (data.remaining > 0) {
        setPolling(true);
      }
    } catch (err: any) {
      setError(err?.message || "Unable to load status.");
    } finally {
      if (!silent) {
        setStatusLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Subscribe to real-time lead updates to refresh status immediately
  useEffect(() => {
    const supabase = supabaseBrowserClient();
    const channel = supabase
      .channel("enrichment-status-updates")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "leads" },
        () => {
          // Refresh status silently whenever any lead is updated
          refreshStatus({ silent: true }).catch(() => undefined);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [refreshStatus]);

  // Poll as backup in case real-time updates fail
  useEffect(() => {
    if (!polling) {
      return;
    }
    const intervalId = setInterval(() => {
      refreshStatus({ silent: true }).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [polling, refreshStatus]);

  useEffect(() => {
    if (status && status.remaining === 0) {
      setPolling(false);
    }
  }, [status]);

  const totalTracked = useMemo(() => {
    if (!status) return 0;
    return status.remaining + status.completed;
  }, [status]);

  const completionPercent = useMemo(() => {
    if (!status || totalTracked === 0) return 0;
    return Math.min(100, Math.round((status.completed / totalTracked) * 100));
  }, [status, totalTracked]);

  const nextLeadLabel = useMemo(() => {
    if (!status?.nextLead) return "";
    const name = [status.nextLead.first_name, status.nextLead.last_name].filter(Boolean).join(" ");
    const company = status.nextLead.company_name || "";
    if (name && company) return `${name} • ${company}`;
    return name || company || status.nextLead.linkedin_url || "";
  }, [status]);

  const start = async () => {
    setRunning(true);
    setStopping(false);
    setMessage("");
    setError("");
    try {
      const res = await fetch("/api/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to start scraper.");
      }
      setMessage(data?.message || "Scraper started. A browser window should appear.");
      setPolling(true);
      await refreshStatus();
    } catch (e: any) {
      setError(e?.message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    setError("");
    try {
      const res = await fetch("/api/enrich/stop", { method: "POST" });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to stop enrichment.");
      }
      setMessage(data?.message || "Enrichment stop requested.");
      setPolling(false);
      setRunning(false);
      await refreshStatus({ silent: true });
    } catch (e: any) {
      setError(e?.message || "Unable to stop enrichment.");
    } finally {
      setStopping(false);
    }
  };

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={start}
          disabled={running}
          className="btn"
          style={{
            background: running ? "#374151" : "#10b981",
            color: "white",
            flex: 1,
          }}
        >
          {running ? "Starting..." : "Start Enrichment"}
        </button>
        <button
          onClick={stop}
          disabled={stopping}
          className="btn"
          style={{
            background: stopping ? "#374151" : "#ef4444",
            color: "white",
            flex: 1,
          }}
        >
          {stopping ? "Stopping..." : "Stop Enrichment"}
        </button>
      </div>

      {message ? (
        <div style={{ marginTop: 8, fontSize: 13, color: "#cbd5e1" }}>{message}</div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 8, fontSize: 13, color: "#f87171" }}>{error}</div>
      ) : null}

      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9ca3af" }}>
          <span>Status</span>
          <span>{statusLoading ? "Updating…" : `${completionPercent}%`}</span>
        </div>
        <div
          style={{
            marginTop: 4,
            height: 10,
            borderRadius: 999,
            background: "#1f2937",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${completionPercent}%`,
              background: "#10b981",
              transition: "width 0.4s ease",
            }}
          />
        </div>
        <div style={{ marginTop: 8, fontSize: 13, color: "#cbd5e1" }}>
          {status ? `${status.completed} completed • ${status.remaining} remaining` : "Loading status…"}
        </div>
        {nextLeadLabel ? (
          <div style={{ marginTop: 6, fontSize: 12, color: "#9ca3af" }}>Next up: {nextLeadLabel}</div>
        ) : null}
      </div>
    </div>
  );
}
