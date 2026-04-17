#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR="$(mktemp -d -t credential-key-smoke.XXXXXX)"
KEY_FILE="${TMPDIR}/linkedin_credentials.key"
TS_OUT="${TMPDIR}/ts"

cleanup() {
  rm -rf "${TMPDIR}"
}
trap cleanup EXIT

mkdir -p "${TS_OUT}"
unset LINKEDIN_CREDENTIALS_KEY || true
export LINKEDIN_CREDENTIALS_KEY_FILE="${KEY_FILE}"

if [ -x "${ROOT}/apps/web/node_modules/.bin/tsc" ]; then
  "${ROOT}/apps/web/node_modules/.bin/tsc" \
    --pretty false \
    --module commonjs \
    --target es2020 \
    --esModuleInterop \
    --moduleResolution node \
    --skipLibCheck \
    --outDir "${TS_OUT}" \
    "${ROOT}/apps/web/lib/credentialCrypto.ts"
else
  npm --prefix "${ROOT}/apps/web" exec -- tsc \
    --pretty false \
    --module commonjs \
    --target es2020 \
    --esModuleInterop \
    --moduleResolution node \
    --skipLibCheck \
    --outDir "${TS_OUT}" \
    "${ROOT}/apps/web/lib/credentialCrypto.ts"
fi

PAYLOAD="$(
  node - "${TS_OUT}/credentialCrypto.js" <<'NODE'
const modulePath = process.argv[2];
const { encryptLinkedinPassword } = require(modulePath);
const payload = encryptLinkedinPassword("smoke-password");
process.stdout.write(JSON.stringify(payload));
NODE
)"

if [ ! -s "${KEY_FILE}" ]; then
  echo "expected shared credential key file to be created at ${KEY_FILE}" >&2
  exit 1
fi

DECRYPTED="$(
  python3 - "${ROOT}/workers" "${PAYLOAD}" <<'PY'
import json
import sys

sys.path.insert(0, sys.argv[1])
from credential_crypto import decrypt_password

payload = json.loads(sys.argv[2])
plain = decrypt_password(payload)
if plain != "smoke-password":
    raise SystemExit(f"expected decrypted password to round-trip, got {plain!r}")
print(plain)
PY
)"

printf 'credential key smoke test passed: %s\n' "${DECRYPTED}"
