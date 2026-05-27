"""LinkedIn profile and activity scraper."""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import os
import time
import random
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from playwright.async_api import BrowserContext, Page, TimeoutError
from supabase import Client, create_client
from tenacity import retry, stop_after_attempt, wait_fixed

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from auth import (
    AUTH_STATE_PATH,
    is_logged_in,
    open_browser,
    reset_remote_login_state,
    save_storage_state,
    shutdown,
    sync_remote_session_to_auth,
    update_auth_status,
)

# Import shared logger
from credential_crypto import decrypt_password
from shared_logger import get_logger

# Load .env from scraper directory explicitly
env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=env_path)
print(f"[SCRAPER] Loading .env from: {env_path}", file=sys.stderr)
print(f"[SCRAPER] .env exists: {env_path.exists()}", file=sys.stderr)

# Initialize logger
logger = get_logger("scraper")

# Avoid tripping LinkedIn automation warnings by capping daily enrichments.
DEFAULT_DAILY_ENRICHMENT_CAP = 20
DAILY_INBOX_SCAN_LIMIT = 60
INBOX_SCAN_COOLDOWN_HOURS = 24  # skip re-opening profiles scanned within this window
PENDING_INVITE_BACKOFF_DAYS = 7  # skip pending invites for this many days
INBOX_REPLY_CANDIDATE_STATUSES = [
    "SENT",
    "FAILED",
    "CONNECT_ONLY_SENT",
    "CONNECTED",
    "MESSAGE_ONLY_READY",
    "MESSAGE_ONLY_APPROVED",
]
INBOX_RECENT_CONVERSATION_LIMIT = 60
INBOX_CARD_FIELD_TIMEOUT_MS = 500
CONNECT_DIALOG_TIMEOUT_MS = 15_000
CONNECTION_DIALOG_CSS = (
    "section[role='dialog'], div[role='dialog'], [role='alertdialog'], "
    ".artdeco-modal, .send-invite"
)
CONNECTION_DIALOG_TEXT_PATTERNS = [
    re.compile(r"Eine Nachricht zu Ihrer Einladung hinzufügen", re.I),
    re.compile(r"Add a note to your invitation", re.I),
]


def get_daily_enrichment_cap() -> int:
    env_limit = os.getenv("DAILY_ENRICHMENT_CAP", "").strip()
    try:
        parsed_limit = int(env_limit) if env_limit else DEFAULT_DAILY_ENRICHMENT_CAP
    except Exception:
        parsed_limit = DEFAULT_DAILY_ENRICHMENT_CAP
    return max(parsed_limit, 1)


# NOTE: WeeklyInviteLimitReached, detect_weekly_invite_limit,
# capture_connect_failure_screenshot, and send_connection_request below are
# imported by workers/sender/sender.py for the --send-invites flow. Do not
# delete them when removing the connect_only scraper mode.
class WeeklyInviteLimitReached(RuntimeError):
    """Raised when LinkedIn blocks additional invites for the week."""
    pass


@dataclass
class Lead:
    id: str
    linkedin_url: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    company_name: Optional[str] = None


@dataclass
class LinkedinCredentials:
    email: str
    password: str


def get_supabase_client() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    print(f"[SCRAPER] SUPABASE_URL: {url[:32] if url else 'MISSING'}", file=sys.stderr)
    print(f"[SCRAPER] SUPABASE_SERVICE_ROLE_KEY: {'SET' if key else 'MISSING'}", file=sys.stderr)
    if not url or not key:
        logger.error("Missing Supabase configuration", data={"has_url": bool(url), "has_key": bool(key)})
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    logger.debug("Supabase client initialized")
    print(f"[SCRAPER] Supabase client created successfully", file=sys.stderr)
    return create_client(url, key)


def now_iso_utc() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


async def capture_connect_failure_screenshot(page: Page, reason: str, lead_id: Optional[str] = None) -> Optional[str]:
    """Best-effort screenshot capture for connect-only failures."""
    try:
        out_dir = Path(__file__).parent / "output" / "connect_failures"
        out_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_reason = re.sub(r"[^a-zA-Z0-9_-]+", "_", reason).strip("_") or "unknown"
        safe_lead = re.sub(r"[^a-zA-Z0-9_-]+", "_", lead_id or "unknown").strip("_")
        path = out_dir / f"{ts}_{safe_lead}_{safe_reason}.png"
        await page.screenshot(path=str(path), full_page=True)
        logger.info("Captured connect-only failure screenshot", data={"reason": reason, "path": str(path)})
        return str(path)
    except Exception as exc:
        logger.warn("Failed to capture connect-only failure screenshot", error=exc, data={"reason": reason})
        return None


def _detect_weekly_invite_limit_text(text: str) -> Optional[str]:
    """Detect LinkedIn invite-limit copy without matching normal invite dialogs."""
    normalized_text = " ".join((text or "").split()).lower()
    if not normalized_text:
        return None

    strong_patterns = [
        "weekly limit",
        "weekly invitation limit",
        "weekly invitation sending limit",
        "invite limit reached",
        "invitation limit reached",
        "contact request limit",
        "contact request limits",
        "too many invitations",
        "too many contact requests",
        "reached a limit",
        "you've reached",
        "you have reached",
        "next week",
        "wöchentliches limit",
        "wöchentliche limit",
        "wöchentlichen limit",
        "wöchentliche kontaktanfragen erreicht",
        "limit für kontaktanfragen",
        "limit für einladungen",
        "zu viele einladungen",
        "zu viele kontaktanfragen",
        "nächste woche",
    ]
    if any(pattern in normalized_text for pattern in strong_patterns):
        return "LinkedIn weekly invite limit reached. Please retry next week."

    limit_words = ("limit", "limits", "begrenzt", "begrenzung", "beschränkung", "erreicht")
    invite_words = (
        "invite",
        "invitation",
        "invitations",
        "contact request",
        "contact requests",
        "einladung",
        "einladungen",
        "kontaktanfrage",
        "kontaktanfragen",
    )
    retry_words = ("next week", "später", "woche", "week")
    if (
        any(word in normalized_text for word in limit_words)
        and any(word in normalized_text for word in invite_words)
        and any(word in normalized_text for word in retry_words)
    ):
        return "LinkedIn weekly invite limit reached. Please retry next week."

    return None


async def detect_weekly_invite_limit(page: Page) -> Optional[str]:
    """Best-effort detection for LinkedIn's weekly invite cap dialog."""
    text_candidates: List[str] = []
    for selector in ["section[role='dialog']", "div[role='dialog']", "[role='alertdialog']"]:
        try:
            text = await page.locator(selector).first.inner_text(timeout=2_000)
            if text:
                text_candidates.append(text)
        except Exception:
            continue

    return _detect_weekly_invite_limit_text("\n".join(text_candidates))


def _has_connection_request_confirmation(text: str) -> bool:
    normalized_text = " ".join(text.split()).lower()
    if not normalized_text:
        return False

    confirmation_patterns = [
        "ausstehend",
        "pending",
        "request sent",
        "invitation sent",
        "einladung gesendet",
        "kontaktanfrage gesendet",
        "invitation pending",
    ]
    return any(pattern in normalized_text for pattern in confirmation_patterns)


async def confirm_connection_request_sent(page: Page, timeout_ms: int = 8_000) -> bool:
    """Wait for a visible post-send confirmation that the invite actually landed."""
    deadline = asyncio.get_event_loop().time() + (timeout_ms / 1000)
    confirmation_selectors = [
        "button:has-text('Ausstehend')",
        "span:has-text('Ausstehend')",
        "button:has-text('Pending')",
        "span:has-text('Pending')",
        "button:has-text('Einladung gesendet')",
        "span:has-text('Einladung gesendet')",
        "button:has-text('Request sent')",
        "span:has-text('Request sent')",
    ]

    while asyncio.get_event_loop().time() < deadline:
        for selector in confirmation_selectors:
            try:
                locator = page.locator(selector)
                if await locator.count() > 0 and await locator.first.is_visible(timeout=500):
                    return True
            except Exception:
                continue

        try:
            body_text = await page.locator("body").inner_text(timeout=1_500)
        except Exception:
            body_text = ""
        if _has_connection_request_confirmation(body_text):
            return True

        await page.wait_for_timeout(250)

    return False


async def confirm_connection_request_sent_with_profile_recheck(
    page: Page,
    profile_url: str,
    *,
    timeout_ms: int = 8_000,
    recheck_timeout_ms: int = 20_000,
) -> bool:
    """Confirm invite delivery, recovering from LinkedIn's post-click loading page."""
    if await confirm_connection_request_sent(page, timeout_ms=timeout_ms):
        return True

    try:
        await page.wait_for_load_state("domcontentloaded", timeout=3_000)
    except Exception:
        pass

    if await confirm_connection_request_sent(page, timeout_ms=2_000):
        return True

    normalized = profile_url.replace("http://", "https://").split("?")[0].rstrip("/")
    if not normalized:
        return False

    logger.info("Connect-only send not confirmed on current page; rechecking profile state", data={"url": normalized})
    try:
        await gentle_nav(page, normalized)
        await page.wait_for_selector("main", timeout=recheck_timeout_ms)
        await page.wait_for_timeout(1_500)
    except Exception as exc:
        logger.warn("Connect-only profile recheck navigation failed", error=exc, data={"url": normalized})
        return False

    if await confirm_connection_request_sent(page, timeout_ms=recheck_timeout_ms):
        return True

    try:
        profile_container = page.get_by_test_id("lazy-column")
        await profile_container.wait_for(state="visible", timeout=3_000)
    except Exception:
        try:
            profile_container = page.locator("main.scaffold-layout__main, section.artdeco-card").first
            await profile_container.wait_for(state="visible", timeout=3_000)
        except Exception:
            profile_container = page

    try:
        more_button = profile_container.get_by_role("button", name=re.compile(r"(More|Mehr)", re.I))
        if await more_button.count() > 0:
            await more_button.first.click(timeout=6_000, force=True)
            await page.wait_for_timeout(700)
            menu_text = await page.locator("body").inner_text(timeout=2_000)
            if _has_connection_request_confirmation(menu_text):
                return True
    except Exception as exc:
        logger.warn("Connect-only profile recheck More menu inspection failed", error=exc, data={"url": normalized})
    finally:
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass

    return False


async def profile_has_pending_invite(page: Page, profile_container) -> bool:
    """Detect a pending invite on the profile action bar or More/Mehr menu."""
    pending_pattern = re.compile(r"(Ausstehend|Pending)", re.I)
    for role in ("button", "link"):
        try:
            pending = profile_container.get_by_role(role, name=pending_pattern)
            if await pending.count() > 0:
                return True
        except Exception:
            continue

    try:
        more_button = profile_container.get_by_role("button", name=re.compile(r"(More|Mehr)", re.I))
        if await more_button.count() == 0:
            return False
        await more_button.first.click(timeout=6_000, force=True)
        await page.wait_for_timeout(700)
        menu_pending = page.get_by_role("menuitem", name=pending_pattern)
        if await menu_pending.count() > 0:
            return True
        menu_text = await page.locator("body").inner_text(timeout=2_000)
        return bool(pending_pattern.search(menu_text))
    except Exception as exc:
        logger.warn("Connect-only pending invite inspection failed", error=exc)
        return False
    finally:
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass


def execute_with_retry(query, desc: str, attempts: int = 3, delay: float = 1.0):
    """Execute a Supabase query with basic retry/backoff for transient network errors."""
    last_exc = None
    for attempt in range(1, attempts + 1):
        try:
            return query.execute()
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            logger.warn(
                f"{desc} failed (attempt {attempt}/{attempts}), retrying...",
                error=exc,
            )
            if attempt < attempts:
                time.sleep(delay)
    # Exhausted retries
    logger.error(f"{desc} failed after {attempts} attempts", error=last_exc)
    raise last_exc


