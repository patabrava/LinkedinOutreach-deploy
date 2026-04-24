# Remove Nudge Review Queue

**Date:** 2026-04-24
**Status:** Approved for implementation plan

## Problem

The `/followups` review queue contains two kinds of records:

1. **REPLY followups** — created when a lead actually replies. The draft response is AI-generated, so human review is correct.
2. **NUDGE followups from the scraper path** — created when the scraper notices "we sent a message, lead hasn't replied yet." These land in `PENDING_REVIEW` with empty `draft_text`, even though a template (`second_message` / `third_message`) already exists on the sequence.

The second kind shouldn't need review. The template was approved the moment the operator wrote the sequence. Worse: `generateAllFollowupDrafts` (`apps/web/app/actions.ts:767`) does not discriminate by `followup_type`, so invoking it causes the LLM to write a new nudge from scratch, silently overwriting the operator's template.

The root cause is duplicated responsibility: both the scraper and the sender currently create NUDGE records, with different status/draft-text conventions.

- Sender path (`workers/sender/sender.py:1418-1461`) — correct: `status='APPROVED'`, `draft_text` = template.
- Scraper path (`workers/scraper/scraper.py:2170-2234`) — incorrect: `status='PENDING_REVIEW'`, `draft_text=''`.

## Goal

The sender worker is the single owner of nudge scheduling. Once a lead accepts the connection, all three outreach steps (message 1, message 2, message 3) flow automatically from the sequence template with no human intervention. The `/followups` tab contains only REPLY followups — AI-drafted responses to real inbound messages — which continue to require human review before sending.

## Non-goals

- No changes to REPLY followup behavior (still AI-drafted, still reviewed).
- No new UI, no new sequence fields, no auto-approve toggle.
- No changes to the sender's existing nudge scheduler — it already does the right thing.
- No DB schema changes (constraints, triggers). Enforcement stays application-level.

## Scope (AGENTS.md §0 locality envelope)

- **Files:** 3 (1 Python edit, 1 TS edit, 1 new SQL migration).
- **LOC:** `scraper.py` ≈ -65, `actions.ts` ≈ +1 line changed, migration ≈ +10 LOC new.
- **Dependencies:** 0 new.

## Design

### Change 1 — Remove scraper's NUDGE-creation branch

**File:** `workers/scraper/scraper.py`

Delete the `elif is_outbound:` block (approximately lines 2170–2234 in the current file). This is the branch that:

- Checks `convo_info.has_history` and skips if missing.
- Checks the 48-hour "too recent" guard.
- Calls `upsert_followup_for_reply(..., followup_type="NUDGE", ...)` at line 2222.
- Increments `nudges_detected`.

After deletion, inbox-scan inspection of a conversation whose last message is outbound simply falls through to the generic scan-timestamp update (lines 2236-2243). The lead is marked scanned and the scraper moves on.

Keep untouched:
- The REPLY branch (lines 2154-2168) — still calls `upsert_followup_for_reply` with `followup_type="REPLY"`. That is correct.
- The `upsert_followup_for_reply` helper itself (line 1905) — still used by the REPLY branch.
- The `nudges_detected` counter declaration and any log summary line that references it becomes unused; remove only the orphaned references introduced by this change. Do not clean up unrelated dead code.
- The `skipped_no_conversation` and `skipped_too_recent` counters that were only incremented inside the deleted branch — remove references that become unused.

### Change 2 — Defensive filter in `generateAllFollowupDrafts`

**File:** `apps/web/app/actions.ts` (around line 779-782).

Restrict the fetch to `followup_type='REPLY'` so the LLM draft generator never touches a NUDGE row, even if a stray one exists.

```ts
const { data: followups, error: fetchError } = await client
  .from("followups")
  .select("id, draft_text")
  .eq("status", "PENDING_REVIEW")
  .eq("followup_type", "REPLY");  // ← added
```

This is defense-in-depth. With Change 1 applied, no new NUDGE rows land in `PENDING_REVIEW`, but the filter stops any legacy / out-of-band row from triggering LLM overwrite.

### Change 3 — One-time cleanup migration

**File:** `supabase/migrations/011_cleanup_pending_review_nudges.sql` (new).

```sql
-- Remove stale NUDGE followups that accumulated in PENDING_REVIEW with empty drafts.
-- The sender worker is now the sole owner of nudge scheduling and will re-create
-- correctly-formed (APPROVED + template draft_text) rows on its next pass.
DELETE FROM followups
WHERE followup_type = 'NUDGE'
  AND status = 'PENDING_REVIEW'
  AND (draft_text IS NULL OR draft_text = '');
```

Only targets junk rows. Does not touch any `REPLY`, `APPROVED`, `SENT`, or `SKIPPED` records.

## Data flow (post-change)

```
Invite sent → connection accepted (detected by scraper)
           → sender: send message 1 (template, APPROVED, auto)
           → N days, no reply
           → sender schedules NUDGE (APPROVED, draft_text = second_message)
           → sender sends it
           → N days, no reply
           → sender schedules NUDGE (APPROVED, draft_text = third_message)
           → sender sends it

Lead replies at any point
           → scraper creates REPLY followup (PENDING_REVIEW, empty draft)
           → generateFollowupDraft runs the LLM, fills draft_text
           → operator reviews on /followups, approves or skips
           → sender sends approved REPLY
```

## Test plan

1. **Grep assertion in scraper:** after the change, `grep -n 'followup_type="NUDGE"' workers/scraper/scraper.py` returns no matches. Only the sender should create NUDGE rows.
2. **Sender still schedules nudges:** seed a lead whose last outbound message is older than `interval_days`. Run the sender's nudge-scheduling pass. Verify a row appears in `followups` with `status='APPROVED'`, `followup_type='NUDGE'`, `attempt=1`, `draft_text` equal to the rendered `second_message` for that lead.
3. **Inbox scan no longer produces nudges:** seed a lead with an outbound-only conversation. Run `inbox_scan`. Verify `followups` is unchanged for that lead and that `leads.last_inbox_scan_at` is updated.
4. **Migration correctness:** on a DB snapshot containing a mix of `PENDING_REVIEW` REPLY and NUDGE rows (some with empty drafts, some with text), run the migration. Verify only `NUDGE + PENDING_REVIEW + empty-draft` rows are deleted. All other rows untouched.
5. **LLM guard:** insert a synthetic `NUDGE + PENDING_REVIEW + empty-draft` row bypassing the migration. Call `generateAllFollowupDrafts`. Verify `total: 0` is returned and no LLM call is dispatched.
6. **UI smoke:** `/followups` loads. Every visible row is `followup_type='REPLY'`. Approving and skipping continue to work.

## Rollback

Each change is independently reversible:

- **Change 1:** `git revert` the scraper commit. Scraper resumes creating NUDGE-type rows in `PENDING_REVIEW`.
- **Change 2:** remove the `.eq("followup_type", "REPLY")` clause.
- **Change 3:** deleted rows are not recoverable from this migration alone. Rely on Supabase point-in-time recovery if a restore is ever needed. Given the rows contained no human-authored content (they had empty `draft_text`), this is acceptable.

## Open questions

None. All decisions locked during brainstorm:

- NUDGE followups always auto-send via template (decision A).
- Sender is the sole nudge owner; scraper's nudge path is deleted (approach 1).
- Existing junk rows deleted via migration; sender re-schedules as needed (option C).
- REPLY followups continue to require human review.
