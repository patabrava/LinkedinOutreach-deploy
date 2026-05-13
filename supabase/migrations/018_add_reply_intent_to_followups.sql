-- Migration 018: Store AI reply intent on followups.
-- The existing followup lifecycle remains unchanged; these fields only annotate
-- AI-generated REPLY drafts for operator review.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'followups' AND column_name = 'reply_intent'
    ) THEN
        ALTER TABLE followups ADD COLUMN reply_intent TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'followups' AND column_name = 'reply_intent_confidence'
    ) THEN
        ALTER TABLE followups ADD COLUMN reply_intent_confidence NUMERIC;
    END IF;
END $$;

ALTER TABLE followups DROP CONSTRAINT IF EXISTS followups_reply_intent_check;
ALTER TABLE followups ADD CONSTRAINT followups_reply_intent_check
CHECK (reply_intent IS NULL OR reply_intent IN ('positive', 'negative'));

ALTER TABLE followups DROP CONSTRAINT IF EXISTS followups_reply_intent_confidence_check;
ALTER TABLE followups ADD CONSTRAINT followups_reply_intent_confidence_check
CHECK (reply_intent_confidence IS NULL OR (reply_intent_confidence >= 0 AND reply_intent_confidence <= 1));

CREATE INDEX IF NOT EXISTS idx_followups_reply_intent ON followups(reply_intent)
WHERE reply_intent IS NOT NULL;

COMMENT ON COLUMN followups.reply_intent IS 'AI-classified inbound reply intent: positive or negative.';
COMMENT ON COLUMN followups.reply_intent_confidence IS 'Model confidence for reply_intent in the range 0..1.';
