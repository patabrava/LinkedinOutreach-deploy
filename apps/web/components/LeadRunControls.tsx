"use client";

import { useMemo, useState } from "react";

import type { OutreachSequenceRow } from "../app/actions";
import type { LinkedinAccountSummary } from "../lib/linkedinAccounts";
import { StartEnrichmentButton } from "./StartEnrichmentButton";

type Props = {
  sequences: OutreachSequenceRow[];
  accounts: LinkedinAccountSummary[];
};

const getDefaultSequenceId = (sequences: OutreachSequenceRow[]): number | null => {
  const activeSequence = sequences.find((sequence) => sequence.is_active);
  return activeSequence?.id ?? sequences[0]?.id ?? null;
};

export function LeadRunControls({ sequences, accounts }: Props) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const accountSequences = useMemo(() => sequences.filter((sequence) => sequence.linkedin_account_id === accountId), [sequences, accountId]);
  const defaultSequenceId = useMemo(() => getDefaultSequenceId(accountSequences), [accountSequences]);
  const [sequenceId, setSequenceId] = useState<number | null>(defaultSequenceId);
  const changeAccount = (nextAccountId: string) => {
    setAccountId(nextAccountId);
    setSequenceId(getDefaultSequenceId(sequences.filter((sequence) => sequence.linkedin_account_id === nextAccountId)));
  };

  return (
    <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16, borderLeft: "none", borderTop: "none", borderBottom: "none" }}>
      <div>
        <div className="pill">Next Actions</div>
        <h3 className="page-title">RUN WHAT&apos;S NEXT</h3>
        <div className="muted">Choose the sequence first. The launch buttons below will use that sequence for both outreach modes.</div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <label htmlFor="lead-run-account" className="muted" style={{ fontSize: 12 }}>Sender</label>
        <select id="lead-run-account" className="input" value={accountId} onChange={(event) => changeAccount(event.target.value)}>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.email}</option>)}
        </select>
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
          {accountSequences.map((sequence) => (
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
          <StartEnrichmentButton mode="message" variant="dashboard" sequenceId={sequenceId} accountId={accountId} />
        </div>

        <div className="action-stack__row">
          <div className="action-stack__header">
            <strong>CONNECT ONLY</strong>
            <div className="muted">Send connection requests without a note for connect-only batches.</div>
          </div>
          <StartEnrichmentButton mode="connect_only" variant="dashboard" sequenceId={sequenceId} accountId={accountId} />
        </div>
      </div>
    </div>
  );
}
