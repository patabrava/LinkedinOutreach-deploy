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
    <div className="card" style={{ width: 380, alignSelf: "flex-start" }}>
      <div className="pill">Lead Enrichment</div>
      <h3 style={{ margin: "10px 0 6px 0" }}>LinkedIn Session</h3>
      <div className="muted" style={{ marginBottom: 10 }}>
        Kick off LinkedIn login. Save credentials first so Playwright can sign in and cache auth.json.
      </div>

      <StartLoginButton onStart={() => setShowForm(true)} />

      {showForm ? (
        <div style={{ marginTop: 12 }}>
          <LinkedinCredentialsForm existing={existingCreds} useCard={false} />
        </div>
      ) : (
        <button
          className="btn secondary"
          style={{ marginTop: 12 }}
          type="button"
          onClick={() => setShowForm(true)}
        >
          Add LinkedIn credentials
        </button>
      )}
    </div>
  );
}
