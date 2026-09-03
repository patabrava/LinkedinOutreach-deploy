from datetime import datetime
from pathlib import Path
import tempfile
import unittest

from degura_campaign import (
    BERLIN,
    add_business_days,
    asset_followup_at,
    invite_withdraw_at,
    next_touch_at,
    nurture_until,
    route_degura_reply,
    validate_guide_pdf,
)


class DeguraCampaignTest(unittest.TestCase):
    def test_business_days_skip_weekend(self):
        friday = datetime(2026, 8, 14, 10, tzinfo=BERLIN)
        self.assertEqual(add_business_days(friday, 1).date().isoformat(), "2026-08-17")
        self.assertEqual(next_touch_at(3, friday).date().isoformat(), "2026-08-20")

    def test_campaign_schedule_contract(self):
        start = datetime(2026, 8, 14, 10, tzinfo=BERLIN)
        self.assertEqual(next_touch_at(2, start).isoformat(), "2026-08-15T10:00:00+02:00")
        self.assertEqual(invite_withdraw_at(start).date().isoformat(), "2026-08-28")
        self.assertEqual(asset_followup_at(start, 1).date().isoformat(), "2026-08-21")
        self.assertEqual(nurture_until(start).date().isoformat(), "2027-02-14")

    def test_pdf_requires_signature(self):
        with tempfile.TemporaryDirectory() as root:
            invalid = Path(root) / "guide.pdf"
            invalid.write_bytes(b"not a pdf")
            with self.assertRaisesRegex(ValueError, "GUIDE_ASSET_INVALID"):
                validate_guide_pdf(invalid)
            valid = Path(root) / "valid.pdf"
            valid.write_bytes(b"%PDF-1.7\n%%EOF")
            self.assertEqual(validate_guide_pdf(valid), valid.resolve())

    def test_human_only_routes_never_auto_send(self):
        for text in ("Was kostet das?", "Ist das nach § 1a BetrAVG rechtssicher?", "Das ist eine Frechheit"):
            decision = route_degura_reply(text)
            self.assertTrue(decision.requires_human)
            self.assertIsNone(decision.auto_template_key)

    def test_clear_no_suppresses_before_close(self):
        decision = route_degura_reply("Nein, bitte nicht mehr kontaktieren.")
        self.assertEqual(decision.action_order, ("suppress", "send_close"))

    def test_guide_requires_delivery_validation_first(self):
        decision = route_degura_reply("Ja, schicken Sie mir bitte den Leitfaden.")
        self.assertEqual(decision.action_order[0], "validate_delivery")

    def test_documented_safe_reply_routes_are_classified(self):
        cases = {
            "Im Moment nicht, vielleicht im November.": "not_now",
            "Wir haben bereits eine bAV und arbeiten mit einem Makler.": "existing_bav",
            "Bitte schicken Sie die Informationen per E-Mail.": "email_request",
            "Ich muss das erst intern mit der Geschäftsführung klären.": "internal_clarification",
            "Wir haben keine Zeit dafür.": "no_time",
            "Das interessiert unsere Mitarbeitenden nicht.": "employee_disinterest",
        }
        for text, expected_route in cases.items():
            with self.subTest(text=text):
                decision = route_degura_reply(text)
                self.assertEqual(decision.route, expected_route)
                self.assertFalse(decision.requires_human)


if __name__ == "__main__":
    unittest.main()
