import { NextResponse } from "next/server";

import { getServerSession } from "../../../../lib/auth";
import { readLinkedinAuthStatus } from "../../../../lib/linkedinAuthSession";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const session = await getServerSession();
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ ok: true, status: readLinkedinAuthStatus() });
}