def extract_profile_meta(profile_data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(profile_data, dict):
        return {}
    meta = profile_data.get("meta")
    return meta if isinstance(meta, dict) else {}


def update_profile_meta(client: Client, lead_id: str, profile_data: Optional[Dict[str, Any]], meta_updates: Dict[str, Any]) -> None:
    """Persist meta flags inside profile_data.meta without schema changes."""
    base = profile_data if isinstance(profile_data, dict) else {}
    if not base:
        try:
            resp = (
                client.table("leads")
                .select("profile_data")
                .eq("id", lead_id)
                .limit(1)
                .execute()
            )
            base = (resp.data or [{}])[0].get("profile_data") or {}
        except Exception:
            base = {}
    meta = extract_profile_meta(base if isinstance(base, dict) else profile_data)
    meta.update(meta_updates)
    new_profile = {**base, "meta": meta}
    execute_with_retry(
        client.table("leads").update({"profile_data": new_profile}).eq("id", lead_id),
        desc=f"Update profile_data meta for lead {lead_id}",
    )


def fetch_new_leads(
    client: Client,
    limit: int = 10,
    outreach_mode: Optional[str] = None,
    sequence_id: Optional[int] = None,
) -> List[Lead]:
    query_meta: Dict[str, Any] = {"status": "NEW", "limit": limit}
    if outreach_mode:
        query_meta["outreach_mode"] = outreach_mode
    if sequence_id is not None:
        query_meta["sequence_id"] = sequence_id

    logger.db_query("select", "leads", query_meta)

    query = (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, company_name")
        .eq("status", "NEW")
        .limit(limit)
    )

    if outreach_mode:
        query = query.eq("outreach_mode", outreach_mode)
    if sequence_id is not None:
        query = query.eq("sequence_id", sequence_id)

    resp = query.execute()
    leads = [Lead(**row) for row in resp.data or []]

    logger.db_result("select", "leads", query_meta, len(leads))
    logger.info(
        f"Fetched {len(leads)} NEW leads",
        data={"count": len(leads), "outreach_mode": outreach_mode or "message"},
    )
    return leads


def fetch_pending_leads_for_intent(
    client: Client,
    limit: int,
    batch_intent: str,
    batch_id: Optional[int] = None,
) -> List[Lead]:
    """Fetch NEW leads for a specific batch_intent (e.g. 'custom_outreach')."""
    logger.db_query(
        "select",
        "leads",
        {"status": "NEW", "batch_intent": batch_intent, "limit": limit},
    )
    query = (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, company_name, batch_id, lead_batches!inner(batch_intent)")
        .eq("status", "NEW")
        .eq("lead_batches.batch_intent", batch_intent)
        .limit(limit)
    )
    if batch_id is not None:
        query = query.eq("batch_id", batch_id)
    response = query.execute()
    rows = response.data or []
    logger.db_result("select", "leads", {"status": "NEW", "batch_intent": batch_intent, "limit": limit}, len(rows))
    return [Lead(
        id=row["id"],
        linkedin_url=row["linkedin_url"],
        first_name=row.get("first_name"),
        last_name=row.get("last_name"),
        company_name=row.get("company_name"),
    ) for row in rows]


def fetch_today_enrichment_count(client: Client) -> int:
    """Return count of leads processed today (enriched or connect-only)."""
    start_of_day = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    tracked_statuses = ["ENRICHED", "CONNECT_ONLY_SENT"]
    logger.db_query("select-count", "leads", {"status": tracked_statuses}, {"since": start_of_day})
    resp = (
        client.table("leads")
        .select("id", count="exact")
        .in_("status", tracked_statuses)
        .gte("updated_at", start_of_day)
        .execute()
    )
    count = resp.count or 0
    logger.db_result("select-count", "leads", {"status": tracked_statuses}, count)
    logger.info(
        f"Enriched today: {count}",
        data={"count": count, "cap": get_daily_enrichment_cap(), "statuses": tracked_statuses},
    )
    return count


def fetch_linkedin_credentials(client: Client) -> Optional[LinkedinCredentials]:
    logger.db_query("select", "settings", {"key": "linkedin_credentials"})
    resp = (
        client.table("settings")
        .select("value")
        .eq("key", "linkedin_credentials")
        .limit(1)
        .execute()
    )
    value = (resp.data or [{}])[0].get("value") or {}
    email = value.get("email") or value.get("username")
    password = decrypt_password(value)
    has_creds = bool(email and password)
    logger.db_result("select", "settings", {"key": "linkedin_credentials"}, 1 if resp.data else 0)
    logger.info(f"LinkedIn credentials: {'found' if has_creds else 'not found'}")
    if not email or not password:
        return None
    return LinkedinCredentials(email=email, password=password)


async def random_pause(min_seconds: float = 3.5, max_seconds: float = 7.2) -> None:
    await asyncio.sleep(random.uniform(min_seconds, max_seconds))


async def wiggle_mouse(page: Page) -> None:
    """Move the mouse in small jittery motions to mimic human behavior."""
    width = (page.viewport_size or {}).get("width", 1200)
    height = (page.viewport_size or {}).get("height", 800)
    points = [
        (
            random.uniform(width * 0.2, width * 0.8),
            random.uniform(height * 0.2, height * 0.8),
        )
        for _ in range(3)
    ]
    for x, y in points:
        await page.mouse.move(x, y, steps=10)
        await asyncio.sleep(random.uniform(0.05, 0.2))


async def safe_click(page: Page, selector: str) -> None:
    await wiggle_mouse(page)
    await page.click(selector, timeout=15_000)
    await random_pause()


async def open_invite_dialog_from_anchor(page: Page, anchor, base_url: str) -> bool:
    """Open the LinkedIn invite dialog from the visible invite anchor.

    Try a force click first so the user-visible control is still activated even when
    LinkedIn overlays partially intercept pointer events. Fall back to direct invite
    URL navigation only if the click path does not open the dialog.
    """
    try:
        href = await anchor.get_attribute("href")
    except Exception:
        href = None

    try:
        await anchor.scroll_into_view_if_needed(timeout=4_000)
        await anchor.click(timeout=8_000, force=True)
        await wait_for_connection_dialog(page)
        await random_pause()
        return True
    except Exception as exc:
        logger.warn("connect-only: invite anchor force click failed", error=exc)

    if href:
        invite_url = urljoin(base_url, href)
        logger.debug("connect-only: navigating to invite URL", data={"inviteUrl": invite_url})
        try:
            await page.goto(invite_url, wait_until="domcontentloaded", timeout=20_000)
            await page.wait_for_timeout(2_500)
            await wait_for_connection_dialog(page)
            await random_pause()
            return True
        except Exception as exc:
            logger.warn("connect-only: invite URL navigation failed", error=exc, data={"inviteUrl": invite_url})

    return False


async def wait_for_connection_dialog(page: Page) -> None:
    """Wait for the LinkedIn connect/invite dialog to become usable."""
    try:
        await page.locator(CONNECTION_DIALOG_CSS).first.wait_for(state="visible", timeout=CONNECT_DIALOG_TIMEOUT_MS)
        await page.wait_for_timeout(500)
        return
    except Exception:
        pass
    for pattern in CONNECTION_DIALOG_TEXT_PATTERNS:
        try:
            await page.get_by_text(pattern).first.wait_for(state="visible", timeout=3_000)
            await page.wait_for_timeout(500)
            return
        except Exception:
            continue
    await page.locator(CONNECTION_DIALOG_CSS).first.wait_for(state="visible", timeout=1_000)


async def connection_dialog_is_visible(page: Page) -> bool:
    """Return true when LinkedIn opened the invite dialog despite a prior click timeout."""
    try:
        await page.locator(CONNECTION_DIALOG_CSS).first.wait_for(state="visible", timeout=5_000)
        await page.wait_for_timeout(500)
        return True
    except Exception:
        for pattern in CONNECTION_DIALOG_TEXT_PATTERNS:
            try:
                await page.get_by_text(pattern).first.wait_for(state="visible", timeout=1_500)
                await page.wait_for_timeout(500)
                return True
            except Exception:
                continue
    return False


def safe_text(value: Optional[str]) -> str:
    return value.strip() if value else ""


def normalize_person_name(value: Optional[str]) -> str:
    """Normalize a LinkedIn display name for exact-ish matching."""
    text = safe_text(value).lower()
    text = text.replace("-", " ")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"[^a-z0-9äöüßáàâãåéèêëíìîïóòôõúùûüñç ]", "", text)
    return text.strip()


def lead_display_name(lead: Dict[str, Any]) -> str:
    return " ".join(
        part for part in [
            safe_text(lead.get("first_name")),
            safe_text(lead.get("last_name")),
        ]
        if part
    ).strip()


def lead_search_terms(lead: Dict[str, Any]) -> List[str]:
    """Return conservative LinkedIn inbox search variants for a lead."""
    terms: List[str] = []
    full_name = lead_display_name(lead)
    if full_name:
        terms.append(full_name)

    first_name = safe_text(lead.get("first_name"))
    last_name = safe_text(lead.get("last_name"))
    if first_name and " " in last_name:
        terms.append(f"{first_name} {last_name.replace(' ', '-')}")

    slug = linkedin_profile_slug(lead.get("linkedin_url"))
    if slug:
        slug_words = re.sub(r"-[0-9a-f]{4,}$", "", slug)
        slug_words = re.sub(r"\s+", " ", slug_words.replace("-", " ")).strip()
        if slug_words:
            terms.append(slug_words)

    unique_terms: List[str] = []
    seen: set[str] = set()
    for term in terms:
        key = safe_text(term).lower()
        if key and key not in seen:
            seen.add(key)
            unique_terms.append(term)
    return unique_terms


def is_last_message_from_lead(convo_info: Dict[str, Any], lead: Dict[str, Any]) -> bool:
    """Return True when the extracted conversation tail is an inbound lead reply."""
    if convo_info.get("is_outbound"):
        return False

    sender = normalize_person_name(convo_info.get("sender"))
    if sender in {"", "sie", "you", "ich"}:
        return False

    full_name = normalize_person_name(lead_display_name(lead))
    first_name = normalize_person_name(lead.get("first_name"))
    last_name = normalize_person_name(lead.get("last_name"))
    return (
        sender == full_name
        or bool(first_name and sender == first_name)
        or bool(full_name and sender in full_name)
        or bool(first_name and last_name and first_name in sender and last_name in sender)
    )


def linkedin_profile_slug(value: Optional[str]) -> str:
    """Return the stable `/in/<slug>` key from a LinkedIn profile URL or href."""
    if not value:
        return ""
    raw = safe_text(value)
    parsed = urlparse(raw)
    path = parsed.path or raw
    match = re.search(r"(?:^|/)in/([^/?#]+)", path)
    if not match:
        match = re.search(r"linkedin\.com/in/([^/?#]+)", raw)
    if not match:
        return ""
    return unquote(match.group(1)).strip().lower().rstrip("/")


