import test from "node:test";
import assert from "node:assert/strict";

import { remoteBrowserPath } from "./linkedinBrowserControl";

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
