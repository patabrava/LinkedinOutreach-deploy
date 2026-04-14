"use client";

import { useMemo, useState, useTransition } from "react";

import type { LeadBatchRow, OutreachSequenceRow } from "../app/actions";
import { assignBatchToSequence, saveOutreachSequence } from "../app/actions";

type Props = {
  sequences: OutreachSequenceRow[];
  batches: LeadBatchRow[];
};

type Draft = {
  name: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
};

const emptyDraft = (): Draft => ({
  name: "",
  first_message: "",
  second_message: "",
  third_message: "",
  followup_interval_days: 3,
});

export function SequenceEditor({ sequences, batches }: Props) {
  const [draft, setDraft] = useState<Draft>(() => {
    const first = sequences[0];
    return first
      ? {
          name: first.name,
          first_message: first.first_message,
          second_message: first.second_message,
          third_message: first.third_message,
          followup_interval_days: first.followup_interval_days,
        }
      : emptyDraft();
  });
  const [selectedSequenceId, setSelectedSequenceId] = useState<number | null>(sequences[0]?.id ?? null);
  const [pending, startTransition] = useTransition();

  const selectedSequence = useMemo(
    () => sequences.find((sequence) => sequence.id === selectedSequenceId) || null,
    [sequences, selectedSequenceId]
  );

  const batchRows = useMemo(
    () =>
      batches
        .filter((batch) => batch.source === "csv_upload")
        .map((batch) => ({ ...batch })),
    [batches]
  );

  const syncDraft = (sequence?: OutreachSequenceRow | null) => {
    if (!sequence) {
      setDraft(emptyDraft());
      return;
    }
    setDraft({
      name: sequence.name,
      first_message: sequence.first_message,
      second_message: sequence.second_message,
      third_message: sequence.third_message,
      followup_interval_days: sequence.followup_interval_days,
    });
  };

  const onCreate = () => {
    const tempId = sequences.length ? Math.max(...sequences.map((sequence) => sequence.id)) + 1 : 1;
    setSelectedSequenceId(tempId);
    setDraft(emptyDraft());
  };

  const onSave = () => {
    startTransition(async () => {
      const saved = await saveOutreachSequence({
        id: selectedSequenceId || undefined,
        name: draft.name || `Sequence ${sequences.length + 1}`,
        first_message: draft.first_message,
        second_message: draft.second_message,
        third_message: draft.third_message,
        followup_interval_days: draft.followup_interval_days,
      });
      setSelectedSequenceId(saved.id);
    });
  };

  const onAssign = (batchId: number, sequenceId: number) => {
    startTransition(async () => {
      await assignBatchToSequence(batchId, sequenceId);
    });
  };

  return (
    <section className="card" style={{ marginBottom: 24 }}>
      <div className="pill">Post-Acceptance Sequences</div>
      <h3 style={{ margin: "12px 0 8px 0" }}>SEQUENCES + BATCH ASSIGNMENT</h3>
      <div className="muted" style={{ marginBottom: 16 }}>
        Sequences are used only after a connection is accepted. Invite notes are separate. Each imported CSV creates a batch; assign each batch to one sequence.
      </div>

      <div className="seq-grid">
        <div className="seq-panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>Sequences</strong>
            <button className="btn secondary" onClick={onCreate} type="button">
              New Sequence
            </button>
          </div>
          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            {sequences.map((sequence) => (
              <button
                key={sequence.id}
                className={`btn ${selectedSequenceId === sequence.id ? "warn" : "secondary"}`}
                onClick={() => {
                  setSelectedSequenceId(sequence.id);
                  syncDraft(sequence);
                }}
                type="button"
              >
                {sequence.name}
              </button>
            ))}
          </div>
        </div>

        <div className="seq-panel">
          <strong>Edit Sequence</strong>
          {!selectedSequence && selectedSequenceId !== null ? (
            <div className="muted" style={{ marginTop: 8 }}>
              Creating a new sequence.
            </div>
          ) : null}

          <label style={{ marginTop: 12 }}>Sequence Name</label>
          <input
            className="input"
            value={draft.name}
            onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="Sequence name"
          />

          <label>Message 1</label>
          <textarea
            className="textarea"
            value={draft.first_message}
            onChange={(event) => setDraft((prev) => ({ ...prev, first_message: event.target.value }))}
            placeholder="First message after acceptance"
          />

          <label>Message 2</label>
          <textarea
            className="textarea"
            value={draft.second_message}
            onChange={(event) => setDraft((prev) => ({ ...prev, second_message: event.target.value }))}
            placeholder="Second message after no reply"
          />

          <label>Message 3</label>
          <textarea
            className="textarea"
            value={draft.third_message}
            onChange={(event) => setDraft((prev) => ({ ...prev, third_message: event.target.value }))}
            placeholder="Third message after no reply"
          />

          <label>Follow-up cadence in days</label>
          <input
            className="input"
            type="number"
            min={1}
            value={draft.followup_interval_days}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                followup_interval_days: Number(event.target.value) || 3,
              }))
            }
          />

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={onSave} disabled={pending} type="button">
              Save Sequence
            </button>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            {pending ? "Saving..." : "Saved sequences are available to the sender worker."}
          </div>
        </div>
      </div>

      <div className="seq-panel" style={{ marginTop: 16 }}>
        <strong>CSV Batches</strong>
        <div className="muted" style={{ marginTop: 4, marginBottom: 8 }}>
          Assign each imported CSV batch to a sequence.
        </div>
        {!batchRows.length ? (
          <div className="muted">No CSV batches yet. Upload a CSV to create one.</div>
        ) : (
          <div className="table-wrapper">
            <table className="lead-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>BATCH</th>
                  <th>SEQUENCE</th>
                </tr>
              </thead>
              <tbody>
                {batchRows.map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.name}</td>
                    <td>
                      <select
                        className="input"
                        value={batch.sequence_id || ""}
                        onChange={(event) => onAssign(batch.id, Number(event.target.value))}
                      >
                        <option value="">No sequence</option>
                        {sequences.map((sequence) => (
                          <option key={sequence.id} value={sequence.id}>
                            {sequence.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
