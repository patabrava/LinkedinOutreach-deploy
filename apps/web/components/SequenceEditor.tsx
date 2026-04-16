"use client";

import { useMemo, useRef, useState, useTransition } from "react";

import type { LeadBatchRow, OutreachSequenceRow } from "../app/actions";
import { assignBatchToSequence, saveOutreachSequence } from "../app/actions";
import * as sequencePlaceholderUtils from "../lib/sequencePlaceholders";

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

type MessageFieldKey = "first_message" | "second_message" | "third_message";
type ValidationErrorsByField = Record<MessageFieldKey, string[]>;

type PlaceholderValidationResult =
  | string[]
  | {
      unknownTokens?: string[];
      invalidTokens?: string[];
      invalid_tokens?: string[];
    };

type PlaceholderValidator = (message: string) => PlaceholderValidationResult;

type PlaceholderResolver = {
  canonicalTokens: string[];
  validateMessage: PlaceholderValidator;
};

type LooseRecord = Record<string, unknown>;
const isMessageFieldKey = (value: unknown): value is MessageFieldKey =>
  value === "first_message" || value === "second_message" || value === "third_message";

const emptyDraft = (): Draft => ({
  name: "",
  first_message: "",
  second_message: "",
  third_message: "",
  followup_interval_days: 3,
});

const MESSAGE_FIELDS: MessageFieldKey[] = ["first_message", "second_message", "third_message"];
const DEFAULT_CANONICAL_TOKENS = ["{{first_name}}", "{{last_name}}", "{{full_name}}", "{{company_name}}"];

const EMPTY_FIELD_ERRORS: ValidationErrorsByField = {
  first_message: [],
  second_message: [],
  third_message: [],
};

const uniqueStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
};

const fallbackUnknownTokenDetection = (message: string, canonicalTokens: string[]): string[] => {
  const tokenPattern = /(\{\{[^{}\n]+\}\}|\{[^{}\n]+\}|\[[^[\]\n]+\])/g;
  const detected = message.match(tokenPattern) ?? [];
  return uniqueStrings(detected.filter((token) => !canonicalTokens.includes(token)));
};

const resolveUnknownTokens = (result: PlaceholderValidationResult): string[] => {
  if (Array.isArray(result)) {
    return uniqueStrings(result);
  }
  if (!result || typeof result !== "object") {
    return [];
  }
  const tokenSet = result.unknownTokens || result.invalidTokens || result.invalid_tokens || [];
  return uniqueStrings(Array.isArray(tokenSet) ? tokenSet : []);
};

const createPlaceholderResolver = (): PlaceholderResolver => {
  const moduleAny = sequencePlaceholderUtils as Record<string, unknown>;
  const canonicalFromModule = moduleAny.CANONICAL_SEQUENCE_PLACEHOLDERS;
  const canonicalTokens =
    Array.isArray(canonicalFromModule) && canonicalFromModule.every((token) => typeof token === "string")
      ? uniqueStrings(canonicalFromModule as string[])
      : DEFAULT_CANONICAL_TOKENS;

  const validateFromModule =
    (moduleAny.validateSequencePlaceholders as PlaceholderValidator | undefined) ||
    (moduleAny.validateSequenceMessagePlaceholders as PlaceholderValidator | undefined) ||
    (moduleAny.findUnknownSequencePlaceholders as PlaceholderValidator | undefined);

  if (typeof validateFromModule === "function") {
    return {
      canonicalTokens,
      validateMessage: validateFromModule,
    };
  }

  return {
    canonicalTokens,
    validateMessage: (message: string) => fallbackUnknownTokenDetection(message, canonicalTokens),
  };
};

const getFieldTokenErrors = (draft: Draft, resolver: PlaceholderResolver): ValidationErrorsByField => {
  const fieldErrors: ValidationErrorsByField = { ...EMPTY_FIELD_ERRORS };
  for (const field of MESSAGE_FIELDS) {
    fieldErrors[field] = resolveUnknownTokens(resolver.validateMessage(draft[field]));
  }
  return fieldErrors;
};

