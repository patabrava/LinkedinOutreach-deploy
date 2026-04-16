"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { isSupabaseBrowserConfigured, supabaseBrowserClient } from "../../lib/supabaseClient";

export function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const supabaseConfigured = isSupabaseBrowserConfigured();

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabaseConfigured) {
      setError("Supabase login is not configured yet.");
      return;
    }
    setPending(true);
    setError("");

    const supabase = supabaseBrowserClient();
    if (!supabase) {
      setPending(false);
      setError("Supabase login is not configured yet.");
      return;
    }
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError(signInError.message);
      setPending(false);
      return;
    }

    router.replace(nextPath);
    router.refresh();
  };

  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <div className="pill">Operator Login</div>
      <h1 style={{ marginTop: 16 }}>Mission Control Access</h1>
      <p className="muted" style={{ marginBottom: 24 }}>
        Sign in to reach the outreach dashboard. This gate protects the Mission Control, leads,
        upload, follow-up, and settings pages.
      </p>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }}>
        <div>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        {error ? <div className="pill status-failed">{error}</div> : null}

        <button className="btn accent" type="submit" disabled={pending || !supabaseConfigured}>
          {pending ? "Signing in..." : supabaseConfigured ? "Sign in" : "Supabase unavailable"}
        </button>
        {!supabaseConfigured ? (
          <div className="muted" style={{ fontSize: 12 }}>
            Add `NEXT_PUBLIC_SUPABASE_URL` and a publishable or anon key to enable this login.
          </div>
        ) : null}
      </form>
    </div>
  );
}
