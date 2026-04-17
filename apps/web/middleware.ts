import { createMiddlewareClient } from "@supabase/auth-helpers-nextjs";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { isAllowed } from "./lib/allowlist";
import { isAuthPublicRoute, isProtectedRoute, LOGIN_PATH } from "./lib/auth";
import { isSupabaseAuthConfigured } from "./lib/authConfig";

const redirectToLogin = (request: NextRequest, reason?: string) => {
  const redirectUrl = new URL(LOGIN_PATH, request.url);
  if (reason) {
    redirectUrl.searchParams.set("e", reason);
  }
  const nextPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (nextPath !== "/") {
    redirectUrl.searchParams.set("next", nextPath);
  }
  return NextResponse.redirect(redirectUrl);
};

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const response = NextResponse.next();

  if (isProtectedRoute(pathname) && !isSupabaseAuthConfigured()) {
    return redirectToLogin(request, "config");
  }

  if (isAuthPublicRoute(pathname) || !isProtectedRoute(pathname)) {
    return response;
  }

  const supabase = createMiddlewareClient({ req: request, res: response });
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (pathname === LOGIN_PATH && user && isAllowed(user.email ?? "")) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (!user) {
    return redirectToLogin(request);
  }

  if (!isAllowed(user.email ?? "")) {
    await supabase.auth.signOut();
    const redirectUrl = new URL(LOGIN_PATH, request.url);
    redirectUrl.searchParams.set("e", "denied");
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*|api/.*).*)"],
};
