import importlib
import os
import sys
import unittest
from pathlib import Path


SENDER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SENDER_DIR))


class MessageOnlyQueueBudgetTest(unittest.TestCase):
    def setUp(self):
        os.environ.pop("MESSAGE_ONLY_PROBE_LIMIT", None)
        if "sender" in sys.modules:
            self.sender = importlib.reload(sys.modules["sender"])
        else:
            self.sender = importlib.import_module("sender")

    def tearDown(self):
        os.environ.pop("MESSAGE_ONLY_PROBE_LIMIT", None)

    def test_default_probe_limit_is_larger_than_remaining_send_quota(self):
        self.assertEqual(self.sender.resolve_message_only_probe_limit(39), 200)

    def test_probe_limit_never_drops_below_remaining_send_quota(self):
        os.environ["MESSAGE_ONLY_PROBE_LIMIT"] = "25"
        self.assertEqual(self.sender.resolve_message_only_probe_limit(39), 39)

    def test_probe_limit_can_be_raised_with_env(self):
        os.environ["MESSAGE_ONLY_PROBE_LIMIT"] = "250"
        self.assertEqual(self.sender.resolve_message_only_probe_limit(39), 250)

    def test_invalid_probe_limit_uses_default(self):
        os.environ["MESSAGE_ONLY_PROBE_LIMIT"] = "not-a-number"
        self.assertEqual(self.sender.resolve_message_only_probe_limit(1), 200)

    def test_zero_remaining_quota_fetches_nothing(self):
        self.assertEqual(self.sender.resolve_message_only_probe_limit(0), 0)

    def test_loop_stop_helper_preserves_daily_send_limit(self):
        self.assertFalse(self.sender.message_only_send_quota_reached(38, 39))
        self.assertTrue(self.sender.message_only_send_quota_reached(39, 39))
        self.assertTrue(self.sender.message_only_send_quota_reached(40, 39))


if __name__ == "__main__":
    unittest.main()
