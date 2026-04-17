#!/usr/bin/env bash
set -euo pipefail

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required for this smoke test" >&2
  exit 1
fi

npx @playwright/cli attach default >/dev/null
npx @playwright/cli --session=default goto https://deguraleads.de/ >/dev/null

save_button_present=$(npx @playwright/cli --session=default eval '() => Boolean(document.querySelector("button") && [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Save Sequence")))')
if [[ "$save_button_present" != *"true"* ]]; then
  echo "Save Sequence button not found on mission control page" >&2
  exit 1
fi

echo "sequence editor smoke test passed"
