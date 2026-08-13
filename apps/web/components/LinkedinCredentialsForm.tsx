"use client";

import { useFormState, useFormStatus } from "react-dom";

import { saveLinkedinAccount } from "../app/actions";
import type { LinkedinCredentialSummary, LinkedinCredentialState } from "../app/actions";

type Props = {
  existing: LinkedinCredentialSummary;
  useCard?: boolean;
  accountId?: string;
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

export function LinkedinCredentialsForm({ existing, useCard = true, accountId }: Props) {
  const [state, formAction] = useFormState(saveLinkedinAccount, initialState);
  const fieldPrefix = accountId || "new-linkedin-account";

  const content = (
    <>
      <input type="hidden" name="account_id" value={accountId || ""} />
      <input type="hidden" name="is_active" value={existing.is_active === false ? "false" : "true"} />
      <div className="pill">LinkedIn Account</div>
      <h3 className="section-title-tight">{accountId ? "ACCOUNT DETAILS" : "ADD ACCOUNT"}</h3>
      <div className="muted" style={{ marginBottom: 16 }}>
        Credentials are encrypted in Supabase. Browser sessions and worker limits are isolated for this sender.
      </div>

      <label htmlFor={`${fieldPrefix}-label`}>ACCOUNT LABEL</label>
      <input
        className="input"
        id={`${fieldPrefix}-label`}
        name="label"
        defaultValue={existing.label || ""}
        placeholder="Sales account 1"
        required
        style={{ marginBottom: 16 }}
      />

      <label htmlFor={`${fieldPrefix}-display-name`}>SENDER DISPLAY NAME</label>
      <input
        className="input"
        id={`${fieldPrefix}-display-name`}
        name="display_name"
        defaultValue={existing.display_name || ""}
        placeholder="Full name shown on LinkedIn"
        required
        style={{ marginBottom: 16 }}
      />

      <label htmlFor={`${fieldPrefix}-email`}>
        EMAIL
      </label>
      <input
        className="input"
        id={`${fieldPrefix}-email`}
        name="email"
        type="email"
        defaultValue={existing.email || ""}
        placeholder="you@example.com"
        required
        autoComplete="username"
        style={{ marginBottom: 16 }}
      />

      <label htmlFor={`${fieldPrefix}-password`}>
        PASSWORD
      </label>
      <input
        className="input"
        id={`${fieldPrefix}-password`}
        name="password"
        type="password"
        placeholder={existing.hasPassword ? "Password stored. Enter to replace." : "LinkedIn password"}
        required={!existing.hasPassword}
        autoComplete="current-password"
        style={{ marginBottom: 16 }}
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginBottom: 20 }}>
        <div>
          <label htmlFor={`${fieldPrefix}-invite-limit`}>DAILY INVITE LIMIT</label>
          <input className="input" id={`${fieldPrefix}-invite-limit`} name="daily_invite_limit" type="number" min="1" defaultValue={existing.daily_invite_limit || 50} required />
        </div>
        <div>
          <label htmlFor={`${fieldPrefix}-message-limit`}>DAILY MESSAGE LIMIT</label>
          <input className="input" id={`${fieldPrefix}-message-limit`} name="daily_message_limit" type="number" min="1" defaultValue={existing.daily_message_limit || 50} required />
        </div>
      </div>

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
