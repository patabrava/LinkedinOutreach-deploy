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

from playwright.async_api import Page


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


def _safe_text(value: Optional[str]) -> str:
    if not value:
        return ""
    return " ".join(value.split()).strip()


async def extract_last_bubble(page: Page) -> Optional[Bubble]:
    """Read the most recent message bubble from an open LinkedIn message surface.

    Returns a Bubble dict or None if no bubbles are visible (e.g., empty
    thread, surface still loading, unrecognized DOM).

    Ported from workers/scraper/scraper.py::extract_last_message_from_conversation
    — same selector lists, same outbound-hint heuristics, same fallbacks.
    """
    try:
        await page.wait_for_timeout(800)

        message_selectors = [
            "li.msg-s-message-list__event",
            "div.msg-s-event-listitem",
            "div.msg-s-message-group",
            "li[class*='message']",
        ]

        messages = None
        for selector in message_selectors:
            items = page.locator(selector)
            count = await items.count()
            if count > 0:
                messages = items
                break

        if not messages or await messages.count() == 0:
            return None

        last_msg = messages.last

        sender = ""
        sender_selectors = [
            "span.msg-s-message-group__name",
            "span.msg-s-event-listitem__sender-name",
            "a.msg-s-message-group__profile-link",
            "span[class*='sender']",
            "span[class*='name']",
        ]
        for sel in sender_selectors:
            try:
                sender_el = last_msg.locator(sel).first
                if await sender_el.count():
                    sender = _safe_text(await sender_el.text_content(timeout=2_000))
                    if sender:
                        break
            except Exception:
                continue

        text = ""
        text_selectors = [
            "p.msg-s-event-listitem__body",
            "div.msg-s-event-listitem__body",
            "p.msg-s-message-group__body",
            "span.msg-s-event-listitem__message-body",
            "p[class*='body']",
        ]
        for sel in text_selectors:
            try:
                text_el = last_msg.locator(sel).first
                if await text_el.count():
                    text = _safe_text(await text_el.text_content(timeout=2_000))
                    if text:
                        break
            except Exception:
                continue

        if not text:
            try:
                text = _safe_text(await last_msg.inner_text(timeout=3_000))[:500]
            except Exception:
                pass

        is_outbound = False
        try:
            msg_classes = await last_msg.get_attribute("class") or ""
            if "outbound" in msg_classes.lower() or "sent" in msg_classes.lower():
                is_outbound = True

            try:
                parent = last_msg.locator("xpath=..")
                parent_classes = await parent.get_attribute("class") or ""
                if "outbound" in parent_classes.lower() or "from-me" in parent_classes.lower():
                    is_outbound = True
            except Exception:
                pass

            if sender.lower() in {"sie", "you", "ich"}:
                is_outbound = True

            try:
                style = await last_msg.get_attribute("style") or ""
                if "right" in style.lower() or "flex-end" in style.lower():
                    is_outbound = True
            except Exception:
                pass
        except Exception:
            pass

        return {
            "sender": sender,
            "text": text,
            "is_outbound": is_outbound,
        }

    except Exception:
        return None
