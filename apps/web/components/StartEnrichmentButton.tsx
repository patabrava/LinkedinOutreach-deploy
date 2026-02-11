"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowserClient } from "../lib/supabaseClient";

type StatusCounts = Record<string, number>;

type StatusResponse = {
  ok: boolean;
  counts: StatusCounts;
  remaining: number;
  completed: number;
  dailyCap?: number;
  completedToday?: number;
  remainingToday?: number;
  queueRemaining?: number;
  nextLead: {
    id: string;
    linkedin_url: string;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
  } | null;
  mode?: EnrichmentMode;
};

const POLL_INTERVAL_MS = 5_000;

type EnrichmentMode = "message" | "connect_only";

type StartEnrichmentButtonProps = {
  mode?: EnrichmentMode;
};

const MODE_CONFIG: Record<EnrichmentMode, {
  statusUrl: string;
  startEndpoint: string;
  startLabel: string;
  runningLabel: string;
  buttonClass: string;
  defaultStartMessage: string;
}> = {
  message: {
    statusUrl: "/api/enrich/status",
    startEndpoint: "/api/enrich",
    startLabel: "START ENRICHMENT",
    runningLabel: "STARTING…",
    buttonClass: "btn",
    defaultStartMessage: "Scraper started. A browser window should appear.",
  },
  connect_only: {
    statusUrl: "/api/enrich/status?mode=connect_only",
    startEndpoint: "/api/enrich/connect-only",
    startLabel: "ENRICH + CONNECT (NO NOTE)",
    runningLabel: "STARTING CONNECT-ONLY…",
    buttonClass: "btn secondary",
    defaultStartMessage: "Connect-only run started. A browser window should appear.",
  },
};

export function StartEnrichmentButton({ mode = "message" }: StartEnrichmentButtonProps) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState<boolean>(false);
  const [polling, setPolling] = useState<boolean>(false);
  const [stopping, setStopping] = useState<boolean>(false);
  const modeConfig = MODE_CONFIG[mode];

  const refreshStatus = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setStatusLoading(true);
    }
    try {
      const res = await fetch(modeConfig.statusUrl, { cache: "no-store" });
      const data = (await res.json()) as StatusResponse & { error?: string };
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to fetch enrichment status.");
      }
      setStatus(data);
      setError("");
      const pending = typeof data.remainingToday === "number" ? data.remainingToday : data.remaining;
      if (pending > 0) {
        setPolling(true);
      } else {
        setPolling(false);
      }
    } catch (err: any) {
      setError(err?.message || "Unable to load status.");
    } finally {
      if (!silent) {
        setStatusLoading(false);
      }
    }
  }, [modeConfig.statusUrl]);

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

  const progress = useMemo(() => {
    const completedForBar = status ? (status.completedToday ?? status.completed) : 0;
    const dailyCap = typeof status?.dailyCap === "number" ? status.dailyCap : null;
    const remainingForBar = dailyCap !== null
      ? Math.max(0, dailyCap - completedForBar)
      : status
        ? (status.remainingToday ?? status.remaining)
        : 0;
    const totalForBar = dailyCap !== null
      ? dailyCap
      : completedForBar + remainingForBar;
    const backlogRemaining = status?.queueRemaining ?? status?.remaining ?? 0;
    return {
      completedForBar,
      remainingForBar,
      totalForBar,
      dailyCap,
      backlogRemaining,
    };
  }, [status]);

  const completionPercent = useMemo(() => {
    if (!status || !progress.totalForBar) return 0;
    return Math.min(100, Math.round((progress.completedForBar / progress.totalForBar) * 100));
  }, [status, progress.completedForBar, progress.totalForBar]);

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
      const res = await fetch(modeConfig.startEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to start scraper.");
      }
      setMessage(data?.message || modeConfig.defaultStartMessage);
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
      <div style={{ display: "flex", gap: 0 }}>
        <button
          onClick={start}
          disabled={running}
          className={modeConfig.buttonClass}
          style={{ flex: 1 }}
        >
          {running ? modeConfig.runningLabel : modeConfig.startLabel}
        </button>
        <button
          onClick={stop}
          disabled={stopping}
          className="btn warn"
          style={{ flex: 1 }}
        >
          {stopping ? "STOPPING…" : "STOP ENRICHMENT"}
        </button>
      </div>

      {message ? (
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>{message}</div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--accent)" }}>{error}</div>
      ) : null}

      <div style={{ marginTop: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          <span>STATUS</span>
          <span>{statusLoading ? "UPDATING…" : `${completionPercent}%`}</span>
        </div>
        <div
          style={{
            marginTop: 8,
            height: 16,
            border: "3px solid #000",
            background: "var(--bg)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${completionPercent}%`,
              background: "var(--fg)",
              transition: "width 0.4s ease",
            }}
          />
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--fg)", fontWeight: 700 }}>
          {status
            ? `${progress.completedForBar} COMPLETED TODAY • ${progress.remainingForBar} REMAINING TODAY`
            : "LOADING STATUS…"}
        </div>
        {progress.dailyCap !== null ? (
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
            DAILY CAP: {progress.dailyCap}
            {progress.backlogRemaining
              ? ` • IN QUEUE: ${progress.backlogRemaining}`
              : ""}
          </div>
        ) : null}
        {nextLeadLabel ? (
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>NEXT UP: {nextLeadLabel}</div>
        ) : null}
      </div>
    </div>
  );
}
