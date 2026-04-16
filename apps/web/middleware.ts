import { createMiddlewareClient } from "@supabase/auth-helpers-nextjs";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { isAllowed } from "./lib/allowlist";
import { isAuthPublicRoute, isProtectedRoute, LOGIN_PATH } from "./lib/auth";

const hasSupabaseSessionConfig = (): boolean =>
  Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const response = NextResponse.next();

  if (!hasSupabaseSessionConfig()) {
    return response;
  }

  const supabase = createMiddlewareClient({ req: request, res: response });
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (pathname === LOGIN_PATH && user && isAllowed(user.email ?? "")) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (isAuthPublicRoute(pathname) || !isProtectedRoute(pathname)) {
    return response;
  }

  if (!user) {
    const redirectUrl = new URL(LOGIN_PATH, request.url);
    const nextPath = `${pathname}${request.nextUrl.search}`;
    if (nextPath !== "/") {
      redirectUrl.searchParams.set("next", nextPath);
    }
    return NextResponse.redirect(redirectUrl);
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
