"use client";

import { useState } from "react";

import { getOperatorApiHeaders } from "../lib/operatorToken";

type Props = {
  onStart?: () => void;
  label?: string;
};

type LoginResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
};

export function StartLoginButton({ onStart, label = "START LOGIN ATTEMPT" }: Props) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string>("");

  const start = async () => {
    onStart?.();
    setRunning(true);
    setMsg("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: getOperatorApiHeaders(),
      });
      const data = (await res.json()) as LoginResponse;
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to start LinkedIn login attempt.");
      }
      setMsg(
        data?.message ||
          "LinkedIn login started on the worker. Recheck session state after it completes."
      );
    } catch (error: unknown) {
      setMsg(error instanceof Error ? error.message : "Network error");
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
      >
        {running ? "LAUNCHING…" : label}
      </button>
      {msg ? (
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>{msg}</div>
      ) : null}
    </div>
  );
}
