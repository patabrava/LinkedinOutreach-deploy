"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  approveAndSendAllDrafts,
  approveDraft,
  fetchDraftFeed,
  rejectDraft,
  sendLeadNow,
  triggerDraftGeneration,
  type CustomOutreachBatchSummary,
} from "../app/actions";
import { CustomOutreachBatchProgress } from "./CustomOutreachBatchProgress";

type DraftRow = {
  leadId: string;
  draftId?: number;
  opener: string;
  body: string;
  cta: string;
  ctaType?: string;
  finalMessage?: string;
  name: string;
  headline: string;
  company?: string;
  linkedinUrl: string;
  status?: string;
};

type DraftEdit = {
  opener: string;
  body: string;
  cta: string;
  ctaType: string;
};

type DraftEditMap = Record<string, DraftEdit>;

const DEFAULT_EDIT = {
  opener: "",
  body: "",
  cta: "",
  ctaType: "",
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT_READY: "Draft ready",
  APPROVED: "Approved",
  SENT: "Sent",
  REJECTED: "Rejected",
  NEW: "Waiting",
  ENRICHED: "Waiting",
};

function normalizeDraftEdit(draft: DraftRow): DraftEdit {
  return {
    opener: draft.opener || "",
    body: draft.body || "",
    cta: draft.cta || "",
    ctaType: draft.ctaType || "",
  };
}

function composeMessage(edit: DraftEdit) {
  return [edit.opener, edit.body, edit.cta].map((part) => part.trim()).filter(Boolean).join(" ");
}

function getDraftStatusLabel(status?: string) {
  if (!status) return "Draft";
  return STATUS_LABELS[status] || status;
}

function hasUnsavedChanges(draft: DraftRow, edit: DraftEdit) {
  return (
    draft.opener !== edit.opener ||
    draft.body !== edit.body ||
    draft.cta !== edit.cta ||
    (draft.ctaType || "") !== edit.ctaType
  );
}

type Props = {
  batches: CustomOutreachBatchSummary[];
};

