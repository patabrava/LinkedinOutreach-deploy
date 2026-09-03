#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${CHROME_USER_DATA_DIR}"

# Chromium writes host-specific singleton links into persistent profiles. A
# recreated container has a different hostname, so those links must not survive
# the container boundary or Chromium exits with "profile in use".
find "${CHROME_USER_DATA_DIR}" -maxdepth 1 \
  \( -name 'SingletonCookie' -o -name 'SingletonLock' -o -name 'SingletonSocket' \) \
  -delete

CHROMIUM_BIN=""

if [[ -x /ms-playwright/chromium/chrome-linux/chrome ]]; then
  CHROMIUM_BIN="/ms-playwright/chromium/chrome-linux/chrome"
else
  CHROMIUM_BIN="$(find /ms-playwright /usr/bin -type f \
    \( -path '*/chrome-linux/chrome' -o -name 'chromium' -o -name 'chromium-browser' \) \
    2>/dev/null | sort | head -n 1 || true)"
fi

if [[ -z "${CHROMIUM_BIN}" ]]; then
  echo "chromium executable not found" >&2
  exit 1
fi

exec "${CHROMIUM_BIN}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-features=Translate,AutomationControlled \
  --no-sandbox \
  --disable-setuid-sandbox \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --user-data-dir="${CHROME_USER_DATA_DIR}" \
  "${LINKEDIN_LOGIN_URL}"
