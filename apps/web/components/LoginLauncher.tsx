"use client";

import type { LinkedinCredentialSummary } from "../app/actions";
import type { LinkedinAuthStatus } from "../lib/linkedinAuthSession";
import { LinkedinCredentialsForm } from "./LinkedinCredentialsForm";
import { StartLoginButton } from "./StartLoginButton";

type Props = {
  existingCreds: LinkedinCredentialSummary;
  authStatus: LinkedinAuthStatus;
};

const SESSION_COPY: Record<
  LinkedinAuthStatus["session_state"],
  { label: string; helper: string; cta: string }
> = {
  no_credentials: {
    label: "NO CREDENTIALS",
    helper: "Save your LinkedIn email and password below before you launch a session.",
    cta: "START LOGIN ATTEMPT",
  },
  credentials_saved: {
    label: "CREDENTIALS SAVED",
    helper: "The login details are stored, but this worker has not verified a usable LinkedIn session yet.",
    cta: "START LOGIN ATTEMPT",
  },
  session_active: {
    label: "SESSION ACTIVE",
    helper: "A cached LinkedIn session is available on the worker.",
    cta: "RECHECK SESSION",
  },
  session_expired: {
    label: "SESSION EXPIRED",
    helper: "The cached session was rejected. Launch LinkedIn login again to refresh it.",
    cta: "RECONNECT SESSION",
  },
  login_required: {
    label: "LOGIN REQUIRED",
    helper: "LinkedIn needs a fresh login before this worker can continue.",
    cta: "START LOGIN ATTEMPT",
  },
};

const formatTimestamp = (value: string | null) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
};

export function LoginLauncher({ existingCreds, authStatus }: Props) {
  const sessionCopy = SESSION_COPY[authStatus.session_state];
  const lastVerified = formatTimestamp(authStatus.last_verified_at);
  const lastAttempt = formatTimestamp(authStatus.last_login_attempt_at);
  const recoveredCachedSession = authStatus.session_state === "session_active" && !authStatus.credentials_saved;

  return (
    <div className="card" style={{ alignSelf: "flex-start" }}>
      <div className="pill">LinkedIn Session</div>
      <h3 className="section-title-tight">SESSION STATUS</h3>
      <div className="muted" style={{ marginBottom: 12 }}>
        {sessionCopy.label}
      </div>
      <div style={{ marginBottom: 16 }}>
        <div className="muted">{sessionCopy.helper}</div>
        {recoveredCachedSession ? (
          <div className="muted" style={{ marginTop: 8, color: "var(--accent)" }}>
            Recovered from the cached browser session. You can scrape now, and the next successful login will refresh the status file.
          </div>
        ) : null}
        <div className="muted" style={{ marginTop: 8 }}>
          Credentials saved: {authStatus.credentials_saved ? "Yes" : "No"} · Cached session file:{" "}
          {authStatus.auth_file_present ? "Present" : "Missing"}
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
        {authStatus.last_login_result ? (
          <div className="muted" style={{ marginTop: 4 }}>
            Last login result: {authStatus.last_login_result}
          </div>
        ) : null}
        {authStatus.last_error ? (
          <div className="muted" style={{ marginTop: 4, color: "var(--accent)" }}>
            Last error: {authStatus.last_error}
          </div>
        ) : null}
      </div>

      <StartLoginButton label={sessionCopy.cta} />

      <div style={{ marginTop: 16 }}>
        <LinkedinCredentialsForm existing={existingCreds} useCard={false} />
      </div>
    </div>
  );
}
