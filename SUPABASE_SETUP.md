# Supabase Project Setup - LinkedIn Outreach

## Project Information

**Project Name:** linkedin-outreach  
**Project ID:** ohsdswytudocxrgdcawc  
**Region:** eu-central-1  
**Status:** ACTIVE_HEALTHY  
**Created:** 2025-11-20

## Database Credentials

Add these to your `.env` files in the following locations:
- `mcp-server/.env`
- `workers/scraper/.env`
- `workers/sender/.env`
- `apps/web/.env.local`

```bash
# Supabase Configuration
SUPABASE_URL=https://ohsdswytudocxrgdcawc.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oc2Rzd3l0dWRvY3hyZ2RjYXdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjM2MjM1MjksImV4cCI6MjA3OTE5OTUyOX0.E_pKsC_jNbvv_Lvq24AafXvQmVW-TnUA9RVhb-hASGY

# Service Role Key (Server-side only - DO NOT expose to client)
# Get this from: https://supabase.com/dashboard/project/ohsdswytudocxrgdcawc/settings/api
SUPABASE_SERVICE_ROLE_KEY=<get-from-dashboard>

# Optional: OpenAI API Key (for MCP agent)
OPENAI_API_KEY=<your-openai-key>

# Optional: Daily send limit for sender worker
DAILY_SEND_LIMIT=20
```

## Database Schema

The following schema has been successfully applied:

### Tables Created:
1. **leads** - Stores LinkedIn profile information and enrichment status
   - Columns: id, linkedin_url, first_name, last_name, company_name, status, sent_at, profile_data, recent_activity, ai_tags, created_at, updated_at
   - Status enum: NEW, ENRICHED, PROCESSING, DRAFT_READY, APPROVED, SENT, REPLIED, REJECTED
   - RLS enabled with authenticated user policies

2. **drafts** - Stores generated message drafts for each lead
   - Columns: id, lead_id, opener, body_type, body_text, cta_type, cta_text, final_message, created_at, updated_at
   - Foreign key to leads(id) with cascade delete
   - RLS enabled with authenticated user policies

3. **settings** - Stores application configuration
   - Columns: id, key, value (jsonb), created_at, updated_at
   - RLS enabled with authenticated user policies

### Extensions Enabled:
- ✅ **pgcrypto** - Cryptographic functions (for UUID generation)
- ✅ **pg_cron** - Job scheduler for PostgreSQL
- ✅ **vector** - Vector data type and similarity search

### Features:
- Automatic `updated_at` timestamp triggers on all tables
- Indexes on `leads.status` and `drafts.lead_id` for query performance
- Row Level Security (RLS) enabled on all tables
- Authenticated user policies for full CRUD access

## Dashboard Access

- **Project Dashboard:** https://supabase.com/dashboard/project/ohsdswytudocxrgdcawc
- **SQL Editor:** https://supabase.com/dashboard/project/ohsdswytudocxrgdcawc/sql
- **Table Editor:** https://supabase.com/dashboard/project/ohsdswytudocxrgdcawc/editor
- **API Settings:** https://supabase.com/dashboard/project/ohsdswytudocxrgdcawc/settings/api

## Next Steps

1. **Get Service Role Key:**
   - Go to: https://supabase.com/dashboard/project/ohsdswytudocxrgdcawc/settings/api
   - Copy the `service_role` key (keep it secret!)
   - Add it to your `.env` files as `SUPABASE_SERVICE_ROLE_KEY`

2. **Create Environment Files:**
   ```bash
   # For MCP Server
   cp mcp-server/.env.example mcp-server/.env
   
   # For Workers
   cp workers/.env.example workers/scraper/.env
   cp workers/.env.example workers/sender/.env
   
   # For Web App
   cp apps/web/.env.example apps/web/.env.local
   ```

3. **Update all `.env` files** with the credentials above

4. **Test the connection:**
   ```bash
   cd mcp-server
   python -c "from tools import supabase_client; print(supabase_client().table('leads').select('*').execute())"
   ```

## Hostinger VPS rollout

When you move the app from local development to the single Hostinger VPS, keep the same Supabase project and use the VPS only as the runtime host.

VPS assumptions:
- The machine has enough RAM to run Next.js, the Python workers, and Chromium together.
- Persistent disk is available for LinkedIn auth state and logs.
- Only the reverse proxy ports (`80` and `443`) are public. The app services remain internal, with the web app on `3000` behind the proxy.
- The runtime service names stay aligned with the launcher/compose terms: `web`, `agent`, `sender`, `sender_message_only`, and `sender_followup`.

Production launch flow:
```bash
docker compose build
docker compose up -d
docker compose logs -f --tail=200 web agent sender sender_message_only sender_followup
docker compose restart web agent sender sender_message_only sender_followup
```

Rollback:
```bash
git checkout HEAD~1
docker compose up -d --build
```

Rollout phases:
1. Public-first: expose the web UI on the domain so the app can be used over the web while the workers stay private on the VPS.
2. Auth gate later: add Supabase login and gate the web UI and privileged actions before opening the app to broader use.

## Security Notes

- ⚠️ **NEVER** commit `.env` files to git
- ⚠️ The `service_role` key bypasses RLS - only use server-side
- ⚠️ The `anon` key is safe for client-side use (respects RLS policies)
- ✅ All tables have RLS enabled
- ✅ Only authenticated users can access data
