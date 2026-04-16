# Sender Worker

Simulates human typing to send approved drafts on LinkedIn.

## Setup
- Install dependencies: `pip install -e .` inside this folder plus Playwright browsers (`python -m playwright install chromium`).  
- Reuse the `auth.json` created for the scraper (copy it here or point to it).  
- Copy `../.env.example` to `.env` and set Supabase keys and `DAILY_SEND_LIMIT`.

## Usage
- `python sender.py` pulls one `APPROVED` lead, opens the profile, composes the message with per-character typing, and marks the row as `SENT`.
- `python sender.py --message-only` checks connect-only leads, detects accepted invites, sends sequence step 1, and schedules step 2/3 followups.
- `python sender.py --followup` processes due `APPROVED` followups, first recovering stale `PROCESSING` rows older than 45 minutes.

Production polling loop (15 minutes):

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach/workers/sender
while true; do python sender.py --message-only; sleep 900; done
```

Follow-up polling loop (15 minutes):

```bash
cd /Users/camiloecheverri/Documents/AI/Linkedin\ Scraper/LinkedinOutreach/workers/sender
while true; do python sender.py --followup; sleep 900; done
```

Limits to respect:
- Skips execution after the `DAILY_SEND_LIMIT`.
- Handles 1st-degree vs connect flow vs locked profiles (warns and skips).
