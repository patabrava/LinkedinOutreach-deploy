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

    def test_message_only_pipeline_leads_are_included_as_reply_candidates(self):
        self.assertIn("CONNECT_ONLY_SENT", scraper.INBOX_REPLY_CANDIDATE_STATUSES)
        self.assertIn("CONNECTED", scraper.INBOX_REPLY_CANDIDATE_STATUSES)
        self.assertIn("MESSAGE_ONLY_READY", scraper.INBOX_REPLY_CANDIDATE_STATUSES)
        self.assertIn("MESSAGE_ONLY_APPROVED", scraper.INBOX_REPLY_CANDIDATE_STATUSES)

    def test_matches_inbox_summary_to_lead_by_profile_slug(self):
        leads = [
            {
                "id": "lead-1",
                "first_name": "Atanas",
                "last_name": "Daltchev",
                "linkedin_url": "https://www.linkedin.com/in/atanasdaltchev",
            }
        ]
        indexes = scraper.build_inbox_candidate_indexes(leads)

        matched = scraper.match_inbox_summary_to_lead(
            {
                "name": "Atanas Daltchev",
                "profile_url": "https://www.linkedin.com/in/atanasdaltchev/?miniProfileUrn=abc",
            },
            indexes,
        )

        self.assertEqual(matched["id"], "lead-1")

    def test_does_not_name_match_duplicate_full_names(self):
        leads = [
            {
                "id": "lead-1",
                "first_name": "Alex",
                "last_name": "Meyer",
                "linkedin_url": "https://www.linkedin.com/in/alex-meyer-1",
            },
            {
                "id": "lead-2",
                "first_name": "Alex",
                "last_name": "Meyer",
                "linkedin_url": "https://www.linkedin.com/in/alex-meyer-2",
            },
        ]
        indexes = scraper.build_inbox_candidate_indexes(leads)

        matched = scraper.match_inbox_summary_to_lead(
            {"name": "Alex Meyer", "profile_url": None},
            indexes,
        )

        self.assertIsNone(matched)

    def test_exact_profile_match_allows_blank_sender_inbound_reply(self):
        lead = {
            "id": "lead-1",
            "first_name": "Atanas",
            "last_name": "Daltchev",
            "linkedin_url": "https://www.linkedin.com/in/atanasdaltchev",
        }
        convo = {"sender": "", "text": "Ja, gern. Was genau bedeutet das?", "is_outbound": False}
        summary = {
            "profile_url": "https://www.linkedin.com/in/atanasdaltchev/?miniProfileUrn=abc",
            "snippet": "Ja, gern. Was genau bedeutet das?",
        }

        self.assertTrue(scraper.is_inbound_reply_from_conversation(convo, lead, summary))

    def test_blank_sender_with_our_snippet_is_not_inbound_reply(self):
        lead = {
            "id": "lead-1",
            "first_name": "Atanas",
            "last_name": "Daltchev",
            "linkedin_url": "https://www.linkedin.com/in/atanasdaltchev",
        }
        convo = {"sender": "", "text": "Hi Atanas, freut mich...", "is_outbound": False}
        summary = {
            "profile_url": "https://www.linkedin.com/in/atanasdaltchev/",
            "snippet": "Sie: Hi Atanas, freut mich...",
        }

        self.assertFalse(scraper.is_inbound_reply_from_conversation(convo, lead, summary))


if __name__ == "__main__":
    unittest.main()
