#!/usr/bin/env bash
set -euo pipefail

cd /app

PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
PLAYWRIGHT_BROWSERS_SEED_PATH="${PLAYWRIGHT_BROWSERS_SEED_PATH:-/ms-playwright-seed}"

mkdir -p /app/.logs /data/scraper /data/sender /data/home "$PLAYWRIGHT_BROWSERS_PATH" "$PLAYWRIGHT_BROWSERS_SEED_PATH"
ln -sfn /data/scraper/auth.json /app/workers/scraper/auth.json
ln -sfn /data/sender/auth.json /app/workers/sender/auth.json

if [ -z "$(ls -A "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null)" ]; then
  if [ "$PLAYWRIGHT_BROWSERS_SEED_PATH" != "$PLAYWRIGHT_BROWSERS_PATH" ] && [ -n "$(ls -A "$PLAYWRIGHT_BROWSERS_SEED_PATH" 2>/dev/null)" ]; then
    echo "[playwright] hydrating runtime browser cache from image seed"
    cp -a "$PLAYWRIGHT_BROWSERS_SEED_PATH"/. "$PLAYWRIGHT_BROWSERS_PATH"/
  else
    echo "[playwright] browser cache missing, installing chromium into $PLAYWRIGHT_BROWSERS_PATH"
    /app/workers/scraper/venv/bin/python -m playwright install chromium
  fi
fi

export HOME="${HOME:-/data/home}"
export WEB_RUNTIME="${WEB_RUNTIME:-prod}"
export PLAYWRIGHT_BROWSERS_PATH
export PLAYWRIGHT_BROWSERS_SEED_PATH

if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  exec ./run_all.sh --all
fi

echo "[entrypoint] Supabase worker env missing; starting web UI only."
exec ./run_all.sh --web