def build_inbox_candidate_indexes(leads: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Build exact URL and unique-name indexes for recent inbox matching."""
    by_slug: Dict[str, Dict[str, Any]] = {}
    by_name: Dict[str, Dict[str, Any]] = {}
    duplicate_names: set[str] = set()

    for lead in leads:
        slug = linkedin_profile_slug(lead.get("linkedin_url"))
        if slug and slug not in by_slug:
            by_slug[slug] = lead

        name = normalize_person_name(lead_display_name(lead))
        if not name:
            continue
        if name in by_name:
            duplicate_names.add(name)
            continue
        by_name[name] = lead

    for name in duplicate_names:
        by_name.pop(name, None)

    return {
        "by_slug": by_slug,
        "by_name": by_name,
    }


def match_inbox_summary_to_lead(
    summary: Dict[str, Any],
    indexes: Dict[str, Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Match a LinkedIn inbox conversation card to a lead, preferring profile URL."""
    slug = linkedin_profile_slug(summary.get("profile_url"))
    if slug:
        lead = indexes.get("by_slug", {}).get(slug)
        if lead:
            return lead

    summary_name = normalize_person_name(summary.get("name"))
    if not summary_name:
        return None

    for lead_name, lead in indexes.get("by_name", {}).items():
        if lead_name == summary_name or lead_name in summary_name:
            return lead
    return None


def snippet_looks_outbound(snippet: Optional[str]) -> bool:
    """Detect common LinkedIn list prefixes that mean the preview is our message."""
    normalized = normalize_person_name(snippet)
    if not normalized:
        return False
    outbound_prefixes = (
        "sie ",
        "sie:",
        "you ",
        "you:",
        "ich ",
        "ich:",
        "you sent",
        "sie haben",
        "du hast",
    )
    return any(normalized.startswith(prefix) for prefix in outbound_prefixes)


def is_exact_profile_summary_match(summary: Optional[Dict[str, Any]], lead: Dict[str, Any]) -> bool:
    if not summary:
        return False
    summary_slug = linkedin_profile_slug(summary.get("profile_url"))
    lead_slug = linkedin_profile_slug(lead.get("linkedin_url"))
    return bool(summary_slug and lead_slug and summary_slug == lead_slug)


def is_inbound_reply_from_conversation(
    convo_info: Dict[str, Any],
    lead: Dict[str, Any],
    summary: Optional[Dict[str, Any]] = None,
) -> bool:
    """Return True when conversation data indicates the latest message is from the lead."""
    if is_last_message_from_lead(convo_info, lead):
        return True
    if convo_info.get("is_outbound"):
        return False

    sender = normalize_person_name(convo_info.get("sender"))
    if sender:
        return False

    # LinkedIn sometimes omits the sender on the final inbound bubble. If the
    # inbox card matched the exact profile URL and its preview is not marked as
    # our own message, trust the card/thread pair as an inbound reply.
    return is_exact_profile_summary_match(summary, lead) and not snippet_looks_outbound(
        summary.get("snippet") if summary else None
    )


def conversation_tail_belongs_to_lead(convo_info: Optional[Dict[str, Any]], lead: Dict[str, Any]) -> bool:
    """Return false when extraction is clearly from a different open thread."""
    if not convo_info:
        return False
    if is_last_message_from_lead(convo_info, lead):
        return True
    if convo_info.get("is_outbound"):
        return True
    sender = normalize_person_name(convo_info.get("sender"))
    # Blank senders happen on some inbound bubbles; the caller should use the
    # clicked result identity to decide whether that is acceptable.
    return not sender


async def safe_text_content(page: Page, selector: str, timeout: int = 6_000) -> str:
    try:
        return safe_text(await page.text_content(selector, timeout=timeout))
    except Exception:
        return ""


async def safe_inner_text(page: Page, selector: str, timeout: int = 6_000) -> str:
    """Get inner text from an element, which preserves more formatting."""
    try:
        locator = page.locator(selector)
        if await locator.count() > 0:
            return safe_text(await locator.first.inner_text(timeout=timeout))
    except Exception:
        pass
    return ""


async def first_match_text(page: Page, selectors: List[str], timeout: int = 6_000, field_name: str = "") -> str:
    """Return the first non-empty text for the provided selectors."""
    for idx, selector in enumerate(selectors):
        # Try inner_text first (better for multi-line content)
        text = await safe_inner_text(page, selector, timeout=timeout)
        if text:
            logger.element_search(selector, 1, extracted=text[:50], context={"field": field_name} if field_name else None)
            return text
        # Fallback to text_content
        text = await safe_text_content(page, selector, timeout=timeout)
        if text:
            logger.element_search(selector, 1, extracted=text[:50], context={"field": field_name} if field_name else None)
            return text
        # Log failed attempts only in very verbose mode
        if idx == len(selectors) - 1:  # Last selector
            logger.element_search(f"{len(selectors)} selectors tried", 0, context={"field": field_name} if field_name else None)
    return ""


async def gentle_nav(page: Page, url: str) -> None:
    """Navigate with forgiving waits to avoid networkidle timeouts."""
    from_url = page.url if page.url and page.url != "about:blank" else None
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(1_200)
        logger.page_navigation(url, from_url=from_url, wait_until="domcontentloaded", success=True)
    except Exception as e:
        logger.page_navigation(url, from_url=from_url, wait_until="domcontentloaded", success=False)
        raise


async def slow_scroll(page: Page, steps: int = 6) -> None:
    """Scroll down to trigger lazy-loaded sections."""
    for _ in range(steps):
        await page.mouse.wheel(0, random.randint(500, 900))
        await asyncio.sleep(random.uniform(0.2, 0.5))
    logger.scroll_action(steps, direction="down")


async def expand_about(page: Page) -> None:
    """Try to expand the About section if there's a 'See more' button."""
    selectors = [
        "section#about button:has-text('more')",
        "section#about button:has-text('See more')",
        "section:has-text('About') button:has-text('more')",
        "section:has-text('About') button:has-text('See more')",
    ]
    for selector in selectors:
        try:
            button = page.locator(selector)
            count = await button.count()
            logger.element_search(selector, count, context={"action": "expand_about"})
            if count > 0:
                await button.first.click(timeout=5_000)
                logger.element_click(selector, success=True, element_text="See more")
                await page.wait_for_timeout(500)
                break
        except Exception as e:
            logger.element_click(selector, success=False)
            continue


async def scrape_experience(page: Page, max_items: int = 3) -> List[Dict[str, str]]:
    section = page.locator("section[id*=experience], section[data-section='experience'], section:has-text('Experience')")
    if await section.count() == 0:
        return []

    try:
        await section.first.scroll_into_view_if_needed(timeout=5_000)
    except Exception:
        pass

    items = section.locator("li")
    total = min(await items.count(), max_items)
    results: List[Dict[str, str]] = []

    for idx in range(total):
        entry = items.nth(idx)
        try:
            title = safe_text(await entry.locator("span[aria-hidden=true]").nth(0).text_content(timeout=4_000))
        except Exception:
            title = ""
        try:
            company = safe_text(await entry.locator("span[aria-hidden=true]").nth(1).text_content(timeout=4_000))
        except Exception:
            company = ""
        try:
            tenure = safe_text(
                await entry.locator("span:has-text('Present'), span:has-text(' yr'), span:has-text(' mos')")
                .first.text_content(timeout=3_000)
            )
        except Exception:
            tenure = ""

        if title or company:
            results.append({"title": title, "company": company, "tenure": tenure})

    return results


async def scrape_profile(page: Page, url: str) -> Dict[str, Any]:
    normalized = url.replace("http://", "https://")
    logger.info(f"Profile scrape starting", data={"url": normalized})
    page.set_default_timeout(20_000)
    page.set_default_navigation_timeout(60_000)

    await gentle_nav(page, normalized)
    
    # Check page state after navigation
    try:
        await page.wait_for_selector("main", timeout=20_000)
        logger.element_search("main", 1, context={"phase": "page_load"})
    except Exception as e:
        logger.element_search("main", 0, context={"phase": "page_load"})
        raise
    
    await slow_scroll(page)
    await expand_about(page)

    # Extract name
    logger.debug("Extracting: name")
    name = await first_match_text(
        page,
        [
            "main h1.text-heading-xlarge",
            "main h1",
            "header h1",
            "div.pv-text-details__left-panel h1",
        ],
        field_name="name",
    )

    # Extract headline - the classes you provided
    logger.debug("Extracting: headline")
    headline = await first_match_text(
        page,
        [
            "p._190e3b93._63ebc304.ec1ff1cf._47b2b2dd._79d083f8.c701dbb2.e51537ee._5a2e2bd7._8b56d53f.ff36582f._3935efd9",
            "main .text-body-medium.break-words",
            "div.text-body-medium.break-words",
            "main div.pv-text-details__left-panel div.text-body-medium",
            "main p",
        ],
        field_name="headline",
    )

    # Extract about - MUST be scoped to the About section only to avoid grabbing activity posts
    logger.debug("Extracting: about")
    about = await first_match_text(
        page,
        [
            "section#about span[data-testid='expandable-text-box']",
            "section[data-section='about'] span[data-testid='expandable-text-box']",
            "div[id='about'] span[data-testid='expandable-text-box']",
            "section:has-text('About') > div span[data-testid='expandable-text-box']",
            "#about .inline-show-more-text",
            "section#about div.display-flex.ph5.pv3",
            "section#about div.pv-shared-text-with-see-more span",
        ],
        field_name="about",
    )

    # Extract current company and title from experience section
    logger.debug("Extracting: experience")
    experience = await scrape_experience(page)
    current_company = ""
    current_title = ""
    if experience and len(experience) > 0:
        current_title = experience[0].get("title", "")
        current_company = experience[0].get("company", "")

    profile_data = {
        "name": name,
        "headline": headline,
        "about": about,
        "current_company": current_company,
        "current_title": current_title,
        "url": normalized,
        "experience": experience,
    }
    
    # Summary log with all extracted fields
    logger.info("Profile scrape complete", data={
        "hasName": bool(name),
        "namePreview": name[:30] if name else None,
        "hasHeadline": bool(headline),
        "hasAbout": bool(about),
        "aboutLength": len(about) if about else 0,
        "experienceCount": len(experience),
        "currentTitle": current_title[:40] if current_title else None,
    })
    
    return profile_data


async def scrape_recent_activity(page: Page, profile_url: str) -> List[Dict[str, Any]]:
    """Navigate to activity section and extract recent posts from the carousel."""
    base = profile_url.rstrip("/")
    activity_url = f"{base}/recent-activity/all/"
    logger.debug("Starting activity scrape", data={"url": activity_url})

    await gentle_nav(page, activity_url)
    await page.wait_for_timeout(2_000)
    await slow_scroll(page, steps=3)

    results: List[Dict[str, Any]] = []

    # Primary path: LinkedIn renders the activity as a carousel
    try:
        carousel = page.get_by_test_id("carousel")
        if await carousel.count() == 0:
            logger.debug("No carousel found on activity page")
            logger.debug("Activity scraping complete", data={"postsFound": 0})
            return results

        # Links inside the carousel carry an accessible name that is the preview text
        activity_links = carousel.get_by_role("link")
        link_count = await activity_links.count()
        logger.debug(f"Found {link_count} activity links in carousel")

        max_activities = min(link_count, 5)
        for idx in range(max_activities):
            try:
                link = activity_links.nth(idx)

                # Extract preview text from aria-label; fallback to inner text
                link_name = await link.get_attribute("aria-label", timeout=3_000)
                if not link_name:
                    try:
                        link_name = safe_text(await link.inner_text(timeout=3_000))
                    except Exception:
                        link_name = ""

                href = await link.get_attribute("href", timeout=3_000)
                post_url = href or ""
                if post_url.startswith("/"):
                    post_url = f"https://www.linkedin.com{post_url}"

                if not link_name or len(link_name.strip()) < 10:
                    continue

                # Start with preview data (fast path)
                activity_data: Dict[str, Any] = {
                    "text": link_name.strip(),
                    "url": post_url,
                    "date": "",
                    "likes": "",
                }

                # If the URL looks like a post, attempt to open for richer extraction
                # Only when preview seems incomplete
                if post_url and "/posts/" in post_url and ("..." in link_name or len(link_name) < 50):
                    try:
                        await gentle_nav(page, post_url)
                        await page.wait_for_timeout(1_500)

                        # Pull full text content
                        content = ""
                        for selector in [
                            "span[data-testid='expandable-text-box']",
                            "div.feed-shared-update-v2__description span[dir='ltr']",
                            "div.feed-shared-text span[dir='ltr']",
                        ]:
                            text = await safe_inner_text(page, selector, timeout=5_000)
                            if text and len(text) > 20:
                                content = text
                                break

                        # Engagement details (best-effort)
                        date_text = await safe_text_content(
                            page,
                            "span.feed-shared-actor__sub-description span[aria-hidden='true']",
                            timeout=3_000,
                        )
                        likes_text = await safe_text_content(
                            page,
                            "button[aria-label*='reactions'] span[aria-hidden='true']",
                            timeout=3_000,
                        )

                        if content and len(content.strip()) > 20:
                            activity_data.update({
                                "text": content.strip(),
                                "date": (date_text or "").strip(),
                                "likes": (likes_text or "").strip(),
                            })

                    except Exception as exc:
                        logger.warn("Failed to extract full post content", error=exc)
                    finally:
                        # Navigate back to the activity page to continue processing
                        await gentle_nav(page, activity_url)
                        await page.wait_for_timeout(600)

                results.append(activity_data)
                await page.wait_for_timeout(random.randint(300, 700))

            except Exception as exc:
                logger.debug(f"Failed to process activity link {idx}", error=exc)
                continue

    except Exception as exc:
        logger.warn("Failed to scrape activity carousel", error=exc)

    logger.debug(f"Activity scraping complete", data={"postsFound": len(results)})
    return results[:5]


async def send_connection_request(page: Page, lead: Lead) -> bool:
    """Send a no-note connection request. Mirrors sender.py open_message_surface flow exactly.
    
    CRITICAL: This function assumes the page is already on the profile (after enrichment).
    It navigates back to the profile first since activity scraping may have left us elsewhere.
    """
    profile_url = lead.linkedin_url or ""
    normalized = profile_url.replace("http://", "https://").split("?")[0]
    
    logger.connection_flow("start", "navigating to profile", data={"url": normalized})
    
    # Navigate back to profile (activity scraping may have left us on /recent-activity/)
    try:
        await gentle_nav(page, normalized)
        await page.wait_for_selector("main", timeout=15_000)
        await random_pause(1.0, 2.0)
        logger.element_search("main", 1, context={"phase": "connect_profile_load"})
    except Exception as exc:
        logger.connection_flow("navigate", "FAILED", data={"url": normalized, "error": str(exc)})
        return False

    await wiggle_mouse(page)
    
    logger.connection_flow("profile_loaded", "searching for connect buttons")
    
    # Scope all interactions to the profile page's main content area
    # Try lazy-column test ID first, with fallback to main profile section
    profile_container = None
    try:
        profile_container = page.get_by_test_id("lazy-column")
        await profile_container.wait_for(state="visible", timeout=5_000)
        logger.debug("connect-only: profile container found via lazy-column test ID")
    except Exception as e:
        logger.warn("connect-only: lazy-column test ID not found, trying fallback selectors", error=e)
        # Fallback to main profile section
        try:
            profile_container = page.locator("main.scaffold-layout__main, section.artdeco-card").first
            await profile_container.wait_for(state="visible", timeout=5_000)
            logger.debug("connect-only: profile container found via fallback selector")
        except Exception as e2:
            logger.error("connect-only: no profile container found with any selector", error=e2)
            # Last resort: use page itself (risky but better than failing)
            profile_container = page
            logger.warn("connect-only: using page-level selectors as last resort")

    if await profile_has_pending_invite(page, profile_container):
        logger.connection_flow("pending_invite", "ALREADY_SENT", data={"url": normalized})
        return True
    
    # PATH 1: Direct invite link inside profile container (Invite <Name> to ...)
    invite_link = profile_container.get_by_role("link", name=re.compile(r"(Invite .+ to|Einladen .+ zu)", re.I))
    invite_link_count = await invite_link.count()
    logger.element_search("Invite link", invite_link_count, role="link", context={"path": 1})
    
    if invite_link_count > 0:
        try:
            opened = await open_invite_dialog_from_anchor(page, invite_link.first, "https://www.linkedin.com")
            if opened:
                logger.element_click("Invite link", success=True)
                logger.dialog_detected("connection_invite", context={"path": 1})
                logger.path_attempt("Invite link", 1, success=True)
                return await _click_send_without_note(page, normalized, lead.id)
        except WeeklyInviteLimitReached:
            raise
        except Exception as e:
            logger.element_click("Invite link", success=False)
            logger.path_attempt("Invite link", 1, success=False)
    
    # PATH 2: Direct Vernetzen / Als Kontakt button on profile card
    direct_connect_anchor_selectors = [
        "a[aria-label*='Vernetzen']",
        "a[aria-label*='Einladen']",
        "a[href*='/preload/custom-invite/']",
    ]
    for css in direct_connect_anchor_selectors:
        direct_connect_anchor = profile_container.locator(css)
        direct_connect_anchor_count = await direct_connect_anchor.count()
        logger.element_search(f"Connect anchor: {css}", direct_connect_anchor_count, role="link", context={"path": 2})

        if direct_connect_anchor_count > 0:
            try:
                logger.debug("connect-only: matched connect anchor", data={"selector": css})
                opened = await open_invite_dialog_from_anchor(page, direct_connect_anchor.first, "https://www.linkedin.com")
                if opened:
                    logger.element_click(f"Connect anchor: {css}", success=True)
                    logger.dialog_detected("connection_direct_anchor", context={"path": 2, "selector": css})
                    logger.path_attempt(f"Direct Connect anchor ({css})", 2, success=True)
                    return await _click_send_without_note(page, normalized, lead.id)
            except WeeklyInviteLimitReached:
                raise
            except Exception as e:
                logger.element_click(f"Connect anchor: {css}", success=False)
                logger.path_attempt(f"Direct Connect anchor ({css})", 2, success=False)

    direct_connect_btn = profile_container.get_by_role(
        "button",
        name=re.compile(r"(Vernetzen|Als Kontakt|als Kontakt|Connect|Einladen|Kontaktanfrage)", re.I),
    )
    direct_connect_count = await direct_connect_btn.count()
    logger.element_search("Vernetzen/Connect button", direct_connect_count, role="button", context={"path": 2})
    
    if direct_connect_count > 0:
        try:
            await direct_connect_btn.first.scroll_into_view_if_needed(timeout=4_000)
            await direct_connect_btn.first.click(timeout=8_000, force=True)
            logger.element_click("Vernetzen button", success=True)
            await wait_for_connection_dialog(page)
            await random_pause()
            logger.dialog_detected("connection_direct", context={"path": 2})
            logger.path_attempt("Direct Connect button", 2, success=True)
            return await _click_send_without_note(page, normalized, lead.id)
        except WeeklyInviteLimitReached:
            raise
        except Exception as e:
            logger.element_click("Vernetzen button", success=False)
            logger.path_attempt("Direct Connect button", 2, success=False)
    
    # PATH 3: Try More button -> Invite flow (fallback)
    more_button = profile_container.get_by_role("button", name=re.compile(r"(More|Mehr)", re.I))
    more_button_count = await more_button.count()
    logger.element_search("More/Mehr button", more_button_count, role="button", context={"path": 3})
    
    if more_button_count > 0:
        try:
            await more_button.first.click(timeout=8_000)
            logger.element_click("More button", success=True)
            await page.wait_for_timeout(1_000)
            
            # Look for Invite/Connect menuitem
            invite_menuitem = page.get_by_role(
                "menuitem",
                name=re.compile(r"(Invite|Einladen|Connect|Vernetzen|Kontaktanfrage)", re.I),
            )
            invite_count = await invite_menuitem.count()
            if invite_count == 0:
                invite_menuitem = page.get_by_role(
                    "button",
                    name=re.compile(r"(Invite|Einladen|Connect|Vernetzen|Kontaktanfrage)", re.I),
                )
                invite_count = await invite_menuitem.count()
            logger.element_search("Invite/Connect menuitem", invite_count, role="menuitem", context={"path": 3})
            
            if invite_count > 0:
                await invite_menuitem.first.click(timeout=8_000, force=True)
                logger.element_click("Invite menuitem", success=True)
                
                # Wait for connection dialog
                await wait_for_connection_dialog(page)
                await random_pause()
                logger.dialog_detected("connection_more_menu", context={"path": 3})
                logger.path_attempt("More -> Invite", 3, success=True)
                return await _click_send_without_note(page, normalized, lead.id)
            else:
                logger.path_attempt("More -> Invite", 3, success=False)
        except WeeklyInviteLimitReached:
            raise
        except Exception as e:
            if await connection_dialog_is_visible(page):
                logger.dialog_detected("connection_more_menu_late", context={"path": 3})
                logger.path_attempt("More -> Invite", 3, success=True)
                return await _click_send_without_note(page, normalized, lead.id)
            logger.element_click("More button flow", success=False)
            logger.path_attempt("More -> Invite", 3, success=False)
    
    screenshot_path = await capture_connect_failure_screenshot(page, "all_paths_exhausted", lead.id)
    logger.connection_flow("all_paths", "EXHAUSTED", data={"url": normalized, "screenshot": screenshot_path})
    return False


async def _click_send_without_note(page: Page, url: str, lead_id: Optional[str] = None) -> bool:
    """Click 'Ohne Notiz senden' button in the connection dialog."""
    limit_reason = await detect_weekly_invite_limit(page)
    if limit_reason:
        screenshot_path = await capture_connect_failure_screenshot(page, "weekly_invite_limit_reached", lead_id)
        logger.connection_flow(
            "send_button",
            "LIMIT_REACHED",
            data={"url": url, "reason": limit_reason, "screenshot": screenshot_path},
        )
        raise WeeklyInviteLimitReached(limit_reason)

    # Try exact German buttons first, then fallback to regex
    send_label = page.get_by_role("button", name="Ohne Notiz senden")
    send_count = await send_label.count()
    logger.element_search("Ohne Notiz senden", send_count, role="button")
    
    if send_count == 0:
        send_label = page.get_by_role("button", name="Ohne Nachricht senden")
        send_count = await send_label.count()
        logger.element_search("Ohne Nachricht senden", send_count, role="button")
    
    if send_count == 0:
        send_label = page.get_by_role(
            "button",
            name=re.compile(r"(Send without a note|Send now|Send|Einladung senden|Senden|Kontaktanfrage senden|Ohne Notiz senden)", re.I),
        )
        send_count = await send_label.count()
        logger.element_search("Send button (fallback regex)", send_count, role="button")

    if send_count == 0:
        screenshot_path = await capture_connect_failure_screenshot(page, "send_button_not_found", lead_id)
        logger.connection_flow("send_button", "NOT_FOUND", data={"url": url, "screenshot": screenshot_path})
        return False

    try:
        await send_label.first.scroll_into_view_if_needed(timeout=4_000)
        await send_label.first.wait_for(state="visible", timeout=5_000)
        await send_label.first.click(timeout=8_000)
        await random_pause(0.8, 1.3)
        limit_reason = await detect_weekly_invite_limit(page)
        if limit_reason:
            screenshot_path = await capture_connect_failure_screenshot(page, "weekly_invite_limit_reached", lead_id)
            logger.connection_flow(
                "send_button",
                "LIMIT_REACHED",
                data={"url": url, "reason": limit_reason, "screenshot": screenshot_path},
            )
            raise WeeklyInviteLimitReached(limit_reason)
        if not await confirm_connection_request_sent_with_profile_recheck(page, url):
            screenshot_path = await capture_connect_failure_screenshot(page, "send_button_unconfirmed", lead_id)
            logger.connection_flow(
                "send_button",
                "UNCONFIRMED",
                data={"url": url, "screenshot": screenshot_path},
            )
            return False
        logger.element_click("Send button", success=True)
        logger.connection_flow("send_button", "CLICKED", data={"url": url})
        return True
    except WeeklyInviteLimitReached:
        raise
    except Exception as exc:
        logger.element_click("Send button", success=False)
        screenshot_path = await capture_connect_failure_screenshot(page, "send_button_click_failed", lead_id)
        logger.connection_flow(
            "send_button",
            "CLICK_FAILED",
            data={"url": url, "screenshot": screenshot_path, "error": str(exc)},
        )
        return False


async def login_with_credentials(
    context: BrowserContext,
    creds: LinkedinCredentials,
    login_attempt_at: Optional[str] = None,
) -> None:
    """Log into LinkedIn using saved credentials and persist auth.json."""
    page = await context.new_page()
    login_attempt_at = login_attempt_at or now_iso_utc()
    try:
        # Always start by checking if we're already authenticated.
        await page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(1_000)
        if "/feed" in page.url and "/login" not in page.url:
            print("Already authenticated, skipping login.")
            await save_storage_state(context, path=AUTH_STATE_PATH)
            update_auth_status(
                credentials_saved=True,
                session_state="session_active",
                auth_file_present=True,
                last_verified_at=now_iso_utc(),
                last_login_attempt_at=login_attempt_at,
                last_login_result="success",
                last_error=None,
            )
            return

        # Navigate explicitly to the login page.
        await page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(1_000)

        # Use role-based, localized selectors first as requested, with fallbacks.
        # Primary (German localization)
        email_locators = [
            lambda: page.get_by_role("textbox", name="E-Mail-Adresse/Telefon"),
            lambda: page.get_by_role("textbox", name="E-Mail-Adresse"),
            lambda: page.get_by_role("textbox", name="Telefon"),
        ]
        password_locators = [
            lambda: page.get_by_role("textbox", name="Passwort"),
        ]
        # Fallbacks (common English UI and legacy ids)
        email_fallbacks = [
            lambda: page.get_by_role("textbox", name="Email or Phone"),
            lambda: page.get_by_role("textbox", name="Email or phone"),
            lambda: page.get_by_role("textbox", name="Email"),
            lambda: page.locator("input#username"),
            lambda: page.locator("input[name='session_key']"),
        ]
        password_fallbacks = [
            lambda: page.get_by_role("textbox", name="Password"),
            lambda: page.locator("input#password"),
            lambda: page.locator("input[name='session_password']"),
        ]

        async def fill_first(workers, value: str) -> bool:
            for w in workers:
                try:
                    loc = w()
                    if await loc.count() > 0:
                        await loc.first.fill(value, timeout=10_000)
                        return True
                except Exception:
                    continue
            return False

        email_filled = await fill_first(email_locators, creds.email) or await fill_first(email_fallbacks, creds.email)
        pwd_filled = await fill_first(password_locators, creds.password) or await fill_first(password_fallbacks, creds.password)

        # LinkedIn occasionally serves an authwall/login variant where /login lacks fields.
        # Retry once on /uas/login before failing hard.
        if not email_filled or not pwd_filled:
            await page.goto("https://www.linkedin.com/uas/login", wait_until="domcontentloaded", timeout=60_000)
            await page.wait_for_timeout(1_000)
            email_filled = await fill_first(email_locators, creds.email) or await fill_first(email_fallbacks, creds.email)
            pwd_filled = await fill_first(password_locators, creds.password) or await fill_first(password_fallbacks, creds.password)

        if not email_filled or not pwd_filled:
            raise TimeoutError("Could not locate email or password fields on LinkedIn login page.")

        # Try clicking a sign-in button using robust selectors.
        sign_in_buttons = [
            lambda: page.get_by_role("button", name="Anmelden"),
            lambda: page.get_by_role("button", name="Sign in"),
            lambda: page.locator("button[type=submit]"),
            lambda: page.locator("button[name='submit']"),
        ]
        clicked = False
        for b in sign_in_buttons:
            try:
                loc = b()
                if await loc.count() > 0:
                    await loc.first.click(timeout=8_000)
                    clicked = True
                    break
            except Exception:
                continue

        if not clicked:
            # As a last resort, press Enter in the password field
            try:
                await page.keyboard.press("Enter")
            except Exception:
                pass

        # Wait for successful navigation to feed (authenticated)
        try:
            await page.wait_for_url("**/feed**", timeout=45_000)
        except TimeoutError as exc:
            # Sometimes LinkedIn shows intermediate checkpoint; consider still saving state
            print(f"Login did not reach feed within timeout. Current URL: {page.url}", file=sys.stderr)
            update_auth_status(
                credentials_saved=True,
                session_state="login_required",
                auth_file_present=AUTH_STATE_PATH.exists(),
                last_login_attempt_at=login_attempt_at,
                last_login_result="failed",
                last_error=str(exc),
            )
            raise RuntimeError(
                "LinkedIn login requires verification. Complete any challenge in the browser, "
                "then reconnect from Settings and retry."
            ) from exc

        # Persist the verified session and publish the success state.
        await save_storage_state(context, path=AUTH_STATE_PATH)
        update_auth_status(
            credentials_saved=True,
            session_state="session_active",
            auth_file_present=True,
            last_verified_at=now_iso_utc(),
            last_login_attempt_at=login_attempt_at,
            last_login_result="success",
            last_error=None,
        )
    except Exception as exc:
        if not isinstance(exc, RuntimeError):
            update_auth_status(
                credentials_saved=True,
                session_state="login_required",
                auth_file_present=AUTH_STATE_PATH.exists(),
                last_login_attempt_at=login_attempt_at,
                last_login_result="failed",
                last_error=str(exc),
            )
            raise RuntimeError(
                "LinkedIn login requires verification. Complete any challenge in the browser, "
                "then reconnect from Settings and retry."
            ) from exc
        raise
    finally:
        await page.close()


async def ensure_linkedin_auth(context: BrowserContext, creds: Optional[LinkedinCredentials]) -> None:
    if await is_logged_in(context):
        if not AUTH_STATE_PATH.exists():
            await save_storage_state(context)
        update_auth_status(
            credentials_saved=bool(creds),
            session_state="session_active",
            auth_file_present=True,
            last_verified_at=now_iso_utc(),
            last_error=None,
        )
        return

    if not creds:
        update_auth_status(
            credentials_saved=False,
            session_state="no_credentials",
            auth_file_present=AUTH_STATE_PATH.exists(),
            last_login_result="failed",
            last_error="LinkedIn credentials are missing from Settings.",
        )
        raise RuntimeError(
            "Unable to authenticate with LinkedIn. Save your LinkedIn credentials in Settings, "
            "then retry so the scraper can sign in automatically."
        )

    login_started_at = now_iso_utc()

    if AUTH_STATE_PATH.exists():
        update_auth_status(
            credentials_saved=True,
            session_state="session_expired",
            auth_file_present=True,
            last_login_attempt_at=login_started_at,
            last_login_result="failed",
            last_error="Cached LinkedIn session was rejected. Reconnecting now.",
        )
    else:
        update_auth_status(
            credentials_saved=True,
            session_state="credentials_saved",
            auth_file_present=False,
            last_login_attempt_at=login_started_at,
            last_login_result="verification_required",
            last_error=None,
        )

    await login_with_credentials(context, creds, login_attempt_at=login_started_at)


def update_lead(
    client: Client,
    lead_id: str,
    profile_data: Dict[str, Any],
    activity: List[Dict[str, Any]],
) -> None:
    logger.db_query("update", "leads", {"leadId": lead_id}, {"status": "ENRICHED", "activityCount": len(activity)})
    client.table("leads").update(
        {
            "profile_data": profile_data,
            "recent_activity": activity,
            "status": "ENRICHED",
        }
    ).eq("id", lead_id).execute()
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    logger.info(f"Lead updated to ENRICHED", {"leadId": lead_id})


def mark_enrich_failed(client: Client, lead_id: str, reason: Optional[str] = None) -> None:
    """Mark a lead as ENRICH_FAILED to avoid being re-queued as NEW endlessly."""
    logger.db_query("update", "leads", {"leadId": lead_id}, {"status": "ENRICH_FAILED", "reason": (reason or "")[:240]})
    client.table("leads").update({"status": "ENRICH_FAILED"}).eq("id", lead_id).execute()
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    logger.warn("Lead marked ENRICH_FAILED", {"leadId": lead_id}, error=reason)


@retry(stop=stop_after_attempt(3), wait=wait_fixed(2))
async def enrich_one(page: Page, client: Client, lead: Lead) -> None:
    logger.scrape_start(lead.id, lead.linkedin_url)
    
    try:
        profile = await scrape_profile(page, lead.linkedin_url)
        try:
            activity = await scrape_recent_activity(page, lead.linkedin_url)
        except Exception as exc:
            logger.warn(f"Activity scrape failed for {lead.id}", {"leadId": lead.id}, error=exc)
            activity = []
        # If we found no meaningful profile or activity, mark as ENRICH_FAILED
        has_profile_signal = any(
            bool((profile or {}).get(k)) for k in [
                "name", "headline", "about", "current_company", "current_title"
            ]
        ) or len((profile or {}).get("experience", []) or []) > 0
        has_activity = len(activity) > 0

        if not has_profile_signal and not has_activity:
            mark_enrich_failed(client, lead.id, reason="No profile or activity signals found")
            logger.scrape_complete(lead.id, profile_data=profile)
            return

        update_lead(client, lead.id, profile, activity)
        logger.scrape_complete(lead.id, profile_data=profile)
    except Exception as exc:
        logger.scrape_error(lead.id, error=exc)
        # On enrichment error, mark as ENRICH_FAILED to avoid resetting to NEW loops
        mark_enrich_failed(client, lead.id, reason=str(exc))
        raise


async def process_batch(context: BrowserContext, client: Client, leads: List[Lead]) -> None:
    for lead in leads:
        logger.info(f"Processing lead {lead.id}", {"leadId": lead.id}, {"url": lead.linkedin_url})
        logger.db_query("update", "leads", {"leadId": lead.id}, {"status": "PROCESSING"})
        client.table("leads").update({"status": "PROCESSING"}).eq("id", lead.id).execute()

        page = await context.new_page()
        try:
            await enrich_one(page, client, lead)
            logger.info(f"Lead {lead.id} enriched successfully", {"leadId": lead.id})
        except TimeoutError as exc:
            logger.error(f"Timeout processing {lead.id}", {"leadId": lead.id}, error=exc)
            mark_enrich_failed(client, lead.id, reason=f"Timeout: {exc}")
        except Exception as exc:
            logger.error(f"Failed to process {lead.id}", {"leadId": lead.id}, error=exc)
            mark_enrich_failed(client, lead.id, reason=str(exc))
        finally:
            try:
                await page.close()
            except Exception:
                pass

        await random_pause()


async def main(limit: int = 0, sequence_id: Optional[int] = None, batch_intent: Optional[str] = None) -> None:
    operation_name = "enrichment"
    logger.operation_start(operation_name, input_data={"limit": limit, "sequence_id": sequence_id, "batch_intent": batch_intent})

    try:
        client = get_supabase_client()
        creds = fetch_linkedin_credentials(client)
        enriched_today = fetch_today_enrichment_count(client)
        daily_cap = get_daily_enrichment_cap()
        remaining_quota = max(0, daily_cap - enriched_today)

        if remaining_quota <= 0:
            logger.warn(f"Daily enrichment cap reached", data={"cap": daily_cap, "enrichedToday": enriched_today})
            return

        effective_limit = remaining_quota if limit <= 0 else min(limit, remaining_quota)
        if effective_limit <= 0:
            logger.info("No quota left for today")
            return

        os.environ["SCRAPER_MODE"] = "enrich"
        if batch_intent:
            leads = fetch_pending_leads_for_intent(client, effective_limit, batch_intent)
        else:
            leads = fetch_new_leads(
                client,
                limit=effective_limit,
                outreach_mode=None,
                sequence_id=sequence_id,
            )
        if not leads:
            logger.info("No NEW leads to process")
            return

        playwright, browser, context = await open_browser(headless=False)
        try:
            logger.info("Browser opened, authenticating...")
            await ensure_linkedin_auth(context, creds)
            logger.info(
                f"Starting batch processing of {len(leads)} leads",
                data={"count": len(leads)},
            )
            await process_batch(context, client, leads)
            logger.operation_complete(operation_name, result={"processed": len(leads)})
        finally:
            await shutdown(playwright, browser)
            logger.info("Browser closed")
    except Exception as exc:
        logger.operation_error(operation_name, error=exc, input_data={"limit": limit, "sequence_id": sequence_id, "batch_intent": batch_intent})
        raise


async def login_only_mode() -> None:
    """Try the existing worker login path first, then fall back to the remote-browser flow."""
    logger.operation_start("linkedin-auth", input_data={"mode": "login_only"})

    try:
        client = get_supabase_client()
        creds = fetch_linkedin_credentials(client)
        if not creds:
            update_auth_status(
                credentials_saved=False,
                session_state="no_credentials",
                auth_file_present=AUTH_STATE_PATH.exists(),
                last_login_attempt_at=now_iso_utc(),
                last_login_result="failed",
                last_error="LinkedIn credentials are missing from Settings.",
            )
            raise RuntimeError("LinkedIn credentials are missing from Settings.")

        playwright, browser, context = await open_browser(headless=False)
        try:
            logger.info("Browser opened for LinkedIn login attempt")
            try:
                await ensure_linkedin_auth(context, creds)
                logger.operation_complete("linkedin-auth", result={"session_state": "session_active"})
                return
            except RuntimeError:
                update_auth_status(
                    credentials_saved=True,
                    session_state="login_required",
                    auth_file_present=AUTH_STATE_PATH.exists(),
                    last_login_attempt_at=now_iso_utc(),
                    last_login_result="verification_required",
                    last_error="Automatic LinkedIn login could not complete. Open the remote LinkedIn browser from Settings, complete login there, then click Capture Session.",
                )
                logger.info("Automatic LinkedIn login requires remote browser follow-up")
                logger.operation_complete(
                    "linkedin-auth",
                    result={"session_state": "login_required", "remote_browser_required": True},
                )
                return
        finally:
            await shutdown(playwright, browser)
            logger.info("Browser closed")
    except Exception as exc:
        logger.operation_error("linkedin-auth", error=exc, input_data={"mode": "login_only"})
        raise


async def manual_browser_mode() -> None:
    """Open a visible browser and keep it alive for manual operator use."""
    logger.operation_start("linkedin-auth", input_data={"mode": "manual_browser"})

    playwright, browser, context = await open_browser(headless=False)
    try:
        logger.info("Manual LinkedIn browser opened")
        page = await context.new_page()
        try:
            await page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=20_000)
            await page.wait_for_timeout(2_000)
            logger.operation_complete(
                "linkedin-auth",
                result={"session_state": "manual_browser_opened", "browser_open": True},
            )
            await asyncio.Event().wait()
        finally:
            try:
                await page.close()
            except Exception:
                pass
    finally:
        await shutdown(playwright, browser)
        logger.info("Manual LinkedIn browser closed")


