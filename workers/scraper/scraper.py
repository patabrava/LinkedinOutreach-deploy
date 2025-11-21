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
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from playwright.async_api import BrowserContext, Page, TimeoutError
from supabase import Client, create_client
from tenacity import retry, stop_after_attempt, wait_fixed

from auth import AUTH_STATE_PATH, is_logged_in, open_browser, save_storage_state, shutdown

load_dotenv()

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
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    return create_client(url, key)


def fetch_new_leads(client: Client, limit: int = 10) -> List[Lead]:
    resp = (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, company_name")
        .eq("status", "NEW")
        .limit(limit)
        .execute()
    )
    leads: List[Lead] = [Lead(**row) for row in resp.data or []]
    return leads


def fetch_today_enrichment_count(client: Client) -> int:
    """Return count of leads marked ENRICHED since 00:00 UTC today."""
    start_of_day = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    resp = (
        client.table("leads")
        .select("id", count="exact")
        .eq("status", "ENRICHED")
        .gte("updated_at", start_of_day)
        .execute()
    )
    return resp.count or 0


def fetch_linkedin_credentials(client: Client) -> Optional[LinkedinCredentials]:
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
    return profile_data


async def scrape_recent_activity(page: Page, profile_url: str) -> List[Dict[str, Any]]:
    """Navigate to activity section, click on recent posts, and extract full text content."""
    base = profile_url.rstrip("/")
    activity_url = f"{base}/recent-activity/all/"

    await gentle_nav(page, activity_url)
    await page.wait_for_timeout(2_000)
    await slow_scroll(page, steps=3)

    results: List[Dict[str, Any]] = []
    
    # Look for post links in the activity feed
    # These are typically anchor tags that link to individual posts
    post_link_selectors = [
        "div[data-view-name='feed-commentary'] a[href*='/posts/']",
        "div[role='listitem'] a[href*='/posts/']",
        "article a[href*='/posts/']",
        "div.feed-shared-update-v2 a[href*='/posts/']",
    ]
    
    post_links = []
    for selector in post_link_selectors:
        links = page.locator(selector)
        count = await links.count()
        if count > 0:
            # Get the href attributes of the first 3 posts
            for idx in range(min(count, 3)):
                try:
                    href = await links.nth(idx).get_attribute("href", timeout=3_000)
                    if href and "/posts/" in href:
                        # Make it an absolute URL if it's relative
                        if href.startswith("/"):
                            href = f"https://www.linkedin.com{href}"
                        if href not in post_links:
                            post_links.append(href)
                except Exception:
                    continue
            break
    
    # If we found post links, visit each one and extract content
    if post_links:
        for post_url in post_links[:3]:  # Limit to 3 most recent posts
            try:
                print(f"  Extracting activity post: {post_url}")
                await gentle_nav(page, post_url)
                await page.wait_for_timeout(1_500)
                
                # Extract post content from the detail view
                content = ""
                content_selectors = [
                    "span[data-testid='expandable-text-box']",
                    "div.feed-shared-update-v2__description span[dir='ltr']",
                    "div.feed-shared-text span[dir='ltr']",
                    "div[class*='feed-shared-inline-show-more-text'] span",
                ]
                
                for selector in content_selectors:
                    text = await safe_inner_text(page, selector, timeout=5_000)
                    if text and len(text) > 20:  # Ensure we got meaningful content
                        content = text
                        break
                
                # If still no content, try getting all text from the main post area
                if not content:
                    main_post = page.locator("div.feed-shared-update-v2, article, div[data-view-name='feed-commentary']")
                    if await main_post.count() > 0:
                        content = safe_text(await main_post.first.inner_text(timeout=6_000))
                
                # Extract date/time
                date_text = ""
                date_selectors = [
                    "span.feed-shared-actor__sub-description span[aria-hidden='true']",
                    "a.app-aware-link span[aria-hidden='true']:has-text('ago')",
                    "span:has-text('ago')",
                ]
                for selector in date_selectors:
                    date_text = await safe_text_content(page, selector, timeout=3_000)
                    if date_text and ("ago" in date_text or "d" in date_text or "w" in date_text):
                        break
                
                # Extract engagement (likes, comments)
                likes_text = ""
                likes_selectors = [
                    "button[aria-label*='reactions'] span[aria-hidden='true']",
                    "span.social-details-social-counts__reactions-count",
                    "button:has-text('reactions') span",
                ]
                for selector in likes_selectors:
                    likes_text = await safe_text_content(page, selector, timeout=3_000)
                    if likes_text:
                        break
                
                # Only add if we got meaningful content
                if content and len(content.strip()) > 20:
                    results.append({
                        "text": content.strip(),
                        "date": date_text.strip(),
                        "likes": likes_text.strip(),
                        "url": post_url
                    })
                    print(f"  ✓ Extracted {len(content)} characters from post")
                
            except Exception as exc:
                print(f"  Failed to extract post {post_url}: {exc}")
                continue
            
            # Small delay between posts
            await page.wait_for_timeout(random.randint(800, 1500))
    
    # Fallback: if no post links found, try to extract from feed view (less reliable)
    if not results:
        print("  No post links found, falling back to feed view extraction")
        cards = page.locator("div[data-view-name='feed-commentary'], div[role='listitem']")
        count = min(await cards.count(), 3)
        
        for idx in range(count):
            card = cards.nth(idx)
            try:
                text_nodes = card.locator("span[data-testid='expandable-text-box']")
                if await text_nodes.count() > 0:
                    content = safe_text(await text_nodes.first.inner_text(timeout=5_000))
                else:
                    content = safe_text(await card.inner_text(timeout=5_000))
                
                if content and len(content.strip()) > 20:
                    results.append({"text": content.strip(), "date": "", "likes": ""})
            except Exception:
                continue
    
    return results[:3]


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
    client.table("leads").update(
        {
            "profile_data": profile_data,
            "recent_activity": activity,
            "status": "ENRICHED",
        }
    ).eq("id", lead_id).execute()


