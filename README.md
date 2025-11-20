# LinkedinOutreach Monorepo

Workspace that hosts the web UI, scraping/sending workers, and MCP agent.

## Structure
- `apps/web` – Next.js Mission Control UI (draft feed, editor, CSV import).
- `workers/scraper` – Playwright scraper that enriches `NEW` leads.
- `workers/sender` – Playwright sender that types and sends `APPROVED` drafts.
- `mcp-server` – FastMCP server exposing tools + an agent loop that writes drafts.
- `supabase` – Schema and bootstrap scripts.

## Quick start
1) **Supabase**: Create a project, run `supabase/schema.sql`, and copy env values.  
2) **Env**: Copy `workers/.env.example` and `apps/web/.env.example` to real `.env` files with Supabase + OpenAI keys.  
3) **Scraper**: `cd workers/scraper && pip install -e . && python -m playwright install chromium`. Login once with `playwright codegen --save-storage=auth.json https://www.linkedin.com/login`, then `python scraper.py`.  
4) **Agent**: `cd mcp-server && pip install -e . && python run_agent.py` to fill drafts from ENRICHED leads.  
5) **Sender**: `cd workers/sender && pip install -e . && python sender.py` (respects daily send limit).  
6) **Web**: `npm install` (root uses workspaces) then `npm run dev:web` to launch the UI.

## Automation targets
- Cron suggestion: scraper every 2h, agent hourly, sender every 15m during 09:00–17:00 M–F.
- Deploy: Supabase (cloud), UI on Vercel, workers on a VPS with Docker Compose (persistent browser).
