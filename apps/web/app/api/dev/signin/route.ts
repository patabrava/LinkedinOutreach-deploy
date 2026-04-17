import { NextResponse, type NextRequest } from "next/server";
import { isAllowed, normalizeEmail } from "../../../../lib/allowlist";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { supabaseRouteHandler } from "../../../../lib/supabaseServer";
import { getCanonicalSiteOrigin } from "../../../../lib/siteOrigin";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not Found", { status: 404 });
  }

  const form = await req.formData();
  const raw = form.get("email");
  if (typeof raw !== "string") {
    return new NextResponse("Bad Request", { status: 400 });
  }
  const email = normalizeEmail(raw);
  if (!isAllowed(email)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const admin = supabaseAdmin();
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    console.error("[dev-bypass] generateLink failed", linkError?.message);
    return new NextResponse("generateLink failed", { status: 500 });
  }

  const supabase = supabaseRouteHandler();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    email,
    token: linkData.properties.email_otp,
    type: "email",
  });
  if (verifyError) {
    console.error("[dev-bypass] verifyOtp failed", verifyError.message);
    return new NextResponse("verifyOtp failed", { status: 500 });
  }

  const nextRaw = form.get("next");
  const next = typeof nextRaw === "string" && nextRaw.startsWith("/") ? nextRaw : "/";
  const redirectOrigin = getCanonicalSiteOrigin() || "http://localhost:3000";
  return NextResponse.redirect(new URL(next, redirectOrigin), { status: 303 });
}
