"""LinkedIn profile and activity scraper."""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import os
import random
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from playwright.async_api import BrowserContext, Page, TimeoutError
from supabase import Client, create_client
from tenacity import retry, stop_after_attempt, wait_fixed

from auth import AUTH_STATE_PATH, is_logged_in, open_browser, save_storage_state, shutdown

# Import shared logger
sys.path.insert(0, str(Path(__file__).parent.parent))
from shared_logger import get_logger

load_dotenv()

# Initialize logger
logger = get_logger("scraper")

# Avoid tripping LinkedIn automation warnings by capping daily enrichments.
DAILY_ENRICHMENT_CAP = 50
DAILY_INBOX_SCAN_LIMIT = 60


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
    if not url or not key:
        logger.error("Missing Supabase configuration", data={"has_url": bool(url), "has_key": bool(key)})
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    logger.debug("Supabase client initialized")
    return create_client(url, key)


def fetch_new_leads(client: Client, limit: int = 10) -> List[Lead]:
    logger.db_query("select", "leads", {"status": "NEW"}, {"limit": limit})
    resp = (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, company_name")
        .eq("status", "NEW")
        .limit(limit)
        .execute()
    )
    leads: List[Lead] = [Lead(**row) for row in resp.data or []]
    logger.db_result("select", "leads", {"status": "NEW"}, len(leads))
    logger.info(f"Fetched {len(leads)} NEW leads", data={"count": len(leads)})
    return leads


def fetch_today_enrichment_count(client: Client) -> int:
    """Return count of leads marked ENRICHED since 00:00 UTC today."""
    start_of_day = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    logger.db_query("select-count", "leads", {"status": "ENRICHED"}, {"since": start_of_day})
    resp = (
        client.table("leads")
        .select("id", count="exact")
        .eq("status", "ENRICHED")
        .gte("updated_at", start_of_day)
        .execute()
    )
    count = resp.count or 0
    logger.db_result("select-count", "leads", {"status": "ENRICHED"}, count)
    logger.info(f"Enriched today: {count}", data={"count": count, "cap": DAILY_ENRICHMENT_CAP})
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
    password = value.get("password")
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


async def first_match_text(page: Page, selectors: List[str], timeout: int = 6_000) -> str:
    """Return the first non-empty text for the provided selectors."""
    for selector in selectors:
        # Try inner_text first (better for multi-line content)
        text = await safe_inner_text(page, selector, timeout=timeout)
        if text:
            return text
        # Fallback to text_content
        text = await safe_text_content(page, selector, timeout=timeout)
        if text:
            return text
    return ""


async def gentle_nav(page: Page, url: str) -> None:
    """Navigate with forgiving waits to avoid networkidle timeouts."""
    await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    await page.wait_for_timeout(1_200)


