#!/usr/bin/env python3
"""Tests for Sales Navigator sender routing helpers."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from sender import (
    INVITE_RETRY_STATUSES,
    DIRECT_MESSAGE_COMPOSER_SELECTOR,
    DIRECT_MESSAGE_SCOPED_SEND_ROOT_SELECTORS,
    DIRECT_MESSAGE_SEND_BUTTON_SELECTOR,
    MESSAGE_ONLY_PROCESSING_STATUSES,
    _pick_send_button_candidate,
    classify_connect_only_surface,
    classify_connect_only_probe_surface,
    connect_only_sent_today_count,
    fetch_invite_queue,
    fetch_message_only_leads,
    build_sales_navigator_body,
    build_sales_navigator_subject,
    clear_message_only_retry_profile_data,
    linkedin_absolute_url,
    _is_invite_candidate,
    _is_message_only_candidate,
    mark_connect_only_limit_reached,
    mark_invite_processing,
    mark_message_only_processing,
    normalize_typed_text,
    normalize_linkedin_profile_url,
    persist_invite_sent,
    promote_connect_only_to_connected,
    strip_sales_navigator_signature,
    typed_text_matches,
    _message_only_priority,
    _connect_or_pending_label_matches,
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


class FakeCountQuery:
    def __init__(self, client):
        self.client = client
        self.filters = []
        self.not_ = self

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

    def is_(self, key, value):
        self.filters.append(("not_is", key, value))
        return self

    def execute(self):
        self.client.calls.append(self.filters)
        return FakeResponse(count=self.client.count)


class FakeCountClient:
    def __init__(self, count=0):
        self.count = count
        self.calls = []

    def table(self, _table_name):
        return FakeCountQuery(self)


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

    def test_normalize_typed_text_matches_linkedin_collapsed_paragraph_spacing(self):
        expected = "Hi Sabrina,\n\nfreut mich, dass wir uns vernetzen.\n\nViele Gruesse,\nKatharina"
        actual = "Hi Sabrina, freut mich, dass wir uns vernetzen. Viele Gruesse, Katharina"

        self.assertEqual(normalize_typed_text(actual), normalize_typed_text(expected))

    def test_direct_message_wait_selector_covers_current_linkedin_composer(self):
        self.assertIn("Write a message", DIRECT_MESSAGE_COMPOSER_SELECTOR)
        self.assertIn("msg-form-ember", DIRECT_MESSAGE_COMPOSER_SELECTOR)
        self.assertIn("role='textbox'", DIRECT_MESSAGE_COMPOSER_SELECTOR)

    def test_direct_message_send_selector_covers_current_linkedin_button(self):
        self.assertIn("msg-form__send-button", DIRECT_MESSAGE_SEND_BUTTON_SELECTOR)
        self.assertIn("Nachricht senden", DIRECT_MESSAGE_SEND_BUTTON_SELECTOR)
        self.assertIn("type='submit'", DIRECT_MESSAGE_SEND_BUTTON_SELECTOR)

    def test_pick_send_button_candidate_prefers_editor_root_enabled_button(self):
        candidates = [
            {"domIndex": 1, "text": "Senden", "visible": True, "enabled": False, "withinEditorRoot": False},
            {"domIndex": 4, "text": "Senden", "visible": True, "enabled": True, "withinEditorRoot": True},
        ]

        result = _pick_send_button_candidate(candidates)

        self.assertEqual(result["domIndex"], 4)

    def test_pick_send_button_candidate_falls_back_to_last_visible_match(self):
        candidates = [
            {"domIndex": 2, "text": "Senden", "visible": True, "enabled": False, "withinEditorRoot": True},
            {"domIndex": 5, "text": "Senden", "visible": True, "enabled": False, "withinEditorRoot": True},
        ]

        result = _pick_send_button_candidate(candidates)

        self.assertEqual(result["domIndex"], 5)

    def test_scoped_send_roots_include_msg_form_ancestor(self):
        roots = " ".join(DIRECT_MESSAGE_SCOPED_SEND_ROOT_SELECTORS)

        self.assertIn("msg-form", roots)

    def test_linkedin_absolute_url_normalizes_relative_compose_href(self):
        result = linkedin_absolute_url("/messaging/compose/?recipient=abc")

        self.assertEqual(result, "https://www.linkedin.com/messaging/compose/?recipient=abc")

    def test_pick_send_button_candidate_prefers_msg_form_button_over_global_send(self):
        candidates = [
            {
                "domIndex": 1,
                "text": "Senden",
                "visible": True,
                "enabled": True,
                "withinEditorRoot": False,
                "className": "artdeco-button",
            },
            {
                "domIndex": 3,
                "text": "",
                "visible": True,
                "enabled": True,
                "withinEditorRoot": True,
                "className": "msg-form__send-button artdeco-button",
            },
        ]

        result = _pick_send_button_candidate(candidates)

        self.assertEqual(result["domIndex"], 3)

    def test_typed_text_matches_accepts_small_extraction_gap_when_words_match(self):
        expected = "Hi Sabrina, freut mich, dass wir uns vernetzen. Viele Gruesse, Katharina"
        actual = "Hi Sabrina, freut mich, dass wir uns vernetzen. Viele Gruesse Katharina"

        matched, details = typed_text_matches(actual, expected)

        self.assertTrue(matched, details)

    def test_typed_text_matches_rejects_missing_name(self):
        expected = "Hi Sabrina, freut mich, dass wir uns vernetzen. Viele Gruesse, Katharina"
        actual = "Hi, freut mich, dass wir uns vernetzen. Viele Gruesse, Katharina"

        matched, details = typed_text_matches(actual, expected)

        self.assertFalse(matched)
        self.assertIn("sabrina", details["missingWords"])

    def test_clear_message_only_retry_profile_data_preserves_unrelated_metadata(self):
        lead = {
            "profile_data": {
                "message_only_retry_attempts": 2,
                "message_only_last_error": "old composer error",
                "message_only_last_retry_at": "2026-05-06T22:23:39",
                "source": "live-test",
            }
        }

        cleaned = clear_message_only_retry_profile_data(lead)

        self.assertEqual(cleaned, {"source": "live-test"})

    def test_connect_or_pending_label_ignores_unrelated_recommendation_connect_button(self):
        self.assertFalse(_connect_or_pending_label_matches("Stefanie Vogt als Kontakt einladen", "Daniel Herm"))

    def test_connect_or_pending_label_accepts_profile_pending_state(self):
        self.assertTrue(_connect_or_pending_label_matches("Ausstehend", "Daniel Herm"))

    def test_connect_or_pending_label_accepts_profile_invite_action(self):
        self.assertTrue(_connect_or_pending_label_matches("Daniel Herm als Kontakt einladen", "Daniel Herm"))

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

    def test_strip_sales_navigator_signature_keeps_manual_closing_without_name(self):
        body = (
            "Hi Marina,\n\n"
            "freut mich, dass wir uns hier vernetzen.\n\n"
            "Viele Grüße,\nKatharina"
        )

        self.assertEqual(
            strip_sales_navigator_signature(body),
            "Hi Marina,\n\nfreut mich, dass wir uns hier vernetzen.\n\nViele Grüße,",
        )

    def test_strip_sales_navigator_signature_keeps_single_line_closing_without_name(self):
        body = (
            "Hi Marina,\n\n"
            "freut mich, dass wir uns hier vernetzen.\n\n"
            "Viele Grüße, Katharina"
        )

        self.assertEqual(
            strip_sales_navigator_signature(body),
            "Hi Marina,\n\nfreut mich, dass wir uns hier vernetzen.\n\nViele Grüße,",
        )

    def test_strip_sales_navigator_signature_keeps_non_signature_body(self):
        body = "Hi Marina,\n\nfreut mich, dass wir uns hier vernetzen."

        self.assertEqual(strip_sales_navigator_signature(body), body)

    def test_build_sales_navigator_body_removes_katharina_signature(self):
        message = (
            "Hi Marina,\n\n"
            "freut mich, dass wir uns hier vernetzen.\n\n"
            "Viele Grüße,\nKatharina"
        )

        self.assertEqual(
            build_sales_navigator_body(message),
            "Hi Marina,\n\nfreut mich, dass wir uns hier vernetzen.\n\nViele Grüße,",
        )

    def test_mark_message_only_processing_locks_connected_without_legacy_timestamp(self):
        lead = {"id": "lead-1", "status": "CONNECTED", "sent_at": None}
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertTrue(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls[0]["filters"][1], ("in", "status", list(MESSAGE_ONLY_PROCESSING_STATUSES)))

    def test_mark_message_only_processing_skips_processing_without_invite_timestamp(self):
        lead = {"id": "lead-1", "status": "PROCESSING", "sent_at": None}
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertFalse(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls, [])

    def test_mark_message_only_processing_allows_targeted_probe_without_invite_timestamp(self):
        lead = {
            "id": "lead-1",
            "status": "FAILED",
            "sent_at": None,
            "outreach_mode": "connect_only",
            "sequence_id": 4,
        }
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead, allow_missing_invite_evidence=True)

        self.assertTrue(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls[0]["filters"][1], ("is", "sent_at", "null"))

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

    def test_mark_message_only_pending_restores_invite_sent_state(self):
        from sender import mark_message_only_pending

        lead = {
            "id": "lead-1",
            "status": "PROCESSING",
            "connection_sent_at": "2026-05-06T10:00:00Z",
            "connection_accepted_at": "2026-05-06T11:00:00Z",
        }
        client = FakeClient(lead)

        mark_message_only_pending(client, lead)

        self.assertEqual(client.lead["status"], "CONNECT_ONLY_SENT")
        self.assertIsNone(client.lead["error_message"])
        self.assertIsNone(client.lead["connection_accepted_at"])

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

    def test_fetch_invite_queue_excludes_attempted_leads_for_current_run(self):
        client = FakeInviteQueueClient(
            [
                {"id": "lead-failed", "status": "FAILED", "outreach_mode": "connect_only", "profile_data": {}},
                {"id": "lead-replacement", "status": "NEW", "outreach_mode": "connect_only", "profile_data": {}},
            ]
        )

        rows = fetch_invite_queue(client, 1, exclude_ids={"lead-failed"})

        self.assertEqual([row["id"] for row in rows], ["lead-replacement"])

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

    def test_connect_only_sent_today_count_uses_connection_sent_at_for_connect_only_rows(self):
        client = FakeCountClient(count=7)

        result = connect_only_sent_today_count(client)

        self.assertEqual(result, 7)
        self.assertTrue(any(item[0] == "eq" and item[1] == "outreach_mode" and item[2] == "connect_only" for item in client.calls[0]))
        self.assertTrue(any(item[0] == "not_is" and item[1] == "connection_sent_at" and item[2] == "null" for item in client.calls[0]))

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

    def test_classify_connect_only_probe_surface_detects_pending_invite_from_more_menu(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=1,
                has_visible_connect_or_pending_state=True,
                has_more_menu_pending_state=True,
            ),
            "pending_invite",
        )

    def test_classify_connect_only_probe_surface_keeps_more_menu_before_generic_message(self):
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
            "invite_available",
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

    def test_classify_connect_only_probe_surface_requires_more_menu_verification_before_generic_message(self):
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
            "invite_available",
        )

    def test_promote_connect_only_to_connected_updates_lead_status(self):
        lead = {"id": "lead-1", "status": "NEW"}
        client = FakeClient(lead)

        result = promote_connect_only_to_connected(client, lead)

        self.assertEqual(result, "connected")
        self.assertEqual(client.lead["status"], "CONNECTED")
        self.assertTrue(client.lead["connection_accepted_at"])

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

    def test_message_only_candidate_accepts_connected_without_legacy_timestamp(self):
        self.assertTrue(
            _is_message_only_candidate(
                {
                    "status": "CONNECTED",
                    "connection_sent_at": None,
                    "connection_accepted_at": None,
                    "sent_at": None,
                }
            )
        )

    def test_message_only_priority_prefers_accepted_before_pending_invites(self):
        rows = [
            {"id": "pending", "status": "CONNECT_ONLY_SENT", "connection_sent_at": "2026-05-06T10:00:00Z"},
            {"id": "message-ready", "status": "MESSAGE_ONLY_READY", "connection_sent_at": None},
            {"id": "connected", "status": "CONNECTED", "connection_sent_at": None},
            {"id": "accepted", "status": "PROCESSING", "connection_accepted_at": "2026-05-06T11:00:00Z"},
        ]

        ordered = sorted(rows, key=_message_only_priority)

        self.assertEqual([row["id"] for row in ordered], ["message-ready", "connected", "accepted", "pending"])

    def test_fetch_message_only_leads_queries_only_post_invite_candidates(self):
        eligible_row = {
            "id": "lead-eligible",
            "status": "NEW",
            "sent_at": None,
            "connection_sent_at": "2026-04-26T00:00:00Z",
            "connection_accepted_at": None,
            "outreach_mode": "connect_only",
        }
        legacy_connected_row = {
            "id": "lead-legacy-connected",
            "status": "CONNECTED",
            "sent_at": None,
            "connection_sent_at": None,
            "connection_accepted_at": None,
            "outreach_mode": "connect_only",
        }
        stale_processing_row = {
            "id": "lead-stale-processing",
            "status": "PROCESSING",
            "sent_at": None,
            "connection_sent_at": None,
            "connection_accepted_at": None,
            "outreach_mode": "connect_only",
        }
        client = FakeMessageOnlyClient([stale_processing_row, legacy_connected_row, eligible_row])

        rows = fetch_message_only_leads(client, 25)

        self.assertEqual(rows, [legacy_connected_row, eligible_row])
        self.assertEqual(client.calls[0]["filters"][0], ("eq", "outreach_mode", "connect_only"))
        self.assertEqual(client.calls[0]["filters"][1], ("is", "sent_at", "null"))
        self.assertEqual(
            client.calls[0]["filters"][2],
            (
                "or",
                "connection_sent_at.not.is.null,"
                "connection_accepted_at.not.is.null,"
                "status.in.(CONNECTED,MESSAGE_ONLY_READY,MESSAGE_ONLY_APPROVED)",
            ),
        )


class FollowupSalesNavigatorRoutingTest(unittest.IsolatedAsyncioTestCase):
    """process_followup_one must detect Sales Navigator composers so the
    Subject field is filled; otherwise the InMail Send button stays disabled.
    """

    def _build_followup(self) -> dict:
        lead = {
            "id": "lead-1",
            "first_name": "Marina",
            "last_name": "Schulz",
            "company_name": "Acme",
            "linkedin_url": "https://www.linkedin.com/in/marina-schulz",
        }
        return {
            "id": "fu-1",
            "lead_id": "lead-1",
            "draft_text": (
                "Hi Marina,\n\nnur ein kurzer Followup zu meiner letzten Nachricht.\n\n"
                "Viele Grüße,\nKatharina"
            ),
            "followup_type": "NUDGE",
            "attempt": 2,
            "lead": lead,
        }

    def _build_mock_page(self):
        from unittest.mock import AsyncMock, MagicMock

        page = MagicMock()
        page.goto = AsyncMock()
        page.wait_for_timeout = AsyncMock()
        page.close = AsyncMock()
        page.screenshot = AsyncMock()
        return page

    def _patches(self, *, surface_result):
        """Patch `open_followup_message_surface` with `surface_result`.

        `surface_result` is either an Exception (side_effect) or a
        `(target_page, surface_string)` tuple (return_value).
        """
        from contextlib import ExitStack
        from unittest.mock import AsyncMock, MagicMock, patch

        import sender as sender_mod

        stack = ExitStack()
        mocks = {}

        if isinstance(surface_result, Exception):
            mocks["open_followup_message_surface"] = stack.enter_context(
                patch.object(
                    sender_mod,
                    "open_followup_message_surface",
                    AsyncMock(side_effect=surface_result),
                )
            )
        else:
            mocks["open_followup_message_surface"] = stack.enter_context(
                patch.object(
                    sender_mod,
                    "open_followup_message_surface",
                    AsyncMock(return_value=surface_result),
                )
            )
        mocks["send_sales_navigator_message"] = stack.enter_context(
            patch.object(sender_mod, "send_sales_navigator_message", AsyncMock())
        )
        mocks["send_message"] = stack.enter_context(
            patch.object(sender_mod, "send_message", AsyncMock())
        )
        mocks["mark_followup_sent"] = stack.enter_context(
            patch.object(sender_mod, "mark_followup_sent", MagicMock())
        )
        mocks["mark_followup_failed"] = stack.enter_context(
            patch.object(sender_mod, "mark_followup_failed", MagicMock())
        )
        mocks["resolve_followup_message"] = stack.enter_context(
            patch.object(
                sender_mod,
                "resolve_followup_message",
                MagicMock(return_value=(
                    "Hi Marina,\n\nnur ein kurzer Followup zu meiner letzten Nachricht.\n\n"
                    "Viele Grüße,\nKatharina",
                    2,
                    "draft_text",
                )),
            )
        )
        mocks["random_pause"] = stack.enter_context(
            patch.object(sender_mod, "random_pause", AsyncMock())
        )
        return stack, mocks

    async def test_routes_to_sales_navigator_when_composer_detected(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one, SURFACE_SALES_NAVIGATOR

        page = self._build_mock_page()
        sales_page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()

        stack, mocks = self._patches(
            surface_result=(sales_page, SURFACE_SALES_NAVIGATOR),
        )
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "sent")
        mocks["send_sales_navigator_message"].assert_awaited_once()
        mocks["send_message"].assert_not_awaited()
        mocks["mark_followup_sent"].assert_called_once()
        mocks["mark_followup_failed"].assert_not_called()

        call_args = mocks["send_sales_navigator_message"].await_args
        sent_page, subject, body = call_args.args
        self.assertIs(sent_page, sales_page)
        self.assertEqual(subject, "Kurze Frage zu deiner bAV")
        # The Sales Navigator body must not duplicate the signature name.
        self.assertNotIn("\nKatharina", body)
        self.assertIn("Hi Marina", body)

    async def test_routes_to_direct_message_when_dm_surface_returned(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one, SURFACE_MESSAGE

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()

        stack, mocks = self._patches(
            surface_result=(page, SURFACE_MESSAGE),
        )
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "sent")
        mocks["send_message"].assert_awaited_once()
        mocks["send_sales_navigator_message"].assert_not_awaited()
        mocks["mark_followup_sent"].assert_called_once()

    async def test_fails_permanently_when_no_surface(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()

        stack, mocks = self._patches(
            surface_result=RuntimeError("No messaging surface found."),
        )
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "failed")
        mocks["send_sales_navigator_message"].assert_not_awaited()
        mocks["send_message"].assert_not_awaited()
        mocks["mark_followup_failed"].assert_called_once()
        kwargs = mocks["mark_followup_failed"].call_args.kwargs
        self.assertTrue(kwargs.get("permanent"))

    async def test_retries_on_transient_failure(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()

        stack, mocks = self._patches(
            surface_result=RuntimeError("Timeout 5000ms exceeded"),
        )
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "retry")
        mocks["mark_followup_failed"].assert_called_once()
        kwargs = mocks["mark_followup_failed"].call_args.kwargs
        self.assertFalse(kwargs.get("permanent"))


if __name__ == "__main__":
    unittest.main()
