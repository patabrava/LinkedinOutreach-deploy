"use client";

import { useFormState, useFormStatus } from "react-dom";
import { requestMagicLink, type LoginState } from "./actions";

const initialState: LoginState = { status: "idle" };

function SubmitButton({ state }: { state: LoginState }) {
  const { pending } = useFormStatus();
  const label = pending ? "SENDING..." : state.status === "ok" ? "LINK SENT →" : "SEND LINK";
  const className = state.status === "ok" ? "btn accent" : "btn";
  return (
    <button type="submit" className={className} disabled={pending}>
      {label}
    </button>
  );
}

function statusLine(state: LoginState, queryError: string | null): string {
  if (state.status === "ok") return "IF ALLOWED, A LINK WAS SENT.";
  if (state.status === "error" && state.code === "AUTH_UNREACHABLE") return "AUTH SYSTEM UNREACHABLE";
  if (state.status === "error" && state.code === "INVALID_EMAIL") return "INVALID EMAIL";
  if (state.status === "error" && state.code === "RATE_LIMITED")
    return "TOO MANY ATTEMPTS. WAIT ~1H OR TRY ANOTHER ALLOWED EMAIL.";
  if (queryError === "denied") return "ACCESS DENIED.";
  if (queryError === "expired") return "LINK EXPIRED. REQUEST A NEW ONE.";
  return "";
}

export function LoginForm({
  nextPath,
  queryError,
}: {
  nextPath: string;
  queryError: string | null;
}) {
  const [state, formAction] = useFormState(requestMagicLink, initialState);
  const inputClass = state.status === "error" ? "login-input login-input--error" : "login-input";

  return (
    <form action={formAction} className="login-card">
      <input type="hidden" name="next" value={nextPath} />
      <label htmlFor="email" className="login-label">EMAIL</label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        className={inputClass}
      />
      <SubmitButton state={state} />
      <p className="login-status">{statusLine(state, queryError)}</p>
    </form>
  );
}
