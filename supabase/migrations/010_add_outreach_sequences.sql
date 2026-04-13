-- Migration 010: Add reusable outreach sequences and CSV batch routing
-- Supports multiple global sequences and one-CSV-per-batch lead routing.

CREATE TABLE IF NOT EXISTS outreach_sequences (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  first_message TEXT NOT NULL DEFAULT '',
  second_message TEXT NOT NULL DEFAULT '',
  third_message TEXT NOT NULL DEFAULT '',
  followup_interval_days INT NOT NULL DEFAULT 3 CHECK (followup_interval_days > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_batches (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'csv_upload',
  sequence_id BIGINT NOT NULL REFERENCES outreach_sequences(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO outreach_sequences (name)
VALUES ('Default Sequence')
ON CONFLICT (name) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'batch_id'
  ) THEN
    ALTER TABLE leads ADD COLUMN batch_id BIGINT REFERENCES lead_batches(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'sequence_id'
  ) THEN
    ALTER TABLE leads ADD COLUMN sequence_id BIGINT REFERENCES outreach_sequences(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'sequence_step'
  ) THEN
    ALTER TABLE leads ADD COLUMN sequence_step INT NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'sequence_started_at'
  ) THEN
    ALTER TABLE leads ADD COLUMN sequence_started_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'sequence_last_sent_at'
  ) THEN
    ALTER TABLE leads ADD COLUMN sequence_last_sent_at TIMESTAMPTZ;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'sequence_stopped_at'
  ) THEN
    ALTER TABLE leads ADD COLUMN sequence_stopped_at TIMESTAMPTZ;
  END IF;
END $$;

UPDATE leads
SET sequence_id = s.id
FROM outreach_sequences s
WHERE s.name = 'Default Sequence'
  AND leads.sequence_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_batch_id ON leads(batch_id);
CREATE INDEX IF NOT EXISTS idx_leads_sequence_id ON leads(sequence_id);
CREATE INDEX IF NOT EXISTS idx_lead_batches_sequence_id ON lead_batches(sequence_id);
CREATE INDEX IF NOT EXISTS idx_outreach_sequences_is_active ON outreach_sequences(is_active);

ALTER TABLE outreach_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_batches ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'outreach_sequences' AND policyname = 'Allow full access to outreach sequences'
  ) THEN
    CREATE POLICY "Allow full access to outreach sequences"
      ON outreach_sequences
      FOR ALL
      USING (auth.role() = 'authenticated' OR auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'authenticated' OR auth.role() = 'service_role');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'lead_batches' AND policyname = 'Allow full access to lead batches'
  ) THEN
    CREATE POLICY "Allow full access to lead batches"
      ON lead_batches
      FOR ALL
      USING (auth.role() = 'authenticated' OR auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'authenticated' OR auth.role() = 'service_role');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'tg_outreach_sequences_updated_at'
  ) THEN
    CREATE TRIGGER tg_outreach_sequences_updated_at
      BEFORE UPDATE ON outreach_sequences
      FOR EACH ROW
      EXECUTE PROCEDURE touch_updated_at();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'tg_lead_batches_updated_at'
  ) THEN
    CREATE TRIGGER tg_lead_batches_updated_at
      BEFORE UPDATE ON lead_batches
      FOR EACH ROW
      EXECUTE PROCEDURE touch_updated_at();
  END IF;
END $$;