export function CustomOutreachWorkspace({ batches }: Props) {
  const router = useRouter();
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(batches[0]?.id ?? null);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [draftEdits, setDraftEdits] = useState<DraftEditMap>({});
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [polling, setPolling] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState(false);
  const [generationPending, setGenerationPending] = useState(false);
  const [workingLeadId, setWorkingLeadId] = useState<string | null>(null);

  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.id === selectedBatchId) || null,
    [batches, selectedBatchId]
  );

  useEffect(() => {
    if (!selectedBatchId && batches[0]?.id) {
      setSelectedBatchId(batches[0].id);
    }
  }, [batches, selectedBatchId]);

  const syncDrafts = async (showLoading = false) => {
    if (!selectedBatchId) {
      setDrafts([]);
      setLoadingDrafts(false);
      return;
    }

    if (showLoading) {
      setLoadingDrafts(true);
    }

    try {
      const nextDrafts = (await fetchDraftFeed("connect_message", selectedBatchId)) as DraftRow[];
      setDrafts(nextDrafts);

      if (polling && nextDrafts.length > 0) {
        setPolling(false);
        setGenerationPending(false);
        setStatusMessage("Drafts are ready for review.");
      } else if (nextDrafts.length === 0 && (polling || generationPending)) {
        setStatusMessage("Draft generation is still running.");
      } else if (selectedBatch && selectedBatch.draft_count === 0 && nextDrafts.length === 0) {
        setStatusMessage("This batch has leads, but no drafts have been generated yet.");
      } else if (nextDrafts.length === 0) {
        setStatusMessage("No approved drafts are ready yet.");
      }

      setErrorMessage(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load custom drafts.";
      setErrorMessage(message);
      setStatusMessage(null);
    } finally {
      setLoadingDrafts(false);
    }
  };

  useEffect(() => {
    if (!selectedBatchId) {
      setDrafts([]);
      setDraftEdits({});
      return;
    }

    setDraftEdits({});
    setStatusMessage(null);
    setErrorMessage(null);
    syncDrafts(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBatchId]);

  useEffect(() => {
    if (!polling) {
      return;
    }

    const interval = setInterval(() => {
      syncDrafts(false);
    }, 4000);

    const timeout = setTimeout(() => {
      setPolling(false);
      setGenerationPending(false);
      setStatusMessage((current) => current || "Draft generation timed out. Refresh the batch to check again.");
    }, 120000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, selectedBatchId]);

  const getDraftEdit = (draft: DraftRow): DraftEdit => {
    return draftEdits[draft.leadId] || normalizeDraftEdit(draft);
  };

  const updateDraftEdit = (leadId: string, field: keyof DraftEdit, value: string) => {
    setDraftEdits((current) => ({
      ...current,
      [leadId]: {
        ...current[leadId],
        ...DEFAULT_EDIT,
        ...(current[leadId] || {}),
        [field]: value,
      },
    }));
  };

  const clearDraftEdit = (leadId: string) => {
    setDraftEdits((current) => {
      const next = { ...current };
      delete next[leadId];
      return next;
    });
  };

  const handleGenerateDrafts = async () => {
    if (!selectedBatchId) return;
    setGenerationPending(true);
    setStatusMessage("Generating drafts for the selected batch.");
    setErrorMessage(null);
    try {
      await triggerDraftGeneration(1, "connect_message", selectedBatchId);
      setPolling(true);
      await syncDrafts(true);
    } catch (error) {
      setGenerationPending(false);
      const message = error instanceof Error ? error.message : "Draft generation failed.";
      setErrorMessage(message);
      setStatusMessage(null);
    }
  };

  const handleApprove = async (draft: DraftRow) => {
    if (!selectedBatchId) return;
    const edit = getDraftEdit(draft);
    setWorkingLeadId(draft.leadId);
    setErrorMessage(null);
    try {
      await approveDraft({
        leadId: draft.leadId,
        draftId: draft.draftId,
        opener: edit.opener,
        body: edit.body,
        cta: edit.cta,
        ctaType: edit.ctaType,
        outreachMode: "connect_message",
        batchId: selectedBatchId,
        skipSend: true,
      });
      clearDraftEdit(draft.leadId);
      setStatusMessage(`Approved ${draft.name || "draft"}.`);
      await syncDrafts(false);
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to approve draft.";
      setErrorMessage(message);
    } finally {
      setWorkingLeadId(null);
    }
  };

  const handleSend = async (draft: DraftRow) => {
    if (!selectedBatchId) return;
    const edit = getDraftEdit(draft);
    setWorkingLeadId(draft.leadId);
    setErrorMessage(null);
    try {
      if (draft.status === "APPROVED" && !hasUnsavedChanges(draft, edit)) {
        await sendLeadNow(draft.leadId, "connect_message");
      } else {
        await approveDraft({
          leadId: draft.leadId,
          draftId: draft.draftId,
          opener: edit.opener,
          body: edit.body,
          cta: edit.cta,
          ctaType: edit.ctaType,
          outreachMode: "connect_message",
          batchId: selectedBatchId,
          skipSend: false,
        });
      }
      clearDraftEdit(draft.leadId);
      setStatusMessage(`Queued ${draft.name || "draft"} for sending.`);
      await syncDrafts(false);
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send draft.";
      setErrorMessage(message);
    } finally {
      setWorkingLeadId(null);
    }
  };

  const handleReject = async (draft: DraftRow) => {
    setWorkingLeadId(draft.leadId);
    setErrorMessage(null);
    try {
      await rejectDraft(draft.leadId);
      clearDraftEdit(draft.leadId);
      setStatusMessage(`Rejected ${draft.name || "draft"}.`);
      await syncDrafts(false);
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reject draft.";
      setErrorMessage(message);
    } finally {
      setWorkingLeadId(null);
    }
  };

  const handleBulkApproveAndSend = async () => {
    if (!selectedBatchId) return;
    setBulkPending(true);
    setErrorMessage(null);
    setStatusMessage("Approving and sending the selected batch.");
    try {
      const result = await approveAndSendAllDrafts("connect_message", selectedBatchId);
      setStatusMessage(
        result.approvedCount
          ? `Approved ${result.approvedCount} draft${result.approvedCount === 1 ? "" : "s"}.`
          : "No drafts were eligible for bulk approval."
      );
      await syncDrafts(false);
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bulk approve and send failed.";
      setErrorMessage(message);
      setStatusMessage(null);
    } finally {
      setBulkPending(false);
    }
  };

  const leadCount = selectedBatch?.lead_count ?? 0;
  const draftCount = Math.max(selectedBatch?.draft_count ?? 0, drafts.length);
  const approvedCount = Math.max(
    selectedBatch?.approved_count ?? 0,
    drafts.filter((draft) => draft.status === "APPROVED").length
  );
  const hasSelectedBatch = Boolean(selectedBatchId && selectedBatch);

  return (
    <section style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "grid", gap: 10, maxWidth: 960 }}>
        <div className="pill">Custom Outreach</div>
        <h1 className="page-title">MANUAL REVIEW WORKSPACE</h1>
        <div className="muted" style={{ maxWidth: 760 }}>
          Select a custom batch, generate one draft per lead, edit the copy by hand, then approve or send only the rows you want.
          This workspace is intentionally separate from Mission Control.
        </div>
      </div>

      {!batches.length ? (
        <div className="card" style={{ padding: 24 }}>
          <div className="pill">No custom batches</div>
          <h3 className="page-title">IMPORT AS CUSTOM OUTREACH</h3>
          <div className="muted">
            Upload a CSV and pick the Custom Outreach intent. The batch picker will populate here once a custom batch exists.
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)",
            gap: 16,
            alignItems: "start",
          }}
        >
          <aside className="card" style={{ padding: 18, position: "sticky", top: 92 }}>
            <div className="pill">Batch Picker</div>
            <h3 className="page-title">CUSTOM BATCHES</h3>
            <div className="muted" style={{ marginBottom: 14 }}>
              Each batch is an isolated review queue. Future sequence edits will not change generated drafts.
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {batches.map((batch) => {
                const active = batch.id === selectedBatchId;
                return (
                  <div key={batch.id} style={{ display: "grid", gap: 6 }}>
                    <button
                      type="button"
                      className={`btn ${active ? "warn" : "secondary"}`}
                      onClick={() => setSelectedBatchId(batch.id)}
                      style={{ textAlign: "left" }}
                    >
                      <div style={{ display: "grid", gap: 6 }}>
                        <strong>{batch.name}</strong>
                        <span className="muted" style={{ fontSize: 11 }}>
                          {batch.lead_count} leads · {batch.draft_count} drafts · {batch.approved_count} approved
                        </span>
                      </div>
                    </button>
                    <CustomOutreachBatchProgress batch={batch} />
                    <button
                      className="btn"
                      type="button"
                      onClick={async (event) => {
                        event.stopPropagation();
                        const res = await fetch("/api/custom-outreach/enrich-batch", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ batchId: batch.id }),
                        });
                        if (res.status === 409) {
                          window.alert("Scraper already running. Wait for it to finish.");
                          return;
                        }
                        if (!res.ok) {
                          window.alert("Failed to start enrichment.");
                          return;
                        }
                        router.refresh();
                      }}
                    >
                      ENRICH NOW
                    </button>
                  </div>
                );
              })}
            </div>
          </aside>

          <div style={{ display: "grid", gap: 16 }}>
            <div className="card" style={{ padding: 20 }}>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div>
                  <div className="pill">{selectedBatch?.batch_intent === "custom_outreach" ? "Custom Outreach" : "Batch"}</div>
                  <h3 className="page-title">{selectedBatch?.name || "Select a batch"}</h3>
                  <div className="muted">
                    {hasSelectedBatch
                      ? "Selected batch locked to manual review. Generate drafts, edit them, then approve or send as needed."
                      : "Pick a batch from the left rail to begin."}
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <span className="pill">Leads {leadCount}</span>
                  <span className="pill">Drafts {draftCount}</span>
                  <span className="pill">Approved {approvedCount}</span>
                </div>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 16 }}>
                <button className="btn accent" type="button" onClick={handleGenerateDrafts} disabled={!hasSelectedBatch || generationPending || loadingDrafts}>
                  {generationPending ? "Generating..." : "Generate Drafts"}
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={handleBulkApproveAndSend}
                  disabled={!hasSelectedBatch || bulkPending || !draftCount}
                >
                  {bulkPending ? "Bulk Sending..." : "Approve + Send Batch"}
                </button>
                <button className="btn secondary" type="button" onClick={() => syncDrafts(true)} disabled={!hasSelectedBatch || loadingDrafts}>
                  Refresh
                </button>
              </div>

              {statusMessage ? (
                <div className="pill status-approved" style={{ marginTop: 14 }}>
                  {statusMessage}
                </div>
              ) : null}
              {errorMessage ? (
                <div className="pill status-failed" style={{ marginTop: 14, display: "inline-flex" }}>
                  {errorMessage}
                </div>
              ) : null}
            </div>

            {!hasSelectedBatch ? (
              <div className="card" style={{ padding: 24 }}>
                <div className="pill">No batch selected</div>
                <h3 className="page-title">PICK A REVIEW QUEUE</h3>
                <div className="muted">Select one custom batch to load its drafts and review state.</div>
              </div>
            ) : selectedBatch && selectedBatch.lead_count === 0 ? (
              <div className="card" style={{ padding: 24 }}>
                <div className="pill">Empty batch</div>
                <h3 className="page-title">NO LEADS IN THIS BATCH</h3>
                <div className="muted">This batch was created, but it does not contain any imported leads yet.</div>
              </div>
            ) : selectedBatch && selectedBatch.draft_count === 0 && drafts.length === 0 ? (
              <div className="card" style={{ padding: 24 }}>
                <div className="pill">Waiting on drafts</div>
                <h3 className="page-title">NO DRAFTS GENERATED YET</h3>
                <div className="muted">
                  {loadingDrafts
                    ? "Loading the batch state now."
                    : "Generate drafts for this batch before trying to approve or send anything."}
                </div>
              </div>
            ) : loadingDrafts ? (
              <div className="card" style={{ padding: 24 }}>
                <div className="pill">Loading</div>
                <h3 className="page-title">FETCHING DRAFTS</h3>
                <div className="muted">Pulling the latest draft rows for this batch.</div>
              </div>
            ) : drafts.length === 0 ? (
              <div className="card" style={{ padding: 24 }}>
                <div className="pill">No drafts</div>
                <h3 className="page-title">NO APPROVED DRAFTS YET</h3>
                <div className="muted">The batch exists, but there are no draft rows to review right now.</div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                {drafts.map((draft) => {
                  const edit = getDraftEdit(draft);
                  const messagePreview = composeMessage(edit);
                  const busy = workingLeadId === draft.leadId;
                  const dirty = hasUnsavedChanges(draft, edit);
                  const approved = draft.status === "APPROVED";
                  return (
                    <article className="card" key={draft.leadId} style={{ padding: 18 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                        <div>
                          <div className="pill">{getDraftStatusLabel(draft.status)}</div>
                          <h3 className="page-title" style={{ marginBottom: 6 }}>
                            {draft.name || "Unnamed lead"}
                          </h3>
                          <div className="muted">{draft.headline || draft.company || "No headline yet"}</div>
                          <a className="muted" href={draft.linkedinUrl} target="_blank" rel="noreferrer">
                            LinkedIn profile →
                          </a>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          <button className="btn secondary" type="button" onClick={() => handleReject(draft)} disabled={busy || bulkPending}>
                            Reject
                          </button>
                          <button className="btn" type="button" onClick={() => handleApprove(draft)} disabled={busy || bulkPending}>
                            Approve
                          </button>
                          <button className="btn accent" type="button" onClick={() => handleSend(draft)} disabled={busy || bulkPending}>
                            {approved ? "Send Approved" : "Approve + Send"}
                          </button>
                        </div>
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
                          gap: 12,
                          marginTop: 16,
                        }}
                      >
                        <div style={{ gridColumn: "span 4" }}>
                          <label>Opener</label>
                          <textarea
                            className="textarea"
                            value={edit.opener}
                            onChange={(event) => updateDraftEdit(draft.leadId, "opener", event.target.value)}
                            rows={4}
                          />
                        </div>
                        <div style={{ gridColumn: "span 5" }}>
                          <label>Body</label>
                          <textarea
                            className="textarea"
                            value={edit.body}
                            onChange={(event) => updateDraftEdit(draft.leadId, "body", event.target.value)}
                            rows={4}
                          />
                        </div>
                        <div style={{ gridColumn: "span 3" }}>
                          <label>CTA</label>
                          <textarea
                            className="textarea"
                            value={edit.cta}
                            onChange={(event) => updateDraftEdit(draft.leadId, "cta", event.target.value)}
                            rows={4}
                          />
                        </div>
                      </div>

                      <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
                        <label>Final Message Preview</label>
                        <div className="preview">{messagePreview || "Compose the opener, body, and CTA to preview the final message."}</div>
                      </div>

                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                        <span className="pill">{dirty ? "Unsaved edits" : "In sync"}</span>
                        <span className="pill">{approved ? "Approved" : "Draft only"}</span>
                        <span className="pill">{edit.ctaType || "No CTA type"}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
