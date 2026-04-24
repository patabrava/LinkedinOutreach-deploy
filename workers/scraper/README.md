# Scraper Worker

Minimal Playwright scraper that enriches leads in Supabase.

## Setup
- Install Python 3.10+ and run `pip install -e .` inside this folder.  
- Install Playwright browsers once: `python -m playwright install chromium`.  
- Copy `.env.example` to `.env` and fill Supabase keys.
- In the web app, open **Settings → LinkedIn credentials** and save your LinkedIn login (email + password).  
  - These are only the saved login details. They do not by themselves mean LinkedIn is currently signed in.
  - The scraper also keeps a cached browser session in `auth.json`. If that file exists locally, Playwright can usually reuse it without logging in again.

## Usage
- `python scraper.py --run` enriches up to the remaining daily quota of `NEW` leads by default: it fetches profile + recent activity, writes JSON, and moves status to `ENRICHED`.
- If `auth.json` is missing, the worker needs a fresh LinkedIn login even if credentials were already saved in Settings. Saving credentials is setup; having a usable session is the separate readiness check.

Safety measures: random waits (3.5–7.2s) and Bezier-like mouse wiggles before actions to reduce bot signatures.
