-- Migration 009: Add last_message tracking columns to followups table
-- These columns track the most recent message in a conversation and who sent it,
-- enabling the followup agent to understand context and generate appropriate responses.

-- Add last_message_text column
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'followups' AND column_name = 'last_message_text'
    ) THEN
        ALTER TABLE followups ADD COLUMN last_message_text TEXT;
    END IF;
END $$;

-- Add last_message_from column with check constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'followups' AND column_name = 'last_message_from'
    ) THEN
        ALTER TABLE followups ADD COLUMN last_message_from TEXT;
        
        -- Add check constraint for valid values
        ALTER TABLE followups ADD CONSTRAINT followups_last_message_from_check 
        CHECK (last_message_from IS NULL OR last_message_from IN ('us', 'lead'));
    END IF;
END $$;

-- Create index for filtering by last_message_from
CREATE INDEX IF NOT EXISTS idx_followups_last_message_from ON followups(last_message_from)
WHERE last_message_from IS NOT NULL;

-- Backfill existing rows
-- Step 1: If reply_snippet is present, set last_message_text=reply_snippet, last_message_from='lead'
UPDATE followups
SET 
    last_message_text = reply_snippet,
    last_message_from = 'lead'
WHERE 
    reply_snippet IS NOT NULL 
    AND reply_snippet != ''
    AND last_message_text IS NULL;

-- Step 2: For rows without reply_snippet, try to get the latest sent_text from this or previous followups
-- This handles NUDGE cases where we sent but they haven't replied
UPDATE followups f
SET 
    last_message_text = sub.latest_sent,
    last_message_from = 'us'
FROM (
    SELECT DISTINCT ON (f2.lead_id) 
        f2.lead_id,
        f2.sent_text as latest_sent
    FROM followups f2
    WHERE f2.sent_text IS NOT NULL AND f2.sent_text != ''
    ORDER BY f2.lead_id, f2.sent_at DESC NULLS LAST
) sub
WHERE 
    f.lead_id = sub.lead_id
    AND f.last_message_text IS NULL
    AND sub.latest_sent IS NOT NULL;

-- Step 3: For remaining rows without last_message, try to get from drafts.final_message
UPDATE followups f
SET 
    last_message_text = sub.latest_draft,
    last_message_from = 'us'
FROM (
    SELECT DISTINCT ON (d.lead_id)
        d.lead_id,
        d.final_message as latest_draft
    FROM drafts d
    WHERE d.final_message IS NOT NULL AND d.final_message != ''
    ORDER BY d.lead_id, d.created_at DESC
) sub
WHERE 
    f.lead_id = sub.lead_id
    AND f.last_message_text IS NULL
    AND sub.latest_draft IS NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN followups.last_message_text IS 'The text of the most recent message in the conversation thread';
COMMENT ON COLUMN followups.last_message_from IS 'Who sent the last message: "us" (we sent it) or "lead" (they replied)';
