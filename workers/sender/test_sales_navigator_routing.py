#!/usr/bin/env python3
"""Tests for Sales Navigator sender routing helpers."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from sender import (
    MESSAGE_ONLY_PROCESSING_STATUSES,
    build_sales_navigator_subject,
    mark_message_only_processing,
    normalize_linkedin_profile_url,
)


class FakeResponse:
    def __init__(self, data=None, count=None):
        self.data = data or []
        self.count = count

    def execute(self):
        return self


class FakeQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.filters = []
        self.payload = None

    def update(self, payload):
        self.payload = payload
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def in_(self, key, values):
        self.filters.append(("in", key, list(values)))
        return self

    def execute(self):
        self.client.calls.append(
            {
                "table": self.table_name,
                "payload": self.payload,
                "filters": self.filters,
            }
        )
        lead = self.client.lead
        id_filter = next((f for f in self.filters if f[:2] == ("eq", "id")), None)
        status_filter = next((f for f in self.filters if f[:2] == ("in", "status")), None)
        if not id_filter or id_filter[2] != lead["id"]:
            return FakeResponse([])
        if status_filter and lead["status"] not in status_filter[2]:
            return FakeResponse([])
        lead.update(self.payload or {})
        return FakeResponse([dict(lead)])


class FakeClient:
    def __init__(self, lead):
        self.lead = dict(lead)
        self.calls = []

    def table(self, table_name):
        return FakeQuery(self, table_name)


class SalesNavigatorRoutingTest(unittest.TestCase):
    def test_normalize_linkedin_profile_url_removes_query_and_trailing_slash(self):
        result = normalize_linkedin_profile_url(
            "http://www.linkedin.com/in/marcel-ohlendorf-42335a197/?miniProfileUrn=abc"
        )

        self.assertEqual(result, "https://www.linkedin.com/in/marcel-ohlendorf-42335a197")

    def test_build_sales_navigator_subject_stays_fixed_when_name_available(self):
        subject = build_sales_navigator_subject(
            {
                "first_name": "Marcel",
                "last_name": "Ohlendorf",
                "company_name": "Degura",
            }
        )

        self.assertEqual(subject, "quotes outstation")

    def test_build_sales_navigator_subject_stays_fixed_without_name(self):
        subject = build_sales_navigator_subject({"company_name": "Degura"})

        self.assertEqual(subject, "quotes outstation")

    def test_mark_message_only_processing_locks_only_eligible_status(self):
        lead = {"id": "lead-1", "status": "CONNECTED"}
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertTrue(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls[0]["filters"][1], ("in", "status", list(MESSAGE_ONLY_PROCESSING_STATUSES)))

    def test_mark_message_only_processing_skips_sent_lead(self):
        lead = {"id": "lead-1", "status": "SENT"}
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertFalse(result)
        self.assertEqual(client.lead["status"], "SENT")


if __name__ == "__main__":
    unittest.main()
