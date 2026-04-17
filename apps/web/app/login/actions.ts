"use server";

import { headers } from "next/headers";
import { isAllowed, normalizeEmail } from "../../lib/allowlist";
import { isSupabaseAuthConfigured } from "../../lib/authConfig";
import { resolveAuthRedirectOrigin } from "../../lib/siteOrigin";
import { supabaseServerAction } from "../../lib/supabaseServer";

export type LoginState =
  | { status: "idle" }
  | { status: "ok" }
  | {
    status: "error";
    code: "AUTH_NOT_CONFIGURED" | "AUTH_UNREACHABLE" | "INVALID_EMAIL" | "RATE_LIMITED" | "SITE_URL_MISSING";
  };

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

  if (!isSupabaseAuthConfigured()) {
    return { status: "error", code: "AUTH_NOT_CONFIGURED" };
  }

  // Always return generic ok for disallowed emails — never reveal membership.
  if (!isAllowed(email)) {
    return { status: "ok" };
  }

  const hdrs = headers();
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host");
  const proto = hdrs.get("x-forwarded-proto") ?? "https";
  const requestOrigin = host ? `${proto}://${host}` : "";
  const origin = resolveAuthRedirectOrigin(requestOrigin);

  if (!origin) {
    return { status: "error", code: "SITE_URL_MISSING" };
  }

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
    const msg = error.message.toLowerCase();
    if (error.status === 429 || msg.includes("rate limit")) {
      return { status: "error", code: "RATE_LIMITED" };
    }
    return { status: "error", code: "AUTH_UNREACHABLE" };
  }

  return { status: "ok" };
}
