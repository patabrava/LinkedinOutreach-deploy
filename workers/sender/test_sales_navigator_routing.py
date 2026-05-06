#!/usr/bin/env python3
"""Tests for Sales Navigator sender routing helpers."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from sender import (
    INVITE_RETRY_STATUSES,
    MESSAGE_ONLY_PROCESSING_STATUSES,
    classify_connect_only_surface,
    classify_connect_only_probe_surface,
    connect_only_invite_limit_active,
    fetch_invite_queue,
    fetch_message_only_leads,
    build_sales_navigator_subject,
    _is_invite_candidate,
    _is_message_only_candidate,
    mark_connect_only_limit_reached,
    mark_invite_processing,
    mark_message_only_processing,
    normalize_linkedin_profile_url,
    persist_invite_sent,
    promote_connect_only_to_connected,
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


class FakeErrorResponse:
    def __init__(self, error):
        self.data = []
        self.error = error

    def execute(self):
        return self


class FakeInvitePersistQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.filters = []
        self.payload = None
        self.selected = None

    def update(self, payload):
        self.payload = payload
        return self

    def select(self, fields):
        self.selected = fields
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def limit(self, value):
        self.filters.append(("limit", value))
        return self

    def execute(self):
        self.client.calls.append(
            {
                "table": self.table_name,
                "payload": self.payload,
                "selected": self.selected,
                "filters": list(self.filters),
            }
        )
        if self.client.error:
            return FakeErrorResponse(self.client.error)
        id_filter = next((f for f in self.filters if f[:2] == ("eq", "id")), None)
        if not id_filter or id_filter[2] != self.client.lead["id"]:
            return FakeResponse([])
        if self.payload is not None:
            self.client.lead.update(self.payload)
            if self.client.return_rows:
                return FakeResponse([dict(self.client.lead)])
            return FakeResponse([])
        return FakeResponse([dict(self.client.lead)])


class FakeInvitePersistClient:
    def __init__(self, lead, return_rows=True, error=None):
        self.lead = dict(lead)
        self.return_rows = return_rows
        self.error = error
        self.calls = []

    def table(self, table_name):
        return FakeInvitePersistQuery(self, table_name)


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


class FakeInviteQueueQuery:
    def __init__(self, client):
        self.client = client
        self.filters = []
        self.selected = None

    def select(self, fields):
        self.selected = fields
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def in_(self, key, values):
        self.filters.append(("in", key, list(values)))
        return self

    def is_(self, key, value):
        self.filters.append(("is", key, value))
        return self

    def limit(self, value):
        self.filters.append(("limit", value))
        return self

    def execute(self):
        self.client.calls.append({"selected": self.selected, "filters": list(self.filters)})
        return FakeResponse(self.client.rows)


class FakeInviteQueueClient:
    def __init__(self, rows):
        self.rows = list(rows)
        self.calls = []

    def table(self, _table_name):
        return FakeInviteQueueQuery(self)


class FakeMessageOnlyQuery:
    def __init__(self, client):
        self.client = client
        self.filters = []
        self.selected = None

    def select(self, fields):
        self.selected = fields
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def is_(self, key, value):
        self.filters.append(("is", key, value))
        return self

    def order(self, key, desc=False):
        self.filters.append(("order", key, desc))
        return self

    def limit(self, value):
        self.filters.append(("limit", value))
        return self

    def or_(self, value):
        self.filters.append(("or", value))
        return self

    def execute(self):
        self.client.calls.append(
            {
                "selected": self.selected,
                "filters": list(self.filters),
            }
        )
        return FakeResponse(self.client.rows)


class FakeMessageOnlyClient:
    def __init__(self, rows):
        self.rows = list(rows)
        self.calls = []

    def table(self, _table_name):
        return FakeMessageOnlyQuery(self)


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

    def test_strip_sales_navigator_signature_removes_single_line_closing(self):
        body = (
            "Hi Marina,\n\n"
            "freut mich, dass wir uns hier vernetzen.\n\n"
            "Viele Grüße, Katharina"
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

    def test_fetch_invite_queue_includes_failed_invite_leads_for_retry(self):
        client = FakeInviteQueueClient(
            [
                {"id": "lead-new", "status": "NEW", "outreach_mode": "connect_only", "profile_data": {}},
                {"id": "lead-failed", "status": "FAILED", "outreach_mode": "connect_only", "profile_data": {}},
            ]
        )

        rows = fetch_invite_queue(client, 10)

        self.assertEqual([row["id"] for row in rows], ["lead-new", "lead-failed"])
        self.assertIn(("in", "status", INVITE_RETRY_STATUSES), client.calls[0]["filters"])

    def test_mark_invite_processing_claims_failed_invite_lead_for_retry(self):
        lead = {"id": "lead-1", "status": "FAILED"}
        client = FakeClient(lead)

        result = mark_invite_processing(client, "lead-1")

        self.assertTrue(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls[0]["filters"][1], ("in", "status", INVITE_RETRY_STATUSES))

    def test_invite_candidate_accepts_failed_connect_only_without_connection_sent(self):
        self.assertTrue(
            _is_invite_candidate(
                {
                    "status": "FAILED",
                    "outreach_mode": "connect_only",
                    "connection_sent_at": None,
                    "sent_at": None,
                }
            )
        )

    def test_invite_candidate_rejects_failed_lead_after_connection_was_sent(self):
        self.assertFalse(
            _is_invite_candidate(
                {
                    "status": "FAILED",
                    "outreach_mode": "connect_only",
                    "connection_sent_at": "2026-05-06T10:00:00Z",
                    "sent_at": None,
                }
            )
        )

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

    def test_persist_invite_sent_moves_lead_to_connect_only_sent(self):
        lead = {"id": "lead-1", "status": "PROCESSING", "outreach_mode": "connect_only"}
        client = FakeInvitePersistClient(lead)

        persist_invite_sent(client, "lead-1", "connect_only")

        self.assertEqual(client.lead["status"], "CONNECT_ONLY_SENT")
        self.assertTrue(client.lead["connection_sent_at"])

    def test_persist_invite_sent_verifies_update_when_supabase_returns_no_rows(self):
        lead = {"id": "lead-1", "status": "PROCESSING", "outreach_mode": "connect_only"}
        client = FakeInvitePersistClient(lead, return_rows=False)

        persist_invite_sent(client, "lead-1", "connect_only")

        self.assertEqual(client.lead["status"], "CONNECT_ONLY_SENT")
        self.assertEqual(client.calls[1]["selected"], "id, status, connection_sent_at, outreach_mode")

    def test_persist_invite_sent_raises_on_supabase_error(self):
        lead = {"id": "lead-1", "status": "PROCESSING", "outreach_mode": "connect_only"}
        client = FakeInvitePersistClient(lead, error="status enum rejected")

        with self.assertRaises(RuntimeError):
            persist_invite_sent(client, "lead-1", "connect_only")

    def test_classify_connect_only_surface_prefers_message_surface(self):
        self.assertEqual(
            classify_connect_only_surface(
                message_button_count=1,
                message_link_count=0,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=0,
            ),
            "already_connected",
        )

    def test_classify_connect_only_surface_keeps_invite_flow_when_message_surface_is_absent(self):
        self.assertEqual(
            classify_connect_only_surface(
                message_button_count=0,
                message_link_count=0,
                invite_link_count=1,
                connect_button_count=0,
                more_button_count=0,
            ),
            "invite_available",
        )

    def test_connect_only_surface_classifier_returns_surface_exhausted_when_no_actions_exist(self):
        self.assertEqual(
            classify_connect_only_surface(
                message_button_count=0,
                message_link_count=0,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=0,
            ),
            "surface_exhausted",
        )

    def test_classify_connect_only_probe_surface_ignores_ambiguous_generic_message_link(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=1,
                connect_button_count=0,
                more_button_count=0,
                has_visible_connect_or_pending_state=True,
            ),
            "invite_available",
        )

    def test_classify_connect_only_probe_surface_treats_generic_message_without_connect_state_as_connected(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=1,
                has_visible_connect_or_pending_state=False,
            ),
            "already_connected",
        )

    def test_classify_connect_only_probe_surface_accepts_generic_message_link_without_invite_state(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=0,
                has_visible_connect_or_pending_state=False,
            ),
            "already_connected",
        )

    def test_classify_connect_only_probe_surface_keeps_invite_link_before_generic_message(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=1,
                connect_button_count=0,
                more_button_count=0,
                has_visible_connect_or_pending_state=False,
            ),
            "invite_available",
        )

    def test_classify_connect_only_probe_surface_keeps_connect_button_before_generic_message(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=0,
                connect_button_count=1,
                more_button_count=0,
                has_visible_connect_or_pending_state=False,
            ),
            "invite_available",
        )

    def test_classify_connect_only_probe_surface_ignores_more_button_when_generic_message_is_unambiguous(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=1,
                has_visible_connect_or_pending_state=False,
            ),
            "already_connected",
        )

    def test_promote_connect_only_to_connected_updates_lead_status(self):
        lead = {"id": "lead-1", "status": "NEW"}
        client = FakeClient(lead)

        result = promote_connect_only_to_connected(client, lead)

        self.assertEqual(result, "connected")
        self.assertEqual(client.lead["status"], "CONNECTED")

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

    def test_fetch_message_only_leads_queries_only_post_invite_candidates(self):
        eligible_row = {
            "id": "lead-eligible",
            "status": "NEW",
            "sent_at": None,
            "connection_sent_at": "2026-04-26T00:00:00Z",
            "connection_accepted_at": None,
            "outreach_mode": "connect_only",
        }
        client = FakeMessageOnlyClient([eligible_row])

        rows = fetch_message_only_leads(client, 25)

        self.assertEqual(rows, [eligible_row])
        self.assertEqual(client.calls[0]["filters"][0], ("eq", "outreach_mode", "connect_only"))
        self.assertEqual(client.calls[0]["filters"][1], ("is", "sent_at", "null"))
        self.assertEqual(
            client.calls[0]["filters"][2],
            (
                "or",
                "connection_sent_at.not.is.null,"
                "connection_accepted_at.not.is.null,"
                "status.in.(CONNECT_ONLY_SENT,CONNECTED,MESSAGE_ONLY_READY,MESSAGE_ONLY_APPROVED)",
            ),
        )


if __name__ == "__main__":
    unittest.main()
