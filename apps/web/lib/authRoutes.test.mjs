import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const module = { exports: {} };
const code = ts.transpileModule(readFileSync(new URL("./auth.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
vm.runInNewContext(code, {
  module, exports: module.exports,
  require: () => ({}),
});
const { isProtectedRoute, isAuthPublicRoute } = module.exports;

test("only the three analytics report routes are public", () => {
  for (const path of ["/analytics", "/analytics/regular", "/analytics/sales-navigator"]) {
    assert.equal(isProtectedRoute(path), false, path);
    assert.equal(isAuthPublicRoute(path), true, path);
  }
});

test("operational pages and unrecognized analytics descendants remain protected", () => {
  for (const path of ["/", "/leads", "/leads/123", "/upload", "/followups", "/settings", "/analytics/private", "/analytics/regular/export", "/analytics-other"]) {
    assert.equal(isProtectedRoute(path), true, path);
    assert.equal(isAuthPublicRoute(path), false, path);
  }
});
