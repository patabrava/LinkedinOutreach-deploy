import unittest

from scraper import Lead, extract_verified_salutation, profile_identity_matches_lead


class SalutationExtractionTest(unittest.TestCase):
    def test_explicit_she_her_maps_to_frau(self):
        result = extract_verified_salutation("Anna Müller", ["Pronouns: She/Her"])
        self.assertEqual(result["salutation"], "Frau")
        self.assertEqual(result["salutation_status"], "verified")
        self.assertEqual(result["salutation_evidence"], "pronouns:she/her")

    def test_explicit_he_him_maps_to_herr(self):
        result = extract_verified_salutation("Jan Müller", ["He/Him"])
        self.assertEqual(result["salutation"], "Herr")
        self.assertEqual(result["salutation_status"], "verified")
        self.assertEqual(result["salutation_evidence"], "pronouns:he/him")

    def test_explicit_honorific_in_profile_name_is_verified(self):
        result = extract_verified_salutation("Frau Anna Müller", [])
        self.assertEqual(result["salutation"], "Frau")
        self.assertEqual(result["salutation_status"], "verified")
        self.assertEqual(result["salutation_evidence"], "profile_name:frau")

    def test_unrelated_honorific_text_is_not_used_as_evidence(self):
        result = extract_verified_salutation("Anna Müller", ["Ich arbeite mit Frau Müller."])
        self.assertEqual(result["salutation"], "")
        self.assertEqual(result["salutation_status"], "unresolved")

    def test_non_binary_or_missing_signal_is_unresolved(self):
        for evidence in ([], ["Pronouns: They/Them"]):
            with self.subTest(evidence=evidence):
                result = extract_verified_salutation("Alex Müller", evidence)
                self.assertEqual(result["salutation"], "")
                self.assertEqual(result["salutation_status"], "unresolved")

    def test_conflicting_signals_are_unresolved(self):
        result = extract_verified_salutation("Alex Müller", ["She/Her and He/Him"])
        self.assertEqual(result["salutation"], "")
        self.assertEqual(result["salutation_status"], "unresolved")
        self.assertEqual(result["salutation_source"], "linkedin_profile_conflicting_signals")

    def test_profile_identity_must_match_before_persisting_evidence(self):
        lead = Lead(id="lead-1", linkedin_url="https://www.linkedin.com/in/anna", first_name="Anna", last_name="Müller")
        self.assertTrue(profile_identity_matches_lead("Anna Müller", lead))
        self.assertTrue(profile_identity_matches_lead("Frau Anna Müller", lead))
        self.assertFalse(profile_identity_matches_lead("Someone Else", lead))


if __name__ == "__main__":
    unittest.main()
