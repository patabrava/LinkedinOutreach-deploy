-- Migration: support connect-only enrichment workflow
-- Adds outreach_mode tracking, connection timestamps, and new lead statuses

ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'CONNECT_ONLY_SENT';
ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'CONNECTED';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'outreach_mode'
  ) THEN
    ALTER TABLE leads ADD COLUMN outreach_mode text NOT NULL DEFAULT 'message';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'connection_sent_at'
  ) THEN
    ALTER TABLE leads ADD COLUMN connection_sent_at timestamptz;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'connection_accepted_at'
  ) THEN
    ALTER TABLE leads ADD COLUMN connection_accepted_at timestamptz;
  END IF;
END$$;
