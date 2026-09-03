-- Mixed HubSpot DEGURA import, newest-first source priority, and URL-backed guide delivery.

ALTER TABLE outreach_sequences
  ADD COLUMN IF NOT EXISTS guide_url TEXT;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS source_company_id TEXT,
  ADD COLUMN IF NOT EXISTS source_sequence_id TEXT,
  ADD COLUMN IF NOT EXISTS source_last_activity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS campaign_paused BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_leads_account_new_source_activity
  ON leads (linkedin_account_id, source_last_activity_at DESC, created_at, id)
  WHERE status = 'NEW' AND campaign_paused = FALSE;

UPDATE outreach_sequences
SET booking_url = 'https://calendly.com/toby-weber-degura/videotelefonat-mit-toby-30min',
    privacy_url = 'https://www.degura.de/datenschutz',
    guide_url = 'https://www.degura.de/bav-leitfaden-confirmation'
WHERE campaign_key IN ('DEGURA_A', 'DEGURA_B', 'DEGURA_C');

UPDATE outreach_sequence_variants
SET connect_note = replace(connect_note, '20 Minuten', '30 Minuten'),
    first_message = replace(first_message, '20 Minuten', '30 Minuten'),
    second_message = replace(second_message, '20 Minuten', '30 Minuten'),
    third_message = replace(third_message, '20 Minuten', '30 Minuten'),
    asset_followup_1 = replace(asset_followup_1, '20 Minuten', '30 Minuten'),
    asset_followup_2 = replace(asset_followup_2, '20 Minuten', '30 Minuten')
WHERE sequence_id IN (
  SELECT id FROM outreach_sequences WHERE campaign_key IN ('DEGURA_A', 'DEGURA_B', 'DEGURA_C')
);

-- Variant B1 deliberately shares the guide link before consent; B2 remains the ask-first control.
UPDATE outreach_sequence_variants v
SET first_message = $copy$Danke fürs Vernetzen, {{first_name}}. Hier ist der Link zu unserem Leitfaden: https://www.degura.de/bav-leitfaden-confirmation. Was mich interessieren würde: Wie verwaltet {{company_name}} aktuell die bAV?$copy$
FROM outreach_sequences s
WHERE v.sequence_id = s.id
  AND s.campaign_key = 'DEGURA_B'
  AND v.variant_key = 1;

UPDATE linkedin_accounts
SET daily_invite_limit = 50,
    daily_message_limit = 50
WHERE is_active;

