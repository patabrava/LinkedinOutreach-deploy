"use client";

import type { CustomOutreachBatchSummary } from "../app/actions";

type Props = {
  batch: CustomOutreachBatchSummary;
};

const STAGES: Array<{ key: keyof CustomOutreachBatchSummary; label: string; modifier: string }> = [
  { key: "new_count",         label: "NEW",         modifier: "status-new" },
  { key: "enriched_count",    label: "ENRICHED",    modifier: "status-enriched" },
  { key: "draft_ready_count", label: "DRAFT READY", modifier: "status-draft" },
  { key: "approved_count",    label: "APPROVED",    modifier: "status-approved" },
  { key: "sent_count",        label: "SENT",        modifier: "status-sent" },
  { key: "failed_count",      label: "FAILED",      modifier: "status-failed" },
];

export function CustomOutreachBatchProgress({ batch }: Props) {
  const total = batch.lead_count;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
        border: "3px solid var(--fg)",
        padding: "8px 10px",
        marginTop: 6,
      }}
      data-testid="custom-outreach-batch-progress"
    >
      <span className="muted" style={{ textTransform: "uppercase", fontSize: 11 }}>
        {total} LEADS
      </span>
      {STAGES.map((stage) => {
        const count = (batch[stage.key] as number) ?? 0;
        if (count === 0) return null;
        return (
          <span key={stage.key} className={`status-chip ${stage.modifier}`}>
            {stage.label} · {count}
          </span>
        );
      })}
    </div>
  );
}
