-- First-touch InMail campaigns remain opt-in at the sequence boundary.
ALTER TABLE outreach_sequences
  ADD COLUMN IF NOT EXISTS linkedin_account_id UUID REFERENCES linkedin_accounts(id) ON DELETE RESTRICT;
ALTER TABLE lead_batches
  ADD COLUMN IF NOT EXISTS linkedin_account_id UUID REFERENCES linkedin_accounts(id) ON DELETE RESTRICT;

UPDATE outreach_sequences AS sequence
SET linkedin_account_id = (
  SELECT leads.linkedin_account_id
  FROM leads
  WHERE leads.sequence_id = sequence.id
    AND leads.linkedin_account_id IS NOT NULL
  GROUP BY leads.linkedin_account_id
  ORDER BY count(*) DESC, leads.linkedin_account_id
  LIMIT 1
)
WHERE sequence.linkedin_account_id IS NULL;

UPDATE outreach_sequences
SET linkedin_account_id = (
  SELECT id FROM linkedin_accounts ORDER BY browser_slot NULLS LAST, created_at, id LIMIT 1
)
WHERE linkedin_account_id IS NULL;

UPDATE lead_batches AS batch
SET linkedin_account_id = (
  SELECT leads.linkedin_account_id
  FROM leads
  WHERE leads.batch_id = batch.id
    AND leads.linkedin_account_id IS NOT NULL
  GROUP BY leads.linkedin_account_id
  ORDER BY count(*) DESC, leads.linkedin_account_id
  LIMIT 1
)
WHERE batch.linkedin_account_id IS NULL;

UPDATE lead_batches
SET linkedin_account_id = (
  SELECT id FROM linkedin_accounts ORDER BY browser_slot NULLS LAST, created_at, id LIMIT 1
)
WHERE linkedin_account_id IS NULL;

ALTER TABLE outreach_sequences ALTER COLUMN linkedin_account_id SET NOT NULL;
ALTER TABLE lead_batches ALTER COLUMN linkedin_account_id SET NOT NULL;

ALTER TABLE outreach_sequences
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'standard_connect_message',
  ADD COLUMN IF NOT EXISTS inmail_subject TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'outreach_sequences_delivery_mode_check'
  ) THEN
    ALTER TABLE outreach_sequences
      ADD CONSTRAINT outreach_sequences_delivery_mode_check
      CHECK (delivery_mode IN ('standard_connect_message', 'invite_and_inmail'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_outreach_sequences_delivery_mode
  ON outreach_sequences (linkedin_account_id, delivery_mode, is_active);

COMMENT ON COLUMN outreach_sequences.delivery_mode IS
  'Explicit first-touch transport; invite_and_inmail is only selected by the dedicated sender mode.';
COMMENT ON COLUMN outreach_sequences.inmail_subject IS
  'Sales Navigator/InMail subject for invite_and_inmail sequences.';
