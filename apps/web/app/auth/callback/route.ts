import { NextResponse, type NextRequest } from "next/server";
import { isAllowed } from "../../../lib/allowlist";
import { isSupabaseAuthConfigured } from "../../../lib/authConfig";
import { supabaseRouteHandler } from "../../../lib/supabaseServer";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const nextParam = url.searchParams.get("next");
  const next = nextParam && nextParam.startsWith("/") ? nextParam : "/";
  const origin = url.origin;

  if (!isSupabaseAuthConfigured()) {
    return NextResponse.redirect(`${origin}/login?e=config`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?e=expired`);
  }

  const supabase = supabaseRouteHandler();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/login?e=expired`);
  }

  const email = data.session.user.email ?? "";
  if (!isAllowed(email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?e=denied`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
