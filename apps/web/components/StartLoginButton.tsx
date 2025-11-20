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
      if (!res.ok) {
        setMsg(data?.error || "Failed to launch login window.");
      } else {
        setMsg(data?.message || "Login window launched. Complete login and close it to save auth.json.");
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
          background: running ? "#374151" : "#3b82f6",
          color: "white",
          border: "none",
          cursor: running ? "not-allowed" : "pointer",
          marginRight: 8,
        }}
      >
        {running ? "Launching..." : "Login to LinkedIn (opens browser)"}
      </button>
      {msg ? (
        <div style={{ marginTop: 8, fontSize: 13, color: "#cbd5e1" }}>{msg}</div>
      ) : null}
    </div>
  );
}
