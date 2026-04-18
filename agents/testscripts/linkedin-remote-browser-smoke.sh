#!/usr/bin/env bash
set -euo pipefail

TMPDIR="$(mktemp -d -t linkedin-remote-browser-smoke.XXXXXX)"

WEB_BASE_URL="${LINKEDIN_WEB_BASE_URL:-http://127.0.0.1:3000}"
BROWSER_ENDPOINT="${LINKEDIN_BROWSER_ENDPOINT:-http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote}"
LOGIN_API_URL="${LINKEDIN_LOGIN_API_URL:-${WEB_BASE_URL%/}/api/login}"
REMOTE_SESSION_API_URL="${LINKEDIN_REMOTE_SESSION_API_URL:-${WEB_BASE_URL%/}/api/linkedin-auth/remote-session}"
EXPECTED_BROWSER_PATH="/linkedin-browser/vnc.html?autoconnect=1&resize=remote"

AUTH_HEADERS=()
if [ -n "${API_OPERATOR_TOKEN:-}" ]; then
  AUTH_HEADERS=(-H "Authorization: Bearer ${API_OPERATOR_TOKEN}")
elif [ -n "${API_AUTH_HEADER:-}" ]; then
  AUTH_HEADERS=(-H "${API_AUTH_HEADER}")
fi

cleanup() {
  rm -rf "${TMPDIR}"
}
trap cleanup EXIT

request_json() {
  local name="$1"
  local method="$2"
  local url="$3"
  local payload="${4:-}"
  local headers_file="${TMPDIR}/${name}.headers"
  local body_file="${TMPDIR}/${name}.body"
  local http_code

  if [ -n "${payload}" ]; then
    http_code="$(curl -sS -D "${headers_file}" -o "${body_file}" -w '%{http_code}' \
      "${AUTH_HEADERS[@]}" \
      -H 'content-type: application/json' \
      -X "${method}" \
      --data "${payload}" \
      "${url}")"
  else
    http_code="$(curl -sS -D "${headers_file}" -o "${body_file}" -w '%{http_code}' \
      "${AUTH_HEADERS[@]}" \
      -X "${method}" \
      "${url}")"
  fi

  RESPONSE_HTTP_CODE="${http_code}"
  RESPONSE_BODY_FILE="${body_file}"
}

assert_json_field() {
  local body_file="$1"
  local expect_success="$2"
  local expected_browser_path="${3:-}"
  python3 - "${body_file}" "${expect_success}" "${expected_browser_path}" <<'PY'
import json
import sys
from pathlib import Path

body_path = Path(sys.argv[1])
expect_success = sys.argv[2] == "1"
expected_browser_path = sys.argv[3]
payload = json.loads(body_path.read_text(encoding="utf-8"))

if expect_success:
    if payload.get("ok") is not True:
        raise SystemExit(f"expected ok=true, got {payload!r}")
    if expected_browser_path and payload.get("browserUrl") != expected_browser_path:
        raise SystemExit(
            f"expected browserUrl={expected_browser_path!r}, got {payload.get('browserUrl')!r}"
        )
    status = payload.get("status")
    if not isinstance(status, dict):
        raise SystemExit(f"expected status object, got {payload!r}")
    if not isinstance(payload.get("message"), str) or not payload["message"].strip():
        raise SystemExit(f"expected non-empty message, got {payload!r}")
else:
    if payload.get("ok") is not False:
        raise SystemExit(f"expected ok=false, got {payload!r}")
    if not isinstance(payload.get("error"), str) or not payload["error"].strip():
        raise SystemExit(f"expected non-empty error, got {payload!r}")
PY
}

assert_remote_session_json() {
  local body_file="$1"
  local expected_action="$2"
  python3 - "${body_file}" "${expected_action}" <<'PY'
import json
import sys
from pathlib import Path

body_path = Path(sys.argv[1])
expected_action = sys.argv[2]
payload = json.loads(body_path.read_text(encoding="utf-8"))

if payload.get("action") != expected_action:
    raise SystemExit(f"expected action={expected_action!r}, got {payload!r}")

status_code = payload.get("status")
if payload.get("ok") is True:
    if not isinstance(status_code, dict):
        raise SystemExit(f"expected status object on success, got {payload!r}")
    if not isinstance(payload.get("message"), str) or not payload["message"].strip():
        raise SystemExit(f"expected non-empty message on success, got {payload!r}")
else:
    if not isinstance(status_code, dict):
        raise SystemExit(f"expected status object on failure, got {payload!r}")
    if not isinstance(payload.get("message"), str) or not payload["message"].strip():
        raise SystemExit(f"expected non-empty message on failure, got {payload!r}")
    if not isinstance(payload.get("error"), str) or not payload["error"].strip():
        raise SystemExit(f"expected non-empty error on failure, got {payload!r}")
PY
}

echo "Checking remote browser endpoint: ${BROWSER_ENDPOINT}"
browser_headers="${TMPDIR}/browser.headers"
browser_body="${TMPDIR}/browser.body"
browser_code="$(curl -sS -D "${browser_headers}" -o "${browser_body}" -w '%{http_code}' "${BROWSER_ENDPOINT}")"
case "${browser_code}" in
  2*|3*) ;;
  *)
    echo "expected browser endpoint to respond with 2xx/3xx, got ${browser_code}" >&2
    exit 1
    ;;
esac

echo "Checking login API: ${LOGIN_API_URL}"
request_json "login" "POST" "${LOGIN_API_URL}" "{}"
case "${RESPONSE_HTTP_CODE}" in
  200)
    assert_json_field "${RESPONSE_BODY_FILE}" 1 "${EXPECTED_BROWSER_PATH}"
    ;;
  401|403)
    assert_json_field "${RESPONSE_BODY_FILE}" 0
    ;;
  *)
    echo "expected /api/login to return 200 with operator auth or 401/403 without it, got ${RESPONSE_HTTP_CODE}" >&2
    cat "${RESPONSE_BODY_FILE}" >&2
    exit 1
    ;;
esac

echo "Checking remote-session sync API: ${REMOTE_SESSION_API_URL}"
request_json "remote-session-sync" "POST" "${REMOTE_SESSION_API_URL}" '{"action":"sync"}'
case "${RESPONSE_HTTP_CODE}" in
  200|500)
    assert_remote_session_json "${RESPONSE_BODY_FILE}" "sync"
    ;;
  401|403)
    assert_json_field "${RESPONSE_BODY_FILE}" 0
    ;;
  *)
    echo "expected /api/linkedin-auth/remote-session sync to return 200, 500, 401, or 403, got ${RESPONSE_HTTP_CODE}" >&2
    cat "${RESPONSE_BODY_FILE}" >&2
    exit 1
    ;;
esac

echo "Checking remote-session reset API: ${REMOTE_SESSION_API_URL}"
request_json "remote-session-reset" "POST" "${REMOTE_SESSION_API_URL}" '{"action":"reset"}'
case "${RESPONSE_HTTP_CODE}" in
  200|500)
    assert_remote_session_json "${RESPONSE_BODY_FILE}" "reset"
    ;;
  401|403)
    assert_json_field "${RESPONSE_BODY_FILE}" 0
    ;;
  *)
    echo "expected /api/linkedin-auth/remote-session reset to return 200, 500, 401, or 403, got ${RESPONSE_HTTP_CODE}" >&2
    cat "${RESPONSE_BODY_FILE}" >&2
    exit 1
    ;;
esac

echo "linkedin remote browser smoke test passed"
