import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../components/LoginLauncher.tsx", import.meta.url), "utf8");

assert.doesNotMatch(
  source,
  /\.toLocaleString\(\)/,
  "LoginLauncher timestamp rendering must not depend on server/client default locales"
);

assert.match(
  source,
  /timeZone: "UTC"/,
  "LoginLauncher timestamp rendering should use an explicit timezone for hydration stability"
);

console.log("loginLauncherTimestamp regression checks passed");