@retry(stop=stop_after_attempt(3), wait=wait_fixed(2))
async def enrich_one(page: Page, client: Client, lead: Lead) -> None:
    profile = await scrape_profile(page, lead.linkedin_url)
    try:
        activity = await scrape_recent_activity(page, lead.linkedin_url)
    except Exception as exc:
        print(f"Activity scrape failed for {lead.id}: {exc}", file=sys.stderr)
        activity = []
    update_lead(client, lead.id, profile, activity)


async def process_batch(context: BrowserContext, client: Client, leads: List[Lead]) -> None:
    for lead in leads:
        print(f"Processing lead {lead.id} ({lead.linkedin_url})")
        client.table("leads").update({"status": "PROCESSING"}).eq("id", lead.id).execute()

        page = await context.new_page()
        try:
            await enrich_one(page, client, lead)
            print(f"Lead {lead.id} enriched.")
            try:
                sent = await send_connection_request(page, lead.linkedin_url)
                if sent:
                    print(f"Connection request sent to {lead.id}.")
            except Exception as exc:
                print(f"Connection request failed for {lead.id}: {exc}", file=sys.stderr)
        except TimeoutError as exc:
            print(f"Timeout enriching {lead.id}: {exc}", file=sys.stderr)
            client.table("leads").update({"status": "NEW"}).eq("id", lead.id).execute()
        except Exception as exc:
            print(f"Failed to enrich {lead.id}: {exc}", file=sys.stderr)
            client.table("leads").update({"status": "NEW"}).eq("id", lead.id).execute()
        finally:
            try:
                await page.close()
            except Exception:
                pass

        await random_pause()


async def main(limit: int = 10) -> None:
    client = get_supabase_client()
    creds = fetch_linkedin_credentials(client)
    enriched_today = fetch_today_enrichment_count(client)
    remaining_quota = max(0, DAILY_ENRICHMENT_CAP - enriched_today)

    if remaining_quota <= 0:
        print(f"Daily enrichment cap of {DAILY_ENRICHMENT_CAP} reached. Skipping run.")
        return

    effective_limit = min(limit, remaining_quota)
    if effective_limit <= 0:
        print("No quota left for today.")
        return

    leads = fetch_new_leads(client, limit=effective_limit)
    if not leads:
        print("No NEW leads to process.")
        return

    playwright, browser, context = await open_browser(headless=False)
    try:
        await ensure_linkedin_auth(context, creds)
        await process_batch(context, client, leads)
    finally:
        await shutdown(playwright, browser)


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
