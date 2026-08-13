-- Multi-account LinkedIn ownership and isolation.
-- Existing data and the legacy singleton credential become the Primary account.

CREATE TABLE IF NOT EXISTS linkedin_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  credentials JSONB NOT NULL DEFAULT '{}'::jsonb,
  display_name TEXT NOT NULL DEFAULT '',
  browser_slot SMALLINT CHECK (browser_slot IN (1, 2)),
  daily_invite_limit INTEGER NOT NULL DEFAULT 50 CHECK (daily_invite_limit > 0),
  daily_message_limit INTEGER NOT NULL DEFAULT 50 CHECK (daily_message_limit > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_accounts_email_unique
  ON linkedin_accounts (lower(email))
  WHERE email <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_accounts_browser_slot_unique
  ON linkedin_accounts (browser_slot)
  WHERE browser_slot IS NOT NULL;

INSERT INTO linkedin_accounts (label, email, credentials, display_name, browser_slot)
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
  ADD COLUMN IF NOT EXISTS linkedin_account_id UUID REFERENCES linkedin_accounts(id) ON DELETE RESTRICT;
ALTER TABLE lead_batches
  ADD COLUMN IF NOT EXISTS linkedin_account_id UUID REFERENCES linkedin_accounts(id) ON DELETE RESTRICT;
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS linkedin_account_id UUID REFERENCES linkedin_accounts(id) ON DELETE RESTRICT;

UPDATE outreach_sequences
SET linkedin_account_id = (SELECT id FROM linkedin_accounts ORDER BY created_at, id LIMIT 1)
WHERE linkedin_account_id IS NULL;

UPDATE lead_batches
SET linkedin_account_id = (SELECT id FROM linkedin_accounts ORDER BY created_at, id LIMIT 1)
WHERE linkedin_account_id IS NULL;

UPDATE leads AS l
SET linkedin_account_id = COALESCE(
  (SELECT b.linkedin_account_id FROM lead_batches AS b WHERE b.id = l.batch_id),
  (SELECT id FROM linkedin_accounts ORDER BY created_at, id LIMIT 1)
)
WHERE l.linkedin_account_id IS NULL;

ALTER TABLE outreach_sequences ALTER COLUMN linkedin_account_id SET NOT NULL;
ALTER TABLE lead_batches ALTER COLUMN linkedin_account_id SET NOT NULL;
ALTER TABLE leads ALTER COLUMN linkedin_account_id SET NOT NULL;

ALTER TABLE outreach_sequences DROP CONSTRAINT IF EXISTS outreach_sequences_name_key;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_linkedin_url_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_sequences_account_name_unique
  ON outreach_sequences (linkedin_account_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_account_linkedin_url_unique
  ON leads (linkedin_account_id, linkedin_url);
CREATE INDEX IF NOT EXISTS idx_lead_batches_linkedin_account_id
  ON lead_batches (linkedin_account_id);
CREATE INDEX IF NOT EXISTS idx_leads_linkedin_account_status
  ON leads (linkedin_account_id, status);
CREATE INDEX IF NOT EXISTS idx_outreach_sequences_linkedin_account_id
  ON outreach_sequences (linkedin_account_id);

ALTER TABLE linkedin_accounts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

DROP POLICY IF EXISTS "Allow full access to linkedin accounts" ON linkedin_accounts;
CREATE POLICY "Allow full access to linkedin accounts" ON linkedin_accounts
  FOR ALL USING (auth.role() IN ('authenticated', 'service_role'))
  WITH CHECK (auth.role() IN ('authenticated', 'service_role'));

DROP TRIGGER IF EXISTS tg_linkedin_accounts_updated_at ON linkedin_accounts;
CREATE TRIGGER tg_linkedin_accounts_updated_at
  BEFORE UPDATE ON linkedin_accounts
  FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();

COMMENT ON TABLE linkedin_accounts IS
  'LinkedIn sender identities and encrypted credential payloads; browser state remains in an account-scoped persistent directory.';
COMMENT ON COLUMN leads.linkedin_account_id IS
  'Immutable sender ownership once outreach begins; LinkedIn URLs are unique inside this account.';

-- Followups exist in deployed environments but are absent from the legacy bootstrap file.
-- Add account ownership conditionally and derive it from the referenced lead forever after.
CREATE OR REPLACE FUNCTION set_followup_linkedin_account_id()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT linkedin_account_id INTO NEW.linkedin_account_id FROM leads WHERE id = NEW.lead_id;
  IF NEW.linkedin_account_id IS NULL THEN
    RAISE EXCEPTION 'Followup lead % has no LinkedIn account', NEW.lead_id;
  END IF;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.followups') IS NOT NULL THEN
    ALTER TABLE followups ADD COLUMN IF NOT EXISTS linkedin_account_id UUID REFERENCES linkedin_accounts(id) ON DELETE RESTRICT;
    UPDATE followups AS f SET linkedin_account_id = l.linkedin_account_id FROM leads AS l
      WHERE l.id = f.lead_id AND f.linkedin_account_id IS NULL;
    ALTER TABLE followups ALTER COLUMN linkedin_account_id SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_followups_linkedin_account_status ON followups (linkedin_account_id, status);
    DROP TRIGGER IF EXISTS tg_followups_linkedin_account ON followups;
    CREATE TRIGGER tg_followups_linkedin_account
      BEFORE INSERT OR UPDATE OF lead_id ON followups
      FOR EACH ROW EXECUTE PROCEDURE set_followup_linkedin_account_id();
  END IF;
END
$$;
