import { NextResponse, type NextRequest } from "next/server";
import { supabaseRouteHandler } from "../../lib/supabaseServer";

export async function POST(req: NextRequest) {
  const supabase = supabaseRouteHandler();
  await supabase.auth.signOut();
  const origin = new URL(req.url).origin;
  return NextResponse.redirect(`${origin}/login`, { status: 303 });
}
