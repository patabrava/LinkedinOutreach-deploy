# Reply Management — Design Spec

**Date:** 2026-05-13  
**Status:** Draft, pending implementation plan  
**Scope:** `cwd=/Users/camiloecheverri/Documents/AI/Linkedin Scraper/LinkedinOutreach`

---

## 1. Problem

The repo already scans inbox replies into `followups` rows and exposes them in `/followups`, but reply handling is still too generic for the two real response paths the business wants:

- no-interest replies should get a short website-oriented answer
- interest replies should get a short booking-oriented answer

The user wants the simplest possible UI, so this must stay inside the existing Followups page. No separate reply dashboard, no new tab, and no visual mockup layer.

The draft text should be AI-assisted, but the final response should stay constrained to approved business wording and links.

## 2. Goals

1. Keep replies inside the existing `/followups` flow.
2. Auto-classify reply intent as `positive` or `negative`.
3. Use Gemini for the classification and draft generation step.
4. Keep the outgoing reply text close to the approved style, with only light AI rewriting.
5. Preserve the existing manual review step before send.
6. Make replies visually distinguishable from nudge followups in the same list.

## 3. Non-goals

- No separate `Replies` page.
- No separate approval workflow for replies.
- No auto-send without review.
- No new outreach mode.
- No change to the connect-only / message-only sender behavior.
- No attempt to build a general-purpose conversation inbox.

## 4. Current State

The existing pipeline already has the right anchors:

- inbox scanning creates `followups` rows with `followup_type = "REPLY"` and `status = "PENDING_REVIEW"`
- `/followups` already renders mixed reply and nudge rows
- `generateFollowupDraft()` already exists as the review-step draft generator
- `mcp-server/run_followup_agent.py` currently produces reply drafts from a prompt-based agent
- `apps/web/components/FollowupsList.tsx` already shows `REPLY` vs `NUDGE`

The missing piece is a reply-specific draft flow that uses Gemini and maps the reply into one of the two approved response styles.

## 5. Proposed Architecture

### 5.1 Data flow

1. Inbox scan detects a lead reply.
2. The scraper writes a `followups` row with:
   - `followup_type = "REPLY"`
   - `status = "PENDING_REVIEW"`
   - `reply_snippet`, `reply_timestamp`, and thread metadata
3. The user opens `/followups`.
4. The user triggers draft generation for that reply row, or bulk generation for pending reply rows.
5. The reply draft worker calls Gemini with the lead context and reply snippet.
6. Gemini returns:
   - classification: `positive` or `negative`
   - draft text
7. The draft is stored on the followup row.
8. The user reviews, edits, and approves the draft.
9. The sender sends the approved reply.

### 5.2 Drafting boundary

Keep the model logic behind one thin adapter instead of scattering prompt code through the web app.

Recommended location:

- `mcp-server/run_followup_agent.py` becomes the reply drafting entrypoint
- a small Gemini adapter is added beside it if needed
- the web app keeps calling the existing `generateFollowupDraft()` action

This preserves the current UI contract and limits the change to one draft boundary.

### 5.3 Model contract

Gemini should not invent new reply styles. It should choose one of two intent buckets and then produce a short answer in that style.

Expected structured output:

```json
{
  "intent": "positive | negative",
  "draft_text": "string",
  "confidence": 0.0
}
```

The draft text may be lightly rewritten, but it must preserve:

- the meaning of the selected template
- the correct link
- the short, natural tone
- the no-extra-fluff constraint

### 5.4 Approved reply styles

Positive interest:

- keep the scheduling-link response style
- allow light wording variation
- keep the booking link intact
- canonical anchor:
  - `Freut mich zu hören, kannst dir gerne hier einen termin mit einem unserer bAV Experten buchen https://api.degura.de/2.0/consultants/my-scheduling-link`

Negative or no-interest:

- keep the website / rent-gap-calculator response style
- allow light wording variation
- keep the Degura website link intact
- canonical anchor:
  - `wenn sie Interesse haben schauen sie auf dieser website vorbeischauen rentenlückenrechner wenn du lust hast buch es hier https://www.degura.de/arbeitnehmer`

The final behavior should feel like AI-assisted wording, not like a freeform chatbot.

## 6. UI Design

### 6.1 Single surface

Use the existing `/followups` page only.

### 6.2 Row treatment

Replies should stay mixed into the current table, but be obvious at a glance:

- keep the existing `REPLY` badge
- show a small intent badge once drafted, such as `POSITIVE` or `NEGATIVE`
- keep reply rows visually subtle but distinct from nudge rows
- do not add another tab, filter panel, or page section

### 6.3 Review flow

Reply rows should behave like this:

- draft box is prefilled by Gemini
- user can edit before approval
- existing `APPROVE & SEND` / `SEND NOW` actions remain in place

The page should still read as one review queue, not two separate workflows.

## 7. Error Handling

If Gemini classification or generation fails:

- keep the followup row in `PENDING_REVIEW`
- surface the failure in the existing row error state
- do not auto-send anything
- allow the operator to retry draft generation

If the model returns invalid or incomplete JSON:

- reject the draft
- log the bad payload
- keep the row reviewable

If a reply is ambiguous:

- choose the safer, lower-pressure response
- keep the reply short
- preserve the approved link and tone

## 8. Testing

Minimum tests for this feature:

1. Reply rows still appear in `/followups`.
2. Reply rows show the `REPLY` badge and the new intent label.
3. Gemini draft output is mapped to `positive` and `negative` correctly.
4. The approved link for each template is preserved.
5. `PENDING_REVIEW -> draft -> approve -> send` still works.
6. Nudge followups keep their existing behavior unchanged.

Recommended coverage:

- unit tests for the reply classifier / prompt contract
- component tests for Followups row labeling
- one integration-style test for the draft generation action path

## 9. Implementation Constraints

- Keep the UI changes small and local to `FollowupsList.tsx` and the followups page action surface.
- Prefer one thin Gemini adapter over a larger prompt framework.
- Preserve the existing `followups` table and statuses.
- Do not change non-reply followup behavior.
- Keep the message concise and business-safe.

## 10. Acceptance Criteria

The feature is done when:

- replies are created as reviewable followups
- the Followups page clearly shows reply rows without adding new navigation
- Gemini drafts a reply in one of the two approved styles
- the user can still edit, approve, and send manually
- nudge followups still work as before
- no unrelated sender or inbox flow regresses
