"""LinkedIn profile and activity scraper."""

from __future__ import annotations

import asyncio
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
    button = page.locator("#about button:has-text('more'), #about button:has-text('See more')")
    if await button.count() > 0:
        await safe_click(page, "#about button:has-text('more'), #about button:has-text('See more')")


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
    await slow_scroll(page)
    await expand_about(page)

    name = await safe_text_content(page, "main h1.text-heading-xlarge")
    headline = await safe_text_content(page, "main .text-heading-medium")
    about = await safe_text_content(page, "#about .inline-show-more-text")

    current_company = await safe_text_content(
        page, "#experience section:first-of-type li a span:has-text('Company') >> .. >> span[aria-hidden=true]"
    )
    current_title = await safe_text_content(page, "#experience section:first-of-type li span[aria-hidden=true]")
    experience = await scrape_experience(page)

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
    base = profile_url.rstrip("/")
    activity_url = f"{base}/recent-activity/all/"

    await gentle_nav(page, activity_url)
    await slow_scroll(page, steps=4)

    articles = page.locator("article")
    count = min(await articles.count(), 3)
    results: List[Dict[str, Any]] = []

    for idx in range(count):
        article = articles.nth(idx)
        try:
            content = safe_text(await article.inner_text(timeout=8_000))
        except Exception:
            continue
        if not content or ("Repost" in content and "reposted" in content):
            continue

        try:
            date_text = safe_text(
                await article.locator("span:has-text('d'), span:has-text('w')").first.text_content(timeout=4_000)
            )
        except Exception:
            date_text = ""
        try:
            likes_text = safe_text(
                await article.locator("button:has-text('Like'), span:has-text('Like')").first.text_content(timeout=4_000)
            )
        except Exception:
            likes_text = ""

        results.append({"text": content, "date": date_text, "likes": likes_text})

    return results[:3]


async def login_with_credentials(context: BrowserContext, creds: LinkedinCredentials) -> None:
    """Log into LinkedIn using saved credentials and persist auth.json."""
    page = await context.new_page()
    await page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded", timeout=60_000)
    await page.fill("input#username", creds.email)
    await page.fill("input#password", creds.password)
    await safe_click(page, "button[type=submit]")
    await page.wait_for_timeout(2_000)
    await page.wait_for_url("**/feed**", timeout=40_000)
    await save_storage_state(context, path=AUTH_STATE_PATH)
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


async def main() -> None:
    client = get_supabase_client()
    creds = fetch_linkedin_credentials(client)
    leads = fetch_new_leads(client, limit=10)
    if not leads:
        print("No NEW leads to process.")
        return

    playwright, browser, context = await open_browser(headless=False)
    try:
        await ensure_linkedin_auth(context, creds)
        await process_batch(context, client, leads)
    finally:
        await shutdown(playwright, browser)


if __name__ == "__main__":
    asyncio.run(main())
