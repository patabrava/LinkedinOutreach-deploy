# LinkedIn Outreach Database Migration Summary

## Status: ✅ COMPLETED (Schema Only)

### Target Database
- **Project Name**: LINKEDIN
- **Project ID**: pbwiyglvnhrtfcnmviir
- **Region**: eu-west-1
- **URL**: https://pbwiyglvnhrtfcnmviir.supabase.co

### Migrated Components

#### 1. Database Schema ✅
All tables created with full column sets:

| Table | Columns | Description |
|-------|---------|-------------|
| `leads` | 20 columns | Main leads table with all status fields, outreach mode, timestamps |
| `drafts` | 10 columns | Message drafts linked to leads |
| `settings` | 5 columns | Application settings |
| `followups` | 16 columns | Follow-up messages with type tracking (REPLY/NUDGE) |

#### 2. Enum Types ✅
- `lead_status`: NEW, ENRICHED, PROCESSING, ENRICH_FAILED, DRAFT_READY, APPROVED, MESSAGE_ONLY_READY, MESSAGE_ONLY_APPROVED, SENT, CONNECT_ONLY_SENT, CONNECTED, REPLIED, REJECTED, FAILED
- `followup_status`: PENDING_REVIEW, APPROVED, PROCESSING, SENT, SKIPPED, FAILED, RETRY_LATER

#### 3. Extensions ✅
- pgcrypto
- pg_cron
- vector

#### 4. Indexes ✅
- idx_leads_status
- idx_drafts_lead_id
- idx_followups_status
- idx_followups_processing_started
- idx_followups_lead_status
- idx_followups_type
- idx_followups_last_message_from

#### 5. Triggers ✅
- tg_leads_updated_at
- tg_drafts_updated_at
- tg_settings_updated_at
- tg_followups_updated_at

#### 6. RLS Policies ✅
Currently set to permissive (`true`) for testing. **Should be tightened before production**:
```sql
-- Recommended production policies:
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role')
```

#### 7. Configuration Files Updated ✅
- `apps/web/.env` - Updated with new Supabase credentials
- `workers/.env.example` - Updated with new Supabase credentials

### Data Migration
⚠️ **NOT COMPLETED** - Source database URL (ohsdswytudocxrgdcawc.supabase.co) is not accessible. The project may have been deleted or the URL has changed.

**To migrate data manually:**
1. Export data from your old project using Supabase Dashboard (Table Editor → Export)
2. Import data into the new project using the SQL Editor or CSV upload
3. Or use pg_dump/psql if you have direct database access

### API Keys

#### Publishable Key (Anon)
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBid2l5Z2x2bmhydGZjbm12aWlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NjQ3NDUsImV4cCI6MjA4NjM0MDc0NX0.ZGr-q1ezQN1uj3NlkBw6_SS54ejy1SEhGRGKdw9U3ss
```

#### Service Role Key
⚠️ **Get this from the Supabase Dashboard**:
https://supabase.com/dashboard/project/pbwiyglvnhrtfcnmviir/settings/api

**IMPORTANT**: Never commit the service role key to git! Add it to:
- `workers/.env` (create this file from `.env.example`)
- Production environment variables

### Testing

All database operations tested and verified:
- ✅ Connection established
- ✅ Leads CRUD operations
- ✅ Drafts CRUD operations
- ✅ Followups CRUD operations
- ✅ Settings read operations
- ✅ RLS policies functional

### Security Recommendations

1. **Tighten RLS Policies** before production:
   ```sql
   -- For workers using service_role key
   CREATE POLICY "service_role_access" ON leads
     FOR ALL
     USING (auth.role() = 'service_role')
     WITH CHECK (auth.role() = 'service_role');
   ```

2. **Enable Row Level Security** on all tables (already done)

3. **Store service_role key securely**:
   - Use environment variables
   - Never commit to version control
   - Rotate keys periodically

4. **Set search path** on the touch_updated_at function:
   ```sql
   ALTER FUNCTION touch_updated_at() SET search_path = public;
   ```

### Next Steps

1. ⬜ Get service_role key from Supabase Dashboard
2. ⬜ Update `workers/.env` with service_role key
3. ⬜ Migrate data from old database (if needed)
4. ⬜ Test web app connection to new database
5. ⬜ Test workers connection to new database
6. ⬜ Tighten RLS policies before production

### Files Modified

- `apps/web/.env`
- `workers/.env.example`

### Files Created

- `MIGRATION_SUMMARY.md` (this file)
