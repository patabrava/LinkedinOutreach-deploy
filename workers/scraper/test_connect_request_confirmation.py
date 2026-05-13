import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from scraper import _has_connection_request_confirmation


class ConnectionRequestConfirmationTest(unittest.TestCase):
    def test_detects_german_pending_state(self):
        self.assertTrue(_has_connection_request_confirmation("Status: Ausstehend"))

    def test_detects_english_pending_state(self):
        self.assertTrue(_has_connection_request_confirmation("Connection status: Pending"))

    def test_detects_sent_copy(self):
        self.assertTrue(_has_connection_request_confirmation("Invitation sent"))

    def test_rejects_plain_action_text(self):
        self.assertFalse(_has_connection_request_confirmation("Send without a note"))


if __name__ == "__main__":
    unittest.main()
