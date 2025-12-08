-- Migration 008: Add followup_type column to distinguish between replies and nudges
-- This allows the system to track whether a followup was triggered by a lead's reply
-- or by the need to nudge a lead who hasn't responded yet.

DO $$
BEGIN
    -- Add followup_type column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'followups' AND column_name = 'followup_type'
    ) THEN
        ALTER TABLE followups ADD COLUMN followup_type TEXT DEFAULT 'REPLY';
        
        -- Add check constraint for valid types
        ALTER TABLE followups ADD CONSTRAINT followups_type_check 
        CHECK (followup_type IN ('REPLY', 'NUDGE'));
    END IF;
END $$;

-- Update existing followups: if reply_snippet is empty, it's a nudge
UPDATE followups 
SET followup_type = 'NUDGE' 
WHERE (reply_snippet IS NULL OR reply_snippet = '') 
  AND followup_type IS NULL;

-- Set default for existing rows with content
UPDATE followups 
SET followup_type = 'REPLY' 
WHERE reply_snippet IS NOT NULL 
  AND reply_snippet != '' 
  AND followup_type IS NULL;

-- Create index for filtering by type
CREATE INDEX IF NOT EXISTS idx_followups_type ON followups(followup_type);

COMMENT ON COLUMN followups.followup_type IS 'Type of followup: REPLY (lead responded to our message) or NUDGE (lead has not responded yet)';
