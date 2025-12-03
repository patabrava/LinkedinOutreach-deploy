-- Backfill existing connect-only leads so UI separation works immediately
UPDATE leads
SET status = 'MESSAGE_ONLY_READY'
WHERE outreach_mode = 'connect_only'
  AND status = 'DRAFT_READY';

UPDATE leads
SET status = 'MESSAGE_ONLY_APPROVED'
WHERE outreach_mode = 'connect_only'
  AND status = 'APPROVED';
