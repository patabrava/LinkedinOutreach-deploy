#!/usr/bin/env python3
"""Focused tests for sequence-owned sender message resolution."""

import sys
import os
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import sender as sender_module
from sender import fetch_lead_by_id, load_sequence_messages, sanitize_followup_message


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
    def setUp(self):
        self.previous_slot = getattr(sender_module, "CURRENT_ACCOUNT_BROWSER_SLOT", None)

    def tearDown(self):
        os.environ.pop("OUTREACH_SEQUENCE_ID", None)
        if self.previous_slot is None:
            sender_module.__dict__.pop("CURRENT_ACCOUNT_BROWSER_SLOT", None)
        else:
            sender_module.CURRENT_ACCOUNT_BROWSER_SLOT = self.previous_slot

    def test_builds_canonical_aggregate_utm_url_and_preserves_query_and_fragment(self):
        build_degura_utm_url = getattr(sender_module, "build_degura_utm_url", None)
        self.assertTrue(callable(build_degura_utm_url), "sender must expose build_degura_utm_url")
        result = build_degura_utm_url(
            "https://www.degura.de/bav-leitfaden-confirmation?lang=de&utm_source=old#download",
            campaign_key="DEGURA_B",
            variant_key=2,
            context="Touch 2 / Reply Guide",
            link_type="guide",
            account_slot=1,
        )

        self.assertEqual(
            result,
            "https://www.degura.de/bav-leitfaden-confirmation?lang=de&utm_source=linkedin&utm_medium=social&utm_campaign=degura_b_836545727&utm_content=v2_touch_2_reply_guide_slot1#download",
        )
        self.assertNotRegex(result, r"camilo|linkedin\.com/in|company|contact-")

    def test_followup_sanitizer_preserves_tracked_url_bytes(self):
        tracked_url = (
            "https://calendly.com/toby-weber-degura/videotelefonat-mit-toby-30min"
            "?utm_source=linkedin&utm_medium=social&utm_campaign=degura_a_837149883"
            "&utm_content=v1_touch3_booking_slot2"
        )

        self.assertEqual(
            sanitize_followup_message(f"Follow-up: {tracked_url}"),
            f"Follow up: {tracked_url}",
        )

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

    def test_launch_sequence_id_override_wins_over_missing_lead_sequence(self):
        os.environ["OUTREACH_SEQUENCE_ID"] = "9"
        client = FakeClient(
            {
                "outreach_sequences": [
                    {
                        "id": 9,
                        "connect_note": "SEQUENZ b ohne Vertrag",
                        "first_message": "Launch note",
                        "second_message": "",
                        "third_message": "",
                        "followup_interval_days": 3,
                        "is_active": False,
                        "created_at": "2026-04-24T00:00:00Z",
                    }
                ],
                "settings": [],
            }
        )
        lead = {"first_name": "Mia", "last_name": "Lopez", "company_name": "ACME"}

        result = load_sequence_messages(client, lead)

        self.assertEqual(result["connect_note"], "SEQUENZ b ohne Vertrag")

    def test_assigned_managed_variant_wins_and_renders_company_name(self):
        sender_module.CURRENT_ACCOUNT_BROWSER_SLOT = 2
        client = FakeClient(
            {
                "outreach_sequence_variants": [
                    {
                        "id": 17,
                        "sequence_id": 7,
                        "variant_key": 2,
                        "connect_note": "Hallo {{first_name}} von {{company_name}}",
                        "first_message": "Leitfaden für {{company_name}}: https://www.degura.de/leitfaden",
                        "second_message": "Termin: https://calendly.com/degura/demo",
                        "third_message": "Dritter Kontakt https://www.degura.de/leitfaden",
                        "asset_followup_1": "Nachfrage eins https://calendly.com/degura/demo",
                        "asset_followup_2": "Nachfrage zwei https://calendly.com/degura/demo",
                        "is_active": True,
                        "sequence": {
                            "id": 7,
                            "campaign_key": "DEGURA_B",
                            "guide_url": "https://www.degura.de/leitfaden",
                            "booking_url": "https://calendly.com/degura/demo",
                            "followup_interval_days": 3,
                            "is_active": True,
                        },
                    }
                ]
            }
        )
        lead = {
            "sequence_id": 7,
            "sequence_variant_id": 17,
            "first_name": "Mia",
            "company_name": "ACME",
        }

        result = load_sequence_messages(client, lead)

        self.assertEqual(result["source"], "outreach_sequence_variants")
        self.assertEqual(result["connect_note"], "Hallo Mia von ACME")
        self.assertIn("utm_content=v2_touch2_guide_slot2", result["first_message"])
        self.assertIn("utm_content=v2_touch3_booking_slot2", result["second_message"])
        self.assertIn("utm_content=v2_touch4_guide_slot2", result["third_message"])
        self.assertIn("utm_content=v2_asset_followup1_booking_slot2", result["asset_followup_1"])
        self.assertIn("utm_content=v2_asset_followup2_booking_slot2", result["asset_followup_2"])
        self.assertTrue(all("utm_campaign=degura_b_836545727" in result[key] for key in (
            "first_message", "second_message", "third_message", "asset_followup_1", "asset_followup_2"
        )))
        self.assertEqual(result["guide_url"], "https://www.degura.de/leitfaden")

    def test_strict_followup_context_does_not_fallback_to_another_active_sequence(self):
        client = FakeClient(
            {
                "outreach_sequences": [
                    {
                        "id": 99,
                        "campaign_key": "UNRELATED_CAMPAIGN",
                        "first_message": "Wrong campaign {{first_name}}",
                        "second_message": "Wrong follow-up",
                        "third_message": "Wrong third touch",
                        "is_active": True,
                        "created_at": "2026-04-24T00:00:00Z",
                    }
                ],
                "settings": [],
            }
        )
        lead = {
            "id": "lead-without-sequence",
            "first_name": "Mia",
            "last_name": "Lopez",
            "outreach_mode": "connect_message",
        }

        result = load_sequence_messages(client, lead, require_explicit_sequence=True)

        self.assertEqual(result["source"], "missing_explicit_sequence_context")
        self.assertEqual(result["campaign_key"], "")
        self.assertEqual(result["second_message"], "")

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
