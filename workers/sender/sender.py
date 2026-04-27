"""Sender worker that types approved drafts as a human."""

from __future__ import annotations

import asyncio
import os
import random
import sys
from datetime import datetime, time as dtime, timedelta, timezone
import re
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from dotenv import load_dotenv
from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright
from supabase import Client, create_client

# Import shared logger
sys.path.insert(0, str(Path(__file__).parent.parent))
from credential_crypto import decrypt_password
from shared_logger import get_logger

# Reuse scraper helpers for invite-send (no-note path + weekly-limit detection)
sys.path.insert(0, str(Path(__file__).parent.parent / "scraper"))
from scraper import (  # noqa: E402
    Lead as ScraperLead,
    WeeklyInviteLimitReached,
    capture_connect_failure_screenshot,
    confirm_connection_request_sent,
    detect_weekly_invite_limit,
    send_connection_request,
)

load_dotenv()

# Initialize logger
logger = get_logger("sender")

# Reuse the scraper's persisted auth state to avoid drift between workers.
def _resolve_scraper_auth_path() -> Path:
    candidates = [
        os.getenv("LINKEDIN_SCRAPER_DIR", "").strip(),
        "/data/scraper",
        str((Path(__file__).parent.parent / "scraper").resolve()),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate).expanduser()
        if path.exists():
            return (path / "auth.json").resolve()
    return (Path(__file__).parent.parent / "scraper" / "auth.json").resolve()


AUTH_STATE_PATH = _resolve_scraper_auth_path()
DAILY_SEND_DEFAULT = 100
SEQUENCE_INTERVAL_DEFAULT_DAYS = 3
LEAD_MESSAGE_ONLY_MAX_RETRIES = 3
FOLLOWUP_PROCESSING_STALE_MINUTES = 45
SEQUENCE_DEFAULT_MESSAGES = {
    "first_message": (
        "Hi {first_name},\n\n"
        "freut mich, dass wir uns hier vernetzen.\n\n"
        "Ich bin Katharina von Degura, du hattest deine betriebliche Altersvorsorge damals über uns eingerichtet.\n\n"
        "Ich melde mich kurz, weil wir bei vielen ehemaligen Degura Kunden sehen, dass nach einem Arbeitgeberwechsel staatliche Förderung "
        "und Arbeitgeberzuschüsse nicht mehr genutzt werden, obwohl sie einem weiterhin zustehen.\n\n"
        "Wie ist es bei dir mit der bAV weitergegangen? Läuft der Vertrag noch?\n\n"
        "Falls du magst, können wir uns das auch gerne kurz gemeinsam anschauen, dauert nur ein paar Minuten.\n\n"
        "Viele Grüße,\nKatharina"
    ),
    "second_message": (
        "Hi {first_name},\n\n"
        "nur ein kurzer Followup zu meiner letzten Nachricht.\n\n"
        "Der Grund, warum mir das Thema wichtig ist: Wenn dein Vertrag beitragsfrei liegt, verzichtest du aktuell auf den Arbeitgeberzuschuss "
        "und die steuerliche Förderung, die dir beim neuen Arbeitgeber zustehen.\n\n"
        "Das ist bares Geld, das du jeden Monat liegen lässt.\n\n"
        "Sollen wir da einmal kurz gemeinsam reinschauen?\n\n"
        "Viele Grüße,\nKatharina"
    ),
    "third_message": (
        "Hi {first_name},\n\n"
        "letzte kurze Nachricht von meiner Seite.\n\n"
        "Dir stehen aktuell vermutlich drei Dinge zu, die du nicht nutzt:\n\n"
        "Arbeitgeberzuschuss (mindestens 15%, oft mehr)\n"
        "Steuerliche Förderung (Beitrag aus dem Brutto)\n"
        "Sozialversicherungsersparnis\n\n"
        "Und noch ein kurzer Ausblick: Ab 2027 kommt das neue Altersvorsorgedepot. Degura wird das ab dem ersten Tag anbieten, "
        "als zentrale Plattform für deine komplette Vorsorge, egal bei welchem Arbeitgeber.\n\n"
        "Falls du Lust hast, das einmal kurz anzuschauen, ich freue mich auf den Austausch.\n\n"
        "Viele Grüße,\nKatharina"
    ),
}


def get_supabase_client() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        logger.error("Missing Supabase configuration", data={"has_url": bool(url), "has_key": bool(key)})
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    logger.debug("Supabase client initialized")
    return create_client(url, key)


def require_auth_state() -> None:
    if not AUTH_STATE_PATH.exists():
        raise FileNotFoundError(
            f"Missing auth.json at {AUTH_STATE_PATH}. "
            "Copy it from the scraper worker or create it via playwright codegen."
        )


def _should_force_headless(requested_headless: bool) -> bool:
    """Keep desktop debugging visible, but force headless mode in Linux containers."""
    if requested_headless:
        return True

    visible_override = os.getenv("PLAYWRIGHT_VISIBLE_BROWSER", "").strip().lower()
    if visible_override in {"1", "true", "yes"}:
        return False

    forced_headless = os.getenv("PLAYWRIGHT_FORCE_HEADLESS", "").strip().lower()
    if forced_headless in {"1", "true", "yes"}:
        return True

    if sys.platform.startswith("linux"):
        has_display = bool(os.getenv("DISPLAY") or os.getenv("WAYLAND_DISPLAY"))
        return not has_display

    return False


async def open_browser(headless: bool = False) -> Tuple[Playwright, Browser, BrowserContext]:
    playwright = await async_playwright().start()
    effective_headless = _should_force_headless(headless)
    browser = await playwright.chromium.launch(headless=effective_headless)
    # Use a copy of the auth state to avoid file locking conflicts with scraper
    storage_state = None
    if AUTH_STATE_PATH.exists():
        try:
            import json
            import tempfile
            # Read auth state and create a temporary copy to avoid locking
            with open(AUTH_STATE_PATH, 'r') as f:
                auth_data = json.load(f)
            # Create context with the auth data directly (no file lock)
            context = await browser.new_context(storage_state=auth_data)
            logger.debug("Browser context created with copied auth state")
            return playwright, browser, context
        except Exception as e:
            logger.warn("Failed to load auth state, creating fresh context", error=e)
    context = await browser.new_context()
    return playwright, browser, context


async def shutdown(playwright: Playwright, browser: Browser) -> None:
    await browser.close()
    await playwright.stop()


def random_delay_ms() -> float:
    return random.uniform(50, 150)


async def random_pause(min_seconds: float = 0.8, max_seconds: float = 1.8) -> None:
    await asyncio.sleep(random.uniform(min_seconds, max_seconds))


async def wiggle_mouse(page: Page) -> None:
    width = (page.viewport_size or {}).get("width", 1200)
    height = (page.viewport_size or {}).get("height", 800)
    for _ in range(3):
        await page.mouse.move(
            random.uniform(width * 0.2, width * 0.8),
            random.uniform(height * 0.2, height * 0.8),
            steps=8,
        )
        await asyncio.sleep(random.uniform(0.05, 0.15))


async def human_type(page: Page, text: str) -> None:
    for char in text:
        await page.keyboard.type(char, delay=random_delay_ms())
        if random.random() < 0.07:
            await asyncio.sleep(random.uniform(0.9, 1.4))


def today_utc_iso() -> str:
    now = datetime.utcnow()
    start = datetime.combine(now.date(), dtime.min)
    return start.isoformat() + "Z"


def sent_today_count(client: Client) -> int:
    start_iso = today_utc_iso()
    logger.db_query("select-count", "leads", {"status": "SENT"}, {"since": start_iso})
    resp = (
        client.table("leads")
        .select("id", count="exact")
        .eq("status", "SENT")
        .gte("sent_at", start_iso)
        .execute()
    )
    count = getattr(resp, "count", None) or 0
    logger.db_result("select-count", "leads", {"status": "SENT"}, count)
    logger.info(f"Sent today: {count}", data={"count": count})
    return count


def fetch_approved_leads(client: Client, limit: int) -> list[Dict[str, Any]]:
    """Fetch multiple approved leads at once to prevent duplicate fetching."""
    logger.db_query("select", "leads", {"status": "APPROVED", "limit": limit})
    resp = (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, company_name")
        .eq("status", "APPROVED")
        .order("updated_at", desc=True)
        .limit(limit)
        .execute()
    )
    rows = resp.data or []
    logger.db_result("select", "leads", {"status": "APPROVED"}, len(rows))
    if rows:
        logger.info(f"Fetched {len(rows)} APPROVED leads")
    return rows


MESSAGE_ONLY_PIPELINE_STATUSES = [
    "CONNECT_ONLY_SENT",
    "CONNECTED",
    "MESSAGE_ONLY_READY",
    "MESSAGE_ONLY_APPROVED",
]
MESSAGE_ONLY_PROCESSING_STATUSES = tuple(MESSAGE_ONLY_PIPELINE_STATUSES)
SURFACE_MESSAGE = "message"
SURFACE_CONNECT_NOTE = "connect_note"
SURFACE_CONNECT = "connect"
SURFACE_SALES_NAVIGATOR = "sales_navigator_message"


def _is_message_only_candidate(lead: Dict[str, Any]) -> bool:
    """Return True when a lead should be checked for post-acceptance messaging."""
    if not isinstance(lead, dict):
        return False
    if lead.get("sent_at"):
        return False
    if lead.get("connection_sent_at") or lead.get("connection_accepted_at"):
        return True
    status = str(lead.get("status") or "").upper()
    return status in MESSAGE_ONLY_PIPELINE_STATUSES


def normalize_linkedin_profile_url(url: str) -> str:
    normalized = (url or "").strip().replace("http://", "https://").split("?")[0].rstrip("/")
    if normalized.startswith("linkedin.com/"):
        normalized = f"https://www.{normalized}"
    if normalized.startswith("www.linkedin.com/"):
        normalized = f"https://{normalized}"
    return normalized


def classify_connect_only_surface(
    message_button_count: int,
    message_link_count: int,
    invite_link_count: int,
    connect_button_count: int,
    more_button_count: int,
) -> str:
    if message_button_count > 0 or message_link_count > 0:
        return "already_connected"
    if invite_link_count > 0 or connect_button_count > 0 or more_button_count > 0:
        return "invite_available"
    return "surface_exhausted"


