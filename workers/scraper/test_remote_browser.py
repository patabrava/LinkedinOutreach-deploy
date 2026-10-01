"""Account isolation and Chromium Host validation for remote session capture."""
import os
import socket
import unittest
from unittest.mock import patch

import auth


class RemoteBrowserEndpointTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "LINKEDIN_ACCOUNT_ID": "a4ecaa71-4297-4f19-b186-4b53a552e6a8",
            "LINKEDIN_BROWSER_CDP_URL": "http://linkedin-browser-2:9222",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_selected_browser_uses_numeric_host_for_chromium(self):
        with patch("socket.gethostbyname", return_value="172.18.0.7") as resolve:
            self.assertEqual(auth._candidate_remote_browser_cdp_urls(), ["http://172.18.0.7:9222"])
            resolve.assert_called_once_with("linkedin-browser-2")

    def test_account_without_selected_endpoint_fails_closed(self):
        os.environ.pop("LINKEDIN_BROWSER_CDP_URL")
        with self.assertRaisesRegex(RuntimeError, "account.*CDP"):
            auth._candidate_remote_browser_cdp_urls()

    def test_missing_selected_browser_never_falls_back_to_another_slot(self):
        with patch("socket.gethostbyname", side_effect=socket.gaierror("not found")):
            with self.assertRaisesRegex(RuntimeError, "selected.*browser"):
                auth._candidate_remote_browser_cdp_urls()

    def test_legacy_unscoped_capture_keeps_local_candidates(self):
        os.environ.pop("LINKEDIN_ACCOUNT_ID")
        self.assertIn("http://127.0.0.1:9222", auth._candidate_remote_browser_cdp_urls())


if __name__ == "__main__":
    unittest.main()
