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
      {pending ? "Saving..." : "Save credentials"}
    </button>
  );
}

export function LinkedinCredentialsForm({ existing, useCard = true }: Props) {
  const [state, formAction] = useFormState(saveLinkedinCredentials, initialState);

  const content = (
    <>
      <div className="pill">LinkedIn Auth</div>
      <h3 style={{ margin: "10px 0 6px 0" }}>Credentials</h3>
      <div className="muted" style={{ marginBottom: 12 }}>
        Stored securely in Supabase settings. Used by the Playwright scraper to log in and cache auth.json.
      </div>

      <label className="muted" htmlFor="email">
        Email
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
        style={{ marginBottom: 10 }}
      />

      <label className="muted" htmlFor="password">
        Password
      </label>
      <input
        className="input"
        id="password"
        name="password"
        type="password"
        placeholder={existing.hasPassword ? "Password stored. Enter to replace." : "LinkedIn password"}
        required
        autoComplete="current-password"
        style={{ marginBottom: 12 }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <SubmitButton />
        {state?.success ? <span className="muted">Saved.</span> : null}
        {state?.error ? (
          <span className="muted" style={{ color: "#fca5a5" }}>
            {state.error}
          </span>
        ) : null}
      </div>
    </>
  );

  if (useCard === false) {
    return (
      <form action={formAction} style={{ marginTop: 8 }}>
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
