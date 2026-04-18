"use client";

import { useState } from "react";

import { getOperatorApiHeaders } from "../lib/operatorToken";
import type { LinkedinAuthStatus } from "../lib/linkedinAuthSession";

type Props = {
  onStart?: () => void;
  onResult?: (result: LoginResponse) => void;
  onBusyChange?: (busy: boolean) => void;
  label?: string;
  browserUrl?: string;
  disabled?: boolean;
};

type LoginResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
  browserUrl?: string;
  status?: LinkedinAuthStatus;
};

export function StartLoginButton({
  onStart,
  onResult,
  onBusyChange,
  label = "START LOGIN ATTEMPT",
  browserUrl = "",
  disabled = false,
}: Props) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string>("");

  const start = async () => {
    if (running || disabled) return;
    onStart?.();
    setRunning(true);
    onBusyChange?.(true);
    setMsg("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: getOperatorApiHeaders(),
      });
      const data = (await res.json().catch(() => ({}))) as LoginResponse;
      if (!res.ok || data?.ok === false) {
        const message = data?.error || data?.message || "Failed to start LinkedIn login attempt.";
        onResult?.({ ...data, ok: false, error: message, message, browserUrl: "" });
        setMsg(message);
        return;
      }
      onResult?.(data);
      setMsg(
        data?.message ||
          "Open the remote LinkedIn browser, complete login there, then capture the session."
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Network error";
      setMsg(message);
      onResult?.({ ok: false, error: message, message });
    } finally {
      setRunning(false);
      onBusyChange?.(false);
    }
  };

  return (
    <div>
      <button onClick={start} disabled={running || disabled} className="btn">
        {running ? "LAUNCHING…" : label}
      </button>
      {browserUrl ? (
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
          Remote browser ready:{" "}
          <a href={browserUrl} target="_blank" rel="noreferrer">
            {browserUrl}
          </a>
        </div>
      ) : null}
      {msg ? (
        <div
          style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}
          role="status"
          aria-live="polite"
        >
          {msg}
        </div>
      ) : null}
    </div>
  );
}
