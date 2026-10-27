import { NextRequest, NextResponse } from 'next/server';
import { analyticsAccess, analyticsRevision, analyticsSnapshot, type AnalyticsScope } from '../../../../lib/analyticsLiveServer';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' };
export async function GET(request: NextRequest) {
  const scope = request.nextUrl.searchParams.get('scope') || 'regular';
  const days = Number(request.nextUrl.searchParams.get('days') || 30);
  if (!['all', 'regular', 'sales-navigator'].includes(scope) || ![7, 30, 90].includes(days)) {
    return NextResponse.json({ status: 400, code: 'INVALID_ANALYTICS_SCOPE', message: 'Choose a valid campaign and 7, 30 or 90 days.' }, { status: 400, headers });
  }
  try {
    // Never trust a caller's requested detail level or a client-cached auth state.
    const privateDetails = await analyticsAccess();
    const revision = await analyticsRevision(scope as AnalyticsScope, privateDetails);
    if (request.nextUrl.searchParams.get('revision') === revision) return new NextResponse(null, { status: 304, headers });
    return NextResponse.json(await analyticsSnapshot(scope as AnalyticsScope, days, privateDetails, revision), { headers });
  } catch {
    console.error(JSON.stringify({ feature: 'analytics-live', code: 'SNAPSHOT_UNAVAILABLE', scope }));
    return NextResponse.json({ status: 503, code: 'SNAPSHOT_UNAVAILABLE', message: 'Analytics could not refresh. Retrying automatically.' }, { status: 503, headers });
  }
}
