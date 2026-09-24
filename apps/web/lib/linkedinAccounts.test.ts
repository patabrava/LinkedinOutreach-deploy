import test from "node:test";
import assert from "node:assert/strict";

import { formatLinkedinAccountIdentity } from "./linkedinAccountIdentity";

test("shows the linked account name and assigned manual browser slot", () => {
  assert.equal(
    formatLinkedinAccountIdentity({
      label: "Primary",
      display_name: "Katharina Hoffmann",
      email: "katharina.hoffmann@degura.de",
      browser_slot: 1,
    }),
    "Katharina Hoffmann · Browser 1",
  );
  assert.equal(
    formatLinkedinAccountIdentity({
      label: "Sandra Molinero",
      display_name: "Sandra Molinero",
      email: "sandra.molinero@degura.de",
      browser_slot: 2,
    }),
    "Sandra Molinero · Browser 2",
  );
});
