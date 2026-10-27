import { notFound } from 'next/navigation';
import CampaignAnalyticsView from '../../../components/CampaignAnalyticsView';
import { analyticsAccess, analyticsRevision, analyticsSnapshot } from '../../../lib/analyticsLiveServer';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export default async function CampaignAnalyticsPage({ params, searchParams }: {
  params: { campaign: string }; searchParams?: { days?: string };
}) {
  if (params.campaign !== 'regular' && params.campaign !== 'sales-navigator') notFound();
  const parsed = Number(searchParams?.days || 30);
  const days = [7, 30, 90].includes(parsed) ? parsed : 30;
  const privateDetails = await analyticsAccess();
  const revision = await analyticsRevision(params.campaign, privateDetails);
  return <CampaignAnalyticsView key={`${params.campaign}:${days}`} initial={await analyticsSnapshot(params.campaign, days, privateDetails, revision)} />;
}
