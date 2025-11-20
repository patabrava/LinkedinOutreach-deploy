#!/bin/bash
# Launch scraper, MCP agent, sender, and web UI together.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/.logs"
mkdir -p "$LOG_DIR"

SERVICE_PIDS=()
TAIL_PIDS=()

cleanup() {
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
run_service "scraper" "cd '$ROOT_DIR/workers/scraper' && source venv/bin/activate && python -u scraper.py"

# MCP agent (turns ENRICHED leads into drafts)
run_service "agent" "cd '$ROOT_DIR/mcp-server' && source venv/bin/activate && python -u run_agent.py"

# Sender (types/sends APPROVED drafts)
run_service "sender" "cd '$ROOT_DIR/workers/sender' && source venv/bin/activate && python -u sender.py"

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
