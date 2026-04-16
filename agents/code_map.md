# Code Map (Current System)

## Top-Level Entrypoints
- Web UI: `apps/web/app/page.tsx`, `apps/web/app/followups/page.tsx`, `apps/web/app/leads/page.tsx`
- Web action orchestrator: `apps/web/app/actions.ts`
- Scraper worker: `workers/scraper/scraper.py`
- Sender worker: `workers/sender/sender.py`
- Draft agent: `mcp-server/run_agent.py`
- Followup draft agent: `mcp-server/run_followup_agent.py`
- Local multi-service launcher: `run_all.sh`

## `apps/web/app/actions.ts`
### Orchestration actions
- `triggerInboxScan()`
  - Spawns `workers/scraper/scraper.py --inbox --run`
- `triggerFollowupSender()`
  - Spawns `workers/sender/sender.py --followup`
- `sendLeadNow(leadId, outreachMode)`
  - Spawns `sender.py --lead-id <id>` or adds `--message-only` for connect-only mode
- `sendAllApproved(outreachMode)`
  - Spawns `sender.py` (connect+message) or `sender.py --message-only` (connect-only)

### Followup review APIs
- `fetchFollowups(statuses, limit)`
- `generateFollowupDraft(followupId)`
  - Calls `mcp-server/run_followup_agent.py` with serialized context
- `approveFollowup(followupId, draftText)`
  - Sets followup `APPROVED`, then triggers followup sender
- `approveAndSendAllFollowups()`
- `skipFollowup(followupId)`
- `retryFollowup(followupId)`
- `stopFollowups(leadId)`

### Draft approval APIs
- `approveDraft(input)`
  - Sets lead to `APPROVED` or `MESSAGE_ONLY_APPROVED` by mode
- `approveAndSendAllDrafts(outreachMode)`

## `workers/scraper/scraper.py`
### Mode dispatcher
- `parse_args()` supports:
  - `--run`
  - `--inbox`
  - `--mode enrich|connect_only`
  - `--limit`
- Main branch:
  - inbox mode -> `inbox_mode(limit)`
  - enrich mode -> `main(limit, mode)`

### Inbox scanning path
- `inbox_mode()`
  - auth + browser lifecycle
  - calls `inbox_scan()`
- `inbox_scan(context, client, limit)`
  - pulls `SENT` leads
  - applies cooldown/backoff
  - `open_profile_and_get_last_message()` per lead
  - classifies REPLY vs NUDGE
  - `upsert_followup_for_reply()` inserts followup and updates lead metrics
- `extract_last_message_from_conversation()`
  - selector-based extraction of sender/text/outbound signal

### Enrichment path (legacy from this map perspective)
- Fetches `NEW` leads and stores profile/activity JSON for agent drafting.

## `workers/sender/sender.py`
### CLI modes
- Default: outbound from `leads.status='APPROVED'`
- `--followup`: outbound from `followups.status='APPROVED'`
- `--message-only`: connect-only acceptance checker and auto-send path

### Shared support
- Auth/session:
  - `open_browser()`, `is_logged_in()`, `login_with_credentials()`, `ensure_linkedin_auth()`
- LinkedIn UI surface:
  - `open_message_surface(page)` -> returns `message | connect_note | connect`
- Typing/delivery:
  - `send_message(page, message, surface, draft)`

### Default outbound flow
- Fetch leads: `fetch_approved_leads()`
- Lock state: `mark_processing()`
- Send one: `process_one()`
- Finalize: `mark_sent()` / retry-or-fail branch in `main()`

### Followup flow
- Queue pull and due filter: `fetch_approved_followups()`
- Build/sanitize: `build_followup_message()` / `sanitize_followup_message()`
- Send one: `process_followup_one()`
- Finalize:
  - `mark_followup_sent()`
  - `mark_followup_skipped()`
  - `mark_followup_failed()`

### Message-only (connect-only accepted) flow
- Eligible leads: `fetch_message_only_leads()`
- Per lead: `process_message_only_one()`
  - pending-invite detection
  - connected check via Message link
  - sends `sequence.first_message`
  - updates lead acceptance/send metadata
  - schedules nudges via `schedule_nudge_followup()`

## `mcp-server/run_agent.py`
- Pulls generation candidates from Supabase tools.
- Builds prompt from profile + activity + example rotation.
- Calls OpenAI and writes drafts for review/send.

## `mcp-server/run_followup_agent.py`
- Generates followup draft text with explicit scenario branching:
  - `last_message_from='lead'` => reply response
  - `last_message_from='us'` => nudge
- Enforces sanitization + 300-char constraints.
- Output is persisted by web action.

## `run_all.sh`
- Starts selected local services in loops:
  - `--agent`: `run_agent.py`
  - `--sender`: `sender.py`
  - `--message-only`: `sender.py --message-only` every 900s
  - `--web`: Next.js dev web
- Scraper is intentionally on-demand via UI (not auto-looped here).

## Status/Queue Coupling Map
- Lead send queue source: `leads.status='APPROVED'`
- Connect-only queue source: `leads.status in [CONNECT_ONLY_SENT, CONNECTED, MESSAGE_ONLY_READY, MESSAGE_ONLY_APPROVED]`
- Reply/nudge followup queue source: `followups.status='PENDING_REVIEW'` -> `APPROVED`
- Followup sender queue source: `followups.status='APPROVED'` + due filter (`next_send_at`)

## Critical File Relationships
- `actions.ts` -> process spawn -> `sender.py` / `scraper.py`
- `scraper.py --inbox` -> creates `followups`
- `FollowupsList.tsx` -> review actions -> `actions.ts`
- `actions.ts generateFollowupDraft` -> `run_followup_agent.py`
- `sender.py --followup` -> final followup delivery + terminal statuses