def _derive_sales_navigator_subject_from_message(message: str) -> str:
    lines = [re.sub(r"\s+", " ", line).strip() for line in (message or "").splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return ""

    greeting_re = re.compile(r"^(hi|hallo|hello|guten tag)\b", re.I)
    if greeting_re.match(lines[0]) and len(lines) > 1:
        lines = lines[1:]
        if not lines:
            return ""

    subject = lines[0].rstrip(".,;:!?")
    return _hard_cap_text(subject, 80)


def build_sales_navigator_subject(lead: Dict[str, Any], message: str = "") -> str:
    # Sales Navigator/InMail performs best with a short, direct subject line.
    # Keep this stable so the compose window always uses the intended wording.
    return "Kurze Frage zu deiner bAV"


def strip_sales_navigator_signature(message: str) -> str:
    """Remove the manual sign-off from Sales Navigator bodies.

    Normal direct messages keep the full template. Sales Navigator/InMail already
    shows the sender identity separately, so duplicating the manual closing adds
    a second footer-like signature.
    """
    lines = (message or "").splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    if len(lines) >= 2 and lines[-2].strip().lower() == "viele grüße,":
        return "\n".join(lines[:-2]).strip()
    return (message or "").strip()


async def _has_visible_connect_or_pending_state(profile_container) -> bool:
    """Detect whether the profile still exposes invite/pending actions."""
    selectors = [
        ("button", r"(Ausstehend|Pending|Vernetzen|Connect|Einladen|Kontaktanfrage|Invite|Anfrage)"),
        ("link", r"(Ausstehend|Pending|Vernetzen|Connect|Einladen|Kontaktanfrage|Invite|Anfrage)"),
    ]
    for role, pattern in selectors:
        try:
            locator = profile_container.get_by_role(role, name=re.compile(pattern, re.I))
            if await locator.count() > 0:
                return True
        except Exception:
            continue
    return False


def fetch_message_only_leads(client: Client, limit: int, batch_id: Optional[int] = None) -> list[Dict[str, Any]]:
    """Fetch leads eligible for message-only sending.

    This intentionally keys off connection-sent timestamps, not just status,
    so leads whose invite was sent remain eligible even if a status promotion
    never happened.
    """
    select_fields_extended = (
        "id, linkedin_url, first_name, last_name, company_name, status, sent_at, "
        "connection_sent_at, connection_accepted_at, followup_count, last_reply_at, "
        "sequence_id, sequence_step, sequence_started_at, sequence_last_sent_at, "
        "csv_batch_id, outreach_mode, profile_data, ai_tags"
    )
    select_fields_legacy = (
        "id, linkedin_url, first_name, last_name, company_name, status, sent_at, "
        "connection_sent_at, connection_accepted_at, followup_count, last_reply_at, "
        "outreach_mode, profile_data, ai_tags"
    )
    query_meta: Dict[str, Any] = {
        "status": MESSAGE_ONLY_PIPELINE_STATUSES,
        "outreach_mode": "connect_only",
        "limit": limit,
    }
    if batch_id is not None:
        query_meta["batch_id"] = batch_id
    logger.db_query("select", "leads", query_meta)
    try:
        query = (
            client.table("leads")
            .select(select_fields_extended)
            .eq("outreach_mode", "connect_only")
            .is_("sent_at", "null")
            .order("updated_at", desc=True)
        )
        if batch_id is not None:
            query = query.eq("batch_id", batch_id)
        resp = query.limit(limit).execute()
    except Exception:
        query = (
            client.table("leads")
            .select(select_fields_legacy)
            .eq("outreach_mode", "connect_only")
            .is_("sent_at", "null")
            .order("updated_at", desc=True)
        )
        if batch_id is not None:
            query = query.eq("batch_id", batch_id)
        resp = query.limit(limit).execute()
    rows = resp.data or []
    logger.db_result("select", "leads", query_meta, len(rows))
    filtered_rows = [row for row in rows if _is_message_only_candidate(row)]
    if filtered_rows:
        logger.info(
            "Fetched %d message-only leads",
            data={"count": len(filtered_rows), "statuses": MESSAGE_ONLY_PIPELINE_STATUSES, "batch_id": batch_id},
        )
    return filtered_rows


def fetch_invite_queue(client: Client, limit: int, batch_id: Optional[int] = None) -> list[Dict[str, Any]]:
    """Fetch NEW sequence-driven leads eligible for connect-invite send.

    Joins through lead_batches to filter by batch_intent so we never grab
    custom_outreach leads (those go through the draft-review path).
    """
    query_meta: Dict[str, Any] = {
        "status": "NEW",
        "batch_intent": ["connect_message", "connect_only"],
        "limit": limit,
    }
    if batch_id is not None:
        query_meta["batch_id"] = batch_id
    logger.db_query("select", "leads", query_meta)
    query = (
        client.table("leads")
        .select(
            "id, linkedin_url, first_name, last_name, company_name, "
            "sequence_id, outreach_mode, batch_id, profile_data, lead_batches!inner(batch_intent)"
        )
        .eq("status", "NEW")
        .is_("connection_sent_at", "null")
        .in_("lead_batches.batch_intent", ["connect_message", "connect_only"])
        .limit(max(limit * 5, limit))
    )
    if batch_id is not None:
        query = query.eq("batch_id", batch_id)
    response = query.execute()
    rows = response.data or []
    filtered_rows: list[Dict[str, Any]] = []
    skipped_paused = 0
    for row in rows:
        meta = ((row.get("profile_data") or {}).get("meta") or {})
        if meta.get("connect_only_limit_reached") is True:
            skipped_paused += 1
            continue
        filtered_rows.append(row)
        if len(filtered_rows) >= limit:
            break
    logger.db_result("select", "leads", query_meta, len(filtered_rows))
    if skipped_paused:
        logger.info(
            "Skipped paused connect-only leads already marked as limit reached",
            data={"skipped": skipped_paused, "batch_id": batch_id},
        )
    return filtered_rows


def connect_only_invite_limit_active(client: Client) -> Optional[str]:
    """Return a reason string when connect-only invites should be paused."""
    start_of_week_window = (datetime.utcnow() - timedelta(days=7)).isoformat()

    recent_failed = (
        client.table("leads")
        .select("id, error_message, updated_at")
        .eq("outreach_mode", "connect_only")
        .eq("status", "FAILED")
        .gte("updated_at", start_of_week_window)
        .order("updated_at", desc=True)
        .limit(10)
        .execute()
    ).data or []
    if any("weekly invite limit" in str(row.get("error_message") or "").lower() for row in recent_failed):
        return "LinkedIn weekly invite limit reached. Stop until next week."

    paused = (
        client.table("leads")
        .select("id")
        .eq("outreach_mode", "connect_only")
        .eq("status", "NEW")
        .contains("profile_data", { "meta": { "connect_only_limit_reached": True } })
        .limit(1)
        .execute()
    ).data or []
    if paused:
        return "LinkedIn weekly invite limit reached. Some leads are paused for retry next week."

    return None


def fetch_next_lead(client: Client) -> Optional[Dict[str, Any]]:
    """Legacy function - fetch a single approved lead."""
    leads = fetch_approved_leads(client, 1)
    return leads[0] if leads else None


def fetch_lead_by_id(client: Client, lead_id: str) -> Optional[Dict[str, Any]]:
    select_fields_extended = (
        "id, linkedin_url, first_name, last_name, company_name, status, sent_at, "
        "connection_sent_at, connection_accepted_at, followup_count, last_reply_at, "
        "sequence_id, sequence_step, sequence_started_at, sequence_last_sent_at, "
        "csv_batch_id, outreach_mode, profile_data, ai_tags"
    )
    select_fields_legacy = (
        "id, linkedin_url, first_name, last_name, company_name, status, sent_at, "
        "connection_sent_at, connection_accepted_at, followup_count, last_reply_at, "
        "outreach_mode, profile_data, ai_tags"
    )
    try:
        resp = (
            client.table("leads")
            .select(select_fields_extended)
            .eq("id", lead_id)
            .limit(1)
            .execute()
        )
    except Exception:
        resp = (
            client.table("leads")
            .select(select_fields_legacy)
            .eq("id", lead_id)
            .limit(1)
            .execute()
        )
    rows = resp.data or []
    return rows[0] if rows else None


def fetch_draft(client: Client, lead_id: str) -> Optional[Dict[str, Any]]:
    logger.db_query("select", "drafts", {"leadId": lead_id})
    resp = (
        client.table("drafts")
        .select("*")
        .eq("lead_id", lead_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    draft = rows[0] if rows else None
    logger.db_result("select", "drafts", {"leadId": lead_id}, 1 if draft else 0)
    return draft


def _hard_cap_text(text: str, limit: int) -> str:
    """Return text trimmed to <= limit characters with an ellipsis if trimmed.

    Tries to cut at a word boundary and cleans up trailing punctuation.
    """
    try:
        t = (text or "").strip()
    except Exception:
        t = str(text or "")
    if limit <= 0:
        return ""
    if len(t) <= limit:
        return t
    if limit <= 3:
        return t[:limit]
    candidate = t[: limit - 1].rstrip()
    space_idx = candidate.rfind(" ")
    if space_idx >= max(10, limit // 2):
        candidate = candidate[:space_idx]
    candidate = candidate.rstrip(" ,.;:-")
    if not candidate:
        candidate = t[: limit - 1]
    return f"{candidate}…"


def build_message(draft: Dict[str, Any]) -> str:
    opener = draft.get("opener") or ""
    body = draft.get("body_text") or draft.get("body") or ""
    cta = draft.get("cta_text") or ""
    final = draft.get("final_message")
    if final:
        logger.debug("Using final_message from draft", data={"length": len(final)})
        # Hard-cap to 300 characters regardless of source
        capped = _hard_cap_text(final, 300)
        if len(capped) != len(final):
            logger.warn("final_message exceeded limit and was capped", data={"original": len(final), "final": len(capped)})
        return capped
    parts = [opener.strip(), body.strip(), cta.strip()]
    message = "\n\n".join([p for p in parts if p])
    logger.debug("Built message from parts", data={"length": len(message)})
    capped = _hard_cap_text(message, 300)
    if len(capped) != len(message):
        logger.warn("Assembled message exceeded limit and was capped", data={"original": len(message), "final": len(capped)})
    return capped


def _parse_iso_datetime(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        if isinstance(value, datetime):
            parsed = value
        else:
            text = str(value).strip()
            if not text:
                return None
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except Exception:
        return fallback


def _render_template_message(template: str, lead: Dict[str, Any]) -> str:
    first_name = (lead.get("first_name") or "").strip()
    last_name = (lead.get("last_name") or "").strip()
    company = (lead.get("company_name") or "").strip()
    full_name = " ".join([p for p in [first_name, last_name] if p]).strip()
    replacements = {
        "{{first_name}}": first_name,
        "{{last_name}}": last_name,
        "{{full_name}}": full_name,
        "{{company_name}}": company,
        "{{VORNAME}}": first_name,
        "{{NACHNAME}}": last_name,
        "{first_name}": first_name,
        "{last_name}": last_name,
        "{full_name}": full_name,
        "{company_name}": company,
        "[Name]": first_name or full_name,
        "[name]": first_name or full_name,
    }
    rendered = (template or "").strip()
    for key, val in replacements.items():
        rendered = rendered.replace(key, val or "")
    # Preserve paragraph breaks for direct LinkedIn messages while normalizing
    # accidental extra spaces inside each line.
    lines = [re.sub(r"[ \t]{2,}", " ", line).strip() for line in rendered.splitlines()]
    return "\n".join(lines).strip()


def load_sequence_messages(client: Client, lead: Dict[str, Any]) -> Dict[str, Any]:
    """Resolve sequence messages for a lead, preferring DB templates over defaults."""
    result: Dict[str, Any] = {
        "connect_note": "",
        "first_message": SEQUENCE_DEFAULT_MESSAGES["first_message"],
        "second_message": SEQUENCE_DEFAULT_MESSAGES["second_message"],
        "third_message": SEQUENCE_DEFAULT_MESSAGES["third_message"],
        "followup_interval_days": SEQUENCE_INTERVAL_DEFAULT_DAYS,
        "source": "defaults",
    }

    sequence_id = lead.get("sequence_id")
    rows: list[Dict[str, Any]] = []
    try:
        query = client.table("outreach_sequences").select(
            "id, connect_note, first_message, second_message, third_message, followup_interval_days, is_active, created_at"
        )
        if sequence_id is not None:
            query = query.eq("id", sequence_id)
        else:
            query = query.eq("is_active", True).order("created_at", desc=False).limit(1)
        resp = query.execute()
        rows = resp.data or []
    except Exception:
        rows = []

    if rows:
        row = rows[0]
        result.update(
            {
                "connect_note": row.get("connect_note") or result["connect_note"],
                "first_message": row.get("first_message") or result["first_message"],
                "second_message": row.get("second_message") or result["second_message"],
                "third_message": row.get("third_message") or result["third_message"],
                "followup_interval_days": _safe_int(
                    row.get("followup_interval_days"), SEQUENCE_INTERVAL_DEFAULT_DAYS
                ),
                "source": "outreach_sequences",
            }
        )
    else:
        for key in ["outreach_sequences", "outreach_sequence", "sequence_templates"]:
            try:
                settings_resp = (
                    client.table("settings")
                    .select("value")
                    .eq("key", key)
                    .limit(1)
                    .execute()
                )
                payload = ((settings_resp.data or [{}])[0].get("value") or {})
                template = None
                if isinstance(payload, list) and payload:
                    template = payload[0]
                elif isinstance(payload, dict):
                    if isinstance(payload.get("templates"), list) and payload.get("templates"):
                        template = payload["templates"][0]
                    else:
                        template = payload
                if isinstance(template, dict):
                    result.update(
                        {
                            "connect_note": template.get("connect_note")
                            or template.get("invite_note")
                            or result["connect_note"],
                            "first_message": template.get("first_message")
                            or template.get("message_1")
                            or result["first_message"],
                            "second_message": template.get("second_message")
                            or template.get("message_2")
                            or result["second_message"],
                            "third_message": template.get("third_message")
                            or template.get("message_3")
                            or result["third_message"],
                            "followup_interval_days": _safe_int(
                                template.get("followup_interval_days"), SEQUENCE_INTERVAL_DEFAULT_DAYS
                            ),
                            "source": f"settings:{key}",
                        }
                    )
                    break
            except Exception:
                continue

    result["connect_note"] = _render_template_message(str(result["connect_note"]), lead)
    result["first_message"] = _render_template_message(str(result["first_message"]), lead)
    result["second_message"] = _render_template_message(str(result["second_message"]), lead)
    result["third_message"] = _render_template_message(str(result["third_message"]), lead)
    if result["followup_interval_days"] < 1:
        result["followup_interval_days"] = SEQUENCE_INTERVAL_DEFAULT_DAYS
    return result


async def click_and_resolve_active_page(page: Page, locator, timeout_ms: int = 8_000) -> Page:
    context = page.context
    before_pages = set(context.pages)
    popup_task = asyncio.create_task(page.wait_for_event("popup", timeout=timeout_ms))
    try:
        await locator.click(timeout=timeout_ms)
        try:
            popup = await popup_task
            await popup.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
            logger.info("Popup page opened for message surface", data={"url": popup.url})
            return popup
        except Exception:
            await page.wait_for_timeout(500)
            after_pages = [candidate for candidate in context.pages if candidate not in before_pages]
            if after_pages:
                candidate = after_pages[-1]
                await candidate.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
                logger.info("New page opened for message surface", data={"url": candidate.url})
                return candidate
            return page
    finally:
        if not popup_task.done():
            popup_task.cancel()


async def open_message_surface(page: Page) -> str:
    """Open a messaging surface on a LinkedIn profile page.
    
    CRITICAL: All selectors must be scoped to lazy-column test ID to avoid
    clicking buttons in the messaging inbox or other parts of the page.
    """
    await wiggle_mouse(page)

    logger.info("Starting open_message_surface")

    # Scope all interactions to the profile page's main content area
    # Try lazy-column test ID first, with fallback to main profile section
    profile_container = None
    try:
        profile_container = page.get_by_test_id("lazy-column")
        await profile_container.wait_for(state="visible", timeout=5_000)
        logger.element_search("lazy-column", 1, context={"method": "test_id"})
    except Exception as e:
        logger.element_search("lazy-column", 0, context={"method": "test_id"})
        # Fallback to main profile section
        try:
            profile_container = page.locator("main.scaffold-layout__main, section.artdeco-card").first
            await profile_container.wait_for(state="visible", timeout=5_000)
            logger.selector_fallback("lazy-column", "main.scaffold-layout__main", success=True)
        except Exception as e2:
            logger.selector_fallback("lazy-column", "main.scaffold-layout__main", success=False)
            # Last resort: use page itself (risky but better than failing)
            profile_container = page
            logger.warn("Using page-level selectors as last resort")

    # PATH 1a: Explicit "Nachricht an <Name>" button (localized message button)
    message_btn = profile_container.get_by_role("button", name=re.compile(r"(Nachricht an|Message to)", re.I))
    message_btn_count = await message_btn.count()
    logger.element_search("Nachricht an / Message to button", message_btn_count, role="button", context={"path": "1a"})

    if message_btn_count > 0:
        try:
            await message_btn.first.click(timeout=8_000)
            logger.element_click("Message button", success=True)
            await page.wait_for_selector(
                "div.msg-overlay-conversation-bubble, section[role='dialog'] div[role='textbox'][contenteditable='true'], div.msg-form__contenteditable[contenteditable='true']",
                timeout=10_000,
            )
            await random_pause()
            logger.path_attempt("Message button (connected user)", 1, success=True)
            return "message"
        except Exception as e:
            logger.element_click("Message button", success=False)
            logger.path_attempt("Message button", 1, success=False)

    # PATH 1b: Try Message link (for existing connections)
    # Scoped to profile container to avoid inbox Message buttons
    message_link = profile_container.get_by_role("link", name=re.compile(r"(Message|Nachricht)", re.I))
    message_link_count = await message_link.count()
    logger.element_search("Message/Nachricht link", message_link_count, role="link", context={"path": "1b"})

    if message_link_count > 0:
        try:
            await message_link.first.click(timeout=8_000)
            logger.element_click("Message link", success=True)
            # Wait for messaging overlay
            await page.wait_for_selector(
                "div.msg-overlay-conversation-bubble, section[role='dialog'] div[role='textbox'][contenteditable='true'], div.msg-form__contenteditable[contenteditable='true']",
                timeout=10_000,
            )
            await random_pause()
            logger.path_attempt("Message link (connected user)", 1, success=True)
            return "message"
        except Exception as e:
            logger.element_click("Message link", success=False)
            logger.path_attempt("Message link", 1, success=False)

    # PATH 2: Direct invite link inside profile container (Invite <Name> to ...)
    invite_link = profile_container.get_by_role("link", name=re.compile(r"(Invite .+ to|Einladen .+ zu)", re.I))
    invite_link_count = await invite_link.count()
    logger.element_search("Invite link", invite_link_count, role="link", context={"path": 2})

    if invite_link_count > 0:
        try:
            await invite_link.first.click(timeout=8_000)
            logger.element_click("Invite link", success=True)
            await page.wait_for_selector("section[role='dialog'], div[role='dialog']", timeout=8_000)
            await random_pause()
            logger.dialog_detected("invite_dialog", context={"path": 2})

            add_note_btn = page.get_by_role("button", name=re.compile(r"(Nachricht hinzufügen|Add a note|Notiz hinzufügen)", re.I))
            add_note_count = await add_note_btn.count()
            logger.element_search("Add a note button", add_note_count, role="button", context={"path": 2})

            if add_note_count > 0:
                await add_note_btn.first.click(timeout=6_000)
                logger.element_click("Add a note button", success=True)
                await page.wait_for_timeout(500)
                logger.path_attempt("Invite link -> Add note", 2, success=True)
                return "connect_note"
            logger.path_attempt("Invite link (no note)", 2, success=True)
            return "connect"
        except Exception as e:
            logger.element_click("Invite link", success=False)
            logger.path_attempt("Invite link", 2, success=False)

    # PATH 3: Direct Vernetzen / Als Kontakt button on profile card
    direct_connect_btn = profile_container.get_by_role(
        "button",
        name=re.compile(r"(Vernetzen|Als Kontakt|als Kontakt)", re.I),
    )
    direct_connect_count = await direct_connect_btn.count()
    logger.element_search("Vernetzen/Connect button", direct_connect_count, role="button", context={"path": 3})

    if direct_connect_count > 0:
        try:
            await direct_connect_btn.first.click(timeout=8_000)
            logger.element_click("Vernetzen button", success=True)
            await page.wait_for_selector("section[role='dialog'], div[role='dialog']", timeout=8_000)
            await random_pause()
            logger.dialog_detected("connect_dialog", context={"path": 3})

            add_note_btn = page.get_by_role("button", name=re.compile(r"(Nachricht hinzufügen|Add a note|Notiz hinzufügen)", re.I))
            add_note_count = await add_note_btn.count()
            logger.element_search("Add a note button", add_note_count, role="button", context={"path": 3})

            if add_note_count > 0:
                await add_note_btn.first.click(timeout=6_000)
                logger.element_click("Add a note button", success=True)
                await page.wait_for_timeout(500)
                logger.path_attempt("Direct Connect -> Add note", 3, success=True)
                return "connect_note"
            logger.path_attempt("Direct Connect (no note)", 3, success=True)
            return "connect"
        except Exception as e:
            logger.element_click("Vernetzen button", success=False)
            logger.path_attempt("Direct Connect", 3, success=False)

    # PATH 4: Try More button -> Invite flow (fallback)
    # Scoped to profile container - allow partial match for "Mehr" or "More"
    more_button = profile_container.get_by_role("button", name=re.compile(r"(More|Mehr)", re.I))
    more_button_count = await more_button.count()
    logger.element_search("More/Mehr button", more_button_count, role="button", context={"path": 4})

    if more_button_count > 0:
        try:
            await more_button.first.click(timeout=8_000)
            logger.element_click("More button", success=True)
            await page.wait_for_timeout(300)

            # Look for Invite/Connect menuitem (can include name like "Invite Antonio-Jean")
            invite_menuitem = page.get_by_role("menuitem", name=re.compile(r"(Invite|Einladen|Connect|Vernetzen)", re.I))
            invite_count = await invite_menuitem.count()
            logger.element_search("Invite/Connect menuitem", invite_count, role="menuitem", context={"path": 4})

            if invite_count > 0:
                await invite_menuitem.first.click(timeout=8_000)
                logger.element_click("Invite menuitem", success=True)

                # Wait for connection dialog
                await page.wait_for_selector("section[role='dialog'], div[role='dialog']", timeout=8_000)
                await random_pause()
                logger.dialog_detected("connect_via_more_menu", context={"path": 4})

                # Click "Add a note" button
                add_note_btn = page.get_by_role("button", name=re.compile(r"(Nachricht hinzufügen|Add a note|Notiz hinzufügen)", re.I))
                add_note_count = await add_note_btn.count()
                logger.element_search("Add a note button", add_note_count, role="button", context={"path": 4})

                if add_note_count > 0:
                    await add_note_btn.first.click(timeout=6_000)
                    logger.element_click("Add a note button", success=True)
                    await page.wait_for_timeout(500)
                    logger.path_attempt("More -> Invite -> Add note", 4, success=True)
                    return "connect_note"
                else:
                    logger.path_attempt("More -> Invite (no note)", 4, success=True)
                    return "connect"
            else:
                logger.path_attempt("More -> Invite (menuitem not found)", 4, success=False)
        except Exception as e:
            logger.element_click("More button flow", success=False)
            logger.path_attempt("More -> Invite", 4, success=False)

    logger.error("All messaging surface paths exhausted")
    raise RuntimeError("No messaging surface found. Check if profile is 3rd-degree or has restrictions.")


async def open_sales_navigator_message_surface(page: Page) -> Optional[Page]:
    sales_nav_selectors = [
        ("sales nav message button", lambda: page.get_by_role("button", name=re.compile(r"(Nachricht|Message|InMail)", re.I))),
        ("sales nav message link", lambda: page.get_by_role("link", name=re.compile(r"(Nachricht|Message|InMail)", re.I))),
        ("sales nav compose button", lambda: page.locator("button:has-text('Nachricht'), button:has-text('Message'), button:has-text('InMail')")),
        ("sales nav compose link", lambda: page.locator("a:has-text('Nachricht'), a:has-text('Message'), a:has-text('InMail')")),
    ]

    for selector_name, builder in sales_nav_selectors:
        try:
            candidate = builder()
            count = await candidate.count()
            logger.element_search(selector_name, count, context={"surface": SURFACE_SALES_NAVIGATOR})
            if count <= 0:
                continue
            target_page = await click_and_resolve_active_page(page, candidate.first)
            await target_page.wait_for_timeout(1_000)
            subject_count = await target_page.locator(
                "input[name='subject'], input[placeholder*='Subject'], input[aria-label*='Subject'], "
                "input[placeholder*='Betreff'], input[aria-label*='Betreff']"
            ).count()
            body_count = await target_page.locator(
                "textarea[name='message'], textarea[placeholder*='Message'], textarea[aria-label*='Message'], "
                "div[role='textbox'][contenteditable='true']"
            ).count()
            if subject_count > 0 and body_count > 0:
                logger.path_attempt("Sales Navigator message surface", 1, success=True)
                return target_page
            logger.path_attempt("Sales Navigator message surface missing fields", 1, success=False)
        except Exception as exc:
            logger.path_attempt("Sales Navigator message surface", 1, success=False)
            logger.warn("Sales Navigator surface attempt failed", error=exc)
    return None


async def fill_text_field(page: Page, selector_name: str, locator, value: str) -> None:
    await locator.wait_for(state="visible", timeout=10_000)
    await locator.click()
    try:
        await page.keyboard.press("Meta+A")
        await page.keyboard.press("Backspace")
    except Exception:
        await page.keyboard.press("Control+A")
        await page.keyboard.press("Backspace")
    await human_type(page, value)
    await page.wait_for_timeout(500)
    actual_text = await locator.evaluate("el => el.value || el.textContent || el.innerText || ''") or ""
    if len(actual_text.strip()) < max(1, len(value.strip()) - 2):
        raise RuntimeError(f"{selector_name} verification failed after typing.")
    logger.element_type(selector_name, len(value), text_preview=value[:40])


async def send_sales_navigator_message(page: Page, subject: str, body: str) -> None:
    safe_subject = _hard_cap_text((subject or "").strip(), 80)
    safe_body = (body or "").strip()
    if not safe_subject:
        raise RuntimeError("Sales Navigator subject is empty.")
    if not safe_body:
        raise RuntimeError("Sales Navigator body is empty.")

    subject_candidates = [
        ("subject input:name", "input[name='subject']"),
        ("subject input:placeholder", "input[placeholder*='Subject'], input[placeholder*='Betreff']"),
        ("subject input:aria", "input[aria-label*='Subject'], input[aria-label*='Betreff']"),
    ]
    body_candidates = [
        ("body textarea:name", "textarea[name='message']"),
        ("body textarea:placeholder", "textarea[placeholder*='Message'], textarea[placeholder*='Nachricht']"),
        ("body textarea:aria", "textarea[aria-label*='Message'], textarea[aria-label*='Nachricht']"),
        ("body contenteditable", "div[role='textbox'][contenteditable='true']"),
    ]

    subject_locator = None
    subject_selector = ""
    for name, selector in subject_candidates:
        candidate = page.locator(selector).first
        if await candidate.count() > 0:
            subject_locator = candidate
            subject_selector = name
            break
    if subject_locator is None:
        raise RuntimeError("Could not find Sales Navigator subject field.")

    body_locator = None
    body_selector = ""
    for name, selector in body_candidates:
        candidate = page.locator(selector).first
        if await candidate.count() > 0:
            body_locator = candidate
            body_selector = name
            break
    if body_locator is None:
        raise RuntimeError("Could not find Sales Navigator body field.")

    await fill_text_field(page, subject_selector, subject_locator, safe_subject)
    await fill_text_field(page, body_selector, body_locator, safe_body)

    send_btn = page.locator(
        "button:has-text('Send'):visible, "
        "button:has-text('Senden'):visible, "
        "button[aria-label*='Send']:visible, "
        "button[aria-label*='Senden']:visible"
    ).first
    await send_btn.wait_for(state="visible", timeout=10_000)
    if not await send_btn.is_enabled():
        raise RuntimeError("Sales Navigator send button is disabled.")
    await page.wait_for_timeout(800)
    await send_btn.click()
    logger.element_click("Sales Navigator send button", success=True)
    await random_pause()


async def has_sales_navigator_composer(page: Page) -> bool:
    subject_count = await page.locator(
        "input[name='subject'], input[placeholder*='Subject'], input[aria-label*='Subject'], "
        "input[placeholder*='Betreff'], input[aria-label*='Betreff']"
    ).count()
    body_count = await page.locator(
        "textarea[name='message'], textarea[placeholder*='Message'], textarea[aria-label*='Message'], "
        "div[role='textbox'][contenteditable='true']"
    ).count()
    return subject_count > 0 and body_count > 0


async def wait_for_sales_navigator_composer(page: Page, timeout_ms: int = 10_000) -> bool:
    deadline = asyncio.get_event_loop().time() + (timeout_ms / 1000)
    while asyncio.get_event_loop().time() < deadline:
        if await has_sales_navigator_composer(page):
            return True
        await page.wait_for_timeout(250)
    return False


async def send_message(page: Page, message: str, surface: str, draft: Optional[Dict[str, Any]] = None) -> None:
    """Send a message through the opened messaging surface.
    
    Args:
        page: Playwright page object
        message: Message text to send
        surface: Type of surface opened ("message" or "connect_note")
        draft: Optional draft data to extract opener for connection notes
    """

    if surface == "connect_note":
        # Add-a-note modal: Use the specific textbox selector
        logger.info("Sending connection request with note", data={"surface": surface})

        # LinkedIn limits note to 300 characters
        safe_message = (message or "").strip()

        if len(safe_message) > 300:
            logger.warn(f"Message too long, truncating", data={"original": len(safe_message), "limit": 300})
            # Intelligently truncate at sentence/word boundary
            safe_message = safe_message[:297] + "..."
        else:
            logger.debug(f"Message fits in limit", data={"length": len(safe_message), "limit": 300})

        # Use the exact selector provided by user (support English & German labels)
        note_box_selectors = [
            ("textbox:Personal note limit", lambda: page.get_by_role("textbox", name=re.compile(r"Please limit personal note to", re.I))),
            ("textbox:Ihre persönliche Nachricht", lambda: page.get_by_role("textbox", name=re.compile(r"Ihre persönliche Nachricht", re.I))),
            ("textbox:Nachricht hinzufügen", lambda: page.get_by_role("textbox", name=re.compile(r"Nachricht hinzufügen", re.I))),
            ("textarea[name=message]", lambda: page.locator("textarea[name='message']")),
            ("textarea[id=custom-message]", lambda: page.locator("textarea[id='custom-message']")),
            ("dialog textarea", lambda: page.locator("div[role='dialog'] textarea")),
        ]
        note_box = None
        note_box_count = 0
        used_selector = ""
        for selector_name, builder in note_box_selectors:
            try:
                candidate = builder()
                count = await candidate.count()
                if count > 0:
                    note_box = candidate
                    note_box_count = count
                    used_selector = selector_name
                    break
            except Exception:
                continue
        logger.element_search(used_selector or "note textbox", note_box_count, context={"surface": "connect_note"})

        if note_box and note_box_count > 0:
            target = note_box.first
            await target.click()
            # Clear any pre-filled text in a human-like way
            try:
                await page.keyboard.press("Meta+A")  # mac shortcut
                await page.keyboard.press("Backspace")
            except Exception:
                try:
                    await page.keyboard.press("Control+A")
                    await page.keyboard.press("Backspace")
                except Exception:
                    pass
            try:
                await target.evaluate("el => { if ('value' in el) el.value=''; if (el.isContentEditable) el.textContent=''; }")
            except Exception:
                pass
            await human_type(page, safe_message)
            logger.element_type(used_selector, len(safe_message), text_preview=safe_message[:40])
            await random_pause(0.5, 1.0)

            # CRITICAL: Verify the full message was typed before clicking send
            # Wait for DOM to stabilize and verify text length
            await page.wait_for_timeout(500)

            # Verify the text was actually entered
            for verification_attempt in range(10):
                try:
                    actual_text = await target.evaluate("el => el.value || el.textContent || ''") or ""
                    actual_length = len(actual_text.strip())
                    expected_length = len(safe_message)

                    if actual_length >= expected_length - 2:  # Allow 1-2 char margin for encoding
                        logger.debug(f"Text verification passed", data={"expected": expected_length, "actual": actual_length})
                        break
                    else:
                        logger.debug(f"Text still being entered", data={"expected": expected_length, "actual": actual_length, "attempt": verification_attempt})
                        await page.wait_for_timeout(200)
                except Exception as e:
                    logger.warn(f"Text verification attempt {verification_attempt} failed", error=e)
                    await page.wait_for_timeout(200)
            else:
                logger.warn("Could not verify full text was entered, proceeding anyway")
        else:
            logger.element_search("note textbox (all selectors)", 0, context={"surface": "connect_note"})
            raise RuntimeError("Could not find note textbox in connection request dialog")

        # Find and click Send button in the dialog
        dialog = page.locator("section[role='dialog'], div[role='dialog']").first
        # Support both English and German
        send_btn = dialog.locator(
            "button:has-text('Send invitation'), button:has-text('Send'), button:has-text('Einladung senden'), button:has-text('Senden'), button[aria-label*='Send']"
        ).first

        # Wait for button to be enabled
        try:
            await send_btn.wait_for(state="visible", timeout=10_000)
            logger.element_search("Send button (dialog)", 1, role="button")

            # Wait for button to be enabled AND give extra time for any final DOM updates
            for attempt in range(30):
                if await send_btn.is_enabled():
                    logger.debug(f"Send button enabled", data={"attempts": attempt})
                    break
                await page.wait_for_timeout(300)

            # Additional safety pause before clicking to ensure typing is truly complete
            await page.wait_for_timeout(800)

            await send_btn.click()
            logger.element_click("Send button (dialog)", success=True)
            await random_pause()
            return
        except Exception as e:
            logger.element_click("Send button (dialog)", success=False)
            raise

    # Direct message composer path (for existing connections)
    logger.info("Sending direct message", data={"surface": surface})

    # Find message input box
    editor_candidates = [
        ("msg-form contenteditable", "div.msg-form__contenteditable[contenteditable='true']"),
        ("msg-form textarea", "div.msg-form__textarea"),
        ("dialog textbox", "section[role='dialog'] div[role='textbox'][contenteditable='true']"),
        ("Write a message", "div[aria-label*='Write a message'][contenteditable='true']"),
        ("generic textbox", "div[role='textbox'][contenteditable='true']:not([id^='g-recaptcha'])"),
        ("msg-form-ember", "div[id^='msg-form-ember'] div[role='textbox'][contenteditable='true']"),
    ]

    editor = None
    used_selector = ""
    for name, sel in editor_candidates:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=3_000)
            editor = loc
            used_selector = name
            logger.element_search(name, 1, context={"surface": "message"})
            break
        except Exception:
            continue

    if editor is None:
        logger.element_search("message editor (all selectors)", 0, context={"surface": "message"})
        raise RuntimeError("Could not find message input box")

    await editor.click()
    await human_type(page, message)
    logger.element_type(used_selector, len(message), text_preview=message[:40])
    await random_pause()

    # CRITICAL: Verify the full message was typed before clicking send
    # Wait for DOM to stabilize and verify text length
    await page.wait_for_timeout(500)

    # Verify the text was actually entered
    for verification_attempt in range(10):
        try:
            actual_text = await editor.evaluate("el => el.value || el.textContent || el.innerText || ''") or ""
            actual_length = len(actual_text.strip())
            expected_length = len(message.strip())

            if actual_length >= expected_length - 2:  # Allow 1-2 char margin for encoding
                logger.debug(f"Text verification passed", data={"expected": expected_length, "actual": actual_length})
                break
            else:
                logger.debug(f"Text still being entered", data={"expected": expected_length, "actual": actual_length, "attempt": verification_attempt})
                await page.wait_for_timeout(200)
        except Exception as e:
            logger.warn(f"Text verification attempt {verification_attempt} failed", error=e)
            await page.wait_for_timeout(200)
    else:
        logger.warn("Could not verify full direct message text was entered, proceeding anyway")

    # Find and click Send button
    send_btn = page.locator(
        "button:has-text('Send'):visible, "
        "button:has-text('Senden'):visible, "
        "button[aria-label*='Send']:visible, "
        "button[aria-label*='Senden']:visible"
    ).first
    try:
        await send_btn.wait_for(state="visible", timeout=10_000)
        logger.element_search("Send button (message)", 1, role="button")

        # Additional safety pause before clicking to ensure typing is truly complete
        await page.wait_for_timeout(800)

        await send_btn.click()
        logger.element_click("Send button (message)", success=True)
        await random_pause()
    except Exception as e:
        logger.element_click("Send button (message)", success=False)
        raise


def mark_processing(client: Client, lead_id: str) -> None:
    """Mark lead as PROCESSING to prevent re-fetching during the same run."""
    logger.db_query("update", "leads", {"leadId": lead_id}, {"status": "PROCESSING"})
    client.table("leads").update({"status": "PROCESSING"}).eq("id", lead_id).execute()
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    logger.debug(f"Lead marked as PROCESSING", {"leadId": lead_id})


def mark_message_only_processing(client: Client, lead: Dict[str, Any]) -> bool:
    lead_id = str(lead.get("id") or "")
    if not lead_id:
        return False

    has_invite_timestamp = bool(lead.get("connection_sent_at") or lead.get("connection_accepted_at"))
    logger.db_query(
        "update",
        "leads",
        {"leadId": lead_id},
        {"status": "PROCESSING", "from": list(MESSAGE_ONLY_PROCESSING_STATUSES)},
    )
    try:
        query = (
            client.table("leads")
            .update({"status": "PROCESSING", "updated_at": datetime.utcnow().isoformat()})
            .eq("id", lead_id)
        )
        if has_invite_timestamp:
            # Invite-sent leads are selected by timestamp, so status can be stale here.
            # Claim them by ID + sent_at guard instead of requiring status promotion first.
            query = query.is_("sent_at", "null")
        else:
            query = query.in_("status", list(MESSAGE_ONLY_PROCESSING_STATUSES))

        resp = query.execute()
    except Exception as exc:
        logger.warn("Failed to lock message-only lead", {"leadId": lead_id}, error=exc)
        return False

    rows = getattr(resp, "data", None) or []
    locked = len(rows) > 0
    logger.db_result("update", "leads", {"leadId": lead_id}, len(rows))
    if locked:
        lead["status"] = "PROCESSING"
        logger.debug("Lead marked as PROCESSING for message-only send", {"leadId": lead_id})
    else:
        logger.info("Message-only lead was already claimed or no longer eligible", {"leadId": lead_id})
    return locked


def mark_sent(client: Client, lead_id: str) -> None:
    now_iso = datetime.utcnow().isoformat()
    logger.db_query("update", "leads", {"leadId": lead_id}, {"status": "SENT", "sequence_step": 1})
    try:
        client.table("leads").update(
            {
                "status": "SENT",
                "sent_at": now_iso,
                "sequence_step": 1,
                "sequence_started_at": now_iso,
                "sequence_last_sent_at": now_iso,
            }
        ).eq("id", lead_id).execute()
    except Exception:
        client.table("leads").update({"status": "SENT", "sent_at": now_iso}).eq("id", lead_id).execute()
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    logger.info(f"Lead marked as SENT", {"leadId": lead_id})


def _step_from_followup(followup_type: Any, attempt: Any) -> Optional[int]:
    if (str(followup_type or "").upper() != "NUDGE"):
        return None
    attempt_i = _safe_int(attempt, 0)
    if attempt_i == 1:
        return 2
    if attempt_i == 2:
        return 3
    return None


def mark_failed(client: Client, lead_id: str, error_message: str = "") -> None:
    """Mark lead as FAILED for permanent failures (e.g., can't message this profile)."""
    logger.db_query("update", "leads", {"leadId": lead_id}, {"status": "FAILED"})
    update_data = {"status": "FAILED", "updated_at": datetime.utcnow().isoformat()}
    if error_message:
        # Store error in profile_data for debugging
        update_data["error_message"] = error_message[:500]  # Truncate to reasonable length
    client.table("leads").update(update_data).eq("id", lead_id).execute()
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    logger.warn(f"Lead marked as FAILED", {"leadId": lead_id, "error": error_message})


def mark_connect_only_limit_reached(client: Client, lead: Dict[str, Any], error_message: str) -> None:
    """Persist the connect-only invite cap in both status and profile metadata."""
    lead_id = str(lead.get("id") or "")
    now_iso = datetime.utcnow().isoformat()
    truncated_error = (error_message or "LinkedIn weekly invite limit reached")[:500]

    current_profile_data = lead.get("profile_data")
    profile_data: Dict[str, Any] = current_profile_data if isinstance(current_profile_data, dict) else {}
    meta = dict(profile_data.get("meta") or {})
    meta["connect_only_limit_reached"] = True
    meta["connect_only_limit_reason"] = truncated_error
    meta["connect_only_limit_at"] = now_iso

    update_payload: Dict[str, Any] = {
        "status": "FAILED",
        "updated_at": now_iso,
        "error_message": truncated_error,
        "profile_data": {**profile_data, "meta": meta},
    }

    logger.db_query("update", "leads", {"leadId": lead_id}, update_payload)
    client.table("leads").update(update_payload).eq("id", lead_id).execute()
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    lead["profile_data"] = update_payload["profile_data"]
    logger.warn("Connect-only lead marked limit reached", {"leadId": lead_id, "error": truncated_error})


def promote_connect_only_to_connected(client: Client, lead: Dict[str, Any]) -> str:
    """Mark an invite-only lead as connected so the message-only worker can pick it up."""
    lead_id = str(lead.get("id") or "")
    update_payload = {
        "status": "CONNECTED",
        "error_message": None,
        "updated_at": datetime.utcnow().isoformat(),
    }
    logger.db_query("update", "leads", {"leadId": lead_id}, update_payload)
    client.table("leads").update(update_payload).eq("id", lead_id).execute()
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    lead.update(update_payload)
    return "connected"


def mark_lead_retry_later(client: Client, lead: Dict[str, Any], error_message: str = "") -> int:
    """Mark a connected lead as needing a later retry and persist retry attempts in profile_data."""
    lead_id = str(lead.get("id") or "")
    current_profile_data = lead.get("profile_data")
    profile_data: Dict[str, Any] = current_profile_data if isinstance(current_profile_data, dict) else {}

    attempts = _safe_int(profile_data.get("message_only_retry_attempts"), 0) + 1
    now_iso = datetime.utcnow().isoformat()
    truncated_error = (error_message or "")[:500]

    updated_profile_data = dict(profile_data)
    updated_profile_data["message_only_retry_attempts"] = attempts
    updated_profile_data["message_only_last_error"] = truncated_error
    updated_profile_data["message_only_last_retry_at"] = now_iso

    logger.db_query("update", "leads", {"leadId": lead_id}, {"status": "CONNECTED"})
    update_payload: Dict[str, Any] = {
        "status": "CONNECTED",
        "updated_at": now_iso,
        "error_message": truncated_error,
    }
    try:
        update_payload["profile_data"] = updated_profile_data
        client.table("leads").update(update_payload).eq("id", lead_id).execute()
    except Exception:
        update_payload.pop("profile_data", None)
        client.table("leads").update(update_payload).eq("id", lead_id).execute()

    lead["profile_data"] = updated_profile_data
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    logger.warn("Lead marked for retry while connected", {"leadId": lead_id, "attempt": attempts, "error": truncated_error})
    return attempts


async def process_one(context: BrowserContext, client: Client, lead: Dict[str, Any]) -> None:
    lead_id = lead["id"]
    logger.message_send_start(lead_id, {"url": lead.get("linkedin_url")})

    draft = fetch_draft(client, lead_id)
    if not draft:
        logger.error("Lead has no draft to send", {"leadId": lead_id})
        raise RuntimeError("Lead has no draft to send.")

    sequence_messages = load_sequence_messages(client, lead)
    connect_note = str(sequence_messages.get("connect_note") or "").strip()
    message = build_message(draft)
    logger.message_send_start(lead_id, message_preview=message)

    page = await context.new_page()
    # Normalize to https to reduce redirects
    url = normalize_linkedin_profile_url(str(lead["linkedin_url"]))
    logger.debug(f"Navigating to profile", {"leadId": lead_id}, {"url": url})

    async def wait_if_checkpoint() -> None:
        # Detect common CAPTCHA/checkpoint surfaces and wait for manual resolution
        checkpoint_markers = [
            "iframe[src*='recaptcha']",
            "textarea#g-recaptcha-response",
            "textarea[id^='g-recaptcha-response']",
            "div:has-text('verify you')",
            "div:has-text('security check')",
            "div:has-text('checkpoint')",
        ]
        for _ in range(60):  # up to ~60 * 3s = 3 minutes
            for sel in checkpoint_markers:
                try:
                    if await page.locator(sel).first.is_visible(timeout=500):
                        print("Checkpoint/CAPTCHA detected. Please solve it in the opened browser window...")
                        await page.wait_for_timeout(3_000)
                        break
                except Exception:
                    pass
            else:
                # no markers visible in this iteration
                return
        # Exit after wait window; continue anyway and let subsequent steps fail if still blocked.

    async def nav_with_auth_retry(target_url: str) -> None:
        # Avoid networkidle on LinkedIn; use domcontentloaded + small wait.
        await page.goto(target_url, wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(1_000)
        await wait_if_checkpoint()
        # If we got bounced to login somehow, re-auth and retry once.
        if "/login" in page.url and not await is_logged_in(context):
            await ensure_linkedin_auth(context, client)
            await page.goto(target_url, wait_until="domcontentloaded", timeout=60_000)
            await page.wait_for_timeout(1_000)
            await wait_if_checkpoint()

    await nav_with_auth_retry(url)
    try:
        # Wait for any main/content shell to be present
        await page.wait_for_selector("main, body", timeout=15_000)
    except Exception:
        pass
    await random_pause()

    try:
        surface = await open_message_surface(page)
        logger.debug(f"Message surface opened", {"leadId": lead_id}, {"surface": surface})
    except Exception as e:
        logger.error(f"Failed to open message surface", {"leadId": lead_id}, error=e)
        # Take a screenshot for debugging
        try:
            screenshot_path = f"/tmp/linkedin_error_{lead_id[:8]}.png"
            await page.screenshot(path=screenshot_path)
            logger.info(f"Screenshot saved to {screenshot_path}")
        except Exception:
            pass
        raise

    try:
        outbound_message = message
        if surface == "connect_note":
            outbound_message = connect_note or message
            if not connect_note:
                logger.warn(
                    "Missing connect_note on sequence; falling back to legacy draft message",
                    {"leadId": lead_id, "sequenceId": lead.get("sequence_id")},
                )
        await send_message(page, outbound_message, surface, draft)
    except Exception as e:
        logger.error(f"Failed to send message through surface", {"leadId": lead_id}, error=e)
        raise

    mark_sent(client, lead_id)
    await page.close()

    logger.message_send_complete(lead_id)
    logger.info(f"Message sent successfully", {"leadId": lead_id})


# ------------------------- FOLLOW-UP FLOW -------------------------
def _followup_is_due(row: Dict[str, Any], now_utc: datetime) -> bool:
    next_send_at = _parse_iso_datetime(row.get("next_send_at"))
    if not next_send_at:
        return True
    return next_send_at <= now_utc


def fetch_approved_followups(
    client: Client,
    limit: int = 10,
    followup_type_filter: Optional[str] = None,
) -> list[Dict[str, Any]]:
    """Fetch APPROVED followups that are due and mark them PROCESSING."""
    now_utc = _utc_now()
    logger.db_query("select", "followups", {"status": "APPROVED", "limit": limit})
    try:
        resp = (
            client.table("followups")
            .select(
                "id, lead_id, status, followup_type, attempt, draft_text, sent_text, next_send_at, "
                "last_message_text, last_message_from, updated_at, "
                "lead:leads(id, linkedin_url, first_name, last_name, company_name, last_reply_at, sequence_id, sequence_step)"
            )
            .eq("status", "APPROVED")
            .order("updated_at", desc=True)
            .limit(max(limit * 5, limit))
            .execute()
        )
    except Exception:
        # Legacy schemas may miss `attempt` but still include `followup_type`.
        try:
            resp = (
                client.table("followups")
                .select(
                    "id, lead_id, status, followup_type, draft_text, sent_text, next_send_at, "
                    "last_message_text, last_message_from, updated_at, "
                    "lead:leads(id, linkedin_url, first_name, last_name, company_name, last_reply_at, sequence_id, sequence_step)"
                )
                .eq("status", "APPROVED")
                .order("updated_at", desc=True)
                .limit(max(limit * 5, limit))
                .execute()
            )
        except Exception:
            # Last-resort legacy fallback.
            resp = (
                client.table("followups")
                .select(
                    "id, lead_id, status, draft_text, sent_text, next_send_at, "
                    "last_message_text, last_message_from, updated_at, "
                    "lead:leads(id, linkedin_url, first_name, last_name, company_name, last_reply_at, sequence_id, sequence_step)"
                )
                .eq("status", "APPROVED")
                .order("updated_at", desc=True)
                .limit(max(limit * 5, limit))
                .execute()
            )
    rows = resp.data or []
    logger.db_result("select", "followups", {"status": "APPROVED"}, len(rows))

    selected: list[Dict[str, Any]] = []
    for row in rows:
        if followup_type_filter and (row.get("followup_type") or "").upper() != followup_type_filter.upper():
            continue
        if not _followup_is_due(row, now_utc):
            continue

        lead = row.get("lead") or {}
        if (row.get("followup_type") or "").upper() == "NUDGE" and lead.get("last_reply_at"):
            mark_followup_skipped(client, row["id"], "Lead replied before scheduled nudge.")
            continue

        selected.append(row)
        if len(selected) >= limit:
            break

    # Mark selected rows as PROCESSING immediately to prevent double-fetch
    for row in selected:
        client.table("followups").update({
            "status": "PROCESSING",
            "processing_started_at": datetime.utcnow().isoformat(),
        }).eq("id", row["id"]).execute()
        logger.debug(f"Followup marked as PROCESSING", {"followupId": row["id"]})

    if selected:
        logger.info(
            f"Fetched {len(selected)} APPROVED followups ready to send",
            data={"followupTypeFilter": followup_type_filter},
        )
    return selected


def recover_stale_processing_followups(
    client: Client,
    stale_minutes: int = FOLLOWUP_PROCESSING_STALE_MINUTES,
    limit: int = 200,
) -> int:
    """Recover followups stuck in PROCESSING beyond the stale threshold."""
    stale_cutoff = (_utc_now() - timedelta(minutes=max(1, stale_minutes))).isoformat()
    query_meta = {"status": "PROCESSING", "stale_before": stale_cutoff, "limit": limit}
    logger.db_query("select", "followups", query_meta)
    try:
        resp = (
            client.table("followups")
            .select("id, processing_started_at")
            .eq("status", "PROCESSING")
            .lt("processing_started_at", stale_cutoff)
            .order("processing_started_at", desc=False)
            .limit(max(1, limit))
            .execute()
        )
    except Exception as e:
        logger.warn("Skipping stale followup recovery (query failed)", data=query_meta, error=e)
        return 0

    rows = resp.data or []
    logger.db_result("select", "followups", query_meta, len(rows))
    recovered = 0
    for row in rows:
        followup_id = row.get("id")
        if not followup_id:
            continue
        try:
            revert_followup_to_approved(client, followup_id)
            recovered += 1
        except Exception as e:
            logger.warn(
                "Failed to recover stale PROCESSING followup",
                {"followupId": followup_id},
                error=e,
            )

    if recovered:
        logger.info(
            "Recovered stale PROCESSING followups",
            data={"count": recovered, "threshold_minutes": stale_minutes},
        )
    return recovered


def fetch_next_followup(client: Client) -> Optional[Dict[str, Any]]:
    """Legacy single-fetch; returns first APPROVED followup."""
    followups = fetch_approved_followups(client, 1)
    return followups[0] if followups else None


def sanitize_followup_message(text: str) -> str:
    """Apply safety filters for direct-message followups without invite-note truncation."""
    if not text:
        return ""
    # Remove dashes and apostrophes (same as outreach no-dash rule)
    sanitized = re.sub(r"[\-\u2010-\u2015\u2212]+", " ", text)
    sanitized = re.sub(r"['`\u2018\u2019]+", " ", sanitized)
    sanitized = sanitized.replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t]{2,}", " ", line).strip() for line in sanitized.splitlines()]
    sanitized = "\n".join(lines).strip()

    # Direct LinkedIn messages support significantly more than invite notes.
    # Keep a generous safety cap to avoid pathological payloads.
    if len(sanitized) > 2000:
        logger.warn("Followup message exceeded 2000 chars, truncating", data={"original": len(sanitized)})
        sanitized = _hard_cap_text(sanitized, 2000)

    return sanitized


def build_followup_message(fu: Dict[str, Any]) -> str:
    # Prefer draft_text; fallback to sent_text if somehow present
    raw_msg = (fu.get("draft_text") or fu.get("sent_text") or "").strip()
    return sanitize_followup_message(raw_msg)


def _next_sequence_step_for_nudge(followup: Dict[str, Any]) -> Optional[int]:
    if (str(followup.get("followup_type") or "").upper() != "NUDGE"):
        return None
    # Prefer explicit attempt mapping when available.
    explicit = _step_from_followup(followup.get("followup_type"), followup.get("attempt"))
    if explicit is not None:
        return explicit
    lead = followup.get("lead") or {}
    current_step = _safe_int(lead.get("sequence_step"), 0)
    if current_step <= 1:
        return 2
    if current_step == 2:
        return 3
    return 3


def resolve_followup_message(client: Client, followup: Dict[str, Any]) -> Tuple[str, Optional[int], str]:
    """Resolve followup text with sequence-aware message selection for NUDGE flows."""
    default_message = build_followup_message(followup)
    followup_type = str(followup.get("followup_type") or "").upper()
    if followup_type != "NUDGE":
        return default_message, None, "followup_draft_text"

    lead = followup.get("lead") or {}
    if not isinstance(lead, dict) or not lead.get("id"):
        return default_message, None, "followup_draft_text_no_lead"

    next_step = _next_sequence_step_for_nudge(followup)
    if next_step not in (2, 3):
        return default_message, None, "followup_draft_text_unknown_step"

    sequence_messages = load_sequence_messages(client, lead)
    message_key = "second_message" if next_step == 2 else "third_message"
    candidate = sanitize_followup_message(str(sequence_messages.get(message_key) or ""))
    if candidate:
        return candidate, next_step, f"sequence_template:{message_key}"
    return default_message, next_step, "followup_draft_text_empty_template"


def mark_followup_sent(
    client: Client,
    followup_id: str,
    message: str,
    followup: Optional[Dict[str, Any]] = None,
    sequence_step: Optional[int] = None,
) -> None:
    now_iso = datetime.utcnow().isoformat()
    logger.db_query("update", "followups", {"followupId": followup_id}, {"status": "SENT"})
    client.table("followups").update(
        {"status": "SENT", "sent_text": message, "sent_at": now_iso, "processing_started_at": None}
    ).eq("id", followup_id).execute()

    lead_id: Optional[str] = None
    step_to_set: Optional[int] = sequence_step
    if isinstance(followup, dict):
        lead_id = str(followup.get("lead_id") or "") or None
        if step_to_set is None:
            step_to_set = _next_sequence_step_for_nudge(followup)

    if lead_id:
        lead_update: Dict[str, Any] = {
            "sequence_last_sent_at": now_iso,
            "updated_at": now_iso,
        }
        if step_to_set is not None:
            lead_update["sequence_step"] = step_to_set

        try:
            client.table("leads").update(lead_update).eq("id", lead_id).execute()
        except Exception:
            # Legacy schemas may miss sequence columns.
            pass

    logger.db_result("update", "followups", {"followupId": followup_id}, 1)
    logger.info(
        f"Followup marked as SENT",
        {
            "followupId": followup_id,
            "leadId": lead_id,
            "sequenceStep": step_to_set,
        },
    )


def mark_followup_skipped(client: Client, followup_id: str, reason: str) -> None:
    logger.db_query("update", "followups", {"followupId": followup_id}, {"status": "SKIPPED"})
    client.table("followups").update(
        {
            "status": "SKIPPED",
            "last_error": reason[:500] if reason else None,
            "processing_started_at": None,
        }
    ).eq("id", followup_id).execute()
    logger.db_result("update", "followups", {"followupId": followup_id}, 1)
    logger.info("Followup marked as SKIPPED", {"followupId": followup_id, "reason": reason})


def mark_followup_failed(client: Client, followup_id: str, error_message: str, permanent: bool = False) -> None:
    """Mark followup as FAILED (permanent) or RETRY_LATER (transient)."""
    status = "FAILED" if permanent else "RETRY_LATER"
    logger.db_query("update", "followups", {"followupId": followup_id}, {"status": status})
    client.table("followups").update({
        "status": status,
        "last_error": error_message[:500] if error_message else None,
        "processing_started_at": None,
    }).eq("id", followup_id).execute()
    logger.db_result("update", "followups", {"followupId": followup_id}, 1)
    logger.warn(f"Followup marked as {status}", {"followupId": followup_id, "error": error_message})


def revert_followup_to_approved(client: Client, followup_id: str) -> None:
    """Revert a PROCESSING followup back to APPROVED for retry."""
    logger.db_query("update", "followups", {"followupId": followup_id}, {"status": "APPROVED"})
    client.table("followups").update({
        "status": "APPROVED",
        "processing_started_at": None,
    }).eq("id", followup_id).execute()
    logger.db_result("update", "followups", {"followupId": followup_id}, 1)
    logger.info(f"Followup reverted to APPROVED for retry", {"followupId": followup_id})


def schedule_nudge_followup(
    client: Client,
    lead: Dict[str, Any],
    attempt: int,
    sequence_messages: Dict[str, Any],
    base_time: datetime,
    previous_message: str,
) -> None:
    """Create an APPROVED nudge followup if one for this attempt does not exist."""
    lead_id = lead["id"]
    attempt = int(attempt)
    if attempt < 1 or attempt > 2:
        return

    message_key = "second_message" if attempt == 1 else "third_message"
    draft_text = (sequence_messages.get(message_key) or "").strip()
    if not draft_text:
        logger.warn("Skipping nudge scheduling due to empty sequence message", {"leadId": lead_id, "attempt": attempt})
        return

    try:
        existing = (
            client.table("followups")
            .select("id, status")
            .eq("lead_id", lead_id)
            .eq("followup_type", "NUDGE")
            .eq("attempt", attempt)
            .limit(1)
            .execute()
        ).data or []
    except Exception:
        # Legacy schemas may not expose attempt/followup_type. Fall back to lead-only dedupe.
        try:
            existing = (
                client.table("followups")
                .select("id, status")
                .eq("lead_id", lead_id)
                .limit(1)
                .execute()
            ).data or []
        except Exception as e:
            logger.warn("Skipping nudge scheduling: followups table unavailable", {"leadId": lead_id, "attempt": attempt}, error=e)
            return
    if existing:
        logger.debug("Nudge followup already exists", {"leadId": lead_id, "attempt": attempt, "followupId": existing[0]["id"]})
        return

    interval_days = _safe_int(sequence_messages.get("followup_interval_days"), SEQUENCE_INTERVAL_DEFAULT_DAYS)
    if interval_days < 1:
        interval_days = SEQUENCE_INTERVAL_DEFAULT_DAYS
    next_send_at = (base_time + timedelta(days=interval_days)).isoformat()

    payload = {
        "lead_id": lead_id,
        "status": "APPROVED",
        "followup_type": "NUDGE",
        "attempt": attempt,
        "draft_text": draft_text,
        "next_send_at": next_send_at,
        "last_message_text": _hard_cap_text(previous_message or "", 2000),
        "last_message_from": "us",
    }
    try:
        client.table("followups").insert(payload).execute()
    except Exception:
        fallback_payload = dict(payload)
        fallback_payload.pop("attempt", None)
        try:
            client.table("followups").insert(fallback_payload).execute()
        except Exception as e:
            minimal_payload = {
                "lead_id": lead_id,
                "status": "APPROVED",
                "draft_text": draft_text,
            }
            try:
                client.table("followups").insert(minimal_payload).execute()
            except Exception as e2:
                logger.warn(
                    "Skipping nudge scheduling due to incompatible followups schema",
                    {"leadId": lead_id, "attempt": attempt},
                    error=e2,
                )
                return
    logger.info(
        "Scheduled nudge followup",
        {"leadId": lead_id},
        {"attempt": attempt, "next_send_at": next_send_at, "source": sequence_messages.get("source")},
    )


async def process_followup_one(context: BrowserContext, client: Client, followup: Dict[str, Any]) -> str:
    """Process a single followup. Returns 'sent', 'failed', or 'retry'.
    
    The followup should already be marked as PROCESSING before calling this.
    """
    followup_id = followup["id"]
    lead = (followup.get("lead") or {})
    lead_id = lead.get("id")
    linkedin_url = str(lead.get("linkedin_url") or "").replace("http://", "https://")

    logger.info(f"Processing followup", {"followupId": followup_id, "leadId": lead_id})

    if not linkedin_url:
        error_msg = "Followup has no linked lead URL"
        logger.error(error_msg, {"followupId": followup_id})
        mark_followup_failed(client, followup_id, error_msg, permanent=True)
        return "failed"

    message, resolved_step, source = resolve_followup_message(client, followup)
    if not message:
        error_msg = "Followup has no draft_text to send"
        logger.error(error_msg, {"followupId": followup_id})
        mark_followup_failed(client, followup_id, error_msg, permanent=True)
        return "failed"

    logger.message_send_start(lead_id or "unknown", {"followupId": followup_id}, message)
    logger.debug(
        f"Followup message preview",
        {"followupId": followup_id},
        {"message": message[:100], "length": len(message), "source": source, "resolvedStep": resolved_step},
    )

    page = await context.new_page()
    try:
        await page.goto(linkedin_url, wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(1_000)
        await random_pause()
        
        surface = await open_message_surface(page)
        logger.debug(f"Message surface opened for followup", {"followupId": followup_id}, {"surface": surface})
        if surface != "message":
            raise RuntimeError(
                f"Followup requires direct-message surface only; got non-sendable surface '{surface}'"
            )

        await send_message(page, message, surface)
        await page.close()
        mark_followup_sent(client, followup_id, message, followup, sequence_step=resolved_step)

        logger.message_send_complete(lead_id or "unknown", {"followupId": followup_id})
        logger.info(f"Followup sent successfully", {"followupId": followup_id, "leadId": lead_id})
        return "sent"
        
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Failed to send followup", {"followupId": followup_id}, error=e)
        
        # Take screenshot for debugging
        try:
            screenshot_path = f"/tmp/followup_error_{followup_id[:8]}.png"
            await page.screenshot(path=screenshot_path)
            logger.info(f"Screenshot saved to {screenshot_path}")
        except Exception:
            pass
        
        # Determine if this is a permanent or transient failure
        permanent_indicators = [
            "No messaging surface found",
            "3rd-degree",
            "restrictions",
            "no draft_text",
            "no linked lead URL",
        ]
        is_permanent = any(ind in error_msg for ind in permanent_indicators)
        
        if is_permanent:
            mark_followup_failed(client, followup_id, error_msg, permanent=True)
            return "failed"
        else:
            mark_followup_failed(client, followup_id, error_msg, permanent=False)
            return "retry"
    finally:
        try:
            await page.close()
        except Exception:
            pass


# ------------------------- SEND-INVITES FLOW -------------------------
def mark_invite_processing(client: Client, lead_id: str) -> bool:
    """Atomically claim a NEW lead for invite send. Returns False if no-op."""
    try:
        resp = (
            client.table("leads")
            .update({"status": "PROCESSING", "updated_at": datetime.utcnow().isoformat()})
            .eq("id", lead_id)
            .eq("status", "NEW")
            .execute()
        )
    except Exception as exc:
        logger.warn("Failed to lock invite lead", {"leadId": lead_id}, error=exc)
        return False
    rows = getattr(resp, "data", None) or []
    return len(rows) > 0


def _fetch_sequence_connect_note(client: Client, sequence_id: Any) -> str:
    if not sequence_id:
        return ""
    try:
        resp = (
            client.table("outreach_sequences")
            .select("connect_note")
            .eq("id", sequence_id)
            .single()
            .execute()
        )
    except Exception as exc:
        logger.warn("Failed to load sequence connect_note", {"sequenceId": sequence_id}, error=exc)
        return ""
    data = getattr(resp, "data", None) or {}
    return str(data.get("connect_note") or "")


async def _send_invite_with_note(page: Page, lead: Dict[str, Any], note_text: str) -> str:
    """Open the invite-with-note dialog and send. Returns 'sent' | 'failed' | 'limit_reached'."""
    lead_id = str(lead.get("id") or "")
    profile_url = normalize_linkedin_profile_url(str(lead.get("linkedin_url") or ""))

    try:
        await page.goto(profile_url, wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_selector("main", timeout=15_000)
        await random_pause(1.0, 2.0)
    except Exception as exc:
        screenshot_path = await capture_connect_failure_screenshot(page, "invite_profile_load_failed", lead_id)
        logger.error(
            "Failed to load profile for invite-with-note",
            {"leadId": lead_id, "url": profile_url, "screenshot": screenshot_path},
            error=exc,
        )
        return "failed"

    try:
        surface = await open_message_surface(page)
    except Exception as exc:
        screenshot_path = await capture_connect_failure_screenshot(page, "all_paths_exhausted", lead_id)
        logger.error(
            "Invite surface exhausted for invite-with-note",
            {"leadId": lead_id, "screenshot": screenshot_path},
            error=exc,
        )
        return "failed"

    if surface != "connect_note":
        screenshot_path = await capture_connect_failure_screenshot(page, f"invite_unexpected_surface_{surface}", lead_id)
        logger.warn(
            "Invite-with-note expected connect_note surface",
            {"leadId": lead_id, "surface": surface, "screenshot": screenshot_path},
        )
        return "failed"

    limit_reason = await detect_weekly_invite_limit(page)
    if limit_reason:
        await capture_connect_failure_screenshot(page, "weekly_invite_limit_reached", lead_id)
        return "limit_reached"

    try:
        await send_message(page, note_text, "connect_note", None)
    except Exception as exc:
        screenshot_path = await capture_connect_failure_screenshot(page, "invite_send_click_failed", lead_id)
        logger.error(
            "Failed to send invite-with-note",
            {"leadId": lead_id, "screenshot": screenshot_path},
            error=exc,
        )
        return "failed"

    limit_reason = await detect_weekly_invite_limit(page)
    if limit_reason:
        await capture_connect_failure_screenshot(page, "weekly_invite_limit_reached", lead_id)
        return "limit_reached"
    if not await confirm_connection_request_sent(page):
        screenshot_path = await capture_connect_failure_screenshot(page, "invite_send_unconfirmed", lead_id)
        logger.warn(
            "Invite-with-note send was not confirmed after click",
            {"leadId": lead_id, "screenshot": screenshot_path},
        )
        return "failed"
    return "sent"


async def probe_connect_only_surface(page: Page, lead: ScraperLead) -> str:
    """Read profile actions before invite-only send to detect existing connections."""
    url = normalize_linkedin_profile_url(lead.linkedin_url)
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_selector("main", timeout=15_000)
        await page.wait_for_timeout(1_000)
    except Exception as exc:
        logger.warn("Connect-only surface probe navigation failed", {"leadId": lead.id, "url": url}, error=exc)
        return "surface_exhausted"

    try:
        profile_container = page.get_by_test_id("lazy-column")
        await profile_container.wait_for(state="visible", timeout=5_000)
    except Exception:
        try:
            profile_container = page.locator("main.scaffold-layout__main, section.artdeco-card").first
            await profile_container.wait_for(state="visible", timeout=5_000)
        except Exception:
            profile_container = page

    message_button = profile_container.get_by_role(
        "button",
        name=re.compile(r"(Nachricht an|Message to)", re.I),
    )
    message_link = profile_container.get_by_role(
        "link",
        name=re.compile(r"(Nachricht an|Message to|Message|Nachricht)", re.I),
    )
    invite_link = profile_container.get_by_role(
        "link",
        name=re.compile(r"(Invite .+ to|Einladen .+ zu)", re.I),
    )
    direct_connect_button = profile_container.get_by_role(
        "button",
        name=re.compile(r"(Vernetzen|Als Kontakt|als Kontakt|Connect|Einladen|Kontaktanfrage)", re.I),
    )
    more_button = profile_container.get_by_role("button", name=re.compile(r"(More|Mehr)", re.I))

    message_button_count = await message_button.count()
    message_link_count = await message_link.count()
    invite_link_count = await invite_link.count()
    connect_button_count = await direct_connect_button.count()
    more_button_count = await more_button.count()
    surface = classify_connect_only_surface(
        message_button_count=message_button_count,
        message_link_count=message_link_count,
        invite_link_count=invite_link_count,
        connect_button_count=connect_button_count,
        more_button_count=more_button_count,
    )
    logger.info(
        "Connect-only surface probe complete",
        data={
            "leadId": lead.id,
            "surface": surface,
            "messageButtonCount": message_button_count,
            "messageLinkCount": message_link_count,
            "inviteLinkCount": invite_link_count,
            "connectButtonCount": connect_button_count,
            "moreButtonCount": more_button_count,
        },
    )
    return surface


async def process_invite_one(
    context: BrowserContext,
    client: Client,
    lead: Dict[str, Any],
) -> str:
    """Render connect_note from sequence and send the LinkedIn invite.

    Returns one of: 'sent', 'failed', 'limit_reached'.
    """
    from sequence_render import render

    lead_id = str(lead.get("id") or "")
    sequence_id = lead.get("sequence_id")
    outreach_mode = lead.get("outreach_mode")  # "message" | "connect_only"

    note_text: str = ""
    if outreach_mode == "message":
        template = _fetch_sequence_connect_note(client, sequence_id)
        note_text = render(template, lead).strip()

    page = await context.new_page()
    try:
        if outreach_mode == "message" and note_text:
            outcome = await _send_invite_with_note(page, lead, note_text)
        else:
            scraper_lead = ScraperLead(
                id=lead_id,
                linkedin_url=str(lead.get("linkedin_url") or ""),
                first_name=lead.get("first_name"),
                last_name=lead.get("last_name"),
                company_name=lead.get("company_name"),
            )
            if outreach_mode == "connect_only":
                surface = await probe_connect_only_surface(page, scraper_lead)
                if surface == "already_connected":
                    result = promote_connect_only_to_connected(client, lead)
                    logger.info(
                        "Connect-only lead already connected; first message deferred",
                        {"leadId": lead_id},
                    )
                    return result
            try:
                ok = await send_connection_request(page, scraper_lead)
            except WeeklyInviteLimitReached:
                outcome = "limit_reached"
            else:
                outcome = "sent" if ok else "failed"
    finally:
        try:
            await page.close()
        except Exception:
            pass

    if outcome == "sent":
        client.table("leads").update({
            "status": "CONNECT_ONLY_SENT",
            "connection_sent_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
        }).eq("id", lead_id).execute()
        logger.message_send_complete(lead_id, {"mode": "send-invites", "outreach_mode": outreach_mode})
        return "sent"

    if outcome == "limit_reached":
        mark_connect_only_limit_reached(client, lead, "LinkedIn weekly invite limit reached")
        logger.warn("Weekly invite limit reached - aborting run", {"leadId": lead_id})
        return "limit_reached"

    client.table("leads").update({
        "status": "FAILED",
        "error_message": "invite_send_failed",
        "updated_at": datetime.utcnow().isoformat(),
    }).eq("id", lead_id).execute()
    return "failed"


# ------------------------- MESSAGE-ONLY FLOW -------------------------
async def process_message_only_one(context: BrowserContext, client: Client, lead: Dict[str, Any]) -> str:
    """Process a CONNECT_ONLY_SENT lead: check if connected, send message if so.
    
    Returns:
        'sent' - message was sent successfully
        'pending' - connection still pending (Ausstehend), skipped
        'retry' - transient failure, queued for retry
        'failed' - could not process
    """
    lead_id = lead["id"]
    first_name = (lead.get("first_name") or "").strip()
    last_name = (lead.get("last_name") or "").strip()
    full_name = " ".join([p for p in [first_name, last_name] if p]).strip()
    
    logger.message_send_start(lead_id, {"url": lead.get("linkedin_url"), "mode": "message-only"})
    
    sequence_messages = load_sequence_messages(client, lead)
    message = (sequence_messages.get("first_message") or "").strip()
    if not message:
        error_msg = "Missing sequence first_message for message-only flow"
        attempts = mark_lead_retry_later(client, lead, error_msg)
        if attempts >= LEAD_MESSAGE_ONLY_MAX_RETRIES:
            mark_failed(client, lead_id, f"Retry limit reached: {error_msg}")
            return "failed"
        return "retry"
    
    page = await context.new_page()
    url = normalize_linkedin_profile_url(str(lead["linkedin_url"]))
    logger.debug(f"Navigating to profile for message-only", {"leadId": lead_id}, {"url": url})
    
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(1_500)
        await random_pause()
        
        # Check for pending connection indicator (Ausstehend)
        pending_indicators = [
            page.locator("button:has-text('Ausstehend')"),
            page.locator("button:has-text('Pending')"),
            page.locator("span:has-text('Ausstehend')"),
            page.locator("span:has-text('Pending')"),
        ]
        
        for indicator in pending_indicators:
            try:
                if await indicator.count() > 0 and await indicator.first.is_visible(timeout=2_000):
                    logger.info("Connection still pending (Ausstehend), skipping", {"leadId": lead_id})
                    await page.close()
                    return "pending"
            except Exception:
                continue
        
        # Try to find the Message button (Nachricht) - indicates we're connected
        profile_container = None
        try:
            profile_container = page.get_by_test_id("lazy-column")
            await profile_container.wait_for(state="visible", timeout=5_000)
        except Exception:
            try:
                profile_container = page.locator("main.scaffold-layout__main, section.artdeco-card").first
                await profile_container.wait_for(state="visible", timeout=5_000)
            except Exception:
                profile_container = page
        
        # Look for explicit connected-user messaging affordances first.
        explicit_message_targets = [
            profile_container.get_by_role("button", name=re.compile(r"(Nachricht an|Message to)", re.I)),
            profile_container.get_by_role("link", name=re.compile(r"(Nachricht an|Message to)", re.I)),
        ]
        explicit_message_link = None
        for candidate in explicit_message_targets:
            if await candidate.count() > 0:
                explicit_message_link = candidate
                break

        if explicit_message_link is None:
            # Generic "Nachricht" surfaces can be Sales Navigator/InMail entry points and
            # are not strong enough by themselves to prove acceptance.
            message_link = profile_container.get_by_role("link", name=re.compile(r"(Message|Nachricht)", re.I))
            message_link_count = await message_link.count()
        else:
            message_link = explicit_message_link
            message_link_count = 1

        if message_link_count > 0:
            if explicit_message_link is None and await _has_visible_connect_or_pending_state(profile_container):
                logger.info(
                    "Generic message surface is ambiguous; connect/pending state is still visible",
                    {"leadId": lead_id},
                )
                await page.close()
                return "pending"

            logger.debug("Found Message link - user is connected", {"leadId": lead_id})
            try:
                message_page = await click_and_resolve_active_page(page, message_link.first)
                await random_pause()
                if await wait_for_sales_navigator_composer(message_page):
                    logger.info("Nachricht opened Sales Navigator composer", {"leadId": lead_id})
                    await send_sales_navigator_message(
                        message_page,
                        build_sales_navigator_subject(lead, message),
                        message,
                    )
                else:
                    await message_page.wait_for_selector(
                        "div.msg-overlay-conversation-bubble, section[role='dialog'] div[role='textbox'][contenteditable='true'], div.msg-form__contenteditable[contenteditable='true']",
                        timeout=10_000,
                    )
                    await send_message(message_page, message, SURFACE_MESSAGE)
                
                # Mark as SENT, capture acceptance, and initialize sequence progress metadata.
                accepted_at = datetime.utcnow().isoformat()
                sequence_started_at = lead.get("sequence_started_at") or accepted_at
                lead_update = {
                    "status": "SENT",
                    "sent_at": accepted_at,
                    "connection_accepted_at": accepted_at,
                    "sequence_step": 1,
                    "sequence_started_at": sequence_started_at,
                    "sequence_last_sent_at": accepted_at,
                    "error_message": None,
                }
                try:
                    client.table("leads").update(lead_update).eq("id", lead_id).execute()
                except Exception:
                    # Older schemas may miss sequence progress columns; fall back to core status update.
                    fallback_update = {
                        "status": "SENT",
                        "sent_at": accepted_at,
                        "connection_accepted_at": accepted_at,
                        "error_message": None,
                    }
                    client.table("leads").update(fallback_update).eq("id", lead_id).execute()

                accepted_base = _parse_iso_datetime(accepted_at) or _utc_now()
                try:
                    schedule_nudge_followup(client, lead, 1, sequence_messages, accepted_base, message)
                    interval_days = _safe_int(
                        sequence_messages.get("followup_interval_days"), SEQUENCE_INTERVAL_DEFAULT_DAYS
                    )
                    if interval_days < 1:
                        interval_days = SEQUENCE_INTERVAL_DEFAULT_DAYS
                    second_message = (sequence_messages.get("second_message") or "").strip()
                    schedule_nudge_followup(
                        client,
                        lead,
                        2,
                        sequence_messages,
                        accepted_base + timedelta(days=interval_days),
                        second_message or message,
                    )
                except Exception as schedule_error:
                    logger.warn(
                        "Failed to schedule followups after first message; keeping lead as SENT",
                        {"leadId": lead_id},
                        error=schedule_error,
                    )
                
                logger.message_send_complete(lead_id)
                logger.info("Message sent to connected lead", {"leadId": lead_id})
                await page.close()
                return "sent"
            except Exception as e:
                logger.error("Failed to send message to connected lead", {"leadId": lead_id}, error=e)
                await page.close()
                error_msg = str(e)
                permanent_indicators = [
                    "No messaging surface found",
                    "3rd-degree",
                    "restrictions",
                    "Messaging disabled",
                    "not available",
                ]
                if any(ind.lower() in error_msg.lower() for ind in permanent_indicators):
                    mark_failed(client, lead_id, error_msg)
                    return "failed"
                attempts = mark_lead_retry_later(client, lead, error_msg)
                if attempts >= LEAD_MESSAGE_ONLY_MAX_RETRIES:
                    mark_failed(client, lead_id, f"Retry limit reached: {error_msg}")
                    return "failed"
                return "retry"
        else:
            logger.info("No normal Message button found; trying Sales Navigator fallback", {"leadId": lead_id})
            sales_page = await open_sales_navigator_message_surface(page)
            if sales_page is None:
                logger.info("No Sales Navigator message surface found, connection may still be pending", {"leadId": lead_id})
                await page.close()
                return "pending"

            try:
                await send_sales_navigator_message(
                    sales_page,
                    build_sales_navigator_subject(lead, message),
                    strip_sales_navigator_signature(message),
                )
                accepted_at = datetime.utcnow().isoformat()
                sequence_started_at = lead.get("sequence_started_at") or accepted_at
                lead_update = {
                    "status": "SENT",
                    "sent_at": accepted_at,
                    "connection_accepted_at": lead.get("connection_accepted_at") or accepted_at,
                    "sequence_step": 1,
                    "sequence_started_at": sequence_started_at,
                    "sequence_last_sent_at": accepted_at,
                    "error_message": None,
                }
                try:
                    client.table("leads").update(lead_update).eq("id", lead_id).execute()
                except Exception:
                    fallback_update = {
                        "status": "SENT",
                        "sent_at": accepted_at,
                        "connection_accepted_at": lead.get("connection_accepted_at") or accepted_at,
                        "error_message": None,
                    }
                    client.table("leads").update(fallback_update).eq("id", lead_id).execute()

                accepted_base = _parse_iso_datetime(accepted_at) or _utc_now()
                try:
                    schedule_nudge_followup(client, lead, 1, sequence_messages, accepted_base, message)
                    interval_days = _safe_int(sequence_messages.get("followup_interval_days"), SEQUENCE_INTERVAL_DEFAULT_DAYS)
                    if interval_days < 1:
                        interval_days = SEQUENCE_INTERVAL_DEFAULT_DAYS
                    second_message = (sequence_messages.get("second_message") or "").strip()
                    schedule_nudge_followup(
                        client,
                        lead,
                        2,
                        sequence_messages,
                        accepted_base + timedelta(days=interval_days),
                        second_message or message,
                    )
                except Exception as schedule_error:
                    logger.warn(
                        "Failed to schedule followups after Sales Navigator first message; keeping lead as SENT",
                        {"leadId": lead_id},
                        error=schedule_error,
                    )
                logger.message_send_complete(lead_id)
                logger.info("Sales Navigator message sent to lead", {"leadId": lead_id})
                await sales_page.close()
                if page != sales_page:
                    await page.close()
                return "sent"
            except Exception as exc:
                logger.error("Failed to send Sales Navigator message", {"leadId": lead_id}, error=exc)
                try:
                    screenshot_path = f"/tmp/sales_nav_error_{lead_id[:8]}.png"
                    await sales_page.screenshot(path=screenshot_path, full_page=True)
                    logger.info(f"Sales Navigator screenshot saved to {screenshot_path}")
                except Exception:
                    pass
                attempts = mark_lead_retry_later(client, lead, str(exc))
                if attempts >= LEAD_MESSAGE_ONLY_MAX_RETRIES:
                    mark_failed(client, lead_id, f"Retry limit reached: {str(exc)}")
                    return "failed"
                return "retry"
            
    except Exception as e:
        logger.error("Error processing message-only lead", {"leadId": lead_id}, error=e)
        attempts = mark_lead_retry_later(client, lead, str(e))
        if attempts >= LEAD_MESSAGE_ONLY_MAX_RETRIES:
            mark_failed(client, lead_id, f"Retry limit reached: {str(e)}")
            return "failed"
        try:
            await page.close()
        except Exception:
            pass
        return "retry"


def fetch_linkedin_credentials(client: Client) -> Optional[Dict[str, str]]:
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
    if not email or not password:
        return None
    return {"email": email, "password": password}


async def is_logged_in(context: BrowserContext) -> bool:
    page = await context.new_page()
    try:
        await page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=30_000)
        await page.wait_for_timeout(1_000)
        current_url = page.url
        if "/login" in current_url or "/checkpoint" in current_url:
            return False
        if "/feed" in current_url:
            return True
        # Fallback for localized/redirected home pages where feed URL is not stable.
        logged_markers = [
            page.locator("input[role='combobox'][aria-label*='Search']"),
            page.locator("a[href*='/mynetwork/']"),
            page.locator("a[href*='/feed/']"),
            page.locator("header[role='banner']"),
        ]
        for marker in logged_markers:
            try:
                if await marker.count() > 0:
                    return True
            except Exception:
                continue
        return False
    except Exception:
        return False
    finally:
        await page.close()


async def login_with_credentials(context: BrowserContext, email: str, password: str) -> None:
    page = await context.new_page()
    try:
        # Go straight to login
        await page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(1_000)
        current_url = page.url
        # LinkedIn can redirect already-authenticated sessions away from /login.
        if "/login" not in current_url and "/checkpoint" not in current_url:
            if "linkedin.com" in current_url:
                await context.storage_state(path=str(AUTH_STATE_PATH))
                return

        # Primary (German localization) using role-based selectors
        email_locators = [
            lambda: page.get_by_role("textbox", name="E-Mail-Adresse/Telefon"),
            lambda: page.get_by_role("textbox", name="E-Mail-Adresse"),
            lambda: page.get_by_role("textbox", name="Telefon"),
        ]
        password_locators = [
            lambda: page.get_by_role("textbox", name="Passwort"),
        ]
        # Fallbacks (English/local variations and legacy ids)
        email_fallbacks = [
            lambda: page.get_by_role("textbox", name="Email or Phone"),
            lambda: page.get_by_role("textbox", name="Email or phone"),
            lambda: page.get_by_role("textbox", name="Email"),
            lambda: page.locator("input[type='text'][name='session_key']"),
            lambda: page.locator("input[type='email']"),
            lambda: page.locator("input#username"),
            lambda: page.locator("input[name='session_key']"),
        ]
        password_fallbacks = [
            lambda: page.get_by_role("textbox", name="Password"),
            lambda: page.locator("input[type='password']"),
            lambda: page.locator("input#password"),
            lambda: page.locator("input[name='session_password']"),
        ]

        async def fill_first(loc_builders, value: str) -> bool:
            for b in loc_builders:
                try:
                    loc = b()
                    if await loc.count() > 0:
                        await loc.first.fill(value, timeout=10_000)
                        return True
                except Exception:
                    continue
            return False

        email_filled = await fill_first(email_locators, email) or await fill_first(email_fallbacks, email)
        pwd_filled = await fill_first(password_locators, password) or await fill_first(password_fallbacks, password)
        account_preselected = False
        try:
            other_account_links = [
                page.get_by_role("link", name=re.compile(r"Loggen Sie sich bei einem anderen Konto ein", re.I)),
                page.get_by_role("link", name=re.compile(r"sign in with a different account", re.I)),
            ]
            for link in other_account_links:
                if await link.count() > 0:
                    account_preselected = True
                    break
            if not account_preselected:
                for marker in [
                    page.get_by_text(re.compile(r"Schön, dass Sie wieder da sind", re.I)),
                    page.get_by_text(re.compile(r"Welcome back", re.I)),
                ]:
                    if await marker.count() > 0:
                        account_preselected = True
                        break
        except Exception:
            account_preselected = False

        if not pwd_filled or (not email_filled and not account_preselected):
            raise RuntimeError("Could not locate LinkedIn email/password fields.")

        # Click sign in
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
            try:
                await page.keyboard.press("Enter")
            except Exception:
                pass

        try:
            await page.wait_for_url(
                lambda url: (
                    "linkedin.com" in url
                    and "/login" not in url
                    and "/checkpoint" not in url
                ),
                timeout=45_000,
            )
        except Exception:
            current = page.url
            if "/login" in current or "/checkpoint" in current:
                raise RuntimeError(f"LinkedIn login did not reach authenticated page (current: {current})")

        # Persist auth for future runs
        await context.storage_state(path=str(AUTH_STATE_PATH))
    finally:
        await page.close()


async def ensure_linkedin_auth(context: BrowserContext, client: Client) -> None:
    if await is_logged_in(context):
        # Make sure we have a valid saved state on disk
        try:
            await context.storage_state(path=str(AUTH_STATE_PATH))
        except Exception:
            pass
        return

    creds = fetch_linkedin_credentials(client)
    if not creds:
        raise RuntimeError(
            "Not logged in and no credentials found in settings (key=linkedin_credentials)."
        )
    await login_with_credentials(context, creds["email"], creds["password"])
    if not await is_logged_in(context):
        raise RuntimeError("LinkedIn login failed. Complete any verification and retry.")


async def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Send approved drafts or follow-ups via LinkedIn.")
    parser.add_argument("--lead-id", help="Send only this lead id (bypass queue).")
    parser.add_argument("--batch-id", type=int, help="Process only leads from this batch id.")
    parser.add_argument("--followup", action="store_true", help="Process APPROVED followups instead of initial outreach.")
    parser.add_argument("--message-only", action="store_true", help="Process CONNECT_ONLY_SENT leads to send messages to accepted connections.")
    parser.add_argument(
        "--send-invites",
        action="store_true",
        help="Process NEW sequence-driven leads (connect_message/connect_only) and send LinkedIn connection invites.",
    )
    args = parser.parse_args()

    mode = (
        "followup" if args.followup
        else ("message_only" if args.message_only
        else ("send_invites" if args.send_invites
        else "connect_message"))
    )
    logger.operation_start(f"sender-{mode}", input_data={"lead_id": args.lead_id, "mode": mode})

    try:
        client = get_supabase_client()
       
        # Compute daily limit with a hard minimum of 100 to avoid getting stuck at 20
        env_limit = os.getenv("DAILY_SEND_LIMIT")
        try:
            parsed_limit = int(env_limit) if env_limit else DAILY_SEND_DEFAULT
        except Exception:
            parsed_limit = DAILY_SEND_DEFAULT
        daily_limit = max(parsed_limit, 100)
        logger.info("Daily send limit computed", data={"limit": daily_limit, "env": env_limit, "default": DAILY_SEND_DEFAULT})
        already_sent = sent_today_count(client)

        if already_sent >= daily_limit and not args.followup:
            logger.warn("Daily send limit reached", data={"limit": daily_limit, "sent": already_sent})
            return

        leads_to_send = []
        remaining = max(0, daily_limit - already_sent)

        if args.followup:
            # Process a batch of approved followups with proper status tracking
            recover_stale_processing_followups(client)
            batch_limit = min(20, max(1, daily_limit - already_sent))
            items = fetch_approved_followups(client, batch_limit)
            
            if not items:
                logger.info("No APPROVED followups to send")
                return

            logger.info(f"Processing {len(items)} followups", data={"batch_limit": batch_limit})
            playwright, browser, context = await open_browser(headless=False)
            try:
                logger.info("Browser opened, authenticating...")
                await ensure_linkedin_auth(context, client)

                sent_count = 0
                failed_count = 0
                retry_count = 0

                for fu in items:
                    try:
                        result = await process_followup_one(context, client, fu)
                        if result == "sent":
                            sent_count += 1
                        elif result == "failed":
                            failed_count += 1
                        else:  # retry
                            retry_count += 1
                    except Exception as exc:
                        logger.error(f"Failed to send followup", {"followupId": fu.get('id')}, error=exc)
                        # Unexpected exception - mark as retry
                        try:
                            mark_followup_failed(client, fu.get('id'), str(exc), permanent=False)
                        except Exception:
                            pass
                        retry_count += 1
                    await random_pause(2, 4)

                logger.operation_complete("sender-followup", result={
                    "sent": sent_count,
                    "failed": failed_count,
                    "retry": retry_count,
                    "total": len(items),
                })
            finally:
                await shutdown(playwright, browser)
                logger.info("Browser closed")
            return

        if args.message_only:
            # Process message-only pipeline (pending connections or approved drafts)
            leads_to_process: list[Dict[str, Any]] = []

            if args.lead_id:
                lead = fetch_lead_by_id(client, args.lead_id)
                if not lead:
                    logger.warn("Requested lead id not found for message-only send", {"leadId": args.lead_id})
                    return
                if not _is_message_only_candidate(lead):
                    logger.warn(
                        "Requested lead is not eligible for message-only send",
                        {
                            "leadId": args.lead_id,
                            "status": lead.get("status"),
                            "connection_sent_at": lead.get("connection_sent_at"),
                            "connection_accepted_at": lead.get("connection_accepted_at"),
                            "sent_at": lead.get("sent_at"),
                        },
                    )
                    return
                leads_to_process = [lead]
            else:
                leads_to_process = fetch_message_only_leads(client, remaining, args.batch_id)
                if not leads_to_process:
                    logger.info(
                        "No message-only leads to process (CONNECT_ONLY_SENT/MESSAGE_ONLY_*)",
                        {"batchId": args.batch_id},
                    )
                    return

            logger.info(
                f"Processing {len(leads_to_process)} message-only leads",
                data={"leadIds": [l.get("id") for l in leads_to_process]},
            )
            playwright, browser, context = await open_browser(headless=False)
            try:
                logger.info("Browser opened, authenticating...")
                await ensure_linkedin_auth(context, client)

                sent_count = 0
                pending_count = 0
                failed_count = 0
                retry_count = 0

                for lead in leads_to_process:
                    try:
                        if not mark_message_only_processing(client, lead):
                            continue
                        result = await process_message_only_one(context, client, lead)
                        if result == "sent":
                            sent_count += 1
                        elif result == "pending":
                            pending_count += 1
                        elif result == "retry":
                            retry_count += 1
                        else:
                            failed_count += 1
                    except Exception as exc:
                        logger.error(
                            "Failed to process message-only lead",
                            {"leadId": lead.get("id")},
                            error=exc,
                        )
                        failed_count += 1
                    await random_pause(2, 4)

                logger.operation_complete(
                    "sender-message-only",
                    result={
                        "sent": sent_count,
                        "pending": pending_count,
                        "retry": retry_count,
                        "failed": failed_count,
                        "total": len(leads_to_process),
                    },
                )
            finally:
                await shutdown(playwright, browser)
                logger.info("Browser closed")
            return

        if args.send_invites:
            limit_pause_reason = connect_only_invite_limit_active(client)
            if limit_pause_reason:
                logger.warn("Connect-only invite sending paused", data={"reason": limit_pause_reason})
                logger.operation_complete(
                    "sender-send-invites",
                    result={
                        "sent": 0,
                        "failed": 0,
                        "skipped": 0,
                        "limit_reached": True,
                        "total": 0,
                    },
                )
                return

            leads_to_process = fetch_invite_queue(client, remaining, args.batch_id)
            if not leads_to_process:
                logger.info("No NEW sequence-driven leads to invite", {"batchId": args.batch_id})
                return

            logger.info(
                f"send-invites: processing {len(leads_to_process)} leads",
                data={"leadIds": [l.get("id") for l in leads_to_process]},
            )
            playwright, browser, context = await open_browser(headless=False)
            try:
                logger.info("Browser opened, authenticating...")
                await ensure_linkedin_auth(context, client)

                sent_count = 0
                failed_count = 0
                skipped_count = 0
                limit_reached = False

                for lead in leads_to_process:
                    lead_id = str(lead.get("id") or "")
                    if not mark_invite_processing(client, lead_id):
                        skipped_count += 1
                        continue
                    try:
                        result = await process_invite_one(context, client, lead)
                        if result == "sent":
                            sent_count += 1
                        elif result == "limit_reached":
                            limit_reached = True
                            break
                        else:
                            failed_count += 1
                    except Exception as exc:
                        logger.error("Failed to process invite lead", {"leadId": lead_id}, error=exc)
                        failed_count += 1
                        try:
                            client.table("leads").update({
                                "status": "FAILED",
                                "error_message": f"unexpected: {exc}"[:240],
                                "updated_at": datetime.utcnow().isoformat(),
                            }).eq("id", lead_id).execute()
                        except Exception:
                            pass
                    await random_pause(2, 4)

                logger.operation_complete(
                    "sender-send-invites",
                    result={
                        "sent": sent_count,
                        "failed": failed_count,
                        "skipped": skipped_count,
                        "limit_reached": limit_reached,
                        "total": len(leads_to_process),
                    },
                )
            finally:
                await shutdown(playwright, browser)
                logger.info("Browser closed")
            return

        if args.lead_id:
            lead = fetch_lead_by_id(client, args.lead_id)
            if not lead:
                print(f"No lead found with id {args.lead_id}")
                return
            leads_to_send.append(lead)
        else:
            # Fetch all approved leads at once to prevent duplicate fetching
            leads_to_send = fetch_approved_leads(client, remaining)

        if not leads_to_send:
            logger.info("No APPROVED leads to send")
            return

        logger.info(f"Processing {len(leads_to_send)} leads")
        playwright, browser, context = await open_browser(headless=False)
        try:
            logger.info("Browser opened, authenticating...")
            await ensure_linkedin_auth(context, client)

            # Mark all leads as PROCESSING immediately to prevent re-fetching
            for lead in leads_to_send:
                mark_processing(client, lead["id"])

            success_count = 0
            for lead in leads_to_send:
                lead_id = lead["id"]
                try:
                    await process_one(context, client, lead)
                    success_count += 1
                except Exception as exc:
                    error_msg = str(exc)
                    logger.error(f"Failed to send message", {"leadId": lead_id}, error=exc)

                    # Determine if this is a permanent failure or retriable error
                    permanent_failure_indicators = [
                        "No messaging surface found",
                        "3rd-degree",
                        "restrictions",
                        "Lead has no draft",
                    ]

                    is_permanent = any(indicator in error_msg for indicator in permanent_failure_indicators)

                    if is_permanent:
                        # Permanent failure - mark as FAILED so we don't retry
                        mark_failed(client, lead_id, error_msg)
                    else:
                        # Retriable error - mark as APPROVED for manual retry or debugging
                        client.table("leads").update({"status": "APPROVED"}).eq("id", lead_id).execute()
                        logger.info(f"Lead marked as APPROVED for retry", {"leadId": lead_id})

                await random_pause(2, 4)

            logger.operation_complete("sender-outreach", result={"sent": success_count, "total": len(leads_to_send)})
        finally:
            await shutdown(playwright, browser)
            logger.info("Browser closed")
    except Exception as exc:
        logger.operation_error(f"sender-{mode}", error=exc)
        raise


if __name__ == "__main__":
    asyncio.run(main())
