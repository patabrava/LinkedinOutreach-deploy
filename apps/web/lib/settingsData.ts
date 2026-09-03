export function resolveSettingsData<TAccount, TCampaign>(
  accountsResult: PromiseSettledResult<TAccount[]>,
  campaignResult: PromiseSettledResult<TCampaign>,
  fallbackCampaign: TCampaign,
) {
  return {
    accounts: accountsResult.status === "fulfilled" ? accountsResult.value : [],
    campaign: campaignResult.status === "fulfilled" ? campaignResult.value : fallbackCampaign,
    accountsUnavailable: accountsResult.status === "rejected",
    campaignUnavailable: campaignResult.status === "rejected",
  };
}