async def sync_remote_session_mode() -> None:
    """Export the current authenticated remote browser session into auth.json."""
    logger.operation_start("linkedin-auth", input_data={"mode": "sync_remote_session"})
    try:
        client = get_supabase_client()
        creds = fetch_linkedin_credentials(client)
        await sync_remote_session_to_auth(credentials_saved=bool(creds))
        logger.operation_complete("linkedin-auth", result={"session_state": "session_active", "source": "remote_browser"})
    except Exception as exc:
        logger.operation_error("linkedin-auth", error=exc, input_data={"mode": "sync_remote_session"})
        raise


async def reset_remote_session_mode() -> None:
    """Clear the remote interactive browser profile and local auth artifacts."""
    logger.operation_start("linkedin-auth", input_data={"mode": "reset_remote_session"})
    try:
        client = get_supabase_client()
        creds = fetch_linkedin_credentials(client)
        result = await reset_remote_login_state(credentials_saved=bool(creds))
        logger.operation_complete(
            "linkedin-auth",
            result={
                "session_state": "login_required" if creds else "no_credentials",
                "source": "remote_browser",
                "auth_state_cleared": result.auth_state_cleared,
                "profile_dir_cleared": result.profile_dir_cleared,
                "remote_browser_reachable": result.remote_browser_reachable,
            },
        )
    except Exception as exc:
        logger.operation_error("linkedin-auth", error=exc, input_data={"mode": "reset_remote_session"})
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LinkedIn scraper")
    parser.add_argument(
        "--run",
        action="store_true",
        help="Actually run scraping; without this flag the script exits immediately.",
    )
    parser.add_argument(
        "--inbox",
        action="store_true",
        help="Run in inbox scanning mode to detect replies and create followups.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Maximum number of leads to process in a single run; 0 means no limit (process all).",
    )
    parser.add_argument(
        "--lead-id",
        action="append",
        default=[],
        help="Only process the given lead id in inbox mode. May be passed multiple times.",
    )
    parser.add_argument(
        "--sequence-id",
        type=int,
        default=None,
        help="Only process leads assigned to this sequence id.",
    )
    parser.add_argument(
        "--login-only",
        action="store_true",
        help="Run only the LinkedIn authentication bootstrap and exit.",
    )
    parser.add_argument(
        "--manual-browser",
        action="store_true",
        help="Open a visible Playwright browser and keep it alive for manual use.",
    )
    parser.add_argument(
        "--sync-remote-session",
        action="store_true",
        help="Export the authenticated remote browser session into auth.json and exit.",
    )
    parser.add_argument(
        "--reset-remote-session",
        action="store_true",
        help="Clear the remote browser profile plus local auth artifacts and exit.",
    )
    parser.add_argument(
        "--enrichment-loop",
        action="store_true",
        help="Continuously enrich NEW custom-outreach leads. Sleeps between passes when queue is empty.",
    )
    parser.add_argument(
        "--batch-intent",
        type=str,
        default=None,
        help="Restrict lead selection to a specific batch_intent (e.g. 'custom_outreach'). None = no filter (legacy behavior).",
    )
    args = parser.parse_args()
    if args.batch_intent and args.batch_intent != "custom_outreach":
        parser.error(f"--batch-intent '{args.batch_intent}' is not supported; only 'custom_outreach' is valid.")
    return args

