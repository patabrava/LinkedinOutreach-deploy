import re
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "supabase" / "migrations" / "020_seed_degura_campaign.sql"
MIGRATION = ROOT / "supabase" / "migrations" / "019_add_two_account_campaign.sql"


class DeguraSeedContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seed = SEED.read_text(encoding="utf-8")
        cls.migration = MIGRATION.read_text(encoding="utf-8")

    def test_seed_has_six_variants_and_invite_notes_fit_linkedin_limit(self):
        blocks = re.findall(
            r"SELECT s[.]id, ([12]),\s*\$copy\$(.*?)\$copy\$,(.*?)FROM outreach_sequences s WHERE s[.]campaign_key = '(DEGURA_[ABC])'",
            self.seed,
            flags=re.DOTALL,
        )
        self.assertEqual(len(blocks), 6)
        self.assertTrue(all(len(connect_note) <= 300 for _, connect_note, _, _ in blocks))
        self.assertEqual({(family, variant) for variant, _, _, family in blocks}, {
            ("DEGURA_A", "1"), ("DEGURA_A", "2"),
            ("DEGURA_B", "1"), ("DEGURA_B", "2"),
            ("DEGURA_C", "1"), ("DEGURA_C", "2"),
        })

    def test_migration_enforces_canonical_unique_urls_and_immutable_ownership(self):
        self.assertIn("idx_leads_linkedin_url_canonical_unique", self.migration)
        self.assertIn("tg_leads_prevent_outreach_owner_reassignment", self.migration)
        self.assertIn("Exactly two active LinkedIn accounts", self.migration)
        self.assertIn("Every imported lead must reference an active variant", self.migration)


if __name__ == "__main__":
    unittest.main()
