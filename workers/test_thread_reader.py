"""Unit tests for thread_reader.classify_last_sender (pure logic, no DOM)."""

import sys
from pathlib import Path

# Match the import pattern used by scraper.py / sender.py.
sys.path.insert(0, str(Path(__file__).parent))

from thread_reader import classify_last_sender


def _bubble(sender: str, is_outbound: bool = False, text: str = "hi"):
    return {"sender": sender, "text": text, "is_outbound": is_outbound}


def test_outbound_flag_wins_even_with_lead_name_sender():
    # Scraper DOM hint trumps everything else — preserves existing behavior.
    assert classify_last_sender(_bubble("Alice Schmidt", is_outbound=True), "Alice Schmidt", "Alice") == "us"


def test_sender_sie_is_us():
    assert classify_last_sender(_bubble("Sie"), "Alice Schmidt", "Alice") == "us"


def test_sender_you_is_us():
    assert classify_last_sender(_bubble("You"), "Alice Schmidt", "Alice") == "us"


def test_sender_ich_is_us():
    assert classify_last_sender(_bubble("Ich"), "Alice Schmidt", "Alice") == "us"


def test_empty_sender_is_us():
    assert classify_last_sender(_bubble(""), "Alice Schmidt", "Alice") == "us"


def test_sender_full_name_match_is_lead():
    assert classify_last_sender(_bubble("Alice Schmidt"), "Alice Schmidt", "Alice") == "lead"


def test_sender_first_name_only_is_lead():
    assert classify_last_sender(_bubble("Alice"), "Alice Schmidt", "Alice") == "lead"


def test_sender_first_name_substring_is_lead():
    # Scraper accepts "Dr. Alice Schmidt" because "alice" is in the sender string.
    assert classify_last_sender(_bubble("Dr. Alice Schmidt"), "Alice Schmidt", "Alice") == "lead"


def test_sender_case_insensitive():
    assert classify_last_sender(_bubble("ALICE schmidt"), "Alice Schmidt", "Alice") == "lead"


def test_third_party_sender_is_unknown():
    # Sender doesn't match lead name and isn't a known "us" marker. Scraper
    # currently treats this as outbound; the sender will log a warning and proceed.
    assert classify_last_sender(_bubble("Bob Other"), "Alice Schmidt", "Alice") == "unknown"


def test_empty_first_name_falls_through_to_unknown():
    # Defensive: don't match arbitrary senders when we have no first name to compare.
    assert classify_last_sender(_bubble("Anything"), "Alice Schmidt", "") == "unknown"


def test_whitespace_only_sender_is_us():
    assert classify_last_sender(_bubble("   "), "Alice Schmidt", "Alice") == "us"
