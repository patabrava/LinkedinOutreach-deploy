import unittest

import scraper


class InboxReplyDetectionTests(unittest.TestCase):
    def test_normalizes_linkedin_display_names(self):
        self.assertEqual(scraper.normalize_person_name("  Daniel   Herm  "), "daniel herm")
        self.assertEqual(scraper.normalize_person_name("Cindy Krüger ✅"), "cindy krüger")

    def test_detects_last_message_from_lead_full_name(self):
        lead = {"first_name": "Daniel", "last_name": "Herm"}
        convo = {"sender": "Daniel Herm", "text": "Hi Katharina", "is_outbound": False}

        self.assertTrue(scraper.is_last_message_from_lead(convo, lead))

    def test_does_not_treat_us_or_blank_sender_as_reply(self):
        lead = {"first_name": "Markus", "last_name": "Tipold"}

        self.assertFalse(scraper.is_last_message_from_lead({"sender": "Sie", "is_outbound": False}, lead))
        self.assertFalse(scraper.is_last_message_from_lead({"sender": "", "is_outbound": False}, lead))
        self.assertFalse(scraper.is_last_message_from_lead({"sender": "Markus Tipold", "is_outbound": True}, lead))

    def test_failed_leads_are_included_as_reply_candidates(self):
        self.assertIn("SENT", scraper.INBOX_REPLY_CANDIDATE_STATUSES)
        self.assertIn("FAILED", scraper.INBOX_REPLY_CANDIDATE_STATUSES)


if __name__ == "__main__":
    unittest.main()
