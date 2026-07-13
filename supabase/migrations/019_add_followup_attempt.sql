-- Add explicit attempt tracking for sequence NUDGE followups.
--
-- attempt=1 is the second sequence message.
-- attempt=2 is the third sequence message.
--
-- The sender has a legacy fallback for projects that do not have this column,
-- but the schema should carry the distinction so second and third nudges do
-- not collapse into one row per lead.

ALTER TABLE followups
ADD COLUMN IF NOT EXISTS attempt integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'followups_attempt_check'
       AND conrelid = 'followups'::regclass
  ) THEN
    ALTER TABLE followups
    ADD CONSTRAINT followups_attempt_check
    CHECK (attempt IS NULL OR attempt IN (1, 2));
  END IF;
END $$;

UPDATE followups AS f
   SET attempt = CASE
     WHEN f.followup_type = 'NUDGE'
      AND f.status = 'SENT'
      AND COALESCE(l.sequence_step, 0) >= 2 THEN 1
     WHEN f.followup_type = 'NUDGE'
      AND f.status IN ('APPROVED', 'PROCESSING', 'RETRY_LATER')
      AND COALESCE(l.sequence_step, 0) >= 2 THEN 2
     WHEN f.followup_type = 'NUDGE' THEN 1
     ELSE NULL
   END
  FROM leads AS l
 WHERE f.lead_id = l.id
   AND f.followup_type = 'NUDGE'
   AND f.attempt IS NULL;

CREATE INDEX IF NOT EXISTS idx_followups_nudge_attempt
ON followups(lead_id, attempt, status)
WHERE followup_type = 'NUDGE';

COMMENT ON COLUMN followups.attempt IS
  'NUDGE attempt: 1 sends the second sequence message; 2 sends the third sequence message.';
