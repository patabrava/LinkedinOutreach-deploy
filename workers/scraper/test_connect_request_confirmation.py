import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from scraper import _detect_weekly_invite_limit_text, _has_connection_request_confirmation


class ConnectionRequestConfirmationTest(unittest.TestCase):
    def test_detects_german_pending_state(self):
        self.assertTrue(_has_connection_request_confirmation("Status: Ausstehend"))

    def test_detects_english_pending_state(self):
        self.assertTrue(_has_connection_request_confirmation("Connection status: Pending"))

    def test_detects_sent_copy(self):
        self.assertTrue(_has_connection_request_confirmation("Invitation sent"))

    def test_rejects_plain_action_text(self):
        self.assertFalse(_has_connection_request_confirmation("Send without a note"))


class WeeklyInviteLimitDetectionTest(unittest.TestCase):
    def test_rejects_normal_german_invite_dialog(self):
        dialog_text = (
            "Eine Nachricht zu Ihrer Einladung hinzufügen? "
            "Fügen Sie eine Nachricht zu Ihrer Einladung an Salim Al Sabaa hinzu. "
            "LinkedIn Mitglieder nehmen eher Einladungen an, die eine Nachricht enthalten. "
            "Nachricht hinzufügen Ohne Notiz senden"
        )

        self.assertIsNone(_detect_weekly_invite_limit_text(dialog_text))

    def test_detects_english_weekly_limit_copy(self):
        self.assertIsNotNone(
            _detect_weekly_invite_limit_text(
                "You've reached the weekly invitation limit. Please try again next week."
            )
        )

    def test_detects_german_limit_copy(self):
        self.assertIsNotNone(
            _detect_weekly_invite_limit_text(
                "Sie haben das Limit für Kontaktanfragen erreicht. Bitte versuchen Sie es nächste Woche erneut."
            )
        )


if __name__ == "__main__":
    unittest.main()
