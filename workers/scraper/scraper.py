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
CONNECT_DIALOG_TIMEOUT_MS = 15_000


def get_daily_enrichment_cap() -> int:
    env_limit = os.getenv("DAILY_ENRICHMENT_CAP", "").strip()
    try:
        parsed_limit = int(env_limit) if env_limit else DEFAULT_DAILY_ENRICHMENT_CAP
    except Exception:
        parsed_limit = DEFAULT_DAILY_ENRICHMENT_CAP
    return max(parsed_limit, 1)


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


async def detect_weekly_invite_limit(page: Page) -> Optional[str]:
    """Best-effort detection for LinkedIn's weekly invite cap dialog."""
    text_candidates: List[str] = []
    for selector in ["section[role='dialog']", "div[role='dialog']", "body"]:
        try:
            text = await page.locator(selector).first.inner_text(timeout=2_000)
            if text:
                text_candidates.append(text)
        except Exception:
            continue

    normalized_text = " ".join(text_candidates).lower()
    if not normalized_text:
        return None

    patterns = [
        "weekly limit",
        "weekly invitation limit",
        "invitation limit",
        "contact requests",
        "contact request limit",
        "wöchentliche limit",
        "wöchentliche kontaktanfragen",
        "kontaktanfragen",
        "kontaktanfrage",
        "nächste woche",
        "next week",
    ]

    if any(pattern in normalized_text for pattern in patterns):
        return "LinkedIn weekly invite limit reached. Please retry next week."

    return None


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


def fetch_new_leads(client: Client, limit: int = 10, outreach_mode: Optional[str] = None) -> List[Lead]:
    query_meta: Dict[str, Any] = {"status": "NEW", "limit": limit}
    if outreach_mode:
        query_meta["outreach_mode"] = outreach_mode

    logger.db_query("select", "leads", query_meta)

    # In connect_only mode, retry previously enriched-but-unsent leads first.
    # This keeps invite throughput high while preserving the existing send flow.
    if outreach_mode == "connect_only":
        query_meta["status"] = "ENRICHED+NEW (unsent)"

        enriched_resp = (
            client.table("leads")
            .select("id, linkedin_url, first_name, last_name, company_name")
            .eq("outreach_mode", "connect_only")
            .eq("status", "ENRICHED")
            .is_("connection_sent_at", "null")
            .limit(limit)
            .execute()
        )

        enriched_rows = enriched_resp.data or []
        remaining = max(0, limit - len(enriched_rows))
        new_rows: List[Dict[str, Any]] = []

        if remaining > 0:
            new_resp = (
                client.table("leads")
                .select("id, linkedin_url, first_name, last_name, company_name")
                .eq("outreach_mode", "connect_only")
                .eq("status", "NEW")
                .is_("connection_sent_at", "null")
                .limit(remaining)
                .execute()
            )
            new_rows = new_resp.data or []

        leads = [Lead(**row) for row in [*enriched_rows, *new_rows]]
    else:
        query = (
            client.table("leads")
            .select("id, linkedin_url, first_name, last_name, company_name")
            .eq("status", "NEW")
            .limit(limit)
        )

        if outreach_mode:
            query = query.eq("outreach_mode", outreach_mode)

        resp = query.execute()
        leads = [Lead(**row) for row in resp.data or []]

    logger.db_result("select", "leads", query_meta, len(leads))
    logger.info(
        f"Fetched {len(leads)} NEW leads",
        data={"count": len(leads), "outreach_mode": outreach_mode or "message"},
    )
    return leads


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


async def wait_for_connection_dialog(page: Page) -> None:
    """Wait for the LinkedIn connect/invite dialog to become usable."""
    await page.wait_for_selector("section[role='dialog'], div[role='dialog']", timeout=CONNECT_DIALOG_TIMEOUT_MS)
    await page.wait_for_timeout(500)


