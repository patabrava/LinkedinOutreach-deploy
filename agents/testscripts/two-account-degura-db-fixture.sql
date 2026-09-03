\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT 'service_role'::text $$;

CREATE TABLE settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  value jsonb NOT NULL
);

CREATE TABLE outreach_sequences (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  connect_note text NOT NULL DEFAULT '',
  first_message text NOT NULL DEFAULT '',
  second_message text NOT NULL DEFAULT '',
  third_message text NOT NULL DEFAULT '',
  followup_interval_days integer NOT NULL DEFAULT 3,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lead_batches (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  source text NOT NULL DEFAULT 'csv_upload',
  batch_intent text NOT NULL DEFAULT 'connect_message',
  sequence_id bigint NOT NULL REFERENCES outreach_sequences(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  linkedin_url text NOT NULL UNIQUE,
  first_name text,
  last_name text,
  company_name text,
  batch_id bigint REFERENCES lead_batches(id),
  sequence_id bigint REFERENCES outreach_sequences(id),
  status text NOT NULL DEFAULT 'NEW',
  outreach_mode text NOT NULL DEFAULT 'connect_message',
  sent_at timestamptz,
  connection_sent_at timestamptz,
  connection_accepted_at timestamptz,
  last_reply_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id),
  status text NOT NULL DEFAULT 'PENDING_REVIEW',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

INSERT INTO settings(key, value)
VALUES ('linkedin_credentials', '{"email":"primary@example.test"}'::jsonb);
INSERT INTO outreach_sequences(name) VALUES ('Default Sequence');
