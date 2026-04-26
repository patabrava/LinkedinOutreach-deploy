-- Migration 014: add batch intent so custom outreach can be filtered independently.

ALTER TABLE lead_batches
  ADD COLUMN IF NOT EXISTS batch_intent text NOT NULL DEFAULT 'connect_message';

UPDATE lead_batches
SET batch_intent = CASE
  WHEN EXISTS (
    SELECT 1
    FROM leads
    WHERE leads.batch_id = lead_batches.id
      AND leads.outreach_mode = 'connect_only'
  ) THEN 'connect_only'
  ELSE 'connect_message'
END;

CREATE INDEX IF NOT EXISTS idx_lead_batches_batch_intent ON lead_batches(batch_intent);
