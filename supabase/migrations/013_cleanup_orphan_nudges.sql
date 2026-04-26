-- Remove APPROVED NUDGE followups that reference leads which never received
-- a first outbound message.
--
-- Background: prior to migration 012 (and the scraper refactor that removed the
-- elif is_outbound: branch), the scraper could create NUDGE followups even for
-- leads whose connection request had not yet been accepted. The sender's
-- legitimate post-acceptance path only schedules NUDGE rows AFTER it has
-- successfully sent the first message (and set sent_at + connection_accepted_at
-- on the lead). Any NUDGE row whose lead has sent_at IS NULL AND
-- connection_accepted_at IS NULL is therefore an orphan: it cannot represent a
-- legitimate follow-up, and would deliver a "follow-up" greeting to someone who
-- never received a first message.
--
-- Migration 012 only removed empty-draft PENDING_REVIEW NUDGE rows. The orphan
-- rows targeted here are APPROVED with non-empty (often malformed) draft_text
-- and would otherwise fire on their next_send_at without this cleanup.
--
-- Safety: only deletes NUDGE rows that meet ALL of:
--   - status = 'APPROVED' (operator-authored APPROVED rows of any other type
--     are not targeted; REPLY rows are not targeted)
--   - lead has never been marked as sent (sent_at IS NULL)
--   - lead has never been marked as connected (connection_accepted_at IS NULL)
-- The sender will re-create correctly-formed APPROVED NUDGE rows via
-- schedule_nudge_followup once any of these leads' connections are actually
-- accepted and the first message is sent.

DELETE FROM followups
WHERE followup_type = 'NUDGE'
  AND status = 'APPROVED'
  AND lead_id IN (
    SELECT id FROM leads
    WHERE sent_at IS NULL
      AND connection_accepted_at IS NULL
  );
