"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("App error boundary caught:", error);
  }, [error]);

  return (
    <div className="page">
      <div className="pill">Error</div>
      <h1 className="page-title">SOMETHING BROKE</h1>
      <div className="card" style={{ maxWidth: 640 }}>
        <div className="muted" style={{ marginBottom: 12 }}>
          The server action or page fetch failed. Check the console and Supabase credentials.
        </div>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginBottom: 16, color: "var(--muted)" }}>
          {error.message}
          {error.digest ? `\nDigest: ${error.digest}` : ""}
        </pre>
        <button className="btn accent" type="button" onClick={reset}>
          RETRY
        </button>
      </div>
    </div>
  );
}
