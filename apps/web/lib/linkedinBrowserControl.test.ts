import test from "node:test";
import assert from "node:assert/strict";

import { remoteBrowserPath, remoteBrowserProbeUrl } from "./linkedinBrowserControl";

test("routes each noVNC websocket through its account-scoped proxy path", () => {
  assert.equal(
    remoteBrowserPath(1),
    "/linkedin-browser-1/vnc.html?autoconnect=1&resize=remote&path=linkedin-browser-1%2Fwebsockify",
  );
  assert.equal(
    remoteBrowserPath(2),
    "/linkedin-browser-2/vnc.html?autoconnect=1&resize=remote&path=linkedin-browser-2%2Fwebsockify",
  );
});

test("probes protected account browser paths through their internal Docker services", () => {
  assert.equal(
    remoteBrowserProbeUrl(1, remoteBrowserPath(1)),
    "http://linkedin-browser-1:6080/vnc.html",
  );
  assert.equal(
    remoteBrowserProbeUrl(2, remoteBrowserPath(2)),
    "http://linkedin-browser-2:6080/vnc.html",
  );
});