def safe_text(value: Optional[str]) -> str:
    return value.strip() if value else ""


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
        logger.connection_flow("navigate", "FAILED", data={"url": normalized}, error=exc)
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
    
    # PATH 1: Direct invite link inside profile container (Invite <Name> to ...)
    invite_link = profile_container.get_by_role("link", name=re.compile(r"(Invite .+ to|Einladen .+ zu)", re.I))
    invite_link_count = await invite_link.count()
    logger.element_search("Invite link", invite_link_count, role="link", context={"path": 1})
    
    if invite_link_count > 0:
        try:
            await invite_link.first.click(timeout=8_000)
            logger.element_click("Invite link", success=True)
            await wait_for_connection_dialog(page)
            await random_pause()
            logger.dialog_detected("connection_invite", context={"path": 1})
            logger.path_attempt("Invite link", 1, success=True)
            return await _click_send_without_note(page, normalized, lead.id)
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
                await direct_connect_anchor.first.click(timeout=8_000)
                logger.element_click(f"Connect anchor: {css}", success=True)
                await wait_for_connection_dialog(page)
                await random_pause()
                logger.dialog_detected("connection_direct_anchor", context={"path": 2, "selector": css})
                logger.path_attempt(f"Direct Connect anchor ({css})", 2, success=True)
                return await _click_send_without_note(page, normalized, lead.id)
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
            await direct_connect_btn.first.click(timeout=8_000)
            logger.element_click("Vernetzen button", success=True)
            await wait_for_connection_dialog(page)
            await random_pause()
            logger.dialog_detected("connection_direct", context={"path": 2})
            logger.path_attempt("Direct Connect button", 2, success=True)
            return await _click_send_without_note(page, normalized, lead.id)
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
                name=re.compile(r"(Invite|Einladen|Connect|Vernetzen|Kontakt|Kontaktanfrage|Anfrage)", re.I),
            )
            invite_count = await invite_menuitem.count()
            if invite_count == 0:
                invite_menuitem = page.get_by_role(
                    "button",
                    name=re.compile(r"(Invite|Einladen|Connect|Vernetzen|Kontakt|Kontaktanfrage|Anfrage)", re.I),
                )
                invite_count = await invite_menuitem.count()
            logger.element_search("Invite/Connect menuitem", invite_count, role="menuitem", context={"path": 3})
            
            if invite_count > 0:
                await invite_menuitem.first.click(timeout=8_000)
                logger.element_click("Invite menuitem", success=True)
                
                # Wait for connection dialog
                await wait_for_connection_dialog(page)
                await random_pause()
                logger.dialog_detected("connection_more_menu", context={"path": 3})
                logger.path_attempt("More -> Invite", 3, success=True)
                return await _click_send_without_note(page, normalized, lead.id)
            else:
                logger.path_attempt("More -> Invite", 3, success=False)
        except Exception as e:
            logger.element_click("More button flow", success=False)
            logger.path_attempt("More -> Invite", 3, success=False)
    
    screenshot_path = await capture_connect_failure_screenshot(page, "all_paths_exhausted", lead.id)
    logger.connection_flow("all_paths", "EXHAUSTED", data={"url": normalized, "screenshot": screenshot_path})
    return False


async def _click_send_without_note(page: Page, url: str, lead_id: Optional[str] = None) -> bool:
    """Click 'Ohne Notiz senden' button in the connection dialog."""
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
        logger.element_click("Send button", success=True)
        logger.connection_flow("send_button", "CLICKED", data={"url": url})
        return True
    except WeeklyInviteLimitReached:
        raise
    except Exception as exc:
        logger.element_click("Send button", success=False)
        screenshot_path = await capture_connect_failure_screenshot(page, "send_button_click_failed", lead_id)
        logger.connection_flow("send_button", "CLICK_FAILED", data={"url": url, "screenshot": screenshot_path}, error=exc)
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


def mark_connect_sent(client: Client, lead_id: str) -> None:
    """Mark a lead as CONNECT_ONLY_SENT and capture timestamp."""
    now_iso = datetime.datetime.utcnow().isoformat()
    logger.db_query(
        "update",
        "leads",
        {"leadId": lead_id},
        {"status": "CONNECT_ONLY_SENT", "connection_sent_at": now_iso},
    )
    client.table("leads").update(
        {
            "status": "CONNECT_ONLY_SENT",
            "connection_sent_at": now_iso,
        }
    ).eq("id", lead_id).execute()
    try:
        update_profile_meta(client, lead_id, None, {"connect_only_limit_reached": False})
    except Exception:
        pass
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    logger.info("Lead marked CONNECT_ONLY_SENT", {"leadId": lead_id})


