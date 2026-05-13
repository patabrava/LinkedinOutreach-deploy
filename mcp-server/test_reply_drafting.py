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


if __name__ == "__main__":
    unittest.main()
