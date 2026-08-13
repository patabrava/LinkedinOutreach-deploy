import { requireLinkedinAccountId } from "./linkedinAccounts";
import { supabaseAdmin } from "./supabaseAdmin";

export type LinkedinAccountRuntime = {
  id: string;
  label: string;
  displayName: string;
  browserSlot: 1 | 2;
  dailyInviteLimit: number;
  dailyMessageLimit: number;
};

export async function getLinkedinAccountRuntime(value: unknown): Promise<LinkedinAccountRuntime> {
  const accountId = requireLinkedinAccountId(value);
  const { data, error } = await supabaseAdmin()
    .from("linkedin_accounts")
    .select("id, label, display_name, browser_slot, daily_invite_limit, daily_message_limit, is_active")
    .eq("id", accountId)
    .single();

  if (error || !data) throw new Error("LinkedIn account was not found.");
  if (!data.is_active) throw new Error("LinkedIn account is disabled.");
  if (data.browser_slot !== 1 && data.browser_slot !== 2) {
    throw new Error("LinkedIn account has no remote browser slot.");
  }
  return {
    id: data.id,
    label: data.label,
    displayName: data.display_name || "",
    browserSlot: data.browser_slot,
    dailyInviteLimit: data.daily_invite_limit || 50,
    dailyMessageLimit: data.daily_message_limit || 50,
  };
}

export async function getLinkedinAccountForBatch(batchId: unknown, requestedAccountId?: unknown): Promise<LinkedinAccountRuntime> {
  if (typeof batchId !== "number" || !Number.isInteger(batchId) || batchId < 1) {
    return getLinkedinAccountRuntime(requestedAccountId);
  }
  const { data, error } = await supabaseAdmin()
    .from("lead_batches")
    .select("linkedin_account_id")
    .eq("id", batchId)
    .single();
  if (error || !data?.linkedin_account_id) throw new Error("Lead batch was not found or has no sender account.");
  if (requestedAccountId && requireLinkedinAccountId(requestedAccountId) !== data.linkedin_account_id) {
    throw new Error("Selected sender does not own this lead batch.");
  }
  return getLinkedinAccountRuntime(data.linkedin_account_id);
}
