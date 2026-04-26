import test from "node:test";
import assert from "node:assert/strict";

import { renderSequence } from "./sequenceRender";

const lead = {
  first_name: "Sven",
  last_name: "Müller",
  company_name: "Acme GmbH",
};

test("substitutes double-curly tokens", () => {
  assert.equal(
    renderSequence("Hi {{first_name}} at {{company_name}}", lead),
    "Hi Sven at Acme GmbH",
  );
});

test("substitutes single-curly tokens", () => {
  assert.equal(renderSequence("Hi {first_name}", lead), "Hi Sven");
});

test("substitutes bracket tokens", () => {
  assert.equal(renderSequence("Hi [first_name]", lead), "Hi Sven");
});

test("derives full_name from first + last when not provided", () => {
  assert.equal(renderSequence("{{full_name}}", lead), "Sven Müller");
});

test("missing fields render as empty string", () => {
  assert.equal(renderSequence("Hi {{first_name}}", { last_name: "X" }), "Hi ");
});

test("preserves text around tokens verbatim", () => {
  assert.equal(
    renderSequence("Greetings, {{first_name}}!  See you.", lead),
    "Greetings, Sven!  See you.",
  );
});

test("leaves unknown tokens untouched (validator's job to reject)", () => {
  assert.equal(renderSequence("Hi {{recent_post}}", lead), "Hi {{recent_post}}");
});
