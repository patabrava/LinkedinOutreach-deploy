"use client";

import { useState } from "react";

import type { LinkedinCredentialSummary } from "../app/actions";
import { LinkedinCredentialsForm } from "./LinkedinCredentialsForm";
import { StartLoginButton } from "./StartLoginButton";

type Props = {
  existingCreds: LinkedinCredentialSummary;
};

export function LoginLauncher({ existingCreds }: Props) {
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="card" style={{ alignSelf: "flex-start" }}>
      <div className="pill">LinkedIn Session</div>
      <h3 style={{ margin: "12px 0 8px 0" }}>LOGIN & CREDENTIALS</h3>
      <div className="muted" style={{ marginBottom: 16 }}>
        Kick off LinkedIn login. Save credentials first so Playwright can sign in and cache auth.json.
      </div>

      <StartLoginButton onStart={() => setShowForm(true)} />

      {showForm ? (
        <div style={{ marginTop: 16 }}>
          <LinkedinCredentialsForm existing={existingCreds} useCard={false} />
        </div>
      ) : (
        <button
          className="btn secondary"
          style={{ marginTop: 16 }}
          type="button"
          onClick={() => setShowForm(true)}
        >
          ADD LINKEDIN CREDENTIALS
        </button>
      )}
    </div>
  );
}
