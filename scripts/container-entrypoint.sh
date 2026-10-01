#!/usr/bin/env bash
set -euo pipefail

cd /app

PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
PLAYWRIGHT_BROWSERS_SEED_PATH="${PLAYWRIGHT_BROWSERS_SEED_PATH:-/ms-playwright-seed}"

mkdir -p /app/.logs /data/scraper /data/sender /data/home "$PLAYWRIGHT_BROWSERS_PATH" "$PLAYWRIGHT_BROWSERS_SEED_PATH"
ln -sfn /data/scraper/auth.json /app/workers/scraper/auth.json
ln -sfn /data/sender/auth.json /app/workers/sender/auth.json

if [ "$PLAYWRIGHT_BROWSERS_SEED_PATH" != "$PLAYWRIGHT_BROWSERS_PATH" ] && [ -n "$(ls -A "$PLAYWRIGHT_BROWSERS_SEED_PATH" 2>/dev/null)" ]; then
  echo "[playwright] reconciling runtime browser cache with image seed"
  # Persistent caches may contain only an older Playwright browser revision.
  # Merge missing revision files on every boot, including nonempty volumes.
  cp -an "$PLAYWRIGHT_BROWSERS_SEED_PATH"/. "$PLAYWRIGHT_BROWSERS_PATH"/
elif [ -z "$(ls -A "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null)" ]; then
  echo "[playwright] browser cache missing, installing chromium into $PLAYWRIGHT_BROWSERS_PATH"
  /app/workers/scraper/venv/bin/python -m playwright install chromium
fi

export HOME="${HOME:-/data/home}"
export WEB_RUNTIME="${WEB_RUNTIME:-prod}"
export START_BACKGROUND_WORKERS="${START_BACKGROUND_WORKERS:-0}"
export PLAYWRIGHT_BROWSERS_PATH
export PLAYWRIGHT_BROWSERS_SEED_PATH

if [ "$START_BACKGROUND_WORKERS" = "1" ]; then
  if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
    echo "[entrypoint] START_BACKGROUND_WORKERS=1 requires Supabase worker credentials." >&2
    exit 1
  fi
  echo "[entrypoint] Explicit worker opt-in enabled; starting web and background workers."
  exec ./run_all.sh --all
fi

echo "[entrypoint] Background workers disabled; starting web UI only."
exec ./run_all.sh --web
