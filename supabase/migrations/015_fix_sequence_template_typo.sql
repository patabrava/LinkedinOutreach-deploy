-- Fix the typo in outreach_sequences.second_message where the placeholder was
-- written as "Hi ,{{first_name}}" instead of "Hi {{first_name}},". Without this
-- fix every NUDGE rendered from the affected template begins with the
-- malformed greeting "Hi ,FirstName" (stray leading comma, no closing comma).
--
-- Discovered while verifying the no-review nudge automation: the three NUDGEs
-- queued from sequence id=3 ("Inactive no bAV") all had draft_text starting
-- with "Hi ,Vitali" / "Hi ,Melda" / "Hi ,Fabio". The bug lives in the template
-- content, not in _render_template_message — substituting the placeholder
-- preserves the leading comma. Migration 016 fixes already-rendered drafts.
--
-- Idempotent: REPLACE is a no-op once the typo is gone.

UPDATE outreach_sequences
   SET second_message = REPLACE(second_message, 'Hi ,{{first_name}}', 'Hi {{first_name}},')
 WHERE second_message LIKE 'Hi ,{{first_name}}%';
