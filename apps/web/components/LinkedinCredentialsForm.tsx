"use client";

import { useFormState, useFormStatus } from "react-dom";

import { saveLinkedinCredentials } from "../app/actions";
import type { LinkedinCredentialSummary, LinkedinCredentialState } from "../app/actions";

type Props = {
  existing: LinkedinCredentialSummary;
  useCard?: boolean;
};

const initialState: LinkedinCredentialState = { success: false };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn" type="submit" disabled={pending}>
      {pending ? "SAVING…" : "SAVE CREDENTIALS"}
    </button>
  );
}

export function LinkedinCredentialsForm({ existing, useCard = true }: Props) {
  const [state, formAction] = useFormState(saveLinkedinCredentials, initialState);

  const content = (
    <>
      <div className="pill">LinkedIn Auth</div>
      <h3 className="section-title-tight">CREDENTIALS</h3>
      <div className="muted" style={{ marginBottom: 16 }}>
        Stored securely in Supabase settings. These credentials are separate from the cached LinkedIn session on the worker, so saving them alone does not mean the scraper is ready.
      </div>

      <label htmlFor="email">
        EMAIL
      </label>
      <input
        className="input"
        id="email"
        name="email"
        type="email"
        defaultValue={existing.email || ""}
        placeholder="you@example.com"
        required
        autoComplete="username"
        style={{ marginBottom: 16 }}
      />

      <label htmlFor="password">
        PASSWORD
      </label>
      <input
        className="input"
        id="password"
        name="password"
        type="password"
        placeholder={existing.hasPassword ? "Password stored. Enter to replace." : "LinkedIn password"}
        required
        autoComplete="current-password"
        style={{ marginBottom: 20 }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <SubmitButton />
        {state?.success ? <span className="muted">SAVED.</span> : null}
        {state?.error ? (
          <span className="muted" style={{ color: "var(--accent)" }}>
            {state.error}
          </span>
        ) : null}
      </div>
    </>
  );

  if (useCard === false) {
    return (
      <form action={formAction} style={{ marginTop: 12 }}>
        {content}
      </form>
    );
  }

  return (
    <form className="card" action={formAction}>
      {content}
    </form>
  );
}
