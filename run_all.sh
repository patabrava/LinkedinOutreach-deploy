#!/bin/bash
# Launch workspace services (agent, sender, web). Scraper remains on-demand via UI.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/.logs"
mkdir -p "$LOG_DIR"

SERVICE_PIDS=()
TAIL_PIDS=()
CLEANED_UP=0

load_envs() {
  # Export env vars for Python services if not already present. Priority:
  # 1) $ROOT_DIR/.env
  # 2) $ROOT_DIR/mcp-server/.env
  # 3) $ROOT_DIR/workers/.env
  # 4) $ROOT_DIR/apps/web/.env.local
  local candidates=(
    "$ROOT_DIR/.env"
    "$ROOT_DIR/mcp-server/.env"
    "$ROOT_DIR/workers/.env"
    "$ROOT_DIR/apps/web/.env.local"
  )
  for f in "${candidates[@]}"; do
    if [ -f "$f" ]; then
      # shellcheck disable=SC1090
      set -a; . "$f"; set +a
      echo "[env] loaded $f"
    fi
  done
}

check_auth() {
  local missing=0
  if [ ! -f "$ROOT_DIR/workers/scraper/auth.json" ]; then
    echo "[scraper] ⚠ Missing auth.json at workers/scraper/auth.json. Login once via:"
    echo "[scraper]   playwright codegen --save-storage=auth.json https://www.linkedin.com/login"
    missing=1
  fi
  if [ ! -f "$ROOT_DIR/workers/sender/auth.json" ]; then
    echo "[sender] ⚠ Missing auth.json at workers/sender/auth.json. Copy it from scraper or generate via codegen."
    missing=1
  fi
  return $missing
}

cleanup() {
  if [ "$CLEANED_UP" -eq 1 ]; then
    return
  fi
  CLEANED_UP=1
  printf '\n🧹 Stopping all services...\n'

  for pid in "${TAIL_PIDS[@]}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done

  for pid in "${SERVICE_PIDS[@]}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done

  echo "✅ All processes terminated."
}

trap cleanup INT TERM EXIT

load_envs

usage() {
  cat <<'EOF'
Usage: ./run_all.sh [--web] [--agent] [--sender] [--all]

Defaults to launching only the web UI to reduce LinkedIn surface area. Add flags to
opt-in other workers:
  --web       Start the Next.js UI
  --agent     Start the MCP agent (generates drafts from ENRICHED leads)
  --sender    Start the sender (connect + send APPROVED drafts)
  --all       Start all of the above
EOF
}

START_WEB=0
START_AGENT=0
START_SENDER=0

if [ $# -eq 0 ]; then
  # Safer default: only start the web UI unless explicitly requested.
  START_WEB=1
else
  while [ $# -gt 0 ]; do
    case "$1" in
      --web) START_WEB=1 ;;
      --agent) START_AGENT=1 ;;
      --sender) START_SENDER=1 ;;
      --all) START_WEB=1; START_AGENT=1; START_SENDER=1 ;;
      -h|--help) usage; exit 0 ;;
      *)
        echo "Unknown option: $1"
        usage
        exit 1
        ;;
    esac
    shift
  done
fi

run_service() {
  local name="$1"
  local cmd="$2"
  local logfile="$LOG_DIR/${name}.log"

  # Truncate previous logs so each run is fresh
  : >"$logfile"

  echo "🚀 Starting $name (log: $logfile)"
  bash -c "$cmd" >>"$logfile" 2>&1 &
  local service_pid=$!
  SERVICE_PIDS+=("$service_pid")
  echo "   ↳ PID $service_pid"

  # Show logs from the beginning and follow updates. Prefix each line with the service name.
  tail -n +1 -F "$logfile" | sed "s/^/[$name] /" &
  local tail_pid=$!
  TAIL_PIDS+=("$tail_pid")
}

# Scraper is triggered manually via the "Start Enrichment" button in the UI
# It calls /api/enrich which spawns scraper.py --run on-demand
echo "[scraper] ⏭ Scraper runs on-demand via Start Enrichment button (not auto-started)"

# MCP agent (turns ENRICHED leads into drafts)
if [ "$START_AGENT" -eq 1 ]; then
  run_service "agent" "cd '$ROOT_DIR/mcp-server' && source venv/bin/activate && while true; do python -u run_agent.py; sleep 15; done"
else
  echo "[agent] ⏭ Skipping (enable with --agent or --all)."
fi

# Sender (connects + sends APPROVED drafts)
if [ "$START_SENDER" -eq 1 ]; then
  if [ -f "$ROOT_DIR/workers/sender/auth.json" ]; then
    run_service "sender" "cd '$ROOT_DIR/workers/sender' && source venv/bin/activate && while true; do python -u sender.py; sleep 20; done"
  else
    echo "[sender] ⏭ Skipping start (missing workers/sender/auth.json)."
  fi
else
  echo "[sender] ⏭ Skipping (enable with --sender or --all)."
fi

# Web UI (Mission Control dashboard)
if [ "$START_WEB" -eq 1 ]; then
  run_service "web" "cd '$ROOT_DIR' && npm run dev:web"
else
  echo "[web] ⏭ Skipping (enable with --web or --all)."
fi

cat <<'EOF'
📟 Services launched:
  - Scraper  (logs: .logs/scraper.log)
  - Agent    (logs: .logs/agent.log)
  - Sender   (logs: .logs/sender.log)
  - Web UI   (logs: .logs/web.log)

Press Ctrl+C to stop everything.
EOF

# Keep script running so trap handles cleanup
if [ "${#SERVICE_PIDS[@]}" -gt 0 ]; then
  for pid in "${SERVICE_PIDS[@]}"; do
    wait "$pid" || true
  done
fi
