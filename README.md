# LinkedinOutreach Monorepo

Workspace that hosts the web UI, scraping/sending workers, and MCP agent.

## Structure
- `apps/web` – Next.js Mission Control UI (draft feed, editor, CSV import).
- `workers/scraper` – Playwright scraper that enriches `NEW` leads.
- `workers/sender` – Playwright sender that types and sends `APPROVED` drafts.
- `mcp-server` – FastMCP server exposing tools + an agent loop that writes drafts.
- `supabase` – Schema and bootstrap scripts.

## Quick start
1) **Supabase**: Project created (see `SUPABASE_SETUP.md`). Schema is in `supabase/schema.sql` with pg_cron/vector enabled.  
2) **Env**: Copy `.env.example` files to `.env` in each service and fill keys (Supabase + OpenAI).  
3) **Scraper**: `cd workers/scraper && pip install -e . && python -m playwright install chromium`. Login once with `playwright codegen --save-storage=auth.json https://www.linkedin.com/login`, then `python scraper.py` to enrich `NEW` leads.  
4) **Agent (MCP)**: `cd mcp-server && pip install -e . && python run_agent.py` to turn ENRICHED leads into drafts.  
5) **Sender**: `cd workers/sender && pip install -e . && python -m playwright install chromium` then `python sender.py` to type/send APPROVED drafts (obeys `DAILY_SEND_LIMIT`). `monitor.py` flags replies.  
6) **Web**: `npm install` then `npm run dev:web` to open Mission Control (draft feed, approve/reject/regenerate, CSV importer).  

## Hostinger single-VPS deployment
This repo is designed to run on one Hostinger VPS with one public reverse proxy and the app services behind it.

Assumptions for the VPS:
- Enough RAM for Next.js, the Python services, and Chromium at the same time.
- Persistent disk for `workers/scraper/auth.json`, `workers/sender/auth.json`, and `.logs/`.
- Only the reverse proxy ports (`80` and `443`) are public. The app services stay internal, with the web app on its normal `3000` listener behind the proxy.
- Service names stay aligned with the launcher/compose terms: `web`, `agent`, `sender`, `sender_message_only`, and `sender_followup`.

Production launch commands:
```bash
docker compose build
docker compose up -d
docker compose logs -f --tail=200 web agent sender sender_message_only sender_followup
docker compose restart web agent sender sender_message_only sender_followup
```

Rollback is a redeploy of the last known good revision:
```bash
git checkout HEAD~1
docker compose up -d --build
```

Rollout phases:
1. Public-first: the web UI is exposed on the domain, the workers stay private, and Supabase holds state.
2. Auth gate later: add Supabase login, then gate the UI routes and any privileged actions before wider access.

### Run everything at once
After completing the setup steps above (including environment variables and Playwright login), you can launch the scraper, MCP agent, sender, and Mission Control UI together:

```bash
./run_all.sh
```

Logs are written to `.logs/` and the script stops all processes when you press `Ctrl+C`.

## Automation targets
- Cron suggestion: scraper every 2h, agent hourly, sender every 15m during 09:00–17:00 M–F.
- Deploy: Supabase (cloud), UI on Vercel, workers on a VPS with Docker Compose (persistent browser).

## CSV importer format
- Accepted columns (case-insensitive): `linkedin_url` (required), `first_name`, `last_name`, `company_name`.  
- Aliases: `LinkedIn`, `linkedin`; `Company`/`company`/`organization_name`.  
- Extra columns are ignored. Duplicates are deduped by `linkedin_url`.
