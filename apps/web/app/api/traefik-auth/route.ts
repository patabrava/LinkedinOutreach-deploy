import { requireStrictOperatorSessionOrToken } from "../../../lib/linkedinBrowserControl";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const denial = await requireStrictOperatorSessionOrToken(
    request,
    "/api/traefik-auth",
    request.headers.get("x-request-id") || "traefik-forward-auth",
  );
  if (denial) return denial;
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
