# Supabase Setup

Steps to create the database and security baseline.

1) Create a new Supabase project in the dashboard.  
2) Open the SQL editor and run `supabase/schema.sql` to create extensions, enums, tables, triggers, and policies.  
3) Confirm pg_cron and vector extensions are enabled in Database » Extensions.  
4) Ensure Row Level Security is on for all tables (it is enabled inside the script).  
5) Optional: test connectivity from TablePlus/DBeaver using the project connection string.  

Environment variables (used by Python workers and Next.js):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side only)
- `SUPABASE_ANON_KEY` (client-side)

Suggested additional keys:

- `OPENAI_API_KEY`
- `DAILY_SEND_LIMIT` (for sender safety constraints)
