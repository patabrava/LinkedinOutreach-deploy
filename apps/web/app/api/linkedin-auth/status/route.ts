import { NextResponse } from "next/server";

import { readLinkedinAuthStatus } from "../../../../lib/linkedinAuthSession";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json({ ok: true, status: readLinkedinAuthStatus() });
}
