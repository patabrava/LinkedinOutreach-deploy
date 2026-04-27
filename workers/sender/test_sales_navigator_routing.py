#!/usr/bin/env python3
"""Tests for Sales Navigator sender routing helpers."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from sender import (
    MESSAGE_ONLY_PROCESSING_STATUSES,
    connect_only_invite_limit_active,
    build_sales_navigator_subject,
    _is_message_only_candidate,
    mark_connect_only_limit_reached,
    mark_message_only_processing,
    normalize_linkedin_profile_url,
    strip_sales_navigator_signature,
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

    def is_(self, key, value):
        self.filters.append(("is", key, value))
        return self

    def in_(self, key, values):
        self.filters.append(("in", key, list(values)))
        return self

    def gte(self, key, value):
        self.filters.append(("gte", key, value))
        return self

    def order(self, key, desc=False):
        self.filters.append(("order", key, desc))
        return self

    def limit(self, value):
        self.filters.append(("limit", value))
        return self

    def contains(self, key, value):
        self.filters.append(("contains", key, value))
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
        sent_at_filter = next((f for f in self.filters if f[:2] == ("is", "sent_at")), None)
        if not id_filter or id_filter[2] != lead["id"]:
            return FakeResponse([])
        if status_filter and lead["status"] not in status_filter[2]:
            return FakeResponse([])
        if sent_at_filter and sent_at_filter[2] == "null" and lead.get("sent_at") is not None:
            return FakeResponse([])
        lead.update(self.payload or {})
        return FakeResponse([dict(lead)])


class FakeClient:
    def __init__(self, lead):
        self.lead = dict(lead)
        self.calls = []

    def table(self, table_name):
        return FakeQuery(self, table_name)


class FakeLimitQuery:
    def __init__(self, client):
        self.client = client
        self.filters = []

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def gte(self, key, value):
        self.filters.append(("gte", key, value))
        return self

    def order(self, key, desc=False):
        self.filters.append(("order", key, desc))
        return self

    def limit(self, value):
        self.filters.append(("limit", value))
        return self

    def contains(self, key, value):
        self.filters.append(("contains", key, value))
        return self

    def execute(self):
        self.client.calls.append(self.filters)
        if any(f[:2] == ("eq", "status") and f[2] == "FAILED" for f in self.filters):
            return FakeResponse(self.client.failed_rows)
        if any(f[0] == "contains" for f in self.filters):
            return FakeResponse(self.client.paused_rows)
        return FakeResponse([])


class FakeLimitClient:
    def __init__(self, failed_rows=None, paused_rows=None):
        self.failed_rows = failed_rows or []
        self.paused_rows = paused_rows or []
        self.calls = []

    def table(self, _table_name):
        return FakeLimitQuery(self)


class SalesNavigatorRoutingTest(unittest.TestCase):
    def test_normalize_linkedin_profile_url_removes_query_and_trailing_slash(self):
        result = normalize_linkedin_profile_url(
            "http://www.linkedin.com/in/marcel-ohlendorf-42335a197/?miniProfileUrn=abc"
        )

        self.assertEqual(result, "https://www.linkedin.com/in/marcel-ohlendorf-42335a197")

    def test_build_sales_navigator_subject_uses_sales_navigator_subject_copy(self):
        subject = build_sales_navigator_subject(
            {
                "first_name": "Marcel",
                "last_name": "Ohlendorf",
                "company_name": "Degura",
            },
            "Hi Marcel,\n\nfreut mich, dass wir uns hier vernetzen.\n\nIch bin Katharina.",
        )

        self.assertEqual(subject, "Kurze Frage zu deiner bAV")

    def test_build_sales_navigator_subject_stays_stable_without_message(self):
        subject = build_sales_navigator_subject({"first_name": "Marcel", "company_name": "Degura"})

        self.assertEqual(subject, "Kurze Frage zu deiner bAV")

    def test_strip_sales_navigator_signature_removes_manual_closing_only(self):
        body = (
            "Hi Marina,\n\n"
            "freut mich, dass wir uns hier vernetzen.\n\n"
            "Viele Grüße,\nKatharina"
        )

        self.assertEqual(
            strip_sales_navigator_signature(body),
            "Hi Marina,\n\nfreut mich, dass wir uns hier vernetzen.",
        )

    def test_strip_sales_navigator_signature_keeps_non_signature_body(self):
        body = "Hi Marina,\n\nfreut mich, dass wir uns hier vernetzen."

        self.assertEqual(strip_sales_navigator_signature(body), body)

    def test_mark_message_only_processing_locks_only_eligible_status(self):
        lead = {"id": "lead-1", "status": "CONNECTED"}
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertTrue(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls[0]["filters"][1], ("in", "status", list(MESSAGE_ONLY_PROCESSING_STATUSES)))

    def test_mark_message_only_processing_locks_invite_sent_lead_even_if_status_is_new(self):
        lead = {
            "id": "lead-1",
            "status": "NEW",
            "sent_at": None,
            "connection_sent_at": "2026-04-26T00:00:00Z",
        }
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertTrue(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls[0]["filters"][1], ("is", "sent_at", "null"))

    def test_mark_message_only_processing_skips_sent_lead(self):
        lead = {"id": "lead-1", "status": "SENT"}
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertFalse(result)
        self.assertEqual(client.lead["status"], "SENT")

    def test_connect_only_invite_limit_active_detects_recent_failed_limit(self):
        client = FakeLimitClient(
            failed_rows=[{"id": "lead-1", "error_message": "LinkedIn weekly invite limit reached"}],
        )

        result = connect_only_invite_limit_active(client)

        self.assertIsNotNone(result)

    def test_connect_only_invite_limit_active_detects_paused_new_lead(self):
        client = FakeLimitClient(paused_rows=[{"id": "lead-1"}])

        result = connect_only_invite_limit_active(client)

        self.assertIsNotNone(result)

    def test_mark_connect_only_limit_reached_persists_pause_metadata(self):
        lead = {"id": "lead-1", "profile_data": {"meta": {"existing": True}}}
        client = FakeClient(lead)

        mark_connect_only_limit_reached(client, lead, "LinkedIn weekly invite limit reached")

        self.assertEqual(client.lead["status"], "FAILED")
        self.assertEqual(client.lead["error_message"], "LinkedIn weekly invite limit reached")
        self.assertTrue(client.lead["profile_data"]["meta"]["connect_only_limit_reached"])
        self.assertEqual(
            client.lead["profile_data"]["meta"]["connect_only_limit_reason"],
            "LinkedIn weekly invite limit reached",
        )
        self.assertIn("connect_only_limit_at", client.lead["profile_data"]["meta"])
        self.assertTrue(client.lead["profile_data"]["meta"]["existing"])

    def test_message_only_candidate_accepts_invite_sent_timestamp(self):
        self.assertTrue(
            _is_message_only_candidate(
                {
                    "status": "NEW",
                    "connection_sent_at": "2026-04-26T00:00:00Z",
                    "sent_at": None,
                }
            )
        )

    def test_message_only_candidate_rejects_unstarted_new_lead(self):
        self.assertFalse(
            _is_message_only_candidate(
                {
                    "status": "NEW",
                    "connection_sent_at": None,
                    "sent_at": None,
                }
            )
        )


if __name__ == "__main__":
    unittest.main()
