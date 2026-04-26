-- Repair already-rendered NUDGE drafts that were stored before migration 015
-- fixed the template. Each affected row's draft_text starts with
-- "Hi ,FirstName\n" — swap the leading-comma rendering for the correct
-- "Hi FirstName,\n" form so the message actually reads naturally when the
-- sender fires it on the row's next_send_at.
--
-- Idempotent: the regex anchor + the WHERE LIKE filter both ensure rows that
-- have already been corrected (or never had the typo) are not touched.

UPDATE followups
   SET draft_text = regexp_replace(draft_text, '^Hi ,([^\n]+)\n', E'Hi \\1,\n')
 WHERE followup_type = 'NUDGE'
   AND draft_text LIKE 'Hi ,%';
