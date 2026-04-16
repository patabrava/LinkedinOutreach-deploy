"use server";

import { headers } from "next/headers";
import { isAllowed, normalizeEmail } from "../../lib/allowlist";
import { supabaseServerAction } from "../../lib/supabaseServer";

export type LoginState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; code: "AUTH_UNREACHABLE" | "INVALID_EMAIL" };

export async function requestMagicLink(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const raw = formData.get("email");
  if (typeof raw !== "string") {
    return { status: "error", code: "INVALID_EMAIL" };
  }
  const email = normalizeEmail(raw);
  if (!email.includes("@")) {
    return { status: "error", code: "INVALID_EMAIL" };
  }

  // Always return generic ok for disallowed emails — never reveal membership.
  if (!isAllowed(email)) {
    return { status: "ok" };
  }

  const hdrs = headers();
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host");
  const proto = hdrs.get("x-forwarded-proto") ?? "http";
  const origin = host ? `${proto}://${host}` : "";

  const nextRaw = formData.get("next");
  const next = typeof nextRaw === "string" && nextRaw.startsWith("/") ? nextRaw : "/";
  const redirectTo = `${origin}/auth/callback?next=${encodeURIComponent(next)}`;

  const supabase = supabaseServerAction();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  });

  if (error) {
    console.error("[auth] signInWithOtp failed", error.message);
    return { status: "error", code: "AUTH_UNREACHABLE" };
  }

  return { status: "ok" };
}
