-- Migration 007: Enhance followups table for robust follow-up workflow
-- Adds new columns and status values to support batch processing, error tracking, and scheduling

-- Add new columns to followups table if they don't exist
DO $$
BEGIN
    -- Add processing_started_at column for batch locking
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'followups' AND column_name = 'processing_started_at'
    ) THEN
        ALTER TABLE followups ADD COLUMN processing_started_at TIMESTAMPTZ;
    END IF;

    -- Add last_error column for error tracking
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'followups' AND column_name = 'last_error'
    ) THEN
        ALTER TABLE followups ADD COLUMN last_error TEXT;
    END IF;

    -- Add next_send_at column for scheduling
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'followups' AND column_name = 'next_send_at'
    ) THEN
        ALTER TABLE followups ADD COLUMN next_send_at TIMESTAMPTZ;
    END IF;
END $$;

-- Update status column to allow new status values
-- First, check if the column is an enum and add new values
DO $$
DECLARE
    col_type TEXT;
BEGIN
    -- Get the column type
    SELECT data_type INTO col_type
    FROM information_schema.columns
    WHERE table_name = 'followups' AND column_name = 'status';
    
    IF col_type = 'USER-DEFINED' THEN
        -- It's an enum, try to add new values
        BEGIN
            ALTER TYPE followup_status ADD VALUE IF NOT EXISTS 'PROCESSING';
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
        
        BEGIN
            ALTER TYPE followup_status ADD VALUE IF NOT EXISTS 'FAILED';
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
        
        BEGIN
            ALTER TYPE followup_status ADD VALUE IF NOT EXISTS 'RETRY_LATER';
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
    ELSIF col_type = 'text' OR col_type = 'character varying' THEN
        -- It's a text column, add a check constraint if not exists
        -- Drop existing constraint if any
        ALTER TABLE followups DROP CONSTRAINT IF EXISTS followups_status_check;
        
        -- Add new constraint with expanded values
        ALTER TABLE followups ADD CONSTRAINT followups_status_check 
        CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'SENT', 'SKIPPED', 'FAILED', 'RETRY_LATER'));
    END IF;
END $$;

-- Create index on status for faster queries
CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status);

-- Create index on processing_started_at for detecting stuck processing
CREATE INDEX IF NOT EXISTS idx_followups_processing_started ON followups(processing_started_at) 
WHERE processing_started_at IS NOT NULL;

-- Create index on lead_id + status for duplicate checking
CREATE INDEX IF NOT EXISTS idx_followups_lead_status ON followups(lead_id, status);

-- Add comment explaining the status values
COMMENT ON COLUMN followups.status IS 'Followup status: PENDING_REVIEW (needs human review), APPROVED (ready to send), PROCESSING (being sent), SENT (delivered), SKIPPED (user skipped), FAILED (permanent failure), RETRY_LATER (transient failure)';
COMMENT ON COLUMN followups.processing_started_at IS 'Timestamp when the followup started being processed (for batch locking)';
COMMENT ON COLUMN followups.last_error IS 'Error message from the last failed send attempt';
COMMENT ON COLUMN followups.next_send_at IS 'Scheduled time for the next send attempt';
