"use client";

type Props = {
  browserUrl: string;
  helperMessage?: string;
};

const OPERATOR_STEPS = [
  "Launch the remote browser session and wait for LinkedIn to finish loading inside the embedded window.",
  "Sign in with the stored LinkedIn credentials, then complete any checkpoint, captcha, or 2FA prompt directly in that remote browser.",
  "Once the LinkedIn home feed or target profile is visible, return here and click Capture Session to sync the authenticated browser state back to the worker.",
  "If the remote browser is stuck on an old account or challenge loop, click Reset Browser, reload the session, and sign in again before capturing.",
];

export function RemoteLinkedinBrowser({ browserUrl, helperMessage }: Props) {
  return (
    <section
      className="card"
      style={{
        marginTop: 16,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div className="pill">Remote Browser</div>
      <h3 className="section-title-tight">LINKEDIN LOGIN OPERATOR VIEW</h3>
      {helperMessage ? (
        <div
          className="muted"
          style={{ fontSize: 12, color: "var(--accent)", border: "2px solid #000", padding: 10 }}
        >
          {helperMessage}
        </div>
      ) : null}

      <div className="muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
        Remote browser URL:{" "}
        <a href={browserUrl} target="_blank" rel="noreferrer">
          {browserUrl}
        </a>
      </div>

      <ol
        style={{
          margin: 0,
          paddingLeft: 18,
          display: "grid",
          gap: 8,
          fontSize: 12,
          color: "var(--muted)",
        }}
      >
        {OPERATOR_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <div
        style={{
          border: "2px solid #000",
          background: "#f6f1e8",
          minHeight: 520,
          overflow: "hidden",
        }}
      >
        <iframe
          key={browserUrl}
          src={browserUrl}
          title="Remote LinkedIn browser"
          style={{ width: "100%", minHeight: 520, border: 0, display: "block" }}
          allow="fullscreen"
        />
      </div>
    </section>
  );
}
