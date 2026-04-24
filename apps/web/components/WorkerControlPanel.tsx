"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { getOperatorApiHeaders } from "../lib/operatorToken";

type WorkerKind =
  | "scraper_outreach"
  | "scraper_inbox"
  | "draft_agent"
  | "sender_outreach"
  | "sender_followup";

type WorkerItem = {
  id: string;
  kind: WorkerKind;
  pid: number;
  label: string;
  startedAt: string;
  args: string[];
};

type WorkerGroup = {
  kind: WorkerKind;
  label: string;
  count: number;
  items: WorkerItem[];
};

type WorkerStatusResponse = {
  ok: boolean;
  total: number;
  groups: WorkerGroup[];
  error?: string;
};

type WorkerControlPanelProps = {
  title: string;
  description: string;
  kinds: WorkerKind[];
  stopLabel: string;
};

const POLL_INTERVAL_MS = 5000;

const formatStartedAt = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown start";
  }
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
};

export function WorkerControlPanel({
  title,
  description,
  kinds,
  stopLabel,
}: WorkerControlPanelProps) {
  const [groups, setGroups] = useState<WorkerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const statusUrl = useMemo(() => {
    const params = new URLSearchParams();
    kinds.forEach((kind) => params.append("kind", kind));
    return `/api/workers/status?${params.toString()}`;
  }, [kinds]);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
    }
    try {
      const response = await fetch(statusUrl, {
        cache: "no-store",
        headers: getOperatorApiHeaders(),
      });
      const data = (await response.json()) as WorkerStatusResponse;
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Failed to fetch worker status.");
      }
      setGroups(data.groups || []);
      setError("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to load worker status.");
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [statusUrl]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      refresh({ silent: true }).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const totalActive = groups.reduce((sum, group) => sum + group.count, 0);

  const stop = async () => {
    setStopping(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/workers/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getOperatorApiHeaders(),
        },
        body: JSON.stringify({ kinds }),
      });
      const data = (await response.json()) as { ok: boolean; message?: string; error?: string };
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Failed to stop workers.");
      }
      setMessage(data.message || "Stop requested.");
      await refresh({ silent: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to stop workers.");
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div className="pill">Worker Control</div>
          <h3 className="section-title-tight">{title}</h3>
          <div className="muted">{description}</div>
        </div>
        <div style={{ display: "grid", gap: 8, justifyItems: "end" }}>
          <div className="muted" style={{ fontSize: 12 }}>
            {loading ? "Checking…" : totalActive > 0 ? `${totalActive} active worker${totalActive === 1 ? "" : "s"}` : "No active workers"}
          </div>
          <div style={{ display: "flex", gap: 0 }}>
            <button className="btn secondary" onClick={() => refresh()} disabled={loading || stopping}>
              REFRESH
            </button>
            <button className="btn warn" onClick={stop} disabled={stopping || totalActive === 0}>
              {stopping ? "STOPPING…" : stopLabel}
            </button>
          </div>
        </div>
      </div>

      {groups.length > 0 ? (
        <div style={{ display: "grid", gap: 8 }}>
          {groups.map((group) => (
            <div key={group.kind} style={{ border: "2px solid var(--line)", padding: "10px 12px" }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>
                {group.label.toUpperCase()} • {group.count}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                {group.items.map((item) => `PID ${item.pid} since ${formatStartedAt(item.startedAt)}`).join(" • ")}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {message ? (
        <div className="muted" style={{ fontSize: 12 }} aria-live="polite">
          {message}
        </div>
      ) : null}
      {error ? (
        <div style={{ fontSize: 12, color: "var(--accent)" }} aria-live="polite">
          {error}
        </div>
      ) : null}
    </div>
  );
}
