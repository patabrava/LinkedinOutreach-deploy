"use client";

import { useState } from "react";

type Props = {
  onStart?: () => void;
};

export function StartLoginButton({ onStart }: Props) {
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string>("");

  const start = async () => {
    onStart?.();
    setRunning(true);
    setMsg("");
    try {
      const res = await fetch("/api/login", { method: "POST" });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to launch login window.");
      }
      setMsg(data?.message || "Login window launched. Complete login and close it to save auth.json.");
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
      >
        {running ? "LAUNCHING…" : "LOGIN TO LINKEDIN (OPENS BROWSER)"}
      </button>
      {msg ? (
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>{msg}</div>
      ) : null}
    </div>
  );
}
