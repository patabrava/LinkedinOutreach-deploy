-- Remove only accidental leading line breaks introduced by the copy migration.
UPDATE outreach_sequences
SET
  first_message = ltrim(first_message, E'\r\n'),
  second_message = ltrim(second_message, E'\r\n'),
  third_message = ltrim(third_message, E'\r\n'),
  updated_at = now()
WHERE id = 10
  AND name = 'COP bAV InMail · Katharina · 2026-09-17'
  AND delivery_mode = 'invite_and_inmail';
