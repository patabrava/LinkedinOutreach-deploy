#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR="$(mktemp -d -t auth-callback-origin.XXXXXX)"
OUT_DIR="${TMPDIR}/out"

cleanup() {
  rm -rf "${TMPDIR}"
}
trap cleanup EXIT

mkdir -p "${OUT_DIR}"

if [ -x "${ROOT}/apps/web/node_modules/.bin/tsc" ]; then
  "${ROOT}/apps/web/node_modules/.bin/tsc" \
    --pretty false \
    --module commonjs \
    --target es2020 \
    --esModuleInterop \
    --moduleResolution node \
    --skipLibCheck \
    --outDir "${OUT_DIR}" \
    "${ROOT}/apps/web/lib/siteOrigin.ts"
else
  npm --prefix "${ROOT}/apps/web" exec -- tsc \
    --pretty false \
    --module commonjs \
    --target es2020 \
    --esModuleInterop \
    --moduleResolution node \
    --skipLibCheck \
    --outDir "${OUT_DIR}" \
    "${ROOT}/apps/web/lib/siteOrigin.ts"
fi

node - "${OUT_DIR}/siteOrigin.js" <<'NODE'
const modulePath = process.argv[2];

process.env.NODE_ENV = "production";
delete process.env.NEXT_PUBLIC_SITE_URL;
delete process.env.NEXT_PUBLIC_APP_URL;

const { resolveAuthRedirectOrigin } = require(modulePath);
const prodMissing = resolveAuthRedirectOrigin("https://0.0.0.0:3000");
if (prodMissing !== "") {
  throw new Error(`expected empty production origin when env is missing, got ${prodMissing}`);
}

process.env.NODE_ENV = "development";
const devFallback = resolveAuthRedirectOrigin("https://degureads.de");
if (devFallback !== "http://localhost:3000") {
  throw new Error(`expected dev fallback to use localhost, got ${devFallback}`);
}

process.env.NEXT_PUBLIC_SITE_URL = "https://degureads.de";
const prodEnv = resolveAuthRedirectOrigin("https://0.0.0.0:3000");
if (prodEnv !== "https://degureads.de") {
  throw new Error(`expected production env origin to win, got ${prodEnv}`);
}

console.log("auth callback origin smoke test passed");
NODE