###################################################################################################
# Inbox scanning helpers
###################################################################################################

async def navigate_to_inbox(page: Page) -> None:
    """Navigate to LinkedIn messaging and wait for the inbox UI to be usable.

    We tolerate layout changes by waiting on several possible selectors and
    not hard-failing on a TimeoutError. This prevents the entire inbox scan
    from crashing if LinkedIn tweaks the DOM.
    """
    await gentle_nav(page, "https://www.linkedin.com/messaging/")

    # Try a few likely containers for the conversation list / main area
    possible_selectors = [
        "div.msg-conversations-container",
        "ul.msg-conversations-container__conversations-list",
        "li.msg-conversation-listitem",
        "div.msg-conversation-card",
        "div[role='main']",
    ]

    for selector in possible_selectors:
        try:
            await page.wait_for_selector(selector, timeout=10_000)
            logger.debug("navigate_to_inbox: found inbox container", {"selector": selector})
            break
        except Exception:
            continue
    else:
        # As a last resort, don't crash the whole run; just log a warning
        logger.warn("navigate_to_inbox: no known inbox container found after timeout")

    # Give the UI a moment and scroll a bit so lazy content loads
    await page.wait_for_timeout(800)
    try:
        await slow_scroll(page, steps=2)
    except Exception:
        pass


