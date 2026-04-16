export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return Response.json({ ok: true, service: "web", ts: new Date().toISOString() });
}
