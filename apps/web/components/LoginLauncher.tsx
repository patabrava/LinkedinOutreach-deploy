"use client";

import { useState } from "react";

import type { LinkedinCredentialSummary } from "../app/actions";
import type { LinkedinAuthStatus } from "../lib/linkedinAuthSession";
import { getOperatorApiHeaders } from "../lib/operatorToken";
import { LinkedinCredentialsForm } from "./LinkedinCredentialsForm";
import { RemoteLinkedinBrowser } from "./RemoteLinkedinBrowser";
import { StartLoginButton } from "./StartLoginButton";

type Props = {
  existingCreds: LinkedinCredentialSummary;
  authStatus: LinkedinAuthStatus;
};

const SESSION_COPY: Record<
  LinkedinAuthStatus["session_state"],
  { label: string; cta: string }
> = {
  no_credentials: {
    label: "NO CREDENTIALS",
    cta: "START LOGIN ATTEMPT",
  },
  credentials_saved: {
    label: "CREDENTIALS SAVED",
    cta: "START LOGIN ATTEMPT",
  },
  session_active: {
    label: "SESSION ACTIVE",
    cta: "RECHECK SESSION",
  },
  session_expired: {
    label: "SESSION EXPIRED",
    cta: "RECONNECT SESSION",
  },
  login_required: {
    label: "LOGIN REQUIRED",
    cta: "START LOGIN ATTEMPT",
  },
};

const formatTimestamp = (value: string | null) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
};

type LoginStartResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
  browserUrl?: string;
  status?: LinkedinAuthStatus;
};

type RemoteSessionResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
  status?: LinkedinAuthStatus;
};

const OPERATOR_SEQUENCE = [
  "Start the remote browser session.",
  "Complete LinkedIn login, challenge, and 2FA directly in the embedded browser.",
  "Wait until LinkedIn is fully authenticated in that browser window.",
  "Click Capture Session to sync the live browser state back to the worker.",
];

export function LoginLauncher({ existingCreds, authStatus }: Props) {
  const [currentStatus, setCurrentStatus] = useState(authStatus);
  const [isLaunching, setIsLaunching] = useState(false);
  const [browserUrl, setBrowserUrl] = useState("");
  const [sessionMessage, setSessionMessage] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [sessionAction, setSessionAction] = useState<"sync" | "reset" | null>(null);

  const sessionCopy = SESSION_COPY[currentStatus.session_state];
  const lastVerified = formatTimestamp(currentStatus.last_verified_at);
  const lastAttempt = formatTimestamp(currentStatus.last_login_attempt_at);
  const recoveredCachedSession =
    currentStatus.session_state === "session_active" && !currentStatus.credentials_saved;
  const isBusy = isLaunching || sessionAction !== null;

  const handleStartResult = (result: LoginStartResponse) => {
    if (result.status) {
      setCurrentStatus(result.status);
    }
    if (typeof result.browserUrl === "string") {
      setBrowserUrl(result.browserUrl);
    }
    setSessionMessage(result.message || "");
    setSessionError(result.ok === false ? result.error || result.message || "Failed to start login." : "");
  };

  const runRemoteSessionAction = async (action: "sync" | "reset") => {
    setSessionAction(action);
    setSessionMessage("");
    setSessionError("");

    try {
      const response = await fetch("/api/linkedin-auth/remote-session", {
        method: "POST",
        headers: {
          ...getOperatorApiHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ action }),
      });

      const result = (await response.json()) as RemoteSessionResponse;
      if (result.status) {
        setCurrentStatus(result.status);
      }

      if (!response.ok || result.ok === false) {
        throw new Error(result.error || result.message || `Remote session ${action} failed.`);
      }

      if (action === "reset") {
        setBrowserUrl("");
      }
      setSessionMessage(result.message || `Remote session ${action} completed.`);
    } catch (error: unknown) {
      setSessionError(error instanceof Error ? error.message : `Remote session ${action} failed.`);
    } finally {
      setSessionAction(null);
    }
  };

  return (
    <div className="card" style={{ alignSelf: "flex-start" }}>
      <div className="pill">LinkedIn Session</div>
      <h3 className="section-title-tight">SESSION STATUS</h3>
      <div className="muted" style={{ marginBottom: 12 }}>
        {sessionCopy.label}
      </div>
      <div style={{ marginBottom: 16 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Operator sequence:
        </div>
        <ol
          style={{
            marginTop: 0,
            marginBottom: 0,
            paddingLeft: 18,
            display: "grid",
            gap: 6,
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          {OPERATOR_SEQUENCE.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {recoveredCachedSession ? (
          <div className="muted" style={{ marginTop: 8, color: "var(--accent)" }}>
            Recovered from the cached browser session. You can scrape now, and the next successful login will refresh the status file.
          </div>
        ) : null}
        <div className="muted" style={{ marginTop: 8 }}>
          Credentials saved: {currentStatus.credentials_saved ? "Yes" : "No"} · Cached session file:{" "}
          {currentStatus.auth_file_present ? "Present" : "Missing"}
        </div>
        {lastVerified ? (
          <div className="muted" style={{ marginTop: 4 }}>
            Last verified: {lastVerified}
          </div>
        ) : null}
        {lastAttempt ? (
          <div className="muted" style={{ marginTop: 4 }}>
            Last login attempt: {lastAttempt}
          </div>
        ) : null}
        {currentStatus.last_login_result ? (
          <div className="muted" style={{ marginTop: 4 }}>
            Last login result: {currentStatus.last_login_result}
          </div>
        ) : null}
        {currentStatus.last_error ? (
          <div className="muted" style={{ marginTop: 4, color: "var(--accent)" }}>
            Last error: {currentStatus.last_error}
          </div>
        ) : null}
      </div>

      <StartLoginButton
        label={sessionCopy.cta}
        browserUrl={browserUrl}
        disabled={isBusy}
        onBusyChange={setIsLaunching}
        onResult={handleStartResult}
      />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
        <button
          type="button"
          className="btn secondary"
          disabled={isBusy}
          onClick={() => runRemoteSessionAction("sync")}
        >
          {sessionAction === "sync" ? "CAPTURING…" : "CAPTURE SESSION"}
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={isBusy}
          onClick={() => runRemoteSessionAction("reset")}
        >
          {sessionAction === "reset" ? "RESETTING…" : "RESET BROWSER"}
        </button>
      </div>

      {sessionMessage ? (
        <div
          style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}
          role="status"
          aria-live="polite"
        >
          {sessionMessage}
        </div>
      ) : null}
      {sessionError ? (
        <div
          style={{ marginTop: 12, fontSize: 12, color: "var(--accent)" }}
          role="alert"
          aria-live="assertive"
        >
          {sessionError}
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <LinkedinCredentialsForm existing={existingCreds} useCard={false} />
      </div>

      {browserUrl ? (
        <RemoteLinkedinBrowser browserUrl={browserUrl} helperMessage={sessionMessage || undefined} />
      ) : null}
    </div>
  );
}
