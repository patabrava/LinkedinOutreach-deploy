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

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  linkedin_url text not null unique,
  first_name text,
  last_name text,
  company_name text,
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

-- Helpful indexes
create index if not exists idx_leads_status on leads (status);
create index if not exists idx_drafts_lead_id on drafts (lead_id);

-- Row Level Security
alter table leads enable row level security;
alter table drafts enable row level security;
alter table settings enable row level security;

-- Allow authenticated users full access to all tables
do $$
begin
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
end$$;

-- Trigger to keep updated_at fresh
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end
$$;

do $$
begin
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