async def slow_scroll(page: Page, steps: int = 6) -> None:
    """Scroll down to trigger lazy-loaded sections."""
    for _ in range(steps):
        await page.mouse.wheel(0, random.randint(500, 900))
        await asyncio.sleep(random.uniform(0.2, 0.5))


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
            if await button.count() > 0:
                await button.first.click(timeout=5_000)
                await page.wait_for_timeout(500)
                break
        except Exception:
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
    logger.debug(f"Starting profile scrape", data={"url": normalized})
    page.set_default_timeout(20_000)
    page.set_default_navigation_timeout(60_000)

    await gentle_nav(page, normalized)
    await page.wait_for_selector("main", timeout=20_000)
    await slow_scroll(page)
    await expand_about(page)

    # Extract name
    name = await first_match_text(
        page,
        [
            "main h1.text-heading-xlarge",
            "main h1",
            "header h1",
            "div.pv-text-details__left-panel h1",
        ],
    )

    # Extract headline - the classes you provided
    headline = await first_match_text(
        page,
        [
            "p._190e3b93._63ebc304.ec1ff1cf._47b2b2dd._79d083f8.c701dbb2.e51537ee._5a2e2bd7._8b56d53f.ff36582f._3935efd9",
            "main .text-body-medium.break-words",
            "div.text-body-medium.break-words",
            "main div.pv-text-details__left-panel div.text-body-medium",
            "main p",
        ],
    )

    # Extract about - MUST be scoped to the About section only to avoid grabbing activity posts
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
    )

    # Extract current company and title from experience section
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
    
    logger.debug("Profile data extracted", data={
        "hasName": bool(name),
        "hasHeadline": bool(headline),
        "hasAbout": bool(about),
        "experienceCount": len(experience),
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


async def send_connection_request(page: Page, profile_url: str) -> bool:
    """Attempt to send a connection request to the profile. Returns True if a send was attempted."""
    normalized = profile_url.replace("http://", "https://").split("?")[0]
    try:
        await gentle_nav(page, normalized)
    except Exception:
        return False

    # If already connected, there might be no Connect button.
    connect_candidates = [
        "button:has-text('Connect')",
        "a:has-text('Connect')",
        "button[aria-label*='Connect']",
    ]
    connect = None
    for selector in connect_candidates:
        locator = page.locator(selector)
        if await locator.count() > 0:
            connect = locator.first
            break

    if not connect:
        return False

    try:
        await connect.click(timeout=6_000)
    except Exception:
        return False

    send_candidates = [
        "button:has-text('Send without a note')",
        "button:has-text('Send')",
        "button:has-text('Send now')",
    ]
    for selector in send_candidates:
        try:
            target = page.locator(selector)
            if await target.count() > 0:
                await target.first.click(timeout=6_000)
                await page.wait_for_timeout(800)
                return True
        except Exception:
            continue

    return False


async def login_with_credentials(context: BrowserContext, creds: LinkedinCredentials) -> None:
    """Log into LinkedIn using saved credentials and persist auth.json."""
    page = await context.new_page()
    try:
        # Always start by checking if we're already authenticated.
        await page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(1_000)
        if "/feed" in page.url and "/login" not in page.url:
            print("Already authenticated, skipping login.")
            await save_storage_state(context, path=AUTH_STATE_PATH)
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
        except TimeoutError:
            # Sometimes LinkedIn shows intermediate checkpoint; consider still saving state
            print(f"Login did not reach feed within timeout. Current URL: {page.url}", file=sys.stderr)
            raise
        finally:
            # Persist whatever state we have in case it helps subsequent runs.
            await save_storage_state(context, path=AUTH_STATE_PATH)
    finally:
        await page.close()


async def ensure_linkedin_auth(context: BrowserContext, creds: Optional[LinkedinCredentials]) -> None:
    if await is_logged_in(context):
        if not AUTH_STATE_PATH.exists():
            await save_storage_state(context)
        return

    if not creds:
        raise RuntimeError(
            "Unable to authenticate with LinkedIn. Upload a fresh auth.json via the login launcher "
            "or add credentials in Settings so the scraper can sign in automatically."
        )

    await login_with_credentials(context, creds)

    if not await is_logged_in(context):
        raise RuntimeError(
            "LinkedIn login failed. Complete any verification in the opened browser window, then retry."
        )


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
            try:
                sent = await send_connection_request(page, lead.linkedin_url)
                if sent:
                    logger.info(f"Connection request sent to {lead.id}", {"leadId": lead.id})
            except Exception as exc:
                logger.warn(f"Connection request failed for {lead.id}", {"leadId": lead.id}, error=exc)
        except TimeoutError as exc:
            logger.error(f"Timeout enriching {lead.id}", {"leadId": lead.id}, error=exc)
            mark_enrich_failed(client, lead.id, reason=f"Timeout: {exc}")
        except Exception as exc:
            logger.error(f"Failed to enrich {lead.id}", {"leadId": lead.id}, error=exc)
            mark_enrich_failed(client, lead.id, reason=str(exc))
        finally:
            try:
                await page.close()
            except Exception:
                pass

        await random_pause()


async def main(limit: int = 10) -> None:
    logger.operation_start("enrichment", input_data={"limit": limit})
    
    try:
        client = get_supabase_client()
        creds = fetch_linkedin_credentials(client)
        enriched_today = fetch_today_enrichment_count(client)
        remaining_quota = max(0, DAILY_ENRICHMENT_CAP - enriched_today)

        if remaining_quota <= 0:
            logger.warn(f"Daily enrichment cap reached", data={"cap": DAILY_ENRICHMENT_CAP, "enrichedToday": enriched_today})
            return

        effective_limit = min(limit, remaining_quota)
        if effective_limit <= 0:
            logger.info("No quota left for today")
            return

        leads = fetch_new_leads(client, limit=effective_limit)
        if not leads:
            logger.info("No NEW leads to process")
            return

        playwright, browser, context = await open_browser(headless=False)
        try:
            logger.info("Browser opened, authenticating...")
            await ensure_linkedin_auth(context, creds)
            logger.info(f"Starting batch processing of {len(leads)} leads")
            await process_batch(context, client, leads)
            logger.operation_complete("enrichment", result={"processed": len(leads)})
        finally:
            await shutdown(playwright, browser)
            logger.info("Browser closed")
    except Exception as exc:
        logger.operation_error("enrichment", error=exc, input_data={"limit": limit})
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LinkedIn enrichment scraper")
    parser.add_argument(
        "--run",
        action="store_true",
        help="Execute the scraper. Without this flag the script exits without doing any work.",
    )
    parser.add_argument(
        "--inbox",
        action="store_true",
        help="Run in inbox scanning mode to detect replies and create followups.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Maximum number of leads to process in a single run (default: 10).",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if not args.run:
        print("Scraper invoked without --run flag. Exiting without processing leads.")
        sys.exit(0)
    # Dispatch based on mode
    if getattr(args, "inbox", False):
        limit = args.limit if isinstance(args.limit, int) and args.limit > 0 else 25
        asyncio.run(inbox_mode(limit=limit))
    else:
        limit = args.limit if isinstance(args.limit, int) and args.limit > 0 else 10
        asyncio.run(main(limit=limit))

###################################################################################################
# Inbox scanning mode
###################################################################################################

async def navigate_to_inbox(page: Page) -> None:
    await gentle_nav(page, "https://www.linkedin.com/messaging/")
    # Wait for conversation list container
    await page.wait_for_selector("div.msg-conversations-container, div[role='main']", timeout=30_000)
    await page.wait_for_timeout(600)


async def extract_conversation_summaries(page: Page, max_items: int) -> List[Dict[str, Any]]:
    """Extract top-N conversation summaries with participant and last message snippet/time."""
    results: List[Dict[str, Any]] = []
    items = page.locator("li.msg-conversation-listitem, li.artdeco-list__item, div.msg-conversation-card")
    count = min(await items.count(), max_items)
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
        snippet = await safe_inner_text(entry.page, "p.msg-conversation-card__message-snippet, p, span.line-clamp-1") if hasattr(entry, 'page') else ""
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


def find_lead_match(client: Client, profile_url: Optional[str], name: str) -> Optional[Dict[str, Any]]:
    """Match a reply to a lead. Prefer linkedin_url exact match; fallback to name heuristic."""
    if profile_url:
        url_norm = profile_url.split("?")[0].rstrip("/")
        resp = (
            client.table("leads")
            .select("id, linkedin_url, first_name, last_name")
            .ilike("linkedin_url", f"%{url_norm}%")
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        if rows:
            return rows[0]
    # Name heuristic: requires both first and last name present and exact ilike match on either order
    parts = [p for p in (name or "").replace("·", " ").split() if p.strip()]
    if len(parts) >= 2:
        first, last = parts[0], parts[-1]
        resp = (
            client.table("leads")
            .select("id, linkedin_url, first_name, last_name")
            .or_(
                f"and(ilike.first_name.%{first}%,ilike.last_name.%{last}%),and(ilike.first_name.%{last}%,ilike.last_name.%{first}%)"
            )
            .limit(3)
            .execute()
        )
        rows = resp.data or []
        if rows:
            return rows[0]
    return None


def upsert_followup_for_reply(
    client: Client,
    lead_id: str,
    reply_id: Optional[str],
    reply_snippet: str,
    reply_timestamp: Optional[str],
) -> None:
    # Create new followup row as PENDING_REVIEW with attempt = (existing count + 1) capped by max.
    # Increment followup_count on lead and set last_reply_at
    client.table("followups").insert({
        "lead_id": lead_id,
        "reply_id": reply_id,
        "reply_snippet": reply_snippet[:2000] if reply_snippet else None,
        "reply_timestamp": reply_timestamp,
        "status": "PENDING_REVIEW",
    }).execute()
    client.table("leads").update({
        "last_reply_at": reply_timestamp or None,
        "followup_count": (client.table("followups").select("id", count="exact").eq("lead_id", lead_id).execute().count or 0)
    }).eq("id", lead_id).execute()


async def inbox_scan(context: BrowserContext, client: Client, limit: int) -> None:
    page = await context.new_page()
    try:
        await navigate_to_inbox(page)
        convos = await extract_conversation_summaries(page, max_items=limit)
        detected = 0
        for convo in convos:
            match = find_lead_match(client, convo.get("profile_url"), convo.get("name", ""))
            if not match:
                continue
            # Basic guard: only create followup if lead was SENT recently or in APPROVED/SENT/REPLIED
            lead = match
            # We could fetch last SENT message time from leads.sent_at if available
            reply_ts = None
            try:
                reply_ts = datetime.datetime.utcnow().isoformat()
            except Exception:
                reply_ts = None
            upsert_followup_for_reply(
                client,
                lead_id=lead["id"],
                reply_id=None,
                reply_snippet=convo.get("snippet", ""),
                reply_timestamp=reply_ts,
            )
            detected += 1
        print(f"Inbox scan complete. New replies detected: {detected}")
    finally:
        await page.close()


async def inbox_mode(limit: int = 25) -> None:
    client = get_supabase_client()
    playwright, browser, context = await open_browser(headless=False)
    try:
        creds = fetch_linkedin_credentials(client)
        await ensure_linkedin_auth(context, creds)
        # Enforce a daily cap on inbox scans via settings if desired (not persisted here, simple runtime cap)
        effective_limit = min(limit, DAILY_INBOX_SCAN_LIMIT)
        await inbox_scan(context, client, effective_limit)
    finally:
        await shutdown(playwright, browser)