def mark_connect_failed(client: Client, lead_id: str, reason: Optional[str] = None) -> None:
    """Mark a lead as FAILED so connect-only retries do not stall in PROCESSING."""
    now_iso = datetime.datetime.utcnow().isoformat()
    logger.db_query(
        "update",
        "leads",
        {"leadId": lead_id},
        {"status": "FAILED", "reason": (reason or "")[:240]},
    )
    update_data = {"status": "FAILED", "updated_at": now_iso}
    if reason:
        update_data["error_message"] = reason[:500]
    client.table("leads").update(update_data).eq("id", lead_id).execute()
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    logger.warn("Lead marked FAILED", {"leadId": lead_id}, error=reason)


def requeue_connect_only_limit_hit(client: Client, lead_id: str, reason: Optional[str] = None) -> None:
    """Return a blocked invite to the NEW queue and remember why it was paused."""
    now_iso = datetime.datetime.utcnow().isoformat()
    logger.db_query(
        "update",
        "leads",
        {"leadId": lead_id},
        {"status": "NEW", "error_message": (reason or "")[:240]},
    )
    update_data = {
        "status": "NEW",
        "updated_at": now_iso,
        "connection_sent_at": None,
        "error_message": None,
    }
    client.table("leads").update(update_data).eq("id", lead_id).execute()
    try:
        update_profile_meta(
            client,
            lead_id,
            None,
            {
                "connect_only_limit_reached": True,
                "connect_only_limit_reached_at": now_iso,
                "connect_only_limit_reached_reason": reason or "Weekly invite limit reached",
            },
        )
    except Exception:
        pass
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    logger.warn("Lead requeued to NEW after weekly invite limit", {"leadId": lead_id}, error=reason)


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


async def process_batch(context: BrowserContext, client: Client, leads: List[Lead], mode: str = "enrich") -> None:
    for lead in leads:
        logger.info(f"Processing lead {lead.id}", {"leadId": lead.id}, {"url": lead.linkedin_url})
        logger.db_query("update", "leads", {"leadId": lead.id}, {"status": "PROCESSING"})
        client.table("leads").update({"status": "PROCESSING"}).eq("id", lead.id).execute()

        page = await context.new_page()
        try:
            if mode == "connect_only":
                try:
                    sent = await send_connection_request(page, lead)
                    if sent:
                        mark_connect_sent(client, lead.id)
                        logger.info(
                            f"Connection request sent to {lead.id}",
                            {"leadId": lead.id},
                            {"mode": mode},
                        )
                    else:
                        mark_connect_failed(client, lead.id, reason="No connect button or invite dialog exhausted.")
                        logger.info(
                            f"No connect button for {lead.id}",
                            {"leadId": lead.id},
                            {"mode": mode},
                        )
                except Exception as exc:
                    if isinstance(exc, WeeklyInviteLimitReached):
                        requeue_connect_only_limit_hit(client, lead.id, reason=str(exc))
                        logger.warn(
                            f"Connection request blocked by weekly invite limit for {lead.id}",
                            {"leadId": lead.id},
                            error=exc,
                        )
                        raise
                    mark_connect_failed(client, lead.id, reason=str(exc))
                    logger.warn(
                        f"Connection request failed for {lead.id}",
                        {"leadId": lead.id},
                        error=exc,
                    )
            else:
                await enrich_one(page, client, lead)
                logger.info(f"Lead {lead.id} enriched successfully", {"leadId": lead.id})
        except TimeoutError as exc:
            logger.error(f"Timeout processing {lead.id}", {"leadId": lead.id, "mode": mode}, error=exc)
            if mode != "connect_only":
                mark_enrich_failed(client, lead.id, reason=f"Timeout: {exc}")
        except Exception as exc:
            logger.error(f"Failed to process {lead.id}", {"leadId": lead.id, "mode": mode}, error=exc)
            if mode == "connect_only" and isinstance(exc, WeeklyInviteLimitReached):
                raise
            if mode != "connect_only":
                mark_enrich_failed(client, lead.id, reason=str(exc))
        finally:
            try:
                await page.close()
            except Exception:
                pass

        await random_pause()