const extractServerValidationErrors = (error: unknown): {
  topLevel: string;
  fieldErrors: ValidationErrorsByField;
} => {
  const fieldErrors: ValidationErrorsByField = { ...EMPTY_FIELD_ERRORS };
  const allowedMessage = `Allowed placeholders: ${DEFAULT_CANONICAL_TOKENS.join(", ")}`;

  const parsePayload = (value: unknown): LooseRecord | null => {
    if (!value) {
      return null;
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? (parsed as LooseRecord) : null;
      } catch {
        return null;
      }
    }
    if (typeof value === "object") {
      return value as LooseRecord;
    }
    return null;
  };

  const errorAny = (error && typeof error === "object" ? error : null) as LooseRecord | null;
  const candidates = [
    parsePayload(errorAny?.details),
    parsePayload(errorAny?.cause),
    parsePayload(errorAny?.context),
    parsePayload(errorAny?.message),
  ].filter((candidate): candidate is LooseRecord => Boolean(candidate));

  for (const payload of candidates) {
    const fieldDetailArray = payload?.field_errors || payload?.fieldErrors || payload?.errors || payload?.details;
    if (Array.isArray(fieldDetailArray)) {
      for (const item of fieldDetailArray) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const itemRecord = item as LooseRecord;
        const field = itemRecord.field || itemRecord.key || itemRecord.path;
        if (!isMessageFieldKey(field)) {
          continue;
        }
        const tokens = uniqueStrings([
          ...(Array.isArray(itemRecord.invalid_tokens) ? itemRecord.invalid_tokens : []),
          ...(Array.isArray(itemRecord.invalidTokens) ? itemRecord.invalidTokens : []),
          ...(Array.isArray(itemRecord.unknown_tokens) ? itemRecord.unknown_tokens : []),
          ...(Array.isArray(itemRecord.unknownTokens) ? itemRecord.unknownTokens : []),
        ].map((token) => String(token)));
        if (tokens.length) {
          fieldErrors[field] = tokens;
        }
      }
    }

    if (fieldDetailArray && typeof fieldDetailArray === "object" && !Array.isArray(fieldDetailArray)) {
      const fieldDetailsRecord = fieldDetailArray as LooseRecord;
      for (const field of MESSAGE_FIELDS) {
        const value = fieldDetailsRecord[field];
        if (Array.isArray(value)) {
          fieldErrors[field] = uniqueStrings(value.map((token) => String(token)));
        }
      }
    }
  }

  const hasFieldValidation = MESSAGE_FIELDS.some((field) => fieldErrors[field].length > 0);
  if (hasFieldValidation) {
    return {
      topLevel: `Please fix unknown placeholders before saving. ${allowedMessage}`,
      fieldErrors,
    };
  }

  const fallbackMessage =
    (typeof errorAny?.message === "string" && errorAny.message.trim()) ||
    `Unable to save sequence. ${allowedMessage}`;
  return { topLevel: fallbackMessage, fieldErrors };
};

