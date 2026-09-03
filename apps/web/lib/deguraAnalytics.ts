export type DeguraEvent = {
  linkedin_account_id: string;
  sequence_variant_id: number | null;
  event_type: string;
};

export type DeguraAnalyticsRow = {
  accountId: string;
  variantId: number | null;
  counts: Record<string, number>;
};

export function aggregateDeguraEvents(events: DeguraEvent[]): DeguraAnalyticsRow[] {
  const groups = new Map<string, DeguraAnalyticsRow>();
  for (const event of events) {
    const key = `${event.linkedin_account_id}:${event.sequence_variant_id ?? "none"}`;
    const row = groups.get(key) || {
      accountId: event.linkedin_account_id,
      variantId: event.sequence_variant_id,
      counts: {},
    };
    row.counts[event.event_type] = (row.counts[event.event_type] || 0) + 1;
    groups.set(key, row);
  }
  return [...groups.values()].sort((left, right) =>
    left.accountId.localeCompare(right.accountId) || (left.variantId || 0) - (right.variantId || 0),
  );
}
