-- Supabase bootstrap script
-- Run in the SQL editor or via the supabase CLI after creating your project.

-- Extensions
create extension if not exists "pgcrypto";
create extension if not exists pg_cron;
create extension if not exists vector;

-- Enum for lead status
do $$
begin
  if not exists (select 1 from pg_type where typname = 'lead_status') then
    create type lead_status as enum (
      'NEW',
      'ENRICHED',
      'PROCESSING',
      'ENRICH_FAILED',
      'DRAFT_READY',
      'APPROVED',
      'MESSAGE_ONLY_READY',
      'MESSAGE_ONLY_APPROVED',
      'SENT',
      'CONNECT_ONLY_SENT',
      'CONNECTED',
      'REPLIED',
      'REJECTED',
      'FAILED'
    );
  end if;
end$$;

create table if not exists linkedin_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  email text not null default '',
  credentials jsonb not null default '{}'::jsonb,
  display_name text not null default '',
  browser_slot smallint check (browser_slot in (1, 2)),
  daily_invite_limit int not null default 50 check (daily_invite_limit > 0),
  daily_message_limit int not null default 50 check (daily_message_limit > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into linkedin_accounts (id, label, browser_slot)
values ('00000000-0000-0000-0000-000000000001', 'Primary', 1)
on conflict (id) do nothing;

create table if not exists outreach_sequences (
  id bigserial primary key,
  linkedin_account_id uuid not null default '00000000-0000-0000-0000-000000000001' references linkedin_accounts(id) on delete restrict,
  name text not null,
  connect_note text not null default '',
  first_message text not null default '',
  second_message text not null default '',
  third_message text not null default '',
  followup_interval_days int not null default 3 check (followup_interval_days > 0),
  campaign_key text unique,
  tone text check (tone is null or tone in ('du', 'sie')),
  primary_goal text check (primary_goal is null or primary_goal in ('call', 'guide_then_call')),
  booking_url text,
  privacy_url text,
  guide_url text,
  guide_asset_path text,
  is_managed_campaign boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists outreach_sequence_variants (
  id bigserial primary key,
  sequence_id bigint not null references outreach_sequences(id) on delete cascade,
  variant_key smallint not null check (variant_key in (1, 2)),
  connect_note text not null,
  first_message text not null,
  second_message text not null,
  third_message text not null,
  asset_followup_1 text not null default '',
  asset_followup_2 text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sequence_id, variant_key)
);

create table if not exists lead_batches (
  id bigserial primary key,
  linkedin_account_id uuid not null default '00000000-0000-0000-0000-000000000001' references linkedin_accounts(id) on delete restrict,
  name text not null,
  source text not null default 'csv_upload',
  batch_intent text not null default 'connect_message',
  sequence_id bigint not null references outreach_sequences(id) on delete restrict,
  distribution_mode text,
  eligibility_confirmed_at timestamptz,
  eligibility_confirmed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  linkedin_account_id uuid not null default '00000000-0000-0000-0000-000000000001' references linkedin_accounts(id) on delete restrict,
  linkedin_url text not null,
  first_name text,
  last_name text,
  company_name text,
  batch_id bigint references lead_batches(id) on delete set null,
  sequence_id bigint references outreach_sequences(id) on delete set null,
  linkedin_account_id uuid not null references linkedin_accounts(id) on delete restrict,
  sequence_variant_id bigint references outreach_sequence_variants(id) on delete set null,
  sequence_step int not null default 0,
  sequence_started_at timestamptz,
  sequence_last_sent_at timestamptz,
  sequence_stopped_at timestamptz,
  next_action_at timestamptz,
  paused_until timestamptz,
  nurture_until timestamptz,
  invite_withdraw_at timestamptz,
  asset_sent_at timestamptz,
  stop_reason text,
  human_handoff_required boolean not null default false,
  human_handoff_reason text,
  source_contact_id text,
  source_company_id text,
  source_sequence_id text,
  source_last_activity_at timestamptz,
  campaign_paused boolean not null default false,
  status lead_status not null default 'NEW',
  outreach_mode text not null default 'message',
  sent_at timestamptz,
  connection_sent_at timestamptz,
  connection_accepted_at timestamptz,
  error_message text,
  profile_data jsonb,
  recent_activity jsonb,
  ai_tags jsonb,
  followup_count int default 0,
  last_reply_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists drafts (
  id bigserial primary key,
  lead_id uuid not null references leads(id) on delete cascade,
  opener text,
  body_type text,
  body_text text,
  cta_type text,
  cta_text text,
  final_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists outbound_suppressions (
  id uuid primary key default gen_random_uuid(),
  linkedin_url text not null unique,
  reason text not null,
  source_lead_id uuid references leads(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  created_by text
);

create table if not exists outreach_events (
  id bigserial primary key,
  linkedin_account_id uuid not null references linkedin_accounts(id) on delete restrict,
  lead_id uuid not null references leads(id) on delete cascade,
  sequence_id bigint references outreach_sequences(id) on delete set null,
  sequence_variant_id bigint references outreach_sequence_variants(id) on delete set null,
  event_type text not null,
  touch_number smallint,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  correlation_id text
);

insert into outreach_sequences (name)
values ('Default Sequence')
on conflict do nothing;

-- Helpful indexes
create index if not exists idx_leads_status on leads (status);
create unique index if not exists idx_linkedin_accounts_email_unique on linkedin_accounts (lower(email)) where email <> '';
create unique index if not exists idx_linkedin_accounts_browser_slot_unique on linkedin_accounts (browser_slot) where browser_slot is not null;
create unique index if not exists idx_outreach_sequences_account_name_unique on outreach_sequences (linkedin_account_id, lower(name));
create unique index if not exists idx_leads_account_linkedin_url_unique on leads (linkedin_account_id, linkedin_url);
create index if not exists idx_leads_linkedin_account_status on leads (linkedin_account_id, status);
create index if not exists idx_drafts_lead_id on drafts (lead_id);
create index if not exists idx_leads_batch_id on leads (batch_id);
create index if not exists idx_leads_sequence_id on leads (sequence_id);
create index if not exists idx_leads_account_status on leads (linkedin_account_id, status);
create index if not exists idx_leads_account_next_action on leads (linkedin_account_id, next_action_at) where next_action_at is not null;
create index if not exists idx_leads_sequence_variant on leads (sequence_variant_id);
create index if not exists idx_leads_account_new_source_activity
  on leads (linkedin_account_id, source_last_activity_at desc, created_at, id)
  where status = 'NEW' and campaign_paused = false;
create or replace function canonical_linkedin_profile_url(value text)
returns text language sql immutable strict as $$
  select regexp_replace(
    replace(replace(
      replace(lower(trim(regexp_replace(value, '[?#].*$', ''))), 'http://linkedin.com/', 'https://www.linkedin.com/'),
      'http://www.linkedin.com/', 'https://www.linkedin.com/'),
      'https://linkedin.com/', 'https://www.linkedin.com/'),
    '/+$', ''
  )
$$;
create unique index if not exists idx_leads_linkedin_url_canonical_unique
  on leads (canonical_linkedin_profile_url(linkedin_url));
create index if not exists idx_lead_batches_sequence_id on lead_batches (sequence_id);
create index if not exists idx_lead_batches_batch_intent on lead_batches (batch_intent);
create index if not exists idx_outreach_events_account_occurred on outreach_events (linkedin_account_id, occurred_at desc);
create index if not exists idx_outreach_events_campaign_dimensions on outreach_events (sequence_id, sequence_variant_id, event_type, occurred_at desc);

create or replace function prevent_outreach_owner_reassignment()
returns trigger language plpgsql as $$
begin
  if (old.linkedin_account_id is distinct from new.linkedin_account_id
      or old.sequence_variant_id is distinct from new.sequence_variant_id)
     and (
       old.connection_sent_at is not null or old.sent_at is not null or old.last_reply_at is not null
       or exists (select 1 from outreach_events e where e.lead_id = old.id)
     ) then
    raise exception 'Lead account and variant ownership are immutable after outreach starts';
  end if;
  return new;
end $$;

drop trigger if exists tg_leads_prevent_outreach_owner_reassignment on leads;
create trigger tg_leads_prevent_outreach_owner_reassignment
  before update of linkedin_account_id, sequence_variant_id on leads
  for each row execute procedure prevent_outreach_owner_reassignment();
-- Followup reply-intent metadata is added by
-- supabase/migrations/018_add_reply_intent_to_followups.sql.

-- Row Level Security
alter table outreach_sequences enable row level security;
alter table linkedin_accounts enable row level security;
alter table lead_batches enable row level security;
alter table leads enable row level security;
alter table drafts enable row level security;
alter table settings enable row level security;
alter table outbound_suppressions enable row level security;
alter table outreach_events enable row level security;

-- Allow authenticated users full access to all tables
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'Allow authenticated linkedin accounts') then
    create policy "Allow authenticated linkedin accounts" on linkedin_accounts
      for all using (auth.role() = 'authenticated')
      with check (auth.role() = 'authenticated');
  end if;

  if not exists (select 1 from pg_policies where policyname = 'Allow authenticated outreach sequences') then
    create policy "Allow authenticated outreach sequences" on outreach_sequences
      for all using (auth.role() = 'authenticated')
      with check (auth.role() = 'authenticated');
  end if;

  if not exists (select 1 from pg_policies where policyname = 'Allow authenticated lead batches') then
    create policy "Allow authenticated lead batches" on lead_batches
      for all using (auth.role() = 'authenticated')
      with check (auth.role() = 'authenticated');
  end if;

  if not exists (select 1 from pg_policies where policyname = 'Allow authenticated leads') then
    create policy "Allow authenticated leads" on leads
      for all using (auth.role() = 'authenticated')
      with check (auth.role() = 'authenticated');
  end if;

  if not exists (select 1 from pg_policies where policyname = 'Allow authenticated drafts') then
    create policy "Allow authenticated drafts" on drafts
      for all using (auth.role() = 'authenticated')
      with check (auth.role() = 'authenticated');
  end if;

  if not exists (select 1 from pg_policies where policyname = 'Allow authenticated settings') then
    create policy "Allow authenticated settings" on settings
      for all using (auth.role() = 'authenticated')
      with check (auth.role() = 'authenticated');
  end if;

  if not exists (select 1 from pg_policies where policyname = 'Allow authenticated outbound suppressions') then
    create policy "Allow authenticated outbound suppressions" on outbound_suppressions
      for all using (auth.role() = 'authenticated')
      with check (auth.role() = 'authenticated');
  end if;

  if not exists (select 1 from pg_policies where policyname = 'Allow authenticated outreach events') then
    create policy "Allow authenticated outreach events" on outreach_events
      for all using (auth.role() = 'authenticated')
      with check (auth.role() = 'authenticated');
  end if;
end$$;

-- Trigger to keep updated_at fresh
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'tg_linkedin_accounts_updated_at'
  ) then
    create trigger tg_linkedin_accounts_updated_at
      before update on linkedin_accounts
      for each row
      execute procedure touch_updated_at();
  end if;

  new.updated_at = now();
  return new;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'tg_linkedin_accounts_updated_at'
  ) then
    create trigger tg_linkedin_accounts_updated_at
      before update on linkedin_accounts
      for each row
      execute procedure touch_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'tg_outreach_sequences_updated_at'
  ) then
    create trigger tg_outreach_sequences_updated_at
      before update on outreach_sequences
      for each row
      execute procedure touch_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'tg_lead_batches_updated_at'
  ) then
    create trigger tg_lead_batches_updated_at
      before update on lead_batches
      for each row
      execute procedure touch_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'tg_outreach_sequence_variants_updated_at'
  ) then
    create trigger tg_outreach_sequence_variants_updated_at
      before update on outreach_sequence_variants
      for each row
      execute procedure touch_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'tg_leads_updated_at'
  ) then
    create trigger tg_leads_updated_at
      before update on leads
      for each row
      execute procedure touch_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'tg_drafts_updated_at'
  ) then
    create trigger tg_drafts_updated_at
      before update on drafts
      for each row
      execute procedure touch_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'tg_settings_updated_at'
  ) then
    create trigger tg_settings_updated_at
      before update on settings
      for each row
      execute procedure touch_updated_at();
  end if;
end$$;
