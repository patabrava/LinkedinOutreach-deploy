"use client";

import { useState } from "react";

import type { LinkedinCredentialSummary } from "../app/actions";
import { LinkedinCredentialsForm } from "./LinkedinCredentialsForm";
import { StartEnrichmentButton } from "./StartEnrichmentButton";
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
        Kick off LinkedIn login and scraping. Save credentials first so Playwright can sign in and cache auth.json.
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <StartLoginButton onStart={() => setShowForm(true)} />
        <StartEnrichmentButton />
      </div>

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
