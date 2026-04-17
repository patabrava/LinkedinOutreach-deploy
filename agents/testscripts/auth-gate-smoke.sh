#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${PORT:-4010}"
LOG_FILE="$(mktemp -t linkedin-auth-smoke.XXXXXX.log)"
SERVER_PID=""

cleanup() {
  if [[ -n "${SERVER_PID}" ]]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT

cd "${ROOT}/apps/web"
env \
  NEXT_PUBLIC_SUPABASE_URL= \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= \
  NEXT_PUBLIC_SUPABASE_ANON_KEY= \
  SUPABASE_URL= \
  SUPABASE_SERVICE_ROLE_KEY= \
  npm run dev -- --hostname 127.0.0.1 --port "${PORT}" >"${LOG_FILE}" 2>&1 &
SERVER_PID="$!"

for _ in {1..60}; do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

root_headers="$(curl -sS -D - -o /dev/null "http://127.0.0.1:${PORT}/" | tr -d '\r')"
printf '%s\n' "${root_headers}"

if ! printf '%s\n' "${root_headers}" | grep -Eq '^HTTP/.* 30[27] '; then
  echo "expected / to redirect when auth env is missing or auth is enforced" >&2
  exit 1
fi

if ! printf '%s\n' "${root_headers}" | grep -Ei '^location: .*/login'; then
  echo "expected redirect to /login" >&2
  exit 1
fi

login_html="$(curl -fsS "http://127.0.0.1:${PORT}/login")"
if ! printf '%s\n' "${login_html}" | grep -Fq "AUTH GATE NOT CONFIGURED"; then
  echo "expected login page to surface the auth misconfiguration" >&2
  exit 1
fi
