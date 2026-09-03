import assert from "node:assert/strict";
import test from "node:test";

import { getSequenceEditorContent, getSequenceVariantOptions } from "./sequenceContent";

const family = {
  id: 7,
  name: "DEGURA A · Rentenreform",
  connect_note: "",
  first_message: "",
  second_message: "",
  third_message: "",
  followup_interval_days: 3,
  variants: [
    {
      id: 101,
      variant_key: 1,
      connect_note: "A1 invite",
      first_message: "A1 message 1",
      second_message: "A1 message 2",
      third_message: "A1 message 3",
      is_active: true,
    },
    {
      id: 102,
      variant_key: 2,
      connect_note: "A2 invite",
      first_message: "A2 message 1",
      second_message: "A2 message 2",
      third_message: "A2 message 3",
      is_active: true,
    },
  ],
};

test("managed sequence content is read from its active variants", () => {
  assert.deepEqual(getSequenceVariantOptions(family), [
    { id: 101, variant_key: 1 },
    { id: 102, variant_key: 2 },
  ]);
  assert.deepEqual(getSequenceEditorContent(family, 2), {
    variantId: 102,
    variantKey: 2,
    name: "DEGURA A · Rentenreform",
    connect_note: "A2 invite",
    first_message: "A2 message 1",
    second_message: "A2 message 2",
    third_message: "A2 message 3",
    followup_interval_days: 3,
  });
});

test("legacy sequences keep using their base message fields", () => {
  assert.deepEqual(getSequenceEditorContent({
    ...family,
    variants: [],
    connect_note: "legacy invite",
    first_message: "legacy message 1",
    second_message: "legacy message 2",
    third_message: "legacy message 3",
  }), {
    variantId: null,
    variantKey: null,
    name: "DEGURA A · Rentenreform",
    connect_note: "legacy invite",
    first_message: "legacy message 1",
    second_message: "legacy message 2",
    third_message: "legacy message 3",
    followup_interval_days: 3,
  });
});
