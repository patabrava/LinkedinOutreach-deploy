-- Two-account LinkedIn ownership and DEGURA campaign runtime contracts.

CREATE TABLE IF NOT EXISTS linkedin_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
  sender_display_name TEXT NOT NULL DEFAULT '',
  browser_slot SMALLINT NOT NULL CHECK (browser_slot IN (1, 2)),
  daily_invite_limit INTEGER NOT NULL DEFAULT 25 CHECK (daily_invite_limit > 0),
  daily_message_limit INTEGER NOT NULL DEFAULT 25 CHECK (daily_message_limit > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE linkedin_accounts
  ADD COLUMN IF NOT EXISTS sender_display_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';

UPDATE linkedin_accounts
SET display_name = sender_display_name
WHERE display_name = '' AND sender_display_name <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_accounts_email_unique
  ON linkedin_accounts (lower(email)) WHERE email <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_accounts_browser_slot_unique
  ON linkedin_accounts (browser_slot);

INSERT INTO linkedin_accounts (label, email, credentials, sender_display_name, browser_slot)
SELECT
  'Primary',
  COALESCE(value->>'email', value->>'username', ''),
  value,
  COALESCE(value->>'display_name', ''),
  1
FROM settings
WHERE key = 'linkedin_credentials'
  AND NOT EXISTS (SELECT 1 FROM linkedin_accounts)
LIMIT 1;

INSERT INTO linkedin_accounts (label, browser_slot)
SELECT 'Primary', 1
WHERE NOT EXISTS (SELECT 1 FROM linkedin_accounts);

ALTER TABLE outreach_sequences
  ADD COLUMN IF NOT EXISTS campaign_key TEXT,
  ADD COLUMN IF NOT EXISTS tone TEXT,
  ADD COLUMN IF NOT EXISTS primary_goal TEXT,
  ADD COLUMN IF NOT EXISTS booking_url TEXT,
  ADD COLUMN IF NOT EXISTS privacy_url TEXT,
  ADD COLUMN IF NOT EXISTS guide_asset_path TEXT,
  ADD COLUMN IF NOT EXISTS is_managed_campaign BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_sequences_tone_check') THEN
    ALTER TABLE outreach_sequences ADD CONSTRAINT outreach_sequences_tone_check
      CHECK (tone IS NULL OR tone IN ('du', 'sie'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_sequences_primary_goal_check') THEN
    ALTER TABLE outreach_sequences ADD CONSTRAINT outreach_sequences_primary_goal_check
      CHECK (primary_goal IS NULL OR primary_goal IN ('call', 'guide_then_call'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_sequences_campaign_key_unique
  ON outreach_sequences (campaign_key) WHERE campaign_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outreach_sequence_variants (
  id BIGSERIAL PRIMARY KEY,
  sequence_id BIGINT NOT NULL REFERENCES outreach_sequences(id) ON DELETE CASCADE,
  variant_key SMALLINT NOT NULL CHECK (variant_key IN (1, 2)),
  connect_note TEXT NOT NULL,
  first_message TEXT NOT NULL,
  second_message TEXT NOT NULL,
  third_message TEXT NOT NULL,
  asset_followup_1 TEXT NOT NULL DEFAULT '',
  asset_followup_2 TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, variant_key)
);

ALTER TABLE lead_batches
  ADD COLUMN IF NOT EXISTS distribution_mode TEXT,
  ADD COLUMN IF NOT EXISTS eligibility_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eligibility_confirmed_by TEXT;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS linkedin_account_id UUID REFERENCES linkedin_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS sequence_variant_id BIGINT REFERENCES outreach_sequence_variants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS nurture_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invite_withdraw_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS asset_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stop_reason TEXT,
  ADD COLUMN IF NOT EXISTS human_handoff_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS human_handoff_reason TEXT;

UPDATE leads AS l
SET linkedin_account_id = (
  SELECT id FROM linkedin_accounts ORDER BY browser_slot, created_at, id LIMIT 1
)
WHERE l.linkedin_account_id IS NULL;

ALTER TABLE leads ALTER COLUMN linkedin_account_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_account_status
  ON leads (linkedin_account_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_account_next_action
  ON leads (linkedin_account_id, next_action_at) WHERE next_action_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_sequence_variant
  ON leads (sequence_variant_id);

CREATE OR REPLACE FUNCTION canonical_linkedin_profile_url(value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT regexp_replace(
    replace(replace(
      replace(lower(trim(regexp_replace(value, '[?#].*$', ''))), 'http://linkedin.com/', 'https://www.linkedin.com/'),
      'http://www.linkedin.com/', 'https://www.linkedin.com/'),
      'https://linkedin.com/', 'https://www.linkedin.com/'),
    '/+$', ''
  )
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_linkedin_url_canonical_unique
  ON leads (canonical_linkedin_profile_url(linkedin_url));

CREATE TABLE IF NOT EXISTS outbound_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  linkedin_url TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  source_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbound_suppressions_active
  ON outbound_suppressions (linkedin_url, expires_at);

CREATE TABLE IF NOT EXISTS outreach_events (
  id BIGSERIAL PRIMARY KEY,
  linkedin_account_id UUID NOT NULL REFERENCES linkedin_accounts(id) ON DELETE RESTRICT,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence_id BIGINT REFERENCES outreach_sequences(id) ON DELETE SET NULL,
  sequence_variant_id BIGINT REFERENCES outreach_sequence_variants(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  touch_number SMALLINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_events_event_type_check') THEN
    ALTER TABLE outreach_events ADD CONSTRAINT outreach_events_event_type_check CHECK (
      event_type IN (
        'invite_sent', 'invite_accepted', 'invite_withdrawn', 'touch_sent',
        'reply_received', 'guide_sent', 'asset_followup_sent', 'booking_link_sent',
        'human_handoff', 'sequence_stopped', 'suppression_created',
        'appointment_booked', 'appointment_showed', 'angry_reply', 'spam_report'
      )
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_outreach_events_account_occurred
  ON outreach_events (linkedin_account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_events_campaign_dimensions
  ON outreach_events (sequence_id, sequence_variant_id, event_type, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_events_delivery_idempotency
  ON outreach_events (lead_id, event_type, COALESCE(touch_number, 0))
  WHERE event_type IN ('invite_sent', 'touch_sent', 'guide_sent', 'asset_followup_sent');

CREATE OR REPLACE FUNCTION set_followup_campaign_ownership()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  SELECT linkedin_account_id, sequence_variant_id
    INTO NEW.linkedin_account_id, NEW.sequence_variant_id
  FROM leads WHERE id = NEW.lead_id;
  IF NEW.linkedin_account_id IS NULL THEN
    RAISE EXCEPTION 'Followup lead % has no LinkedIn account', NEW.lead_id;
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF to_regclass('public.followups') IS NOT NULL THEN
    ALTER TABLE followups
      ADD COLUMN IF NOT EXISTS linkedin_account_id UUID REFERENCES linkedin_accounts(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS sequence_variant_id BIGINT REFERENCES outreach_sequence_variants(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS reply_route TEXT,
      ADD COLUMN IF NOT EXISTS requires_human BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS source_touch SMALLINT,
      ADD COLUMN IF NOT EXISTS handoff_reason TEXT;

    UPDATE followups AS f
      SET linkedin_account_id = l.linkedin_account_id,
          sequence_variant_id = l.sequence_variant_id
      FROM leads AS l
      WHERE l.id = f.lead_id
        AND (f.linkedin_account_id IS NULL OR f.sequence_variant_id IS NULL);

    ALTER TABLE followups ALTER COLUMN linkedin_account_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_followups_account_status
      ON followups (linkedin_account_id, status);
    DROP TRIGGER IF EXISTS tg_followups_campaign_ownership ON followups;
    CREATE TRIGGER tg_followups_campaign_ownership
      BEFORE INSERT OR UPDATE OF lead_id ON followups
      FOR EACH ROW EXECUTE PROCEDURE set_followup_campaign_ownership();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tg_linkedin_accounts_updated_at ON linkedin_accounts;
CREATE TRIGGER tg_linkedin_accounts_updated_at
  BEFORE UPDATE ON linkedin_accounts
  FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();

DROP TRIGGER IF EXISTS tg_outreach_sequence_variants_updated_at ON outreach_sequence_variants;
CREATE TRIGGER tg_outreach_sequence_variants_updated_at
  BEFORE UPDATE ON outreach_sequence_variants
  FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();

CREATE OR REPLACE FUNCTION prevent_outreach_owner_reassignment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.linkedin_account_id IS DISTINCT FROM NEW.linkedin_account_id
      OR OLD.sequence_variant_id IS DISTINCT FROM NEW.sequence_variant_id)
     AND (
       OLD.connection_sent_at IS NOT NULL OR OLD.sent_at IS NOT NULL OR OLD.last_reply_at IS NOT NULL
       OR EXISTS (SELECT 1 FROM outreach_events e WHERE e.lead_id = OLD.id)
     ) THEN
    RAISE EXCEPTION 'Lead account and variant ownership are immutable after outreach starts';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tg_leads_prevent_outreach_owner_reassignment ON leads;
CREATE TRIGGER tg_leads_prevent_outreach_owner_reassignment
  BEFORE UPDATE OF linkedin_account_id, sequence_variant_id ON leads
  FOR EACH ROW EXECUTE PROCEDURE prevent_outreach_owner_reassignment();

ALTER TABLE linkedin_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_sequence_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated linkedin accounts" ON linkedin_accounts;
CREATE POLICY "Allow authenticated linkedin accounts" ON linkedin_accounts
  FOR ALL USING (auth.role() IN ('authenticated', 'service_role'))
  WITH CHECK (auth.role() IN ('authenticated', 'service_role'));
DROP POLICY IF EXISTS "Allow authenticated sequence variants" ON outreach_sequence_variants;
CREATE POLICY "Allow authenticated sequence variants" ON outreach_sequence_variants
  FOR ALL USING (auth.role() IN ('authenticated', 'service_role'))
  WITH CHECK (auth.role() IN ('authenticated', 'service_role'));
DROP POLICY IF EXISTS "Allow authenticated outbound suppressions" ON outbound_suppressions;
CREATE POLICY "Allow authenticated outbound suppressions" ON outbound_suppressions
  FOR ALL USING (auth.role() IN ('authenticated', 'service_role'))
  WITH CHECK (auth.role() IN ('authenticated', 'service_role'));
DROP POLICY IF EXISTS "Allow authenticated outreach events" ON outreach_events;
CREATE POLICY "Allow authenticated outreach events" ON outreach_events
  FOR ALL USING (auth.role() IN ('authenticated', 'service_role'))
  WITH CHECK (auth.role() IN ('authenticated', 'service_role'));

CREATE OR REPLACE FUNCTION import_degura_batch(
  p_batch_name TEXT,
  p_sequence_id BIGINT,
  p_batch_intent TEXT,
  p_eligibility_confirmed_by TEXT,
  p_leads JSONB
)
RETURNS TABLE(batch_id BIGINT, inserted_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_id BIGINT;
  v_inserted INTEGER := 0;
BEGIN
  IF jsonb_typeof(p_leads) <> 'array' OR jsonb_array_length(p_leads) = 0 THEN
    RAISE EXCEPTION 'At least one assigned lead is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM outreach_sequences WHERE id = p_sequence_id AND is_active) THEN
    RAISE EXCEPTION 'Active outreach sequence % was not found', p_sequence_id;
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
    LEFT JOIN outreach_sequence_variants variant
      ON variant.id = (item->>'sequence_variant_id')::BIGINT
      AND variant.sequence_id = p_sequence_id
      AND variant.is_active
    WHERE variant.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Every imported lead must reference an active variant of the selected sequence';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_leads) item
    WHERE item->>'linkedin_url' !~ '^https://www[.]linkedin[.]com/in/[a-z0-9%_.~-]+$'
  ) THEN
    RAISE EXCEPTION 'Every LinkedIn URL must be canonical before import';
  END IF;

  INSERT INTO lead_batches (
    name, source, batch_intent, sequence_id, distribution_mode,
    eligibility_confirmed_at, eligibility_confirmed_by
  ) VALUES (
    p_batch_name, 'csv_upload', p_batch_intent, p_sequence_id,
    'balanced_two_account', now(), p_eligibility_confirmed_by
  ) RETURNING id INTO v_batch_id;

  INSERT INTO leads (
    linkedin_url, first_name, last_name, company_name, status, outreach_mode,
    batch_id, sequence_id, sequence_variant_id, linkedin_account_id
  )
  SELECT
    item->>'linkedin_url', NULLIF(item->>'first_name', ''),
    NULLIF(item->>'last_name', ''), NULLIF(item->>'company_name', ''),
    'NEW', COALESCE(NULLIF(item->>'outreach_mode', ''), 'connect_message'),
    v_batch_id, p_sequence_id, (item->>'sequence_variant_id')::BIGINT,
    (item->>'linkedin_account_id')::UUID
  FROM jsonb_array_elements(p_leads) AS item
  WHERE NOT EXISTS (
    SELECT 1 FROM outbound_suppressions s
    WHERE s.linkedin_url = item->>'linkedin_url'
      AND (s.expires_at IS NULL OR s.expires_at > now())
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    DELETE FROM lead_batches WHERE id = v_batch_id;
    RAISE EXCEPTION 'No eligible unique leads remained after validation';
  END IF;

  RETURN QUERY SELECT v_batch_id, v_inserted;
END $$;

COMMENT ON TABLE linkedin_accounts IS 'LinkedIn sender identities with encrypted credentials and isolated browser slots.';
COMMENT ON COLUMN leads.linkedin_account_id IS 'Immutable sender ownership after the first outbound event.';
COMMENT ON TABLE outbound_suppressions IS 'Global outbound suppression by canonical LinkedIn URL.';
COMMENT ON TABLE outreach_events IS 'Immutable account, sequence, variant, touch and outcome events.';
