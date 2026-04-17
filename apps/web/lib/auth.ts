import { createServerComponentClient } from "@supabase/auth-helpers-nextjs";
import type { Session, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { isSupabaseAuthConfigured } from "./authConfig";

export const LOGIN_PATH = "/login";

export const PROTECTED_ROUTE_PREFIXES = [
  "/leads",
  "/upload",
  "/followups",
  "/analytics",
  "/settings",
] as const;

export const isProtectedRoute = (pathname: string): boolean =>
  pathname === "/" || PROTECTED_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));

export const isAuthPublicRoute = (pathname: string): boolean =>
  pathname === LOGIN_PATH || pathname.startsWith("/api/") || pathname.startsWith("/_next/") || pathname === "/favicon.ico";

const hasSupabaseSessionConfig = (): boolean => isSupabaseAuthConfigured();

export async function getServerSession(): Promise<Session | null> {
  if (!hasSupabaseSessionConfig()) {
    return null;
  }

  const supabase = createServerComponentClient({ cookies });
  try {
    const { data } = await supabase.auth.getSession();
    return data.session ?? null;
  } catch {
    return null;
  }
}

export async function getServerUser(): Promise<User | null> {
  const session = await getServerSession();
  return session?.user ?? null;
}