async def open_profile_and_get_last_message(
    page: Page,
    lead_full_name: str,
    linkedin_url: Optional[str],
) -> Optional[Dict[str, Any]]:
    """Visit a lead's profile and, if possible, open the message thread and return last message info.

    This avoids relying on the inbox search, which can miss conversations, by going
    profile-by-profile and clicking the appropriate Nachricht / Message button.
    
    Returns:
        - {"pending_invite": True} if connection request is still pending
        - {"sender": ..., "text": ..., "is_outbound": ..., "has_history": True} if conversation exists
        - None if no conversation could be found
    """
    if not linkedin_url:
        logger.debug("open_profile_and_get_last_message: missing linkedin_url", {"lead": lead_full_name})
        return None

    try:
        logger.info("Opening profile for followup scan", {"lead": lead_full_name, "url": linkedin_url})
        await gentle_nav(page, linkedin_url)
        await page.wait_for_timeout(1200)

        # Try to find a profile container similar to the sender worker, so we don't
        # accidentally click buttons from other UI surfaces.
        try:
            profile_container = page.get_by_test_id("lazy-column")
            if await profile_container.count() > 0:
                await profile_container.first.wait_for(state="visible", timeout=5_000)
            else:
                raise RuntimeError("lazy-column not found")
        except Exception:
            # Fallback: main scaffold layout / card
            profile_container = page.locator("main.scaffold-layout__main, section.artdeco-card").first

        # ============================================================
        # STEP 1: CHECK FOR PENDING INVITE FIRST (before anything else)
        # ============================================================
        # Look for "Ausstehend" / "Pending" button anywhere on profile - multiple patterns
        pending_patterns = [
            r"Ausstehend",  # German: "Pending"
            r"Pending",     # English
            r"Ausstehend, klicken Sie",  # German full text
        ]
        for pattern in pending_patterns:
            pending_btn = profile_container.get_by_role("button", name=re.compile(pattern, re.I))
            pending_count = await pending_btn.count()
            if pending_count > 0:
                logger.info(
                    "open_profile_and_get_last_message: PENDING INVITE detected",
                    {"lead": lead_full_name, "pattern": pattern},
                )
                return {"pending_invite": True}
        
        # Also check for "Vernetzen" / "Connect" button (not connected at all)
        connect_btn = profile_container.get_by_role("button", name=re.compile(r"(Vernetzen|Connect)$", re.I))
        if await connect_btn.count() > 0:
            logger.info(
                "open_profile_and_get_last_message: NOT CONNECTED (Connect button visible)",
                {"lead": lead_full_name},
            )
            return {"pending_invite": True}  # Treat as pending - not connected yet

        # ============================================================
        # STEP 2: TRY TO OPEN MESSAGE THREAD
        # ============================================================
        msg_button = profile_container.get_by_role(
            "button",
            name=re.compile(r"(Nachricht an |Message)", re.I),
        )
        msg_btn_count = await msg_button.count()
        logger.debug(
            "open_profile_and_get_last_message: Nachricht/Message button count",
            {"lead": lead_full_name, "count": msg_btn_count},
        )

        messaging_opened = False
        if msg_btn_count > 0:
            try:
                await msg_button.first.click(timeout=8_000)
                # Wait for messaging surface / overlay to appear
                await page.wait_for_selector(
                    "div.msg-overlay-conversation-bubble, section[role='dialog'] div[role='textbox'][contenteditable='true'], div.msg-form__contenteditable[contenteditable='true']",
                    timeout=10_000,
                )
                await page.wait_for_timeout(800)
                messaging_opened = True
            except Exception as exc:
                logger.warn(
                    "open_profile_and_get_last_message: failed to open messaging surface via Nachricht button",
                    {"lead": lead_full_name},
                    error=exc,
                )

        # Fallback: try a generic Message / Nachricht button anywhere on page
        if not messaging_opened:
            generic_msg_btn = page.get_by_role("button", name=re.compile(r"(Nachricht|Message)", re.I))
            if await generic_msg_btn.count() > 0:
                try:
                    await generic_msg_btn.first.click(timeout=8_000)
                    await page.wait_for_selector(
                        "div.msg-overlay-conversation-bubble, section[role='dialog'] div[role='textbox'][contenteditable='true'], div.msg-form__contenteditable[contenteditable='true']",
                        timeout=10_000,
                    )
                    await page.wait_for_timeout(800)
                    messaging_opened = True
                except Exception as exc:
                    logger.warn(
                        "open_profile_and_get_last_message: generic Nachricht/Message button failed",
                        {"lead": lead_full_name},
                        error=exc,
                    )

        if not messaging_opened:
            logger.debug(
                "open_profile_and_get_last_message: no usable messaging surface found on profile",
                {"lead": lead_full_name},
            )
            return None

        # ============================================================
        # STEP 3: VERIFY CONVERSATION HISTORY EXISTS
        # ============================================================
        # Extract the last message and verify there's actual conversation history
        msg_info = await extract_last_message_from_conversation(page)
        
        if msg_info is None:
            # No message history found - might be empty compose window
            logger.debug(
                "open_profile_and_get_last_message: messaging opened but no message history found",
                {"lead": lead_full_name},
            )
            return None
        
        # Mark that we verified conversation history exists
        msg_info["has_history"] = True
        return msg_info

    except Exception as exc:
        logger.warn(
            "open_profile_and_get_last_message: error while visiting profile",
            {"lead": lead_full_name, "url": linkedin_url},
            error=exc,
        )
        return None


