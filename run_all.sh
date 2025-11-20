#!/bin/bash
# Launch scraper, MCP agent, sender, and web UI together.

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

# Scraper (processes NEW leads and exits when queue is empty)
# Use -u to disable Python stdout buffering so logs stream immediately to file.
if [ -f "$ROOT_DIR/workers/scraper/auth.json" ]; then
  run_service "scraper" "cd '$ROOT_DIR/workers/scraper' && source venv/bin/activate && while true; do python -u scraper.py; sleep 15; done"
else
  echo "[scraper] ⏭ Skipping start (missing workers/scraper/auth.json)."
fi

# MCP agent (turns ENRICHED leads into drafts)
run_service "agent" "cd '$ROOT_DIR/mcp-server' && source venv/bin/activate && while true; do python -u run_agent.py; sleep 15; done"

# Sender (types/sends APPROVED drafts)
if [ -f "$ROOT_DIR/workers/sender/auth.json" ]; then
  run_service "sender" "cd '$ROOT_DIR/workers/sender' && source venv/bin/activate && while true; do python -u sender.py; sleep 20; done"
else
  echo "[sender] ⏭ Skipping start (missing workers/sender/auth.json)."
fi

# Web UI (Mission Control dashboard)
run_service "web" "cd '$ROOT_DIR' && npm run dev:web"

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
