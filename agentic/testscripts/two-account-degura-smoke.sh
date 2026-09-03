#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

python3 -m py_compile \
  workers/degura_campaign.py \
  workers/scraper/auth.py workers/scraper/scraper.py workers/sender/sender.py \
  mcp-server/run_followup_agent.py
PYTHONPATH=workers python3 -m unittest \
  workers.test_degura_campaign workers.test_degura_seed workers.test_thread_reader
(cd workers/sender && PYTHONPATH=..:. python3 -m unittest \
  test_message_only_queue.py test_nudge_gate.py test_sales_navigator_routing.py \
  test_sequence_messages.py test_sequence_render.py)
(cd mcp-server && PYTHONPATH=../workers:. python3 -m unittest test_reply_drafting.py)

(cd apps/web && npx --yes tsx --test \
  lib/analyticsFunnel.test.ts lib/analyticsPageRange.test.ts \
  lib/deguraCampaign.test.ts lib/deguraAnalytics.test.ts \
  lib/deguraPerformanceReport.test.ts lib/followupReplyIntent.test.ts \
  lib/followupVisibility.test.ts lib/senderMessageOnlyHealth.test.ts \
  lib/linkedinBrowserControl.test.ts \
  lib/sequenceConnectNote.test.ts lib/sequenceContent.test.ts \
  lib/sequenceRender.test.ts lib/settingsData.test.ts lib/workerControl.test.ts)
(cd apps/web && node --test lib/*.test.mjs)
(cd apps/web && npx tsc --noEmit)
(cd apps/web && npm run build -- --no-lint)

bash -n run_all.sh scripts/container-entrypoint.sh
compose_file="$(mktemp)"
trap 'rm -f "$compose_file"' EXIT
sed '/^[[:space:]]*env_file:/,+1d' docker-compose.yml >"$compose_file"
docker compose --project-directory "$ROOT_DIR" -f "$compose_file" config --quiet
grep -q 'START_BACKGROUND_WORKERS: "0"' docker-compose.yml
grep -q 'START_BACKGROUND_WORKERS=1' scripts/container-entrypoint.sh
grep -q 'exec ./run_all.sh --web' scripts/container-entrypoint.sh

if ! docker info >/dev/null 2>&1; then
  echo "BLOCKED: Docker daemon is required for disposable PostgreSQL migration verification." >&2
  exit 2
fi

browser_profile_root="$(mktemp -d)"
mkdir -p "$browser_profile_root/profile"
ln -s stale-container-host "$browser_profile_root/profile/SingletonLock"
ln -s /tmp/stale-chromium.sock "$browser_profile_root/profile/SingletonSocket"
docker build -q -f docker/playwright-remote/Dockerfile -t degura-browser-test . >/dev/null
docker run --rm -d --name degura-browser-test \
  -v "$browser_profile_root:/data/browser" \
  -e CHROME_USER_DATA_DIR=/data/browser/profile degura-browser-test >/dev/null
cleanup_browser() {
  docker stop degura-browser-test >/dev/null 2>&1 || true
  find "$browser_profile_root" -depth -delete >/dev/null 2>&1 || true
}
trap 'cleanup_browser; rm -f "$compose_file"' EXIT
for _ in $(seq 1 20); do
  docker exec degura-browser-test bash -c "</dev/tcp/127.0.0.1/9222" >/dev/null 2>&1 && break
  sleep 1
done
docker exec degura-browser-test bash -c "</dev/tcp/127.0.0.1/9222"
test ! -e "$browser_profile_root/profile/SingletonLock" || \
  test "$(readlink "$browser_profile_root/profile/SingletonLock")" != "stale-container-host"
cleanup_browser

docker run --rm -d --name degura-postgres-test \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=degura postgres:16-alpine >/dev/null
cleanup_db() { docker stop degura-postgres-test >/dev/null 2>&1 || true; }
trap 'cleanup_db; cleanup_browser; rm -f "$compose_file"' EXIT
for _ in $(seq 1 30); do
  docker exec degura-postgres-test \
    psql -v ON_ERROR_STOP=1 -U postgres -d degura -tAc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec degura-postgres-test \
  psql -v ON_ERROR_STOP=1 -U postgres -d degura -tAc 'SELECT 1' >/dev/null
docker exec -i degura-postgres-test psql -v ON_ERROR_STOP=1 -U postgres -d degura <agents/testscripts/two-account-degura-db-fixture.sql
docker exec -i degura-postgres-test psql -v ON_ERROR_STOP=1 -U postgres -d degura <supabase/migrations/019_add_two_account_campaign.sql
docker exec -i degura-postgres-test psql -v ON_ERROR_STOP=1 -U postgres -d degura <supabase/migrations/020_seed_degura_campaign.sql
docker exec -i degura-postgres-test psql -v ON_ERROR_STOP=1 -U postgres -d degura <supabase/migrations/021_import_mixed_degura_campaign.sql
docker exec -i degura-postgres-test psql -v ON_ERROR_STOP=1 -U postgres -d degura <supabase/migrations/022_linkedin_account_display_compatibility.sql
docker exec -i degura-postgres-test psql -v ON_ERROR_STOP=1 -U postgres -d degura <supabase/migrations/019_add_two_account_campaign.sql
docker exec -i degura-postgres-test psql -v ON_ERROR_STOP=1 -U postgres -d degura <supabase/migrations/020_seed_degura_campaign.sql
docker exec -i degura-postgres-test psql -v ON_ERROR_STOP=1 -U postgres -d degura <supabase/migrations/021_import_mixed_degura_campaign.sql
docker exec -i degura-postgres-test psql -v ON_ERROR_STOP=1 -U postgres -d degura <supabase/migrations/022_linkedin_account_display_compatibility.sql
docker exec -i degura-postgres-test psql -v ON_ERROR_STOP=1 -U postgres -d degura <agents/testscripts/two-account-degura-db.sql

echo "PASS: two-account DEGURA non-sending regression block"
