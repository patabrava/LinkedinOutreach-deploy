import {
  createMiddlewareClient,
  createRouteHandlerClient,
  createServerActionClient,
  createServerComponentClient,
} from "@supabase/auth-helpers-nextjs";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";

export function supabaseServerComponent() {
  return createServerComponentClient({ cookies });
}

export function supabaseServerAction() {
  return createServerActionClient({ cookies });
}

export function supabaseRouteHandler() {
  return createRouteHandlerClient({ cookies });
}

export function supabaseMiddleware(req: NextRequest, res: NextResponse) {
  return createMiddlewareClient({ req, res });
}
