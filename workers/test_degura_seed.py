import re
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "supabase" / "migrations" / "020_seed_degura_campaign.sql"
COPY_SPEC = ROOT / "degura-linkedin-sequenzen.md"
COPY_SYNC = ROOT / "supabase" / "migrations" / "023_sync_degura_copy_v2.sql"
COPY_PATCH = ROOT / "supabase" / "migrations" / "024_sync_degura_copy_september_2026.sql"
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

    def test_version_2_copy_correction_preserves_approved_a1_link_and_closing(self):
        self.assertTrue(COPY_SPEC.is_file(), "The approved Version 2 Markdown must be kept in the repository")
        self.assertTrue(COPY_SYNC.is_file(), "A forward migration must correct already-seeded databases")
        approved = COPY_SPEC.read_text(encoding="utf-8")
        correction = COPY_SYNC.read_text(encoding="utf-8")
        calendly_line = (
            "Toby, unser bAV Experte, kann es Dir zeigen: "
            "https://calendly.com/toby-weber-degura/videotelefonat-mit-toby-30min"
        )
        closing = "Ansonten, wünsche ich Dir weiterhin viel Erfolg und einen schönen Tag."
        self.assertIn(calendly_line, approved)
        self.assertIn(closing, approved)
        self.assertIn(calendly_line, correction)
        self.assertIn(closing, correction)

    def test_september_copy_patch_uses_full_name_only_for_formal_connection_notes(self):
        self.assertTrue(COPY_PATCH.is_file(), "A forward migration must apply the September copy changes")
        patch = COPY_PATCH.read_text(encoding="utf-8")
        formal_notes = re.findall(
            r"\('DEGURA_C',\s*[12],\s*'connect_note',\s*\$copy\$(.*?)\$copy\$\)",
            patch,
            flags=re.DOTALL,
        )
        self.assertEqual(len(formal_notes), 2)
        self.assertTrue(all(note.startswith("Guten Tag {{full_name}},") for note in formal_notes))
        self.assertNotIn("{{full_name}}", "\n".join(
            message for family, _, _, message in re.findall(
                r"\('(DEGURA_[AB])',\s*([12]),\s*'([^']+)',\s*\$copy\$(.*?)\$copy\$\)",
                patch,
                flags=re.DOTALL,
            )
        ))

    def test_version_2_copy_correction_matches_every_approved_outbound_message(self):
        approved = COPY_SPEC.read_text(encoding="utf-8")
        correction = COPY_SYNC.read_text(encoding="utf-8")

        def between(text, start, end=None):
            value = text.split(start, 1)[1]
            return value.split(end, 1)[0] if end else value

        def quoted_message(text):
            result = []
            started = False
            for raw_line in text.splitlines():
                quote = re.match(r"^>\s?(.*)$", raw_line)
                bare_link = re.match(r"^https://\S+\s*$", raw_line)
                if quote:
                    started = True
                    result.append(quote.group(1).strip())
                elif bare_link:
                    started = True
                    result.append(raw_line.strip())
                elif started and not raw_line.strip():
                    result.append("")
            compact = []
            for line in result:
                if line or (compact and compact[-1]):
                    compact.append(line)
            return "\n".join(compact).strip()

        def variant_message(touch, number):
            marker = re.search(rf"^\*\*Variante {number}(?:,.*?)?\*\*.*$", touch, flags=re.MULTILINE)
            self.assertIsNotNone(marker)
            remainder = touch[marker.end():]
            next_variant = re.search(r"^\*\*Variante [12](?:,.*?)?\*\*.*$", remainder, flags=re.MULTILINE)
            return quoted_message(remainder[:next_variant.start()] if next_variant else remainder)

        def normalize(value):
            replacements = {
                "{{Vorname}} {{Nachname}}": "{{full_name}}",
                "{{Vorname}}": "{{first_name}}",
                "{{Nachname}}": "{{last_name}}",
                "{{Company Name}}": "{{company_name}}",
                "{{Company_Name}}": "{{company_name}}",
                "{{Firma}}": "{{company_name}}",
                "{{Compamy}}": "{{company_name}}",
            }
            for source, target in replacements.items():
                value = value.replace(source, target)
            return value.replace("20 Minuten", "30 Minuten").strip()

        sequence_a = between(approved, "# Sequenz A: Rentenreform", "# Sequenz B:")
        sequence_b = between(approved, "# Sequenz B: bAV Leitfaden, Du-Form", "# Sequenz C:")
        sequence_c = between(approved, "# Sequenz C: bAV Leitfaden, formelle Ansprache", "# Sequenzübergreifend")

        def touches(sequence):
            return {
                1: between(sequence, "## Touch 1,", "## Touch 2,"),
                2: between(sequence, "## Touch 2,", "## Touch 3,"),
                3: between(sequence, "## Touch 3,", "## Touch 4,"),
                4: between(sequence, "## Touch 4,", "## Antwortpfade"),
            }

        a, b, c = touches(sequence_a), touches(sequence_b), touches(sequence_c)
        b_assets = between(sequence_b, "## Asset-Follow-up")
        c_assets = between(sequence_c, "## Asset-Follow-up Sequenz C")

        def followup(asset_section, number):
            marker = re.search(rf"^\*\*Follow-up {number},.*?\*\*$", asset_section, flags=re.MULTILINE)
            self.assertIsNotNone(marker)
            remainder = asset_section[marker.end():]
            next_followup = re.search(r"^\*\*Follow-up [12],.*?\*\*$", remainder, flags=re.MULTILINE)
            return quoted_message(remainder[:next_followup.start()] if next_followup else remainder)

        expected = {}
        for variant in (1, 2):
            expected[("DEGURA_A", variant)] = tuple(map(normalize, (
                variant_message(a[1], variant), variant_message(a[2], variant),
                variant_message(a[3], variant), variant_message(a[4], variant),
                followup(b_assets, 1), followup(b_assets, 2),
            )))
            expected[("DEGURA_B", variant)] = tuple(map(normalize, (
                variant_message(b[1], variant), variant_message(b[2], variant),
                variant_message(b[3], variant), variant_message(b[4], variant),
                followup(b_assets, 1), followup(b_assets, 2),
            )))
            expected[("DEGURA_C", variant)] = tuple(map(normalize, (
                variant_message(c[1], variant), variant_message(c[2], variant),
                variant_message(c[3], variant), quoted_message(c[4]),
                followup(c_assets, 1), followup(c_assets, 2),
            )))

        copy_value = r"\$copy\$(.*?)\$copy\$"
        row_pattern = re.compile(
            r"\('(DEGURA_[ABC])',\s*([12]),\s*" +
            r",\s*".join([copy_value] * 6) + r"\)",
            flags=re.DOTALL,
        )
        actual = {
            (match.group(1), int(match.group(2))): tuple(value.strip() for value in match.groups()[2:])
            for match in row_pattern.finditer(correction)
        }
        field_indexes = {
            "connect_note": 0,
            "first_message": 1,
            "second_message": 2,
            "third_message": 3,
            "asset_followup_1": 4,
            "asset_followup_2": 5,
        }
        patch_pattern = re.compile(
            r"\('(DEGURA_[ABC])',\s*([12]),\s*'([^']+)',\s*\$copy\$(.*?)\$copy\$\)",
            flags=re.DOTALL,
        )
        patches = patch_pattern.findall(COPY_PATCH.read_text(encoding="utf-8"))
        self.assertEqual(len(patches), 8)
        for family, variant, field_name, content in patches:
            key = (family, int(variant))
            row = list(actual[key])
            row[field_indexes[field_name]] = content.strip()
            actual[key] = tuple(row)
        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
