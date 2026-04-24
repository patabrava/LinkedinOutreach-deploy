-- Remove stale NUDGE followups stuck in PENDING_REVIEW with empty drafts.
--
-- Background: before this migration, the scraper's inbox_scan created NUDGE
-- followups as PENDING_REVIEW with empty draft_text, duplicating the sender's
-- own nudge scheduler (which creates them as APPROVED with template text).
-- The scraper path has been removed. This cleans up the orphaned rows.
--
-- The sender worker's nudge scheduler will re-create correctly-formed rows
-- (status='APPROVED', draft_text=sequence template) on its next pass for any
-- lead that is still eligible for a nudge.
--
-- Safety: only targets rows that (a) are NUDGE type, (b) are still in review,
-- and (c) have no draft text. Any row with operator-authored or LLM-generated
-- draft_text is preserved. REPLY followups are never touched.

DELETE FROM followups
WHERE followup_type = 'NUDGE'
  AND status = 'PENDING_REVIEW'
  AND (draft_text IS NULL OR draft_text = '');
