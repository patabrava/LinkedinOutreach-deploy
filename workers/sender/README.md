# Sender Worker

Simulates human typing to send approved drafts on LinkedIn.

## Setup
- Install dependencies: `pip install -e .` inside this folder plus Playwright browsers (`python -m playwright install chromium`).  
- Reuse the `auth.json` created for the scraper (copy it here or point to it).  
- Copy `../.env.example` to `.env` and set Supabase keys and `DAILY_SEND_LIMIT`.

## Usage
- `python sender.py` pulls one `APPROVED` lead, opens the profile, composes the message with per-character typing, and marks the row as `SENT`.

Limits to respect:
- Skips execution after the `DAILY_SEND_LIMIT`.
- Handles 1st-degree vs connect flow vs locked profiles (warns and skips).
