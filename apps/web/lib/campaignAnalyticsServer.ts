import "server-only";

import { supabaseAdmin } from "./supabaseAdmin";
import {
  aggregateCampaignAnalytics,
  CAMPAIGN_ANALYTICS_SCOPES,
  type CampaignAnalytics,
  type CampaignAnalyticsEvent,
  type CampaignAnalyticsKind,
  type CampaignAnalyticsLead,
} from "./campaignAnalytics";

type CampaignBatchRow = {
  id: number;
  sequence_id: number;
  linkedin_account_id: string;
};

type CampaignSequenceRow = {
  id: number;
  linkedin_account_id: string;
  delivery_mode: string;
};

const PAGE_SIZE = 1000;

type PagedQuery<Row> = {
  range: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>;
};

async function fetchPaged<Row>(makeQuery: () => PagedQuery<Row>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await makeQuery().range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data || []) as Row[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

const expectedDeliveryMode = (kind: CampaignAnalyticsKind): string =>
  kind === "sales-navigator" ? "invite_and_inmail" : "standard_connect_message";

export async function fetchCampaignAnalytics(
  kind: CampaignAnalyticsKind,
  days = 30,
): Promise<CampaignAnalytics> {
  const scope = CAMPAIGN_ANALYTICS_SCOPES[kind];
  const safeDays = [7, 30, 90].includes(days) ? days : 30;
  const client = supabaseAdmin();
  const batchIds = scope.sequences.map((sequence) => sequence.batchId);
  const sequenceIds = scope.sequences.map((sequence) => sequence.sequenceId);

  const [{ data: batchData, error: batchError }, { data: sequenceData, error: sequenceError }] = await Promise.all([
    client.from("lead_batches").select("id, sequence_id, linkedin_account_id").in("id", batchIds),
    client.from("outreach_sequences").select("id, linkedin_account_id, delivery_mode").in("id", sequenceIds),
  ]);
  if (batchError) throw batchError;
  if (sequenceError) throw sequenceError;

  const batches = new Map(((batchData || []) as CampaignBatchRow[]).map((batch) => [batch.id, batch]));
  const sequences = new Map(((sequenceData || []) as CampaignSequenceRow[]).map((sequence) => [sequence.id, sequence]));
  const triples = scope.sequences.map((definition) => {
    const batch = batches.get(definition.batchId);
    const sequence = sequences.get(definition.sequenceId);
    if (
      !batch ||
      !sequence ||
      batch.sequence_id !== definition.sequenceId ||
      batch.linkedin_account_id !== sequence.linkedin_account_id ||
      sequence.delivery_mode !== expectedDeliveryMode(kind)
    ) {
      throw new Error(`Campaign analytics scope mismatch for batch ${definition.batchId} / sequence ${definition.sequenceId}.`);
    }
    return { ...definition, accountId: batch.linkedin_account_id };
  });

  const leadPages = await Promise.all(
    triples.map((triple) =>
      fetchPaged<CampaignAnalyticsLead>(() =>
        client
          .from("leads")
          .select("id, batch_id, sequence_id, linkedin_account_id, status")
          .eq("batch_id", triple.batchId)
          .eq("sequence_id", triple.sequenceId)
          .eq("linkedin_account_id", triple.accountId)
          .order("id", { ascending: true }),
      ),
    ),
  );
  const leads = leadPages.flat();
  const leadIds = new Set(leads.map((lead) => lead.id));
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (safeDays - 1));
  since.setUTCHours(0, 0, 0, 0);
  const until = new Date(since);
  until.setUTCDate(until.getUTCDate() + safeDays);

  const eventPages = await Promise.all(
    triples.map((triple) =>
      fetchPaged<CampaignAnalyticsEvent>(() =>
        client
          .from("outreach_events")
          .select("lead_id, sequence_id, linkedin_account_id, event_type, touch_number, occurred_at")
          .eq("sequence_id", triple.sequenceId)
          .eq("linkedin_account_id", triple.accountId)
          .gte("occurred_at", since.toISOString())
          .lt("occurred_at", until.toISOString())
          .order("occurred_at", { ascending: true }),
      ),
    ),
  );
  const events = eventPages.flat().filter((event) => leadIds.has(event.lead_id));

  return aggregateCampaignAnalytics({ scope, leads, events, days: safeDays });
}
