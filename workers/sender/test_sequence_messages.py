#!/usr/bin/env python3
"""Focused tests for sequence-owned sender message resolution."""

import sys
import os
import re
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import sender as sender_module
from sender import (
    _connect_invite_anchor_selectors,
    _fetch_sequence_connect_note,
    fetch_lead_by_id,
    load_sequence_messages,
    sanitize_followup_message,
)


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
    def test_invite_with_note_recognizes_linkedin_preload_anchor(self):
        self.assertIn("a[href*='/preload/custom-invite/']", _connect_invite_anchor_selectors())

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

    def test_invite_note_resolver_uses_assigned_variant(self):
        client = FakeClient(
            {
                "outreach_sequence_variants": [
                    {
                        "id": 17,
                        "sequence_id": 7,
                        "variant_key": 2,
                        "connect_note": "Hallo {{first_name}} von {{company_name}}",
                        "first_message": "",
                        "second_message": "",
                        "third_message": "",
                        "asset_followup_1": "",
                        "asset_followup_2": "",
                        "is_active": True,
                        "sequence": {"id": 7, "is_active": True},
                    }
                ],
                "outreach_sequences": [
                    {"id": 7, "connect_note": "Falsche Basisvorlage"},
                ],
            }
        )
        lead = {
            "id": "lead-1",
            "sequence_id": 7,
            "sequence_variant_id": 17,
            "first_name": "Mia",
            "company_name": "ACME",
        }

        self.assertEqual(
            _fetch_sequence_connect_note(client, lead),
            "Hallo Mia von ACME",
        )

    def test_invite_note_resolver_fails_closed_when_assigned_variant_is_missing(self):
        client = FakeClient(
            {
                "outreach_sequence_variants": [],
                "outreach_sequences": [
                    {"id": 7, "connect_note": "Falsche Basisvorlage"},
                ],
            }
        )
        lead = {"id": "lead-1", "sequence_id": 7, "sequence_variant_id": 17}

        self.assertEqual(_fetch_sequence_connect_note(client, lead), "")

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


class CopApprovedCopyTests(unittest.TestCase):
    def test_cop_followup_rejects_missing_or_oversized_template(self):
        lead = {"id": "cop-copy-fixture", "batch_id": 33, "sequence_id": 10, "sequence_step": 1}
        for template in ("", "x" * 2001):
            with self.subTest(length=len(template)):
                client = FakeClient({"outreach_sequences": [{
                    "id": 10, "delivery_mode": "invite_and_inmail",
                    "is_active": True, "second_message": template,
                }], "settings": []})
                with self.assertRaisesRegex(ValueError, "cop_followup"):
                    sender_module.resolve_followup_message(client, {
                        "lead": lead, "followup_type": "NUDGE", "attempt": 1,
                        "draft_text": "Stale draft must not be sent",
                    })

    def test_cop_followup_resolution_preserves_approved_copy_exactly(self):
        root = Path(__file__).resolve().parents[2]
        migration = (root / "supabase/migrations/029_restore_laura_cop_followups.sql").read_text()
        bodies = re.findall(r"\$copy\$(.*?)\$copy\$", migration, re.S)
        lead = {
            "id": "cop-copy-fixture", "batch_id": 33, "sequence_id": 10,
            "sequence_step": 1, "first_name": "Anna-Lena", "last_name": "D'Angelo",
            "company_name": "X-FAB Dresden GmbH & Co. KG",
        }
        client = FakeClient({"outreach_sequences": [{
            "id": 10, "delivery_mode": "invite_and_inmail", "is_active": True,
            "second_message": bodies[0], "third_message": bodies[1],
        }], "settings": []})
        for attempt, body in enumerate(bodies, 1):
            with self.subTest(attempt=attempt):
                lead["sequence_step"] = attempt
                resolved, step, source = sender_module.resolve_followup_message(client, {
                    "lead": lead, "followup_type": "NUDGE", "attempt": attempt,
                    "draft_text": "Stale draft that must not win",
                })
                expected = sender_module._render_template_message(body, lead)
                self.assertEqual(resolved, expected)
                self.assertEqual(step, attempt + 1)
                self.assertTrue(source.startswith("sequence_template:"))

    def test_cop_migration_matches_laura_reminders_with_full_name_greeting(self):
        root = Path(__file__).resolve().parents[2]
        source = (root / "Linkedin Mailing COP Cases.md").read_text()
        migration = (root / "supabase/migrations/029_restore_laura_cop_followups.sql").read_text()
        bodies = re.findall(r"\$copy\$(.*?)\$copy\$", migration, re.S)
        self.assertEqual(len(bodies), 2)
        headings = ["## **2\\. Erste Erinnerung**", "## **3\\. Zweite und letzte Erinnerung**"]
        for index, heading in enumerate(headings):
            section = source.split(heading, 1)[1]
            if index == 0:
                section = section.split(headings[1], 1)[0]
            section = re.sub(r"\*\*Betreff:\*\*[^\n]*\n", "", section).strip()
            section = section.replace("\\[Frau/Herr Nachname\\]", "{{first_name}} {{last_name}}")
            section = section.replace("\\[ehemaliger Arbeitgeber\\]", "{{company_name}}")
            self.assertEqual(bodies[index], section)
            rendered = sender_module._render_template_message(
                bodies[index], {"first_name": "Ada", "last_name": "Fixture", "company_name": "Example"}
            )
            self.assertTrue(rendered.startswith("Hallo Ada Fixture,\n\n"))
            self.assertNotIn("{{", rendered)
        assignments = migration.split("WHERE", 1)[0]
        self.assertNotIn("first_message =", assignments)
        self.assertNotIn("is_active =", assignments)
        self.assertIn("AND linkedin_account_id = '13f81aad-8a5d-4cad-b94d-15aecef6ee03'", migration)


class CampaignPreviewTokenParityTests(unittest.TestCase):
    def test_legacy_token_forms_match_preview(self):
        lead = {"first_name": "Ada", "last_name": "Fixture", "company_name": "Example", "profile_data": {"salutation": "Frau"}}
        self.assertEqual(sender_module._render_template_message("Hello [first_name] {{ last_name }} { company_name } [salutation]", lead), "Hello Ada Fixture Example Frau")


if __name__ == "__main__":
    unittest.main()
