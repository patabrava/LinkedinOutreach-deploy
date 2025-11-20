# Scraper Worker

Minimal Playwright scraper that enriches leads in Supabase.

## Setup
- Install Python 3.10+ and run `pip install -e .` inside this folder.  
- Install Playwright browsers once: `python -m playwright install chromium`.  
- Create `auth.json` by running `playwright codegen --save-storage=auth.json https://www.linkedin.com/login` and logging in manually.  
- Copy `.env.example` to `.env` and fill Supabase keys.

## Usage
- `python scraper.py` enriches up to 10 `NEW` leads: it fetches profile + recent activity, writes JSON, and moves status to `ENRICHED`.

Safety measures: random waits (3.5–7.2s) and Bezier-like mouse wiggles before actions to reduce bot signatures.
