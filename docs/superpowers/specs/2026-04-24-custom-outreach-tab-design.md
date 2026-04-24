# Custom Outreach Tab Design

**Date:** 2026-04-24  
**Status:** Draft, pending user review  
**Scope:** Add a separate custom outreach workspace for manually reviewed per-lead drafts, distinct from Mission Control's automated sequence workflow.

---

## 1. Problem

The current outreach UI mixes two different operator intents:

- automated sequence-driven outreach for repeatable campaigns
- manual, highly customized outreach for selected batches

Those two workflows have different rules, different status lifecycles, and different levels of operator involvement. Keeping them inside the same panel makes the system harder to understand and easier to misuse. It also makes the current Mission Control surface look outdated because it is trying to serve both the automated path and the manual review path at once.

## 2. Goal

Add a separate `Custom Outreach` tab where an operator can:

- select a batch created specifically for custom outreach
- generate one draft per lead in that batch
- edit and review each draft manually
- approve and send only the drafts they want to send

The automated sequence workflow remains in Mission Control and is not repurposed for custom outreach.

## 3. Non-goals

- Rewriting the automated sequence flow
- Replacing Mission Control's sequence editor
- Introducing a new sender system
- Adding live synchronization between custom outreach and automated sequences
- Making custom outreach fully free-form per send without batch context

## 4. Product Shape

## 4.1 Navigation and surface separation

The app gets a new top-level tab:

- `Mission Control` remains the automated sequence workspace
- `Custom Outreach` becomes the manual review workspace

The new tab should not expose Mission Control's sequence generation controls. It should be visibly separate in the navigation and in the page copy so operators immediately understand which workflow they are using.

## 4.2 Batch intent at import time

Custom outreach must be chosen at import time, not converted later from an automated batch.

Batch intents:

- `connect_message`
- `connect_only`
- `custom_outreach`

The custom workflow uses a batch marked `custom_outreach`. That batch is then the unit of work for draft generation, review, and sending.

## 4.3 Draft model

The custom tab still uses one draft per lead.

Each lead in the selected batch can have:

- a custom opener
- a custom body
- a custom CTA
- a final composed message

The operator can edit drafts individually and approve them one by one, or bulk approve and send the approved set for the selected batch.

## 4.4 Relationship to sequences

Custom outreach must not be live-linked to an existing automated sequence.

Recommended behavior:

- the batch may optionally use an existing sequence as a **template seed** at creation time
- after the custom batch is created, the custom drafts are independent of future sequence edits
- changing the automated sequence later must not alter already-generated custom drafts

This preserves the separation between reusable automation and custom, operator-reviewed work.

## 5. Workflow

### 5.1 Import

1. Operator selects `Custom Outreach` in the CSV upload step.
2. CSV rows are imported into a batch with `batch_intent = custom_outreach`.
3. The batch becomes visible in the `Custom Outreach` tab.

### 5.2 Draft generation

1. Operator opens `Custom Outreach`.
2. Operator selects one custom batch.
3. The app generates one draft per lead in that batch.
4. The drafts are shown as editable cards.

Draft generation may use lead profile data, activity data, and optionally a template seed, but the output is still custom per lead.

### 5.3 Review and send

1. Operator edits draft text as needed.
2. Operator approves or rejects each draft.
3. Approved drafts can be sent individually or in bulk.
4. Sent drafts update lead status and send metadata as usual.

## 6. Data Model

### 6.1 Batch intent

`lead_batches` needs a persistent `batch_intent` field so the UI can query custom batches separately from automated batches.

The intent values must be stable and explicit:

- `connect_message`
- `connect_only`
- `custom_outreach`

### 6.2 Custom batch summary

The custom tab needs a batch summary shape that can drive the UI:

- batch id
- batch name
- batch intent
- lead count
- draft count
- approved count

This lets the page show a useful batch picker instead of a raw list.

## 7. UI Design

### 7.1 Custom Outreach page

The page should:

- explain that it is for manually reviewed outreach
- let the operator select a custom batch
- show batch status and lead counts
- load one editable draft card per lead
- provide per-lead approve/reject/send actions
- provide a bulk approve-and-send action for the selected batch

### 7.2 Empty state

If no custom batches exist, the page should clearly tell the operator to import a CSV as `Custom Outreach`.

### 7.3 Loading and error states

The page must distinguish:

- no batch selected
- selected batch has no leads
- selected batch exists but no drafts have been generated yet
- draft generation or send failed

These states should be specific enough that the operator knows whether the problem is selection, generation, or sending.

## 8. Backend Behavior

### 8.1 Draft generation scope

Draft generation should accept an optional batch id and only generate drafts for leads in that batch when provided.

This avoids cross-batch draft pollution and keeps the custom tab isolated from the automated queues.

### 8.2 Bulk actions

Bulk approve/send actions should also accept an optional batch id and only act on that batch.

The custom tab must not bulk-approve unrelated leads.

### 8.3 Sender reuse

The custom tab should reuse the existing sender and approval primitives.

Do not introduce a separate sender mode for custom outreach unless there is a hard technical reason. The important distinction is workflow scope, not a new delivery engine.

## 9. Acceptance Criteria

The feature is complete when:

- `Custom Outreach` appears as a separate navigation tab
- custom batches are selected at import time
- custom batches are stored with a persistent intent flag
- the custom tab shows only custom batches
- the custom tab generates one draft per lead for the selected batch
- each draft can be edited, approved, rejected, and sent
- Mission Control remains the automated sequence workspace
- automated sequence behavior does not change

## 10. Risks

- If custom outreach stays tied to automated sequences, the two workflows will blur again and the UI will become ambiguous.
- If the custom workspace has batch-level behavior but no batch intent storage, the page cannot reliably filter the correct queue.
- If the custom tab reuses Mission Control labels, operators will confuse manual review with automation.

## 11. Suggested Implementation Boundaries

The implementation should stay small and local:

- one database migration for batch intent
- one shared batch-intent helper
- one new custom outreach route
- one new workspace component
- narrow changes to upload/import actions
- narrow changes to draft generation so it can scope to one batch

---

## Spec Review

This design keeps the system split into two clean workflows:

- Mission Control for automated sequence-driven outreach
- Custom Outreach for per-lead manual review inside a custom batch

It avoids a live link between custom outreach and automated sequences, while still allowing optional template seeding at creation time. That matches the requested behavior and preserves clear operator intent.
