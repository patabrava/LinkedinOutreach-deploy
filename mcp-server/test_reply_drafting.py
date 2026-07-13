#!/usr/bin/env python3
"""Tests for Gemini-backed reply draft contract."""

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import run_followup_agent as agent


class ReplyDraftingTest(unittest.TestCase):
    def test_positive_reply_preserves_booking_link(self):
        payload = json.dumps({
            "intent": "positive",
            "draft_text": "Freut mich zu hören, hier kannst du einen Termin buchen https://api.degura.de/2.0/consultants/my-scheduling-link",
            "confidence": 0.91,
        })
        result = agent.parse_reply_generation_response(payload)

        self.assertEqual(result["intent"], "positive")
        self.assertEqual(result["confidence"], 0.91)
        self.assertIn(agent.POSITIVE_REPLY_LINK, result["message"])

    def test_negative_reply_preserves_website_link(self):
        payload = json.dumps({
            "intent": "negative",
            "draft_text": "Kein Problem, falls es später interessant wird findest du hier Infos https://www.degura.de/arbeitnehmer",
            "confidence": 0.74,
        })
        result = agent.parse_reply_generation_response(payload)

        self.assertEqual(result["intent"], "negative")
        self.assertIn(agent.NEGATIVE_REPLY_LINK, result["message"])

    def test_ambiguous_intent_defaults_to_negative(self):
        payload = json.dumps({
            "intent": "unclear",
            "draft_text": "Schau gerne hier vorbei https://www.degura.de/arbeitnehmer",
            "confidence": 0.32,
        })
        result = agent.parse_reply_generation_response(payload)

        self.assertEqual(result["intent"], "negative")
        self.assertIn(agent.NEGATIVE_REPLY_LINK, result["message"])

    def test_rejects_missing_required_link(self):
        payload = json.dumps({
            "intent": "positive",
            "draft_text": "Freut mich, ich melde mich dazu.",
            "confidence": 0.9,
        })

        with self.assertRaises(ValueError) as raised:
            agent.parse_reply_generation_response(payload)

        self.assertIn("approved link", str(raised.exception))

    def test_rejects_invalid_json(self):
        with self.assertRaises(ValueError) as raised:
            agent.parse_reply_generation_response("not json")

        self.assertIn("valid JSON", str(raised.exception))

    def test_generate_reply_uses_gemini_adapter_for_reply_rows(self):
        context = {
            "followup_id": "fu_1",
            "followup_type": "REPLY",
            "reply_snippet": "Ja, das klingt interessant.",
            "last_message_text": "Ja, das klingt interessant.",
            "last_message_from": "lead",
        }
        payload = json.dumps({
            "intent": "positive",
            "draft_text": f"Gerne, buch dir hier einen Termin {agent.POSITIVE_REPLY_LINK}",
            "confidence": 0.88,
        })

        with patch.object(agent, "call_gemini_reply_model", return_value=payload):
            result = agent.generate_followup(context)

        self.assertEqual(result["intent"], "positive")
        self.assertEqual(result["message_type"], "reply_positive")
        self.assertIn(agent.POSITIVE_REPLY_LINK, result["message"])

    def test_reply_prompt_treats_vendor_counter_pitch_as_negative(self):
        prompt = agent.build_reply_generation_prompt({
            "first_name": "Daniel",
            "company_name": "ServiceNow",
            "last_message_text": "Wie sieht es denn bei Degura mit eurem IT-Ticketsystem aus?",
            "last_message_from": "lead",
            "followup_type": "REPLY",
        })

        self.assertIn("eigene Leistung anbietet", prompt)
        self.assertIn("Verkaufsgespräch", prompt)
        self.assertIn("bestens aufgestellt", prompt)
        self.assertIn("Niemals mit dem Vornamen", prompt)
        self.assertIn("Nicht paraphrasieren", prompt)

    def test_negative_reply_rewrites_vendor_counter_pitch_without_name_or_paraphrase(self):
        payload = json.dumps({
            "intent": "negative",
            "draft_text": (
                "Danke für die Nachfrage zu unserem IT-Ticketsystem, Daniel. "
                f"Wenn das Thema Altersvorsorge später interessant wird, findest du hier einen Überblick: {agent.NEGATIVE_REPLY_LINK}"
            ),
            "confidence": 0.82,
        })
        result = agent.parse_reply_generation_response(payload, {
            "first_name": "Daniel",
            "last_message_text": (
                "Hi Katharina, wir sind bei ServiceNow sehr gut abgesichert, was Altersvorsorge angeht. "
                "Wie sieht es denn anders herum bei Degura mit eurem IT-Ticketsystem aus?"
            ),
        })

        self.assertIn("bestens aufgestellt", result["message"])
        self.assertIn("lieb von dir zu fragen", result["message"])
        self.assertIn("schau gerne hier vorbei", result["message"])
        self.assertNotIn("Daniel", result["message"])
        self.assertNotIn("Danke für die Nachfrage zu", result["message"])
        self.assertIn(agent.NEGATIVE_REPLY_LINK, result["message"])

    def test_negative_reply_rewrites_relocation_paraphrase_to_natural_close(self):
        payload = json.dumps({
            "intent": "negative",
            "draft_text": (
                "Schade, dass es durch deinen Umzug nach Bulgarien nicht passt. "
                f"Wenn es später interessant wird, findest du hier einen Überblick: {agent.NEGATIVE_REPLY_LINK}"
            ),
            "confidence": 0.79,
        })
        result = agent.parse_reply_generation_response(payload, {
            "first_name": "Atanas",
            "last_message_text": (
                "Hi Katharina, Danke für die Nachricht! Das wird bei mir wahrscheinlich nicht zutreffen, "
                "da ich nach Bulgarien gezogen bin."
            ),
        })

        self.assertIn("macht das aktuell keinen Sinn", result["message"])
        self.assertIn("schau gerne hier vorbei", result["message"])
        self.assertNotIn("Atanas", result["message"])
        self.assertNotIn("Bulgarien", result["message"])
        self.assertNotIn("Schade, dass", result["message"])
        self.assertIn(agent.NEGATIVE_REPLY_LINK, result["message"])

    def test_negative_reply_warms_old_link_phrase_even_when_model_avoids_echo(self):
        payload = json.dumps({
            "intent": "negative",
            "draft_text": (
                "Alles gut, danke dir. Beim IT-Ticketsystem sind wir bestens aufgestellt. "
                f"Wenn es später interessant wird, findest du hier einen Überblick: {agent.NEGATIVE_REPLY_LINK}"
            ),
            "confidence": 0.91,
        })
        result = agent.parse_reply_generation_response(payload, {
            "first_name": "Daniel",
            "last_message_text": "Wie sieht es denn bei Degura mit eurem IT-Ticketsystem aus?",
        })

        self.assertIn("lieb von dir zu fragen", result["message"])
        self.assertIn("schau gerne hier vorbei", result["message"])
        self.assertNotIn("findest du hier einen Überblick", result["message"])
        self.assertIn(agent.NEGATIVE_REPLY_LINK, result["message"])

    def test_negative_reply_uses_english_fallback_for_english_no_interest(self):
        payload = json.dumps({
            "intent": "negative",
            "draft_text": (
                "Thanks for letting me know that you are not interested. "
                f"If it becomes relevant later, here is some info: {agent.NEGATIVE_REPLY_LINK}"
            ),
            "confidence": 0.88,
        })
        result = agent.parse_reply_generation_response(payload, {
            "first_name": "Gulshan",
            "last_message_text": "Thank you for reaching out, however I am not interested at the moment.",
        })

        self.assertIn("Totally understandable", result["message"])
        self.assertIn("feel free to take a look here", result["message"])
        self.assertNotIn("Gulshan", result["message"])
        self.assertIn(agent.NEGATIVE_REPLY_LINK, result["message"])


if __name__ == "__main__":
    unittest.main()
