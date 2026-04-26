"use client";

import { useCallback, useEffect, useState } from "react";

import { getOperatorApiHeaders } from "../lib/operatorToken";

type IterationOutcome = "ok" | "error" | "unknown";

type HealthResponse = {
  ok: boolean;
  running: boolean;
  stuck: boolean;
  pid: number | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  lastIterationAt: string | null;
  lastIterationOutcome: IterationOutcome;
  lastError: string | null;
  intervalSec: number;
  stuckThresholdSec: number;
  error?: string;
};

const POLL_INTERVAL_MS = 5000;

const formatClock = (value: string | null): string => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
};

const formatStaleness = (lastActivityAt: string | null): string => {
  if (!lastActivityAt) return "—";
  const date = new Date(lastActivityAt);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

const outcomeLabel = (outcome: IterationOutcome): string => {
  if (outcome === "ok") return "OK";
  if (outcome === "error") return "ERROR";
  return "PENDING";
};

export function SenderMessageOnlyControl() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<"start" | "stop" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/sender/message-only/health", {
        cache: "no-store",
        headers: getOperatorApiHeaders(),
      });
      const data = (await response.json()) as HealthResponse;
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Failed to fetch daemon health.");
      }
      setHealth(data);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to load daemon health.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      refresh({ silent: true }).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const start = async () => {
    setActing("start");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/sender/message-only/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getOperatorApiHeaders() },
      });
      const data = (await response.json()) as { ok: boolean; message?: string; error?: string; pid?: number };
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Failed to start daemon.");
      }
      setMessage(data.message || `Started (pid ${data.pid}).`);
      await refresh({ silent: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to start daemon.");
    } finally {
      setActing(null);
    }
  };

  const stop = async () => {
    setActing("stop");
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/workers/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getOperatorApiHeaders() },
        body: JSON.stringify({ kinds: ["sender_message_only"] }),
      });
      const data = (await response.json()) as { ok: boolean; message?: string; error?: string };
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Failed to stop daemon.");
      }
      setMessage(data.message || "Stop requested.");
      await refresh({ silent: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to stop daemon.");
    } finally {
      setActing(null);
    }
  };

  const running = Boolean(health?.running);
  const stuck = Boolean(health?.stuck);
  const status = !running ? "STOPPED" : stuck ? "STUCK" : "RUNNING";

  const chipStyle: React.CSSProperties =
    status === "RUNNING"
      ? { background: "var(--fg)", color: "var(--bg)", padding: "2px 8px", border: "3px solid var(--fg)" }
      : status === "STUCK"
      ? { color: "var(--fg)", padding: "2px 8px", border: "3px dashed var(--fg)" }
      : { color: "var(--muted)", padding: "2px 8px", border: "3px solid var(--muted)" };

  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div className="pill">Auto Mode</div>
          <h3 className="section-title-tight">MESSAGE-ONLY AUTO MODE</h3>
          <div className="muted" style={{ maxWidth: 540 }}>
            Polls accepted friend requests every ~{Math.round((health?.intervalSec ?? 900) / 60)} min and sends the
            first sequence message until stopped.
          </div>
        </div>
        <div style={{ display: "grid", gap: 8, justifyItems: "end" }}>
          <span style={{ ...chipStyle, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>{status}</span>
          {loading && !health ? <div className="muted" style={{ fontSize: 12 }}>Checking…</div> : null}
        </div>
      </div>

      <div style={{ fontSize: 12, fontFamily: "inherit", letterSpacing: 0.5 }}>
        PID {health?.pid ?? "—"} · STARTED {formatClock(health?.startedAt ?? null)} · LAST RUN{" "}
        {formatClock(health?.lastIterationAt ?? null)} · {outcomeLabel(health?.lastIterationOutcome ?? "unknown")}
      </div>

      {stuck ? (
        <div style={{ border: "3px dashed var(--fg)", padding: "8px 10px", fontSize: 12 }}>
          NO LOG ACTIVITY IN {formatStaleness(health?.lastActivityAt ?? null)} — DAEMON MAY BE HUNG.
        </div>
      ) : null}

      {health?.lastError ? (
        <div style={{ border: "3px dashed var(--fg)", padding: "8px 10px", fontSize: 12, wordBreak: "break-all" }}>
          LAST ERROR: {health.lastError}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 0, flexWrap: "wrap" }}>
        <button
          className="btn"
          onClick={start}
          disabled={Boolean(acting) || running}
        >
          {acting === "start" ? "STARTING…" : "START FULL AUTO"}
        </button>
        <button
          className="btn warn"
          onClick={stop}
          disabled={Boolean(acting) || !running}
        >
          {acting === "stop" ? "STOPPING…" : "STOP FULL AUTO"}
        </button>
        <button className="btn secondary" onClick={() => refresh()} disabled={loading || Boolean(acting)}>
          REFRESH
        </button>
      </div>

      {message ? (
        <div className="muted" style={{ fontSize: 12 }} aria-live="polite">{message}</div>
      ) : null}
      {error ? (
        <div style={{ fontSize: 12, color: "var(--accent)" }} aria-live="polite">{error}</div>
      ) : null}
    </div>
  );
}