export function SequenceEditor({ sequences, batches }: Props) {
  const placeholderResolver = useMemo(() => createPlaceholderResolver(), []);
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
  const [focusedMessageField, setFocusedMessageField] = useState<MessageFieldKey>("first_message");
  const [serverFieldErrors, setServerFieldErrors] = useState<ValidationErrorsByField>({ ...EMPTY_FIELD_ERRORS });
  const [topLevelError, setTopLevelError] = useState<string | null>(null);
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const messageRefs = useRef<Record<MessageFieldKey, HTMLTextAreaElement | null>>({
    first_message: null,
    second_message: null,
    third_message: null,
  });

  const selectedSequence = useMemo(
    () => sequences.find((sequence) => sequence.id === selectedSequenceId) || null,
    [sequences, selectedSequenceId]
  );
  const sequenceById = useMemo(() => {
    return new Map(sequences.map((sequence) => [sequence.id, sequence]));
  }, [sequences]);

  const batchRows = useMemo(
    () =>
      batches
        .filter((batch) => batch.source === "csv_upload")
        .map((batch) => ({ ...batch })),
    [batches]
  );

  const localFieldErrors = useMemo(
    () => getFieldTokenErrors(draft, placeholderResolver),
    [draft, placeholderResolver]
  );

  const fieldErrors = useMemo(() => {
    const merged: ValidationErrorsByField = { ...EMPTY_FIELD_ERRORS };
    for (const field of MESSAGE_FIELDS) {
      merged[field] = uniqueStrings([...localFieldErrors[field], ...serverFieldErrors[field]]);
    }
    return merged;
  }, [localFieldErrors, serverFieldErrors]);

  const hasInvalidTokens = MESSAGE_FIELDS.some((field) => fieldErrors[field].length > 0);

  const clearErrors = (field?: MessageFieldKey) => {
    setTopLevelError(null);
    if (!field) {
      setServerFieldErrors({ ...EMPTY_FIELD_ERRORS });
      return;
    }
    setServerFieldErrors((prev) => ({ ...prev, [field]: [] }));
  };

  const focusField = (field: MessageFieldKey) => {
    const node = messageRefs.current[field];
    if (!node) {
      return;
    }
    node.focus();
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const focusFirstInvalidField = () => {
    for (const field of MESSAGE_FIELDS) {
      if (fieldErrors[field].length) {
        focusField(field);
        return;
      }
    }
  };

  const updateDraftMessageField = (field: MessageFieldKey, value: string) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    clearErrors(field);
  };

  const insertPlaceholderIntoFocusedField = (token: string) => {
    const field = focusedMessageField;
    const fieldNode = messageRefs.current[field];
    const start = fieldNode?.selectionStart ?? draft[field].length;
    const end = fieldNode?.selectionEnd ?? draft[field].length;
    const nextValue = `${draft[field].slice(0, start)}${token}${draft[field].slice(end)}`;
    updateDraftMessageField(field, nextValue);
    setTokenPickerOpen(false);
    requestAnimationFrame(() => {
      const nextNode = messageRefs.current[field];
      if (!nextNode) {
        return;
      }
      const cursor = start + token.length;
      nextNode.focus();
      nextNode.setSelectionRange(cursor, cursor);
    });
  };

  const syncDraft = (sequence?: OutreachSequenceRow | null) => {
    clearErrors();
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
    clearErrors();
  };

  const onSave = () => {
    clearErrors();
    if (hasInvalidTokens) {
      setTopLevelError(`Unknown placeholders detected. Allowed placeholders: ${placeholderResolver.canonicalTokens.join(", ")}`);
      focusFirstInvalidField();
      return;
    }
    startTransition(async () => {
      try {
        const saved = await saveOutreachSequence({
          id: selectedSequenceId || undefined,
          name: draft.name || `Sequence ${sequences.length + 1}`,
          first_message: draft.first_message,
          second_message: draft.second_message,
          third_message: draft.third_message,
          followup_interval_days: draft.followup_interval_days,
        });
        setSelectedSequenceId(saved.id);
      } catch (error) {
        const parsed = extractServerValidationErrors(error);
        setTopLevelError(parsed.topLevel);
        setServerFieldErrors(parsed.fieldErrors);
        const firstInvalidField = MESSAGE_FIELDS.find((field) => parsed.fieldErrors[field].length > 0);
        if (firstInvalidField) {
          focusField(firstInvalidField);
        }
      }
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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
            <strong>Edit Sequence</strong>
            <div style={{ position: "relative" }}>
              <button
                className="btn secondary"
                onClick={() => setTokenPickerOpen((prev) => !prev)}
                type="button"
                aria-expanded={tokenPickerOpen}
                aria-controls="sequence-spintax-dropdown"
              >
                {tokenPickerOpen ? "Hide Spintax / Variables" : "Spintax / Variables"}
              </button>
              {tokenPickerOpen ? (
                <div
                  id="sequence-spintax-dropdown"
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "calc(100% + 8px)",
                    zIndex: 20,
                    border: "1px solid #334155",
                    borderRadius: 8,
                    padding: 8,
                    background: "var(--bg)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 8,
                    maxHeight: 220,
                    overflowY: "auto",
                    minWidth: 320,
                    maxWidth: "min(92vw, 420px)",
                  }}
                >
                  <div className="muted" style={{ fontSize: 12 }}>
                    Click a tag to insert it into the focused message field.
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    {placeholderResolver.canonicalTokens.map((token) => (
                      <button
                        key={token}
                        className="btn secondary"
                        onClick={() => insertPlaceholderIntoFocusedField(token)}
                        type="button"
                      >
                        {token}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
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
            onChange={(event) => updateDraftMessageField("first_message", event.target.value)}
            onFocus={() => setFocusedMessageField("first_message")}
            ref={(node) => {
              messageRefs.current.first_message = node;
            }}
            placeholder="First message after acceptance"
            aria-invalid={fieldErrors.first_message.length > 0}
          />
          {fieldErrors.first_message.length ? (
            <div role="alert" style={{ color: "#dc2626", marginTop: 6 }}>
              Unknown placeholders: {fieldErrors.first_message.join(", ")}
            </div>
          ) : null}

          <label>Message 2</label>
          <textarea
            className="textarea"
            value={draft.second_message}
            onChange={(event) => updateDraftMessageField("second_message", event.target.value)}
            onFocus={() => setFocusedMessageField("second_message")}
            ref={(node) => {
              messageRefs.current.second_message = node;
            }}
            placeholder="Second message after no reply"
            aria-invalid={fieldErrors.second_message.length > 0}
          />
          {fieldErrors.second_message.length ? (
            <div role="alert" style={{ color: "#dc2626", marginTop: 6 }}>
              Unknown placeholders: {fieldErrors.second_message.join(", ")}
            </div>
          ) : null}

          <label>Message 3</label>
          <textarea
            className="textarea"
            value={draft.third_message}
            onChange={(event) => updateDraftMessageField("third_message", event.target.value)}
            onFocus={() => setFocusedMessageField("third_message")}
            ref={(node) => {
              messageRefs.current.third_message = node;
            }}
            placeholder="Third message after no reply"
            aria-invalid={fieldErrors.third_message.length > 0}
          />
          {fieldErrors.third_message.length ? (
            <div role="alert" style={{ color: "#dc2626", marginTop: 6 }}>
              Unknown placeholders: {fieldErrors.third_message.join(", ")}
            </div>
          ) : null}

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

          {topLevelError ? (
            <div role="alert" style={{ color: "#dc2626", marginTop: 10 }}>
              {topLevelError}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={onSave} disabled={pending || hasInvalidTokens} type="button">
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
                  <th scope="col">BATCH</th>
                  <th scope="col">SEQUENCE</th>
                </tr>
              </thead>
              <tbody>
                {batchRows.map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.name}</td>
                    <td>
                      {(() => {
                        const assignedSequence = batch.sequence_id ? sequenceById.get(batch.sequence_id) : undefined;
                        const hasFirstMessage = Boolean(assignedSequence?.first_message?.trim());
                        return (
                          <>
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
                            <div className="muted" style={{ marginTop: 6 }}>
                              {hasFirstMessage
                                ? "Launch readiness: READY (Message 1 detected)."
                                : "Launch readiness: STANDBY (assign sequence with Message 1)."}
                            </div>
                          </>
                        );
                      })()}
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