CREATE OR REPLACE FUNCTION import_degura_campaign_batches(
  p_batch_name TEXT,
  p_eligibility_confirmed_by TEXT,
  p_leads JSONB
)
RETURNS TABLE(batch_id BIGINT, sequence_id BIGINT, inserted_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_id BIGINT;
  v_sequence_id BIGINT;
  v_campaign_key TEXT;
  v_inserted INTEGER;
  v_total_inserted INTEGER := 0;
BEGIN
  IF jsonb_typeof(p_leads) <> 'array' OR jsonb_array_length(p_leads) = 0 THEN
    RAISE EXCEPTION 'At least one assigned lead is required';
  END IF;
  IF NULLIF(trim(p_eligibility_confirmed_by), '') IS NULL THEN
    RAISE EXCEPTION 'Eligibility confirmation is required';
  END IF;
  IF (SELECT count(*) FROM linkedin_accounts WHERE is_active) <> 2
     OR (SELECT array_agg(browser_slot ORDER BY browser_slot) FROM linkedin_accounts WHERE is_active) <> ARRAY[1::smallint, 2::smallint] THEN
    RAISE EXCEPTION 'Exactly two active LinkedIn accounts in browser slots 1 and 2 are required';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_leads) item
    LEFT JOIN linkedin_accounts account
      ON account.id = (item->>'linkedin_account_id')::UUID AND account.is_active
    WHERE account.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Every imported lead must reference an active LinkedIn account';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_leads) item
    LEFT JOIN outreach_sequences sequence
      ON sequence.id = (item->>'sequence_id')::BIGINT
      AND sequence.is_active
      AND sequence.is_managed_campaign
    LEFT JOIN outreach_sequence_variants variant
      ON variant.id = (item->>'sequence_variant_id')::BIGINT
      AND variant.sequence_id = sequence.id
      AND variant.is_active
    WHERE sequence.id IS NULL OR variant.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Every imported lead must reference an active managed sequence and matching variant';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_leads) item
    JOIN outreach_sequences sequence ON sequence.id = (item->>'sequence_id')::BIGINT
    WHERE sequence.campaign_key IS DISTINCT FROM CASE item->>'source_sequence_id'
      WHEN '837149883' THEN 'DEGURA_A'
      WHEN '836545727' THEN 'DEGURA_B'
      WHEN '837149889' THEN 'DEGURA_C'
      ELSE NULL
    END
  ) THEN
    RAISE EXCEPTION 'Source sequence does not match its DEGURA campaign family';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_leads) item
    WHERE item->>'linkedin_url' !~ '^https://www[.]linkedin[.]com/in/[a-z0-9%_.~-]+$'
       OR (NULLIF(trim(item->>'source_last_activity_at'), '') IS NOT NULL
           AND item->>'source_last_activity_at' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$')
  ) THEN
    RAISE EXCEPTION 'Every LinkedIn URL and source activity timestamp must be normalized';
  END IF;

  FOR v_sequence_id, v_campaign_key IN
    SELECT DISTINCT sequence.id, sequence.campaign_key
    FROM jsonb_array_elements(p_leads) item
    JOIN outreach_sequences sequence ON sequence.id = (item->>'sequence_id')::BIGINT
    ORDER BY sequence.campaign_key
  LOOP
    INSERT INTO lead_batches (
      name, source, batch_intent, sequence_id, distribution_mode,
      eligibility_confirmed_at, eligibility_confirmed_by
    ) VALUES (
      format('%s (DEGURA %s)', trim(p_batch_name), right(v_campaign_key, 1)),
      'hubspot_csv', 'connect_message', v_sequence_id,
      'balanced_two_account_two_variant', now(), p_eligibility_confirmed_by
    ) RETURNING id INTO v_batch_id;

    INSERT INTO leads (
      linkedin_url, first_name, last_name, company_name, status, outreach_mode,
      batch_id, sequence_id, sequence_variant_id, linkedin_account_id,
      source_contact_id, source_company_id, source_sequence_id, source_last_activity_at,
      campaign_paused
    )
    SELECT
      item->>'linkedin_url', NULLIF(item->>'first_name', ''),
      NULLIF(item->>'last_name', ''), NULLIF(item->>'company_name', ''),
      'NEW', 'connect_message', v_batch_id, v_sequence_id,
      (item->>'sequence_variant_id')::BIGINT, (item->>'linkedin_account_id')::UUID,
      NULLIF(item->>'source_contact_id', ''), NULLIF(item->>'source_company_id', ''),
      item->>'source_sequence_id',
      CASE WHEN NULLIF(trim(item->>'source_last_activity_at'), '') IS NULL THEN NULL
        ELSE (item->>'source_last_activity_at')::timestamp AT TIME ZONE 'Europe/Berlin'
      END, TRUE
    FROM jsonb_array_elements(p_leads) item
    WHERE (item->>'sequence_id')::BIGINT = v_sequence_id
      AND NOT EXISTS (
        SELECT 1 FROM outbound_suppressions suppression
        WHERE suppression.linkedin_url = item->>'linkedin_url'
          AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
      )
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
      DELETE FROM lead_batches WHERE id = v_batch_id;
    ELSE
      v_total_inserted := v_total_inserted + v_inserted;
      batch_id := v_batch_id;
      sequence_id := v_sequence_id;
      inserted_count := v_inserted;
      RETURN NEXT;
    END IF;
  END LOOP;

  IF v_total_inserted = 0 THEN
    RAISE EXCEPTION 'No eligible unique leads remained after validation';
  END IF;
END $$;
