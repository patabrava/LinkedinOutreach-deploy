#!/usr/bin/env python3
"""Focused tests for sequence-owned sender message resolution."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from sender import fetch_lead_by_id, load_sequence_messages


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def execute(self):
        return self


class FakeQuery:
    def __init__(self, rows, table_name):
        self.rows = rows
        self.table_name = table_name

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        return FakeResponse(self.rows.get(self.table_name, []))


class FakeClient:
    def __init__(self, rows):
        self.rows = rows

    def table(self, table_name):
        return FakeQuery(self.rows, table_name)


class SelectFallbackQuery:
    def __init__(self, row):
        self.row = row
        self.selected = ""

    def select(self, selected, *_args, **_kwargs):
        self.selected = selected
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        if "csv_batch_id" in self.selected:
            raise RuntimeError("column leads.csv_batch_id does not exist")
        return FakeResponse([self.row])


class SelectFallbackClient:
    def __init__(self, row):
        self.row = row

    def table(self, table_name):
        assert table_name == "leads"
        return SelectFallbackQuery(self.row)


class LoadSequenceMessagesTest(unittest.TestCase):
    def test_connect_note_is_hydrated_from_sequence_row(self):
        client = FakeClient(
            {
                "outreach_sequences": [
                    {
                        "id": 7,
                        "connect_note": "Hi {{first_name}}",
                        "first_message": "Hello {{first_name}}",
                        "second_message": "",
                        "third_message": "",
                        "followup_interval_days": 3,
                        "is_active": True,
                        "created_at": "2026-04-24T00:00:00Z",
                    }
                ],
                "settings": [],
            }
        )
        lead = {"sequence_id": 7, "first_name": "Mia", "last_name": "Lopez", "company_name": "ACME"}

        result = load_sequence_messages(client, lead)

        self.assertEqual(result["connect_note"], "Hi Mia")

    def test_fetch_lead_by_id_fallback_preserves_sequence_fields(self):
        client = SelectFallbackClient(
            {
                "id": "lead-1",
                "sequence_id": 4,
                "batch_id": 21,
                "outreach_mode": "connect_only",
            }
        )

        result = fetch_lead_by_id(client, "lead-1")

        self.assertEqual(result["sequence_id"], 4)
        self.assertEqual(result["batch_id"], 21)


if __name__ == "__main__":
    unittest.main()
