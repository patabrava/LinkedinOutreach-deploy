import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import scraper
from scraper import Lead, extract_verified_salutation, profile_identity_matches_lead, classify_cop_former_employer


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


class CopFormerEmployerTest(unittest.TestCase):
    def test_completed_experience_accepts_legal_suffix_and_accent_variants(self):
        result = classify_cop_former_employer("Müller GmbH", [
            {"company": "Mueller", "tenure": "Jan 2020 - Mär 2022"},
        ])
        self.assertEqual(result["status"], "verified")

    def test_current_or_undated_experience_is_not_past_employment(self):
        for tenure in ("Jan 2020 - Present", "Jan 2020 - Heute", "Jan 2020", ""):
            with self.subTest(tenure=tenure):
                result = classify_cop_former_employer("Acme GmbH", [
                    {"company": "Acme", "tenure": tenure},
                ])
                self.assertNotEqual(result["status"], "verified")

    def test_related_affiliate_name_matches_under_cop_rule(self):
        result = classify_cop_former_employer("Bosch", [
            {"company": "Bosch Rexroth", "tenure": "2018 - 2020"},
        ])
        self.assertEqual(result["status"], "verified")

    def test_gmbh_and_co_kg_legal_form_does_not_change_identity(self):
        result = classify_cop_former_employer("Acme GmbH & Co. KG", [
            {"company": "Acme", "tenure": "2018 - 2020"},
        ])
        self.assertEqual(result["status"], "verified")

    def test_related_brand_aliases_and_descriptors_match(self):
        pairs = [
            ("DeepL AI GmbH", "DeepL"),
            ("Everphone Service GmbH", "everphone"),
            ("Grand City Property Ltd. ZN Dtl.", "GCP - Grand City Property"),
            ("Lush GmbH", "Lush Deutschland"),
            ("SYZYGY AG", "SYZYGY GROUP"),
            ("gitti GmbH", "gitti Conscious Beauty"),
            ("X-FAB Global Services GmbH", "X-FAB"),
            ("X-FAB Dresden GmbH & Co. KG", "X-FAB"),
            ("Lovehoney Group Germany GmbH", "Lovehoney Group"),
            ("apetito kids & schools GmbH", "apetito catering"),
            ("Numa Group SE", "numa"),
            ("internetwarriors GmbH", "internetwarriors - Online Marketing Agentur Berlin"),
            ("aufinity Group GmbH", "Aufinity Group | bezahl.de"),
            ("AdScanner GmbH", "all eyes on screens"),
            ("Titel Media GmbH", "Highsnobiety"),
            ("Sonoma Internet GmbH", "AMORELIE"),
            ("fritz-kola GmbH", "fritz-kulturgüter GmbH"),
            ("Garden & House BidCo GmbH", "A-Z Gartenhaus GmbH"),
        ]
        for expected, observed in pairs:
            with self.subTest(expected=expected, observed=observed):
                self.assertEqual(classify_cop_former_employer(expected, [
                    {"company": observed, "tenure": "Jan. 2020–Sept. 2023"},
                ])["status"], "verified")

    def test_unrelated_generic_names_and_description_words_do_not_match(self):
        for expected, observed, tenure in [
            ("Adjust GmbH", "Grand Hyatt", "2020 - 2023. Adjust group forecast"),
            ("Alpha Group GmbH", "Beta Group GmbH", "2020 - 2023"),
            ("Acme GmbH", "Acmeology GmbH", "2020 - 2023"),
        ]:
            self.assertEqual(classify_cop_former_employer(expected, [
                {"company": observed, "tenure": tenure},
            ])["status"], "company_mismatch")

    def test_missing_experience_is_ineligible(self):
        result = classify_cop_former_employer("Acme", [])
        self.assertEqual(result["status"], "experience_unavailable")


class CopProfileEvidenceTest(unittest.IsolatedAsyncioTestCase):
    async def test_profile_identity_mismatch_blocks_employer_evidence(self):
        lead = Lead(id="lead-1", linkedin_url="https://www.linkedin.com/in/anna", first_name="Anna", last_name="Müller", company_name="Acme")
        page = MagicMock()
        with patch.object(scraper, "first_match_text", AsyncMock(return_value="Someone Else")):
            result = await scraper.verify_cop_employer_on_page(page, lead)
        self.assertEqual(result["status"], "profile_identity_mismatch")

    async def test_full_experience_page_can_verify_role_after_first_three(self):
        lead = Lead(id="lead-1", linkedin_url="https://www.linkedin.com/in/anna", first_name="Anna", last_name="Müller", company_name="Acme GmbH")
        page = MagicMock()
        page.locator.return_value.count = AsyncMock(return_value=1)
        page.locator.return_value.first.get_attribute = AsyncMock(return_value="/in/anna/details/experience/")
        page.goto = AsyncMock()
        page.wait_for_selector = AsyncMock()
        roles = [{"company": f"Other {n}", "tenure": "2020 - 2021"} for n in range(4)]
        roles.append({"company": "Acme", "tenure": "2015 - 2018"})
        with patch.object(scraper, "first_match_text", AsyncMock(return_value="Anna Müller")), patch.object(
            scraper, "scrape_experience", AsyncMock(return_value=roles)
        ) as scrape:
            result = await scraper.verify_cop_employer_on_page(page, lead)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(scrape.await_args.kwargs["max_items"], 100)


if __name__ == "__main__":
    unittest.main()