async def main(limit: int = 0, mode: str = "enrich") -> None:
    logger.operation_start("enrichment", input_data={"limit": limit, "mode": mode})
    
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

        outreach_filter = "connect_only" if mode == "connect_only" else None
        os.environ["SCRAPER_MODE"] = mode
        leads = fetch_new_leads(client, limit=effective_limit, outreach_mode=outreach_filter)
        if not leads:
            logger.info("No NEW leads to process")
            return

        playwright, browser, context = await open_browser(headless=False)
        try:
            logger.info("Browser opened, authenticating...")
            await ensure_linkedin_auth(context, creds)
            logger.info(
                f"Starting batch processing of {len(leads)} leads",
                data={"count": len(leads), "mode": mode},
            )
            await process_batch(context, client, leads, mode=mode)
            logger.operation_complete("enrichment", result={"processed": len(leads)})
        finally:
            await shutdown(playwright, browser)
            logger.info("Browser closed")
    except Exception as exc:
        logger.operation_error("enrichment", error=exc, input_data={"limit": limit, "mode": mode})
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
        "--mode",
        type=str,
        choices=["enrich", "connect_only"],
        default="enrich",
        help="Execution mode: enrich (default) or connect_only for enrichment + invite without note.",
    )
    parser.add_argument(
        "--login-only",
        action="store_true",
        help="Run only the LinkedIn authentication bootstrap and exit.",
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
    return parser.parse_args()

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


async def search_conversation_by_name(page: Page, lead_name: str) -> Optional[Dict[str, Any]]:
    """Search for a conversation by lead name using LinkedIn's messaging search box.
    
    Returns conversation info if found, None otherwise.
    """
    try:
        # Find the search box - German UI: "Nachrichten durchsuchen", English: "Search messages"
        searchbox = page.get_by_role("searchbox", name="Nachrichten durchsuchen")
        if not await searchbox.count():
            searchbox = page.get_by_role("searchbox", name="Search messages")
        if not await searchbox.count():
            # Fallback to placeholder text
            searchbox = page.locator("input[placeholder*='durchsuchen'], input[placeholder*='Search']").first
        
        if not await searchbox.count():
            logger.warn("search_conversation_by_name: could not find search box")
            return None
        
        # Clear any existing search and type the lead name
        await searchbox.click()
        await page.wait_for_timeout(300)
        await searchbox.fill("")
        await page.wait_for_timeout(200)
        await searchbox.fill(lead_name)
        await page.wait_for_timeout(1500)  # Wait for search results to load
        
        # Look for the conversation in search results
        # Try multiple selectors for conversation items
        result_selectors = [
            "li.msg-conversation-listitem",
            "div.msg-conversation-card",
            "li[data-control-name='conversation']",
            "div.msg-search-result",
        ]
        
        result_item = None
        for selector in result_selectors:
            items = page.locator(selector)
            if await items.count() > 0:
                result_item = items.first
                break
        
        if not result_item:
            logger.debug(f"search_conversation_by_name: no results for '{lead_name}'")
            # Clear search before returning
            await searchbox.fill("")
            await page.wait_for_timeout(300)
            return None
        
        # Click to open the conversation
        await result_item.click()
        await page.wait_for_timeout(1000)  # Wait for conversation to load
        
        # Extract the last message from the opened conversation
        last_message_info = await extract_last_message_from_conversation(page)
        
        # Clear the search box for next search
        try:
            await searchbox.fill("")
        except Exception:
            pass
        
        return last_message_info
        
    except Exception as exc:
        logger.warn(f"search_conversation_by_name: error searching for '{lead_name}'", error=exc)
        return None


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


async def extract_conversation_summaries(page: Page, max_items: int) -> List[Dict[str, Any]]:
    """Extract top-N conversation summaries with participant and last message snippet/time.
    
    DEPRECATED: This function has unreliable DOM selectors. 
    Use search_conversation_by_name() instead for targeted lead lookup.
    """
    results: List[Dict[str, Any]] = []
    items = page.locator("li.msg-conversation-listitem, li.artdeco-list__item, div.msg-conversation-card")
    count = min(await items.count(), max_items)
    logger.debug(f"extract_conversation_summaries: found {count} items")
    for i in range(count):
        entry = items.nth(i)
        try:
            # Participant name and profile link
            name = safe_text(await entry.locator("a.app-aware-link span[aria-hidden='true'], h3, h2").first.text_content(timeout=3_000))
        except Exception:
            name = ""
        try:
            profile_href = await entry.locator("a.app-aware-link[href*='/in/']").first.get_attribute("href", timeout=2_000)
            if profile_href and profile_href.startswith("/"):
                profile_href = f"https://www.linkedin.com{profile_href}"
        except Exception:
            profile_href = None
        # Last message snippet and time
        snippet = ""
        try:
            snippet_el = entry.locator("p.msg-conversation-card__message-snippet, p, span.line-clamp-1").first
            if await snippet_el.count():
                snippet = safe_text(await snippet_el.text_content(timeout=2_000))
        except Exception:
            pass
        # Fallback snippet
        if not snippet:
            try:
                snippet = safe_text(await entry.inner_text(timeout=2_000))[:220]
            except Exception:
                snippet = ""
        # Timestamp often in time element
        try:
            ts_text = safe_text(await entry.locator("time, span.msg-overlay-timestamp").first.text_content(timeout=2_000))
        except Exception:
            ts_text = ""
        results.append({
            "name": name,
            "profile_url": profile_href,
            "snippet": snippet,
            "ts_text": ts_text,
        })
    return results


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


async def inbox_scan(context: BrowserContext, client: Client, limit: int) -> None:
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
        # Fetch leads with SENT status from database - these are contacts we've messaged
        # Include throttling columns to skip recently scanned or pending invite leads
        logger.info("Fetching SENT leads from database...", {"limit": limit})
        leads_query = (
            client.table("leads")
            .select("id, first_name, last_name, linkedin_url, status, last_inbox_scan_at, pending_invite, pending_checked_at")
            .eq("status", "SENT")
        )
        if limit and limit > 0:
            leads_query = leads_query.limit(limit)
        leads_resp = execute_with_retry(leads_query, desc="Fetch SENT leads for inbox scan")
        sent_leads = leads_resp.data or []
        logger.info(f"Found {len(sent_leads)} leads with SENT status to check")
        
        if not sent_leads:
            print("No SENT leads found in database. Nothing to scan.")
            return
        
        replies_detected = 0
        skipped_existing = 0
        skipped_no_conversation = 0
        skipped_ambiguous = 0
        skipped_recently_scanned = 0
        skipped_pending_invite = 0
        
        now_utc = datetime.datetime.now(datetime.timezone.utc)
        
        for lead in sent_leads:
            lead_id = lead["id"]
            first_name = (lead.get("first_name") or "").strip()
            last_name = (lead.get("last_name") or "").strip()
            lead_full_name = " ".join([p for p in [first_name, last_name] if p]).strip()
            
            if not lead_full_name:
                logger.debug(f"Skipping lead with no name", {"leadId": lead_id})
                continue
            
            # --- THROTTLING: Skip if recently scanned ---
            last_scan = lead.get("last_inbox_scan_at")
            if last_scan:
                try:
                    scan_dt = datetime.datetime.fromisoformat(last_scan.replace("Z", "+00:00"))
                    hours_since_scan = (now_utc - scan_dt).total_seconds() / 3600
                    if hours_since_scan < INBOX_SCAN_COOLDOWN_HOURS:
                        logger.debug(
                            f"Skipping {lead_full_name}, scanned {round(hours_since_scan, 1)}h ago (cooldown={INBOX_SCAN_COOLDOWN_HOURS}h)",
                            {"leadId": lead_id}
                        )
                        skipped_recently_scanned += 1
                        continue
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
            
            logger.info(f"Opening profile for SENT lead followup check: {lead_full_name}", {"leadId": lead_id})
            
            # Check if we already have a pending followup for this lead
            existing = execute_with_retry(
                client.table("followups")
                .select("id")
                .eq("lead_id", lead_id)
                .in_("status", ["PENDING_REVIEW", "APPROVED", "PROCESSING"])
                .limit(1),
                desc=f"Check existing followup for lead {lead_id}",
            )
            if existing.data:
                logger.debug(f"Lead already has pending followup, skipping", {"leadId": lead_id})
                skipped_existing += 1
                continue
            
            # Visit the profile and try to open the message thread via Nachricht / Message button
            linkedin_url = (lead.get("linkedin_url") or "").strip()
            convo_info = await open_profile_and_get_last_message(page, lead_full_name, linkedin_url)
            
            # Always update last_inbox_scan_at after visiting the profile
            scan_ts = now_iso_utc()
            
            if not convo_info:
                logger.debug(f"No conversation found for {lead_full_name}", {"leadId": lead_id})
                # Update scan timestamp even if no conversation found
                execute_with_retry(
                    client.table("leads").update({
                        "last_inbox_scan_at": scan_ts,
                        "pending_invite": False,
                    }).eq("id", lead_id),
                    desc=f"Update last_inbox_scan_at for lead {lead_id}",
                )
                skipped_no_conversation += 1
                continue
            
            # --- HANDLE PENDING INVITE ---
            if convo_info.get("pending_invite"):
                logger.info(f"Lead {lead_full_name} has pending invite (Ausstehend), marking and skipping", {"leadId": lead_id})
                execute_with_retry(
                    client.table("leads").update({
                        "pending_invite": True,
                        "pending_checked_at": scan_ts,
                        "last_inbox_scan_at": scan_ts,
                    }).eq("id", lead_id),
                    desc=f"Mark pending_invite for lead {lead_id}",
                )
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
            
            # Additional check: if sender name matches lead name, it's their reply
            sender_lower = sender.lower().strip()
            is_their_reply = False
            
            if is_outbound:
                # Last message is from us
                is_their_reply = False
            elif sender_lower in ["sie", "you", "ich", ""]:
                # Ambiguous sender that looks like us
                is_their_reply = False
                is_outbound = True
            elif (
                sender_lower == lead_full_name.lower() or
                sender_lower == first_name.lower() or
                first_name.lower() in sender_lower or
                sender_lower in lead_full_name.lower()
            ):
                # Sender matches lead name - this is their reply
                is_their_reply = True
            else:
                # Sender doesn't match lead name and isn't a standard "you" indicator.
                # Since we opened this conversation from the lead's profile, if the sender
                # is NOT the lead, it must be US (the logged-in user, e.g. "Simon Vestner").
                # This means the last message is outbound - treat as NUDGE candidate.
                logger.debug(
                    f"Sender '{sender}' doesn't match lead '{lead_full_name}' - treating as our outbound message",
                    {"leadId": lead_id, "sender": sender, "leadName": lead_full_name}
                )
                is_outbound = True
            
            reply_ts = datetime.datetime.utcnow().isoformat()
            
            if is_their_reply:
                # This is a REPLY - they responded to our message
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
            execute_with_retry(
                client.table("leads").update({
                    "last_inbox_scan_at": scan_ts,
                    "pending_invite": False,
                }).eq("id", lead_id),
                desc=f"Update last_inbox_scan_at after processing {lead_id}",
            )
            
            # Small delay between searches to avoid rate limiting
            await page.wait_for_timeout(500)
        
        # Summary
        logger.info(
            f"Inbox scan complete",
            data={
                "replies": replies_detected,
                "skipped_existing": skipped_existing,
                "skipped_no_conversation": skipped_no_conversation,
                "skipped_ambiguous": skipped_ambiguous,
                "skipped_recently_scanned": skipped_recently_scanned,
                "skipped_pending_invite": skipped_pending_invite,
                "total_leads_checked": len(sent_leads),
            }
        )
        print(f"\n{'='*50}")
        print(f"INBOX SCAN COMPLETE")
        print(f"{'='*50}")
        print(f"  Leads checked: {len(sent_leads)}")
        print(f"  Replies detected: {replies_detected}")
        print(f"  Already pending: {skipped_existing}")
        print(f"  No conversation: {skipped_no_conversation}")
        print(f"  Recently scanned ({INBOX_SCAN_COOLDOWN_HOURS}h): {skipped_recently_scanned}")
        print(f"  Pending invite ({PENDING_INVITE_BACKOFF_DAYS}d): {skipped_pending_invite}")
        print(f"{'='*50}")
    finally:
        await page.close()


async def inbox_mode(limit: int = 0) -> None:
    """Entry point for inbox scanning.

    Opens a visible browser (headless=False), ensures LinkedIn auth, and then
    runs inbox_scan with a daily cap based on DAILY_INBOX_SCAN_LIMIT.
    """
    client = get_supabase_client()
    playwright, browser, context = await open_browser(headless=False)
    try:
        creds = fetch_linkedin_credentials(client)
        await ensure_linkedin_auth(context, creds)
        # If limit <= 0, process all SENT leads; otherwise respect the explicit cap.
        await inbox_scan(context, client, limit)
    finally:
        await shutdown(playwright, browser)


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

    if not args.run:
        print("Scraper invoked without --run flag. Exiting without processing leads.")
        sys.exit(0)

    # Dispatch based on mode / inbox flag
    if getattr(args, "inbox", False):
        # For inbox scans, limit=0 means "no limit" (all SENT leads)
        limit = args.limit if isinstance(args.limit, int) and args.limit >= 0 else 0
        asyncio.run(inbox_mode(limit=limit))
    else:
        limit = args.limit if isinstance(args.limit, int) and args.limit >= 0 else 0
        mode = getattr(args, "mode", "enrich")
        asyncio.run(main(limit=limit, mode=mode))
