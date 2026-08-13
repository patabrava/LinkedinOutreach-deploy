import { NextResponse } from "next/server";

import { getServerSession } from "../../../../lib/auth";
import { readLinkedinAuthStatus } from "../../../../lib/linkedinAuthSession";
import { getLinkedinAccountRuntime } from "../../../../lib/linkedinAccountServer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const account = await getLinkedinAccountRuntime(new URL(request.url).searchParams.get("accountId"));
    return NextResponse.json({ ok: true, accountId: account.id, status: readLinkedinAuthStatus(account.id) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Invalid account." }, { status: 400 });
  }
}
