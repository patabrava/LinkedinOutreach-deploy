import AnalyticsOverviewView from '../../components/AnalyticsOverviewView';
import { analyticsAccess, analyticsRevision, analyticsSnapshot } from '../../lib/analyticsLiveServer';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export default async function AnalyticsPage({ searchParams }: { searchParams?: { days?: string } }) {
  const parsed = Number(searchParams?.days || 7);
  const days = [7, 30, 90].includes(parsed) ? parsed : 7;
  const privateDetails = await analyticsAccess();
  const revision = await analyticsRevision('all', privateDetails);
  return <AnalyticsOverviewView key={days} initial={await analyticsSnapshot('all', days, privateDetails, revision)} />;
}
