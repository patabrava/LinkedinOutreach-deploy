"""Shared helpers for reading the latest message bubble in a LinkedIn thread.

Two responsibilities:

1. `extract_last_bubble(page)` — Playwright DOM reader. Ported verbatim from
   the scraper so both scraper.inbox_scan and sender.process_followup_one
   read bubbles the same way.

2. `classify_last_sender(bubble, lead_full_name, lead_first_name)` — pure
   function that decides whether the last bubble is ours, the lead's, or
   unknown. Unit-tested.

The classifier returns three states. The scraper's existing inline logic
coerced anything-not-clearly-lead to "us"; we surface "unknown" explicitly
so the sender can log/escalate on it without changing scraper behavior.
"""

from __future__ import annotations

from typing import Optional, TypedDict


class Bubble(TypedDict):
    sender: str       # Raw sender text scraped from DOM. May be "Sie", "Alice", "" etc.
    text: str         # Message body text.
    is_outbound: bool # DOM-derived hint (CSS class / style / alignment).


SenderClass = str  # one of "us" | "lead" | "unknown"

_US_MARKERS = {"sie", "you", "ich", ""}


def classify_last_sender(bubble: Bubble, lead_full_name: str, lead_first_name: str) -> SenderClass:
    """Decide whether the last bubble is ours, the lead's, or unknown.

    Logic ported from workers/scraper/scraper.py:2302-2330:
      1. If the DOM marked the bubble as outbound → "us".
      2. If the sender label is one of {"sie", "you", "ich", ""} (case-insensitive) → "us".
      3. If the sender matches the lead's full or first name (incl. substring
         containment in either direction, case-insensitive) → "lead".
      4. Otherwise → "unknown".

    The scraper currently treats branch 4 as outbound. To preserve that
    behavior, scraper callers should check `== "lead"` rather than `!= "us"`.
    """
    if bubble.get("is_outbound"):
        return "us"

    sender_lower = (bubble.get("sender") or "").lower().strip()
    if sender_lower in _US_MARKERS:
        return "us"

    full_lower = (lead_full_name or "").lower().strip()
    first_lower = (lead_first_name or "").lower().strip()
    if first_lower and (
        sender_lower == full_lower
        or sender_lower == first_lower
        or first_lower in sender_lower
        or (full_lower and sender_lower in full_lower)
    ):
        return "lead"

    return "unknown"
