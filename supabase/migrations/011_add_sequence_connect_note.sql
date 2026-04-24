-- Add an invite note to outreach_sequences.
-- Existing sequences get an empty string so the UI can save immediately.

ALTER TABLE outreach_sequences
  ADD COLUMN IF NOT EXISTS connect_note text NOT NULL DEFAULT '';

UPDATE outreach_sequences
SET connect_note = COALESCE(connect_note, '')
WHERE connect_note IS NULL;
