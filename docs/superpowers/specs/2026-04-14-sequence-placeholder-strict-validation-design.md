# Sequence Placeholder Strict Validation Design

Date: 2026-04-14
Owner: Outreach product + sender pipeline
Status: Proposed

## 1. Context and Problem

The post-acceptance message flow sent raw placeholder text (example: `{{VORNAME}}`) to real contacts.  
Root cause: placeholder formats used in stored sequence templates were not consistently supported by runtime rendering, and there was no strict validation at sequence authoring time.

We need prevention at authoring time and enforcement at persistence time, so invalid templates never enter production again.

## 2. Goals

1. Prevent invalid placeholders from being saved in sequences.
2. Enforce rules in both UI and server paths.
3. Preserve runtime safety for legacy rows already stored.
4. Give users clear, immediate feedback in the sequence editor.

## 3. Non-Goals

1. No redesign of message generation strategy.
2. No broad migration of all historical sequence text in this scope.
3. No change to follow-up scheduling logic.

## 4. Scope and Budgets

- Files: 3-5 (target)
- LOC/file: <= 250 added/changed per file
- Deps: 0 new dependencies

Planned touchpoints:

1. `apps/web/components/SequenceEditor.tsx`
2. `apps/web/app/actions.ts`
3. `apps/web/lib/<new placeholder validator utility>.ts`
4. `workers/sender/sender.py` (compatibility aliases only)
5. Optional tests file(s) co-located with web utility/actions

## 5. Placeholder Contract

### 5.1 Canonical placeholders (allowed for new saves)

1. `{{first_name}}`
2. `{{last_name}}`
3. `{{full_name}}`
4. `{{company_name}}`

### 5.2 Placeholder token detection

Detect placeholder-like tokens in message text using these classes:

1. double-curly tokens: `{{...}}`
2. single-curly tokens: `{...}`
3. bracket tokens: `[...]`

### 5.3 Strict rule

If any detected token is outside the canonical allowlist, save is blocked.

## 6. UX Design (Sequence Editor)

### 6.1 Spintax/Variables button behavior

1. The button opens a token picker with canonical placeholders only.
2. Clicking a token inserts it into the currently focused message field.
3. This prevents free-form typo entry for most users.

### 6.2 Live validation behavior

Each message field (`Message 1/2/3`) validates on change:

1. Valid state: no field error.
2. Invalid state: inline field error listing unknown token(s).

### 6.3 Save behavior

1. `Save` is disabled while any field has invalid placeholder tokens.
2. If submit is triggered anyway, show top-level error summary and focus the first invalid field.
3. Form content remains intact; no text loss.

## 7. Server Enforcement

Validation is duplicated server-side as a hard guard in `createOrUpdateSequence`:

1. Reject payloads containing non-canonical tokens.
2. Return structured validation details:
   - field key (`first_message`, `second_message`, `third_message`)
   - invalid tokens
   - allowed tokens

This protects against bypasses (direct API calls, scripts, stale clients).

## 8. Legacy Compatibility Strategy

Runtime sender will remain backward-compatible for existing stored legacy tokens:

1. Keep and extend alias rendering in `workers/sender/sender.py`.
2. This is compatibility only; new saves remain strict canonical.

Examples of runtime aliases for old rows:

1. `{{VORNAME}}` -> first name
2. `{{NACHNAME}}` -> last name
3. Existing aliases (`{first_name}`, `[Name]`) remain supported

## 9. Data Flow After Change

1. User edits sequence in `SequenceEditor`.
2. UI validator detects tokens and blocks invalid save.
3. Valid payload calls server action.
4. Server action re-validates and persists.
5. Sender consumes sequence text; legacy rows still resolve safely at runtime.

## 10. Error Handling

UI error copy (example):

`Unknown placeholder "{{VORNAME}}". Allowed placeholders: {{first_name}}, {{last_name}}, {{full_name}}, {{company_name}}.`

Server error contract:

1. deterministic error shape for UI mapping
2. non-200 return for invalid payload
3. no partial writes on validation failure

## 11. Testing Strategy

### 11.1 Unit tests (web validator utility)

1. Accept canonical tokens.
2. Reject unknown double-curly, single-curly, bracket tokens.
3. Handle mixed plain text + tokens.
4. Return deterministic field-level error output.

### 11.2 Action-level tests

1. `createOrUpdateSequence` rejects invalid placeholders.
2. `createOrUpdateSequence` accepts canonical placeholders.

### 11.3 UI behavior checks

1. Save button disabled for invalid tokens.
2. Inline errors appear on affected message field(s).
3. Valid content enables save.

### 11.4 Runtime compatibility check

1. Existing sequence rows with `{{VORNAME}}` still render correctly in sender.

## 12. Rollout Plan

1. Ship UI + server strict validation in one release.
2. Keep sender legacy alias compatibility enabled.
3. Optional follow-up: one-time admin migration to canonicalize existing sequences.

## 13. Risks and Mitigations

1. Risk: false positives from token regex.
   Mitigation: targeted tests for normal punctuation and braces used as text.
2. Risk: UX friction when old templates are edited.
   Mitigation: clear error copy + insert-from-picker workflow.
3. Risk: hidden bypass path.
   Mitigation: server action strict validation is authoritative.

## 14. Acceptance Criteria

1. A sequence containing `{{VORNAME}}` cannot be newly saved from UI.
2. Any non-canonical placeholder is rejected by server action.
3. Canonical placeholders save successfully.
4. Sender still correctly renders legacy placeholders in already-stored sequences.
5. No outbound message contains unresolved placeholders from newly saved sequences.
