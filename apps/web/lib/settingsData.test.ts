import assert from "node:assert/strict";
import test from "node:test";

import { resolveSettingsData } from "./settingsData";

test("keeps loaded accounts available when the campaign query fails", () => {
  const accounts = [{ id: "account-1" }];
  const fallbackCampaign = { ready: false, codes: ["SUPABASE_UNAVAILABLE"] };

  const result = resolveSettingsData(
    { status: "fulfilled", value: accounts },
    { status: "rejected", reason: new TypeError("fetch failed") },
    fallbackCampaign,
  );

  assert.deepEqual(result.accounts, accounts);
  assert.deepEqual(result.campaign, fallbackCampaign);
  assert.equal(result.accountsUnavailable, false);
  assert.equal(result.campaignUnavailable, true);
});

test("marks the account source unavailable without inventing login accounts", () => {
  const fallbackCampaign = { ready: false, codes: ["SUPABASE_UNAVAILABLE"] };

  const result = resolveSettingsData(
    { status: "rejected", reason: new TypeError("fetch failed") },
    { status: "fulfilled", value: fallbackCampaign },
    fallbackCampaign,
  );

  assert.deepEqual(result.accounts, []);
  assert.equal(result.accountsUnavailable, true);
  assert.equal(result.campaignUnavailable, false);
});
