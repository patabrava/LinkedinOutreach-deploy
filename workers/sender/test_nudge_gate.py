"""Unit tests for the NUDGE lead-state gate."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from sender import _nudge_lead_state_valid


def _lead(**overrides):
    base = {
        "id": "lead-1",
        "status": "SENT",
        "sent_at": "2026-04-26T15:00:00Z",
        "outreach_mode": "connect_only",
        "connection_sent_at": "2026-04-24T10:00:00Z",
        "connection_accepted_at": "2026-04-26T15:00:00Z",
    }
    base.update(overrides)
    return base


# --- Happy path ---

def test_connect_only_fully_connected_is_valid():
    ok, reason = _nudge_lead_state_valid(_lead())
    assert ok is True
    assert reason == ""


def test_non_connect_only_mode_only_needs_status_and_sent_at():
    ok, reason = _nudge_lead_state_valid(_lead(
        outreach_mode="message_only",
        connection_sent_at=None,
        connection_accepted_at=None,
    ))
    assert ok is True
    assert reason == ""


# --- Status gate ---

def test_status_failed_is_invalid():
    # Yigit's shape from the 2026-05-12 incident.
    ok, reason = _nudge_lead_state_valid(_lead(
        status="FAILED",
        sent_at=None,
        connection_sent_at=None,
        connection_accepted_at=None,
    ))
    assert ok is False
    assert "lead_status_FAILED" in reason


def test_status_new_is_invalid():
    ok, reason = _nudge_lead_state_valid(_lead(status="NEW", sent_at=None))
    assert ok is False
    assert "lead_status_NEW" in reason


def test_status_missing_is_invalid():
    ok, reason = _nudge_lead_state_valid(_lead(status=None))
    assert ok is False
    assert "lead_status_unknown" in reason


# --- sent_at gate ---

def test_sent_at_null_is_invalid_even_if_status_sent():
    ok, reason = _nudge_lead_state_valid(_lead(sent_at=None))
    assert ok is False
    assert "sent_at_null" in reason


# --- connect_only sub-gate ---

def test_connect_only_with_no_connection_sent_at_is_invalid():
    # Marina's shape from the incident: status=SENT, sent_at set, but no connect record.
    ok, reason = _nudge_lead_state_valid(_lead(
        connection_sent_at=None,
        connection_accepted_at=None,
    ))
    assert ok is False
    assert "connect_only_invite_not_sent" in reason


def test_connect_only_with_accepted_but_no_sent_is_invalid():
    # Benedikt/Kálmán/Yanis shape: incoming invite accepted, no outbound connect.
    # We did not initiate sequenced outreach → no NUDGE basis.
    ok, reason = _nudge_lead_state_valid(_lead(
        connection_sent_at=None,
        connection_accepted_at="2026-04-26T15:00:00Z",
    ))
    assert ok is False
    assert "connect_only_invite_not_sent" in reason


def test_connect_only_invite_sent_but_not_accepted_is_invalid():
    # Edge case: we sent the invite but they haven't accepted. Can't message yet.
    ok, reason = _nudge_lead_state_valid(_lead(connection_accepted_at=None))
    assert ok is False
    assert "connect_only_not_accepted" in reason


# --- Defensive ---

def test_empty_dict_is_invalid():
    ok, reason = _nudge_lead_state_valid({})
    assert ok is False
    assert reason  # must give some non-empty reason


def test_outreach_mode_case_insensitive():
    # Status check uses upper(); outreach_mode comparison should be tolerant of case.
    ok, reason = _nudge_lead_state_valid(_lead(outreach_mode="CONNECT_ONLY"))
    assert ok is True
    assert reason == ""
