-- Migration: Add FAILED status and error_message column to leads table
-- This prevents the sender from getting stuck retrying the same lead repeatedly

-- Add FAILED status to the enum (only if it doesn't exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum 
    WHERE enumlabel = 'FAILED' 
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'lead_status')
  ) THEN
    ALTER TYPE lead_status ADD VALUE 'FAILED';
  END IF;
END$$;

-- Add error_message column to leads table (only if it doesn't exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'leads' AND column_name = 'error_message'
  ) THEN
    ALTER TABLE leads ADD COLUMN error_message text;
  END IF;
END$$;

-- Add followup_count and last_reply_at columns if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'leads' AND column_name = 'followup_count'
  ) THEN
    ALTER TABLE leads ADD COLUMN followup_count int DEFAULT 0;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'leads' AND column_name = 'last_reply_at'
  ) THEN
    ALTER TABLE leads ADD COLUMN last_reply_at timestamptz;
  END IF;
END$$;