async def search_conversation_by_name(page: Page, lead: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Search for a conversation by lead name using LinkedIn's messaging search box.
    
    Returns conversation info if found, None otherwise.
    """
    try:
        # Find the conversation-list search input. The global top-nav search has
        # a similar German label, so prefer LinkedIn's inbox-specific id first.
        searchbox = page.locator("input#search-conversations").first
        if not await searchbox.count():
            searchbox = page.locator("input[name='searchTerm'][placeholder*='Nachrichten'], input[name='searchTerm'][placeholder*='Search']").first
        
        if not await searchbox.count():
            logger.warn("search_conversation_by_name: could not find search box")
            return None
        
        result_selectors = [
            "li.msg-conversation-listitem",
            "ul.msg-conversations-container__conversations-list li",
            "div.msg-conversation-card",
            "li[data-control-name='conversation']",
            "div.msg-search-result",
            "li.artdeco-list__item",
        ]

        for search_term in lead_search_terms(lead):
            lead_name_norm = normalize_person_name(search_term)

            # Clear any existing search and type the lead name
            await searchbox.click()
            await page.wait_for_timeout(300)
            await searchbox.fill("")
            await page.wait_for_timeout(200)
            await page.keyboard.type(search_term, delay=60)
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(1500)  # Wait for search results to load

            # Look for the conversation in search results. Prefer an item whose
            # visible text includes the exact lead name, otherwise the first result
            # can open a different thread with a similar name.
            result_item = None
            for selector in result_selectors:
                items = page.locator(selector)
                count = await items.count()
                for idx in range(min(count, 8)):
                    item = items.nth(idx)
                    try:
                        item_text = normalize_person_name(await item.inner_text(timeout=2_000))
                    except Exception:
                        item_text = ""
                    if lead_name_norm and lead_name_norm in item_text:
                        result_item = item
                        break
                if result_item:
                    break

            if not result_item:
                logger.debug("search_conversation_by_name: no results for search term", {"searchTerm": search_term})
                continue

            # Click to open the conversation
            await result_item.click()
            await page.wait_for_timeout(1000)  # Wait for conversation to load

            # Extract the last message from the opened conversation
            last_message_info = await extract_last_message_from_conversation(page)
            if conversation_tail_belongs_to_lead(last_message_info, lead):
                try:
                    await searchbox.fill("")
                except Exception:
                    pass
                return last_message_info

            logger.warn(
                "search_conversation_by_name: opened thread did not match searched lead",
                {
                    "leadId": lead.get("id"),
                    "lead": lead_display_name(lead),
                    "searchTerm": search_term,
                    "sender": (last_message_info or {}).get("sender"),
                    "text": ((last_message_info or {}).get("text") or "")[:80],
                },
            )

        try:
            await searchbox.fill("")
        except Exception:
            pass
        await page.wait_for_timeout(300)
        return None
        
    except Exception as exc:
        logger.warn(f"search_conversation_by_name: error searching for '{lead_display_name(lead)}'", error=exc)
        return None


async def find_recent_inbox_items(page: Page):
    """Return the most specific locator that exposes recent conversation cards."""
    selectors = [
        "li.msg-conversation-listitem",
        "ul.msg-conversations-container__conversations-list li",
        "div.msg-conversation-card",
        "li[data-control-name='conversation']",
        "li.artdeco-list__item",
    ]
    for selector in selectors:
        items = page.locator(selector)
        try:
            count = await items.count()
        except Exception:
            count = 0
        if count > 0:
            logger.debug("find_recent_inbox_items: found conversation items", {"selector": selector, "count": count})
            return items
    logger.warn("find_recent_inbox_items: no conversation cards found")
    return None


async def extract_conversation_summary_from_item(entry) -> Dict[str, Any]:
    """Read stable matching fields from one LinkedIn conversation-list item."""
    name = ""
    full_text = ""
    try:
        full_text = safe_text(await entry.inner_text(timeout=INBOX_CARD_FIELD_TIMEOUT_MS))
    except Exception:
        pass

    name_selectors = [
        "span.msg-conversation-listitem__participant-names",
        "h3 span[aria-hidden='true']",
        "a[href*='/in/'] span[aria-hidden='true']",
        "span[dir='ltr']",
        "h3",
        "h2",
    ]
    for selector in name_selectors:
        try:
            element = entry.locator(selector).first
            if await element.count():
                name = safe_text(await element.inner_text(timeout=INBOX_CARD_FIELD_TIMEOUT_MS))
                if name:
                    break
        except Exception:
            continue

    if not name and full_text:
        for line in full_text.splitlines():
            line = safe_text(line)
            if line:
                name = line
                break

    profile_href = None
    try:
        profile_link = entry.locator("a[href*='/in/']").first
        if await profile_link.count():
            profile_href = await profile_link.get_attribute("href", timeout=INBOX_CARD_FIELD_TIMEOUT_MS)
            if profile_href and profile_href.startswith("/"):
                profile_href = urljoin("https://www.linkedin.com", profile_href)
    except Exception:
        profile_href = None

    snippet = ""
    snippet_selectors = [
        "p.msg-conversation-card__message-snippet",
        "span.msg-conversation-listitem__message-snippet",
        "p[class*='message-snippet']",
        "span.line-clamp-1",
        "p",
    ]
    for selector in snippet_selectors:
        try:
            element = entry.locator(selector).first
            if await element.count():
                snippet = safe_text(await element.inner_text(timeout=INBOX_CARD_FIELD_TIMEOUT_MS))
                if snippet:
                    break
        except Exception:
            continue

    if not snippet and full_text:
        lines = [safe_text(line) for line in full_text.splitlines() if safe_text(line)]
        if len(lines) > 1:
            snippet = lines[-1]

    ts_text = ""
    try:
        ts_el = entry.locator("time, span.msg-overlay-timestamp").first
        if await ts_el.count():
            ts_text = safe_text(await ts_el.inner_text(timeout=INBOX_CARD_FIELD_TIMEOUT_MS))
    except Exception:
        pass

    return {
        "name": name,
        "profile_url": profile_href,
        "snippet": snippet,
        "ts_text": ts_text,
    }


def has_active_reply_followup(client: Client, lead_id: str) -> bool:
    existing = execute_with_retry(
        client.table("followups")
        .select("id")
        .eq("lead_id", lead_id)
        .eq("followup_type", "REPLY")
        .in_("status", ["PENDING_REVIEW", "APPROVED", "PROCESSING"])
        .limit(1),
        desc=f"Check existing followup for lead {lead_id}",
    )
    return bool(existing.data)


def fetch_active_reply_lead_ids(client: Client, lead_ids: List[str]) -> set[str]:
    """Return lead IDs that already have an active reply followup."""
    if not lead_ids:
        return set()
    resp = execute_with_retry(
        client.table("followups")
        .select("lead_id")
        .in_("lead_id", lead_ids)
        .eq("followup_type", "REPLY")
        .in_("status", ["PENDING_REVIEW", "APPROVED", "PROCESSING"]),
        desc="Fetch active reply followups for inbox candidates",
    )
    return {row.get("lead_id") for row in (resp.data or []) if row.get("lead_id")}


def update_inbox_scan_timestamp(
    client: Client,
    lead_id: str,
    scan_ts: str,
    *,
    pending_invite: bool = False,
) -> None:
    payload: Dict[str, Any] = {
        "last_inbox_scan_at": scan_ts,
        "pending_invite": pending_invite,
    }
    if pending_invite:
        payload["pending_checked_at"] = scan_ts
    execute_with_retry(
        client.table("leads").update(payload).eq("id", lead_id),
        desc=f"Update last_inbox_scan_at for lead {lead_id}",
    )


async def scan_recent_inbox_conversations(
    page: Page,
    client: Client,
    candidate_leads: List[Dict[str, Any]],
    max_items: int,
) -> Dict[str, Any]:
    """Open recent inbox cards once and create REPLY followups for matched leads."""
    stats: Dict[str, Any] = {
        "processed_lead_ids": set(),
        "recent_items_seen": 0,
        "recent_matches": 0,
        "recent_replies": 0,
        "recent_existing": 0,
        "recent_ambiguous": 0,
    }
    if not candidate_leads or max_items <= 0:
        return stats

    items = await find_recent_inbox_items(page)
    if items is None:
        return stats

    indexes = build_inbox_candidate_indexes(candidate_leads)
    try:
        count = min(await items.count(), max_items)
    except Exception:
        return stats

    for idx in range(count):
        stats["recent_items_seen"] += 1
        try:
            item = items.nth(idx)
            summary = await extract_conversation_summary_from_item(item)
            lead = match_inbox_summary_to_lead(summary, indexes)
            if not lead:
                continue

            lead_id = lead["id"]
            if lead_id in stats["processed_lead_ids"]:
                continue
            stats["recent_matches"] += 1

            if has_active_reply_followup(client, lead_id):
                logger.debug("Recent inbox match already has pending reply followup", {"leadId": lead_id})
                stats["recent_existing"] += 1
                stats["processed_lead_ids"].add(lead_id)
                continue

            if snippet_looks_outbound(summary.get("snippet")):
                update_inbox_scan_timestamp(client, lead_id, now_iso_utc())
                stats["processed_lead_ids"].add(lead_id)
                logger.debug(
                    "Recent inbox card preview is outbound; skipping thread open",
                    {"leadId": lead_id, "summaryName": summary.get("name")},
                )
                continue

            await item.click(timeout=8_000)
            await page.wait_for_timeout(1_200)
            convo_info = await extract_last_message_from_conversation(page)
            if not convo_info:
                logger.debug(
                    "Recent inbox conversation opened but no message bubble was found",
                    {"leadId": lead_id, "summary": summary},
                )
                continue

            scan_ts = now_iso_utc()
            sender = convo_info.get("sender", "")
            text = convo_info.get("text", "") or summary.get("snippet", "")
            inbound = is_inbound_reply_from_conversation(convo_info, lead, summary)

            logger.debug(
                "Recent inbox last-message classification",
                {
                    "leadId": lead_id,
                    "sender": sender,
                    "isOutbound": convo_info.get("is_outbound", False),
                    "inbound": inbound,
                    "summaryName": summary.get("name"),
                    "summaryProfile": summary.get("profile_url"),
                    "preview": text[:80] if text else "",
                },
            )

            if inbound:
                cancel_active_nudges_for_reply(client, lead_id)
                upsert_followup_for_reply(
                    client,
                    lead_id=lead_id,
                    reply_id=None,
                    reply_snippet=text[:500] if text else "",
                    reply_timestamp=scan_ts,
                    followup_type="REPLY",
                    last_message_text=text[:2000] if text else "",
                    last_message_from="lead",
                )
                update_inbox_scan_timestamp(client, lead_id, scan_ts)
                stats["recent_replies"] += 1
                stats["processed_lead_ids"].add(lead_id)
                lead_name = lead_display_name(lead)
                logger.info("Recent inbox REPLY detected", {"leadId": lead_id, "lead": lead_name})
                print(f"  ✓ REPLY detected from recent inbox: {lead_name}")
                continue

            if convo_info.get("is_outbound") or sender:
                update_inbox_scan_timestamp(client, lead_id, scan_ts)
                stats["processed_lead_ids"].add(lead_id)
                continue

            stats["recent_ambiguous"] += 1
        except Exception as exc:
            logger.warn("Recent inbox card scan failed; continuing", {"index": idx}, error=exc)

    return stats


async def extract_last_message_from_conversation(page: Page) -> Optional[Dict[str, Any]]:
    """Extract the last message from an open conversation thread.
    
    Returns dict with 'sender', 'text', 'is_outbound' or None if extraction fails.
    """
    try:
        # Wait for message thread to load
        await page.wait_for_timeout(800)
        
        # Find all messages in the conversation
        # LinkedIn uses various selectors for messages
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
                logger.debug(f"extract_last_message: found {count} messages with selector '{selector}'")
                break
        
        if not messages or await messages.count() == 0:
            logger.debug("extract_last_message: no messages found in conversation")
            return None
        
        # Get the last message
        last_msg = messages.last
        
        # Try to extract the sender name
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
                    sender = safe_text(await sender_el.text_content(timeout=2_000))
                    if sender:
                        break
            except Exception:
                continue
        
        # Extract message text
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
                    text = safe_text(await text_el.text_content(timeout=2_000))
                    if text:
                        break
            except Exception:
                continue
        
        # Fallback: get all text from the message
        if not text:
            try:
                text = safe_text(await last_msg.inner_text(timeout=3_000))[:500]
            except Exception:
                pass
        
        # Determine if this is an outbound message (sent by us)
        # Check for outbound indicators in the message element
        is_outbound = False
        try:
            # LinkedIn often marks outbound messages with specific classes or attributes
            msg_classes = await last_msg.get_attribute("class") or ""
            if "outbound" in msg_classes.lower() or "sent" in msg_classes.lower():
                is_outbound = True
            
            # Check parent elements for outbound indicators
            try:
                parent = last_msg.locator("xpath=..")
                parent_classes = await parent.get_attribute("class") or ""
                if "outbound" in parent_classes.lower() or "from-me" in parent_classes.lower():
                    is_outbound = True
            except Exception:
                pass
            
            # Also check if "Sie" appears as sender (German for "You")
            if sender.lower() in ["sie", "you", "ich"]:
                is_outbound = True
            
            # Check for visual indicators (e.g., message alignment, background color classes)
            try:
                # Outbound messages often have specific styling
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
        
    except Exception as exc:
        logger.warn("extract_last_message: error extracting message", error=exc)
        return None


def find_lead_match(client: Client, profile_url: Optional[str], name: str, status_filter: Optional[list[str]] = None) -> Optional[Dict[str, Any]]:
    """Match a reply to a lead. Prefer linkedin_url exact match; fallback to name heuristic.
    
    Args:
        client: Supabase client
        profile_url: LinkedIn profile URL to match
        name: Name to match if URL doesn't work
        status_filter: Optional list of statuses to filter by (e.g., ["SENT"] for inbox scan)
    """
    if not profile_url:
        # Without a stable profile URL, we avoid guessing based on name only.
        # This prevents accidental association of inbox threads with unrelated leads.
        logger.debug("find_lead_match: missing profile_url, skipping name-only match", {"name": name})
        return None

    url_norm = profile_url.split("?")[0].rstrip("/")
    query = (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, status")
        .ilike("linkedin_url", f"%{url_norm}%")
    )
    if status_filter:
        query = query.in_("status", status_filter)
    resp = query.limit(1).execute()
    rows = resp.data or []
    if rows:
        return rows[0]
    logger.debug("find_lead_match: no lead match for profile_url", {"profile_url": profile_url, "name": name})
    return None


def upsert_followup_for_reply(
    client: Client,
    lead_id: str,
    reply_id: Optional[str],
    reply_snippet: str,
    reply_timestamp: Optional[str],
    followup_type: str = "REPLY",
    last_message_text: Optional[str] = None,
    last_message_from: Optional[str] = None,
) -> None:
    """Create a new followup row as PENDING_REVIEW.
    
    Args:
        client: Supabase client
        lead_id: ID of the lead
        reply_id: Optional message ID of the reply
        reply_snippet: Text snippet of the reply (empty for nudges)
        reply_timestamp: Timestamp of the reply/detection
        followup_type: "REPLY" if lead responded, "NUDGE" if we need to follow up
        last_message_text: The actual text of the last message in the thread
        last_message_from: Who sent the last message ("us" or "lead")
    """
    # Determine last_message values if not provided
    if last_message_text is None:
        if reply_snippet:
            last_message_text = reply_snippet
            last_message_from = "lead"
        # For NUDGE, the caller should provide last_message_text/from
    
    insert_data = {
        "lead_id": lead_id,
        "reply_id": reply_id,
        "reply_snippet": reply_snippet[:2000] if reply_snippet else None,
        "reply_timestamp": reply_timestamp,
        "status": "PENDING_REVIEW",
        "followup_type": followup_type,
        "last_message_text": last_message_text[:2000] if last_message_text else None,
        "last_message_from": last_message_from,
    }
    
    insert_resp = execute_with_retry(
        client.table("followups").insert(insert_data),
        desc="Insert followup",
    )
    if getattr(insert_resp, "error", None):
        logger.error(
            "Failed to insert followup",
            {"lead_id": lead_id, "followup_type": followup_type},
            error=getattr(insert_resp, "error", None),
        )
        raise RuntimeError(f"Followup insert failed for lead {lead_id}: {insert_resp.error}")
    
    # Only update last_reply_at if this is an actual reply
    update_data = {
        "followup_count": (client.table("followups").select("id", count="exact").eq("lead_id", lead_id).execute().count or 0)
    }
    if followup_type == "REPLY" and reply_timestamp:
        update_data["last_reply_at"] = reply_timestamp
    update_resp = execute_with_retry(
        client.table("leads").update(update_data).eq("id", lead_id),
        desc="Update lead after followup insert",
    )
    if getattr(update_resp, "error", None):
        logger.error(
            "Failed to update lead after followup insert",
            {"lead_id": lead_id, "followup_type": followup_type},
            error=getattr(update_resp, "error", None),
        )
        raise RuntimeError(f"Lead update failed for lead {lead_id}: {update_resp.error}")


def cancel_active_nudges_for_reply(client: Client, lead_id: str) -> None:
    """Prevent stale nudge rows from being sent after a lead has replied."""
    execute_with_retry(
        client.table("followups")
        .update({"status": "SKIPPED", "last_error": "Superseded by detected reply"})
        .eq("lead_id", lead_id)
        .eq("followup_type", "NUDGE")
        .in_("status", ["PENDING_REVIEW", "APPROVED", "PROCESSING", "RETRY_LATER"]),
        desc=f"Cancel active nudges for replied lead {lead_id}",
    )


async def inbox_scan(context: BrowserContext, client: Client, limit: int, lead_ids: Optional[List[str]] = None) -> None:
    """Scan LinkedIn inbox for conversations with SENT leads using search.
    
    NEW APPROACH: Instead of scraping the inbox list (unreliable DOM selectors),
    we fetch leads with status=SENT from the database and search for each one
    by name in LinkedIn's messaging search box. This is much more reliable.
    
    Creates followups for two scenarios:
    1. REPLY: The lead has replied to our message (last message is from them)
    2. NUDGE: We sent a message but they haven't replied (last message is from us)
    """
    page = await context.new_page()
    try:
        # Fetch leads likely to have received outreach. FAILED is included because
        # the browser can fail after sending or after LinkedIn state changes, while
        # the inbox remains the authoritative source of replies.
        # Include throttling columns to skip recently scanned or pending invite leads
        logger.info(
            "Fetching inbox reply candidates from database...",
            {"limit": limit, "statuses": INBOX_REPLY_CANDIDATE_STATUSES, "lead_ids": lead_ids or []},
        )
        leads_query = (
            client.table("leads")
            .select("id, first_name, last_name, linkedin_url, status, last_inbox_scan_at, pending_invite, pending_checked_at")
            .in_("status", INBOX_REPLY_CANDIDATE_STATUSES)
        )
        if lead_ids:
            leads_query = leads_query.in_("id", lead_ids)
        if limit and limit > 0:
            leads_query = leads_query.limit(limit)
        elif not lead_ids:
            leads_query = leads_query.limit(DAILY_INBOX_SCAN_LIMIT)
        leads_resp = execute_with_retry(leads_query, desc="Fetch inbox reply candidates")
        sent_leads = leads_resp.data or []
        logger.info(f"Found {len(sent_leads)} inbox reply candidates to check")
        
        if not sent_leads:
            print("No inbox reply candidates found in database. Nothing to scan.")
            return
        
        replies_detected = 0
        inbox_hits = 0
        profile_fallbacks = 0
        skipped_existing = 0
        skipped_no_conversation = 0
        skipped_ambiguous = 0
        skipped_recently_scanned = 0
        skipped_pending_invite = 0

        active_reply_lead_ids = fetch_active_reply_lead_ids(
            client,
            [str(lead.get("id")) for lead in sent_leads if lead.get("id")],
        )
        if active_reply_lead_ids:
            skipped_existing += len(active_reply_lead_ids)
            logger.info(
                "Skipping candidates that already have active reply followups",
                {"count": len(active_reply_lead_ids)},
            )
        scan_leads = [lead for lead in sent_leads if lead.get("id") not in active_reply_lead_ids]
        if not scan_leads:
            logger.info(
                "Inbox scan complete",
                data={
                    "replies": replies_detected,
                    "inbox_hits": inbox_hits,
                    "profile_fallbacks": profile_fallbacks,
                    "skipped_existing": skipped_existing,
                    "skipped_no_conversation": skipped_no_conversation,
                    "skipped_ambiguous": skipped_ambiguous,
                    "skipped_recently_scanned": skipped_recently_scanned,
                    "skipped_pending_invite": skipped_pending_invite,
                    "recent_items_seen": 0,
                    "recent_matches": 0,
                    "recent_replies": 0,
                    "total_leads_checked": len(sent_leads),
                },
            )
            print(f"\n{'='*50}")
            print("INBOX SCAN COMPLETE")
            print(f"{'='*50}")
            print(f"  Leads checked: {len(sent_leads)}")
            print("  Replies detected: 0")
            print("  Inbox conversations found: 0")
            print("  Recent inbox cards scanned: 0")
            print("  Recent inbox lead matches: 0")
            print("  Profile fallbacks: 0")
            print(f"  Already pending: {skipped_existing}")
            print("  No conversation: 0")
            print(f"  Recently scanned ({INBOX_SCAN_COOLDOWN_HOURS}h): 0")
            print(f"  Pending invite ({PENDING_INVITE_BACKOFF_DAYS}d): 0")
            print(f"{'='*50}")
            return
        
        now_utc = datetime.datetime.now(datetime.timezone.utc)
        await navigate_to_inbox(page)

        recent_item_limit = (
            INBOX_RECENT_CONVERSATION_LIMIT
            if lead_ids
            else max(limit if limit and limit > 0 else INBOX_RECENT_CONVERSATION_LIMIT, 1)
        )
        recent_stats = await scan_recent_inbox_conversations(
            page,
            client,
            scan_leads,
            recent_item_limit,
        )
        processed_recent_lead_ids = recent_stats["processed_lead_ids"]
        replies_detected += recent_stats["recent_replies"]
        inbox_hits += recent_stats["recent_matches"]
        skipped_existing += recent_stats["recent_existing"]
        skipped_ambiguous += recent_stats["recent_ambiguous"]
        
        for lead in scan_leads:
            lead_id = lead["id"]
            lead_full_name = lead_display_name(lead)
            if lead_id in processed_recent_lead_ids:
                continue
            
            if not lead_full_name:
                logger.debug(f"Skipping lead with no name", {"leadId": lead_id})
                continue
            
            recently_scanned = False
            last_scan = lead.get("last_inbox_scan_at")
            if last_scan:
                try:
                    scan_dt = datetime.datetime.fromisoformat(last_scan.replace("Z", "+00:00"))
                    hours_since_scan = (now_utc - scan_dt).total_seconds() / 3600
                    if hours_since_scan < INBOX_SCAN_COOLDOWN_HOURS:
                        recently_scanned = True
                except Exception:
                    pass
            
            # --- THROTTLING: Skip if pending invite and checked recently ---
            if lead.get("pending_invite"):
                pending_checked = lead.get("pending_checked_at")
                if pending_checked:
                    try:
                        checked_dt = datetime.datetime.fromisoformat(pending_checked.replace("Z", "+00:00"))
                        days_since_check = (now_utc - checked_dt).total_seconds() / 86400
                        if days_since_check < PENDING_INVITE_BACKOFF_DAYS:
                            logger.debug(
                                f"Skipping {lead_full_name}, pending invite checked {round(days_since_check, 1)}d ago (backoff={PENDING_INVITE_BACKOFF_DAYS}d)",
                                {"leadId": lead_id}
                            )
                            skipped_pending_invite += 1
                            continue
                    except Exception:
                        pass
            
            logger.info(f"Checking inbox for reply candidate: {lead_full_name}", {"leadId": lead_id, "status": lead.get("status")})
            
            # Existing REPLY rows are authoritative. Existing NUDGE rows should
            # not block reply detection, because a later inbound reply supersedes them.
            if has_active_reply_followup(client, lead_id):
                logger.debug(f"Lead already has pending reply followup, skipping", {"leadId": lead_id})
                skipped_existing += 1
                continue
            
            # Prefer LinkedIn Messaging itself. Profile message buttons are
            # layout-dependent and can be absent even when the inbox has replies.
            if "linkedin.com/messaging" not in page.url:
                await navigate_to_inbox(page)
            convo_info = await search_conversation_by_name(page, lead)
            if convo_info:
                inbox_hits += 1
                logger.info("Inbox search found conversation", {"leadId": lead_id, "lead": lead_full_name})
            elif recently_scanned:
                logger.debug(
                    f"Skipping profile fallback for {lead_full_name}, scanned {round(hours_since_scan, 1)}h ago (cooldown={INBOX_SCAN_COOLDOWN_HOURS}h)",
                    {"leadId": lead_id},
                )
                skipped_recently_scanned += 1
                continue
            else:
                profile_fallbacks += 1
                logger.info("Inbox search found no conversation, falling back to profile", {"leadId": lead_id, "lead": lead_full_name})
                linkedin_url = (lead.get("linkedin_url") or "").strip()
                convo_info = await open_profile_and_get_last_message(page, lead_full_name, linkedin_url)

            # Always update last_inbox_scan_at after visiting the profile
            scan_ts = now_iso_utc()
            
            if not convo_info:
                logger.debug(f"No conversation found for {lead_full_name}", {"leadId": lead_id})
                # Update scan timestamp even if no conversation found
                update_inbox_scan_timestamp(client, lead_id, scan_ts)
                skipped_no_conversation += 1
                continue
            
            # --- HANDLE PENDING INVITE ---
            if convo_info.get("pending_invite"):
                logger.info(f"Lead {lead_full_name} has pending invite (Ausstehend), marking and skipping", {"leadId": lead_id})
                update_inbox_scan_timestamp(client, lead_id, scan_ts, pending_invite=True)
                skipped_pending_invite += 1
                print(f"  ⏳ Pending invite: {lead_full_name}")
                continue
            
            # Determine if the last message was from us or from them
            sender = convo_info.get("sender", "")
            text = convo_info.get("text", "")
            is_outbound = convo_info.get("is_outbound", False)
            
            logger.debug(
                f"Last message info for {lead_full_name}",
                {"sender": sender, "text": text[:60] if text else "", "is_outbound": is_outbound, "leadId": lead_id}
            )
            
            is_their_reply = is_inbound_reply_from_conversation(convo_info, lead)

            if not is_their_reply and not is_outbound:
                # Sender doesn't match lead name and isn't a standard "you" indicator.
                # Since we opened this conversation from the lead's profile, if the sender
                # is NOT the lead, it must be US (the logged-in user, e.g. "Simon Vestner").
                # This means the last message is outbound; the sender worker owns nudge scheduling.
                logger.debug(
                    f"Sender '{sender}' doesn't match lead '{lead_full_name}' - treating as our outbound message",
                    {"leadId": lead_id, "sender": sender, "leadName": lead_full_name}
                )
                is_outbound = True
            
            reply_ts = datetime.datetime.utcnow().isoformat()
            
            if is_their_reply:
                # This is a REPLY - they responded to our message
                cancel_active_nudges_for_reply(client, lead_id)
                upsert_followup_for_reply(
                    client,
                    lead_id=lead_id,
                    reply_id=None,
                    reply_snippet=text[:500] if text else "",
                    reply_timestamp=reply_ts,
                    followup_type="REPLY",
                    last_message_text=text[:2000] if text else "",
                    last_message_from="lead",
                )
                replies_detected += 1
                logger.info(f"✓ Created followup for REPLY from {lead_full_name}", {"leadId": lead_id})
                print(f"  ✓ REPLY detected from: {lead_full_name}")

            # Update lead with scan timestamp after processing
            update_inbox_scan_timestamp(client, lead_id, scan_ts)
            
            # Small delay between searches to avoid rate limiting
            await page.wait_for_timeout(500)
        
        # Summary
        logger.info(
            f"Inbox scan complete",
            data={
                "replies": replies_detected,
                "inbox_hits": inbox_hits,
                "profile_fallbacks": profile_fallbacks,
                "skipped_existing": skipped_existing,
                "skipped_no_conversation": skipped_no_conversation,
                "skipped_ambiguous": skipped_ambiguous,
                "skipped_recently_scanned": skipped_recently_scanned,
                "skipped_pending_invite": skipped_pending_invite,
                "recent_items_seen": recent_stats["recent_items_seen"],
                "recent_matches": recent_stats["recent_matches"],
                "recent_replies": recent_stats["recent_replies"],
                "total_leads_checked": len(sent_leads),
            }
        )
        print(f"\n{'='*50}")
        print(f"INBOX SCAN COMPLETE")
        print(f"{'='*50}")
        print(f"  Leads checked: {len(sent_leads)}")
        print(f"  Replies detected: {replies_detected}")
        print(f"  Inbox conversations found: {inbox_hits}")
        print(f"  Recent inbox cards scanned: {recent_stats['recent_items_seen']}")
        print(f"  Recent inbox lead matches: {recent_stats['recent_matches']}")
        print(f"  Profile fallbacks: {profile_fallbacks}")
        print(f"  Already pending: {skipped_existing}")
        print(f"  No conversation: {skipped_no_conversation}")
        print(f"  Recently scanned ({INBOX_SCAN_COOLDOWN_HOURS}h): {skipped_recently_scanned}")
        print(f"  Pending invite ({PENDING_INVITE_BACKOFF_DAYS}d): {skipped_pending_invite}")
        print(f"{'='*50}")
    finally:
        await page.close()


async def inbox_mode(limit: int = 0, lead_ids: Optional[List[str]] = None) -> None:
    """Entry point for inbox scanning.

    Opens a visible browser (headless=False), ensures LinkedIn auth, and then
    runs inbox_scan with a daily cap based on DAILY_INBOX_SCAN_LIMIT.
    """
    client = get_supabase_client()
    playwright, browser, context = await open_browser(headless=False)
    try:
        creds = fetch_linkedin_credentials(client)
        await ensure_linkedin_auth(context, creds)
        # If limit <= 0, process all reply candidates; otherwise respect the explicit cap.
        await inbox_scan(context, client, limit, lead_ids=lead_ids)
    finally:
        await shutdown(playwright, browser)


async def enrichment_loop_mode() -> None:
    """Continuously enrich NEW custom_outreach leads; sleep when the queue is empty."""
    # Claim the same pidfile the JS endpoint checks so the single-spawn invariant holds.
    pid_path = Path(__file__).parent / "enrichment.pid"
    own_pid = str(os.getpid())

    if pid_path.exists():
        raw = pid_path.read_text().strip()
        existing_pid = int(raw) if raw.isdigit() else None
        if existing_pid:
            try:
                os.kill(existing_pid, 0)
                # Process is alive — another scraper is running.
                logger.error(
                    "enrichment-loop: another scraper is already running",
                    None,
                    {"pid": existing_pid, "pidFile": str(pid_path)},
                )
                sys.exit(1)
            except OSError:
                # Stale pidfile — process is dead, clean up and continue.
                pid_path.unlink(missing_ok=True)

    pid_path.write_text(own_pid)

    logger.operation_start("scraper-enrichment-loop", input_data={"intent": "custom_outreach"})
    sleep_when_empty = int(os.getenv("ENRICHMENT_LOOP_IDLE_SECONDS", "60"))
    pass_size = int(os.getenv("ENRICHMENT_LOOP_PASS_SIZE", "10"))
    client = get_supabase_client()
    creds = fetch_linkedin_credentials(client)
    try:
        while True:
            leads = fetch_pending_leads_for_intent(client, pass_size, "custom_outreach")
            if not leads:
                logger.info("enrichment-loop: queue empty, sleeping", None, {"seconds": sleep_when_empty})
                await asyncio.sleep(sleep_when_empty)
                continue

            playwright, browser, context = await open_browser(headless=False)
            try:
                await ensure_linkedin_auth(context, creds)
                for lead in leads:
                    logger.db_query("update", "leads", {"leadId": lead.id}, {"status": "PROCESSING"})
                    client.table("leads").update({"status": "PROCESSING"}).eq("id", lead.id).execute()
                    page = await context.new_page()
                    try:
                        await enrich_one(page, client, lead)
                    except Exception as exc:
                        logger.error("enrichment-loop: lead failed", {"leadId": lead.id}, error=exc)
                    finally:
                        try:
                            await page.close()
                        except Exception:
                            pass
                    await random_pause()
            finally:
                await shutdown(playwright, browser)
    except KeyboardInterrupt:
        logger.info("enrichment-loop: stopping on SIGINT")
    finally:
        try:
            if pid_path.exists() and pid_path.read_text().strip() == own_pid:
                pid_path.unlink(missing_ok=True)
        except Exception:
            pass


if __name__ == "__main__":
    args = parse_args()
    if getattr(args, "sync_remote_session", False):
        asyncio.run(sync_remote_session_mode())
        sys.exit(0)

    if getattr(args, "reset_remote_session", False):
        asyncio.run(reset_remote_session_mode())
        sys.exit(0)

    if getattr(args, "login_only", False):
        asyncio.run(login_only_mode())
        sys.exit(0)

    if getattr(args, "manual_browser", False):
        asyncio.run(manual_browser_mode())
        sys.exit(0)

    if getattr(args, "enrichment_loop", False):
        asyncio.run(enrichment_loop_mode())
        sys.exit(0)

    if not args.run:
        print("Scraper invoked without --run flag. Exiting without processing leads.")
        sys.exit(0)

    # Dispatch based on inbox flag
    if getattr(args, "inbox", False):
        # For inbox scans, limit=0 means "no limit" (all reply candidates)
        limit = args.limit if isinstance(args.limit, int) and args.limit >= 0 else 0
        asyncio.run(inbox_mode(limit=limit, lead_ids=args.lead_id or None))
    else:
        limit = args.limit if isinstance(args.limit, int) and args.limit >= 0 else 0
        sequence_id = args.sequence_id if isinstance(args.sequence_id, int) and args.sequence_id > 0 else None
        batch_intent = getattr(args, "batch_intent", None)
        asyncio.run(main(limit=limit, sequence_id=sequence_id, batch_intent=batch_intent))
