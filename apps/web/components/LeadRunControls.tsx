"use client";

import { useMemo, useState } from "react";

import type { OutreachSequenceRow } from "../app/actions";
import { StartEnrichmentButton } from "./StartEnrichmentButton";

type Props = {
  sequences: OutreachSequenceRow[];
};

const getDefaultSequenceId = (sequences: OutreachSequenceRow[]): number | null => {
  const activeSequence = sequences.find((sequence) => sequence.is_active);
  return activeSequence?.id ?? sequences[0]?.id ?? null;
};

export function LeadRunControls({ sequences }: Props) {
  const defaultSequenceId = useMemo(() => getDefaultSequenceId(sequences), [sequences]);
  const [sequenceId, setSequenceId] = useState<number | null>(defaultSequenceId);

  return (
    <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, borderLeft: "none", borderTop: "none", borderBottom: "none" }}>
      <div>
        <div className="pill">Next Actions</div>
        <h3 className="page-title">RUN WHAT&apos;S NEXT</h3>
        <div className="muted">Choose the sequence first. The launch buttons below will use that sequence for both outreach modes.</div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <label htmlFor="lead-run-sequence" className="muted" style={{ fontSize: 12 }}>
          Sequence
        </label>
        <select
          id="lead-run-sequence"
          className="input"
          value={sequenceId ?? ""}
          onChange={(event) => setSequenceId(event.target.value ? Number(event.target.value) : null)}
        >
          <option value="">No sequence selected</option>
          {sequences.map((sequence) => (
            <option key={sequence.id} value={sequence.id}>
              {sequence.name}
              {sequence.is_active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
        <div className="muted" style={{ fontSize: 12 }}>
          {sequenceId ? "This sequence will drive the invite note and post-acceptance messages." : "Pick a sequence before starting automation."}
        </div>
      </div>

      <div className="action-stack">
        <div className="action-stack__row action-stack__row--primary">
          <div className="action-stack__header">
            <strong>CONNECT + MESSAGE</strong>
            <div className="muted">Step 1: Send the connection request for this batch, then message after acceptance.</div>
          </div>
          <StartEnrichmentButton mode="message" variant="dashboard" sequenceId={sequenceId} />
        </div>

        <div className="action-stack__row">
          <div className="action-stack__header">
            <strong>CONNECT ONLY</strong>
            <div className="muted">Send connection requests without a note for connect-only batches.</div>
          </div>
          <StartEnrichmentButton mode="connect_only" variant="dashboard" sequenceId={sequenceId} />
        </div>
      </div>
    </div>
  );
}
