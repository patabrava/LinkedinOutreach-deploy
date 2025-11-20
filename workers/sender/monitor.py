"""Inbox monitor that flags replies and stops automation for that lead."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Dict, Optional

from dotenv import load_dotenv
from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright
from supabase import Client, create_client

load_dotenv()

AUTH_STATE_PATH = Path(__file__).parent / "auth.json"


def supabase_client() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    return create_client(url, key)


async def open_browser(headless: bool = False):
    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(headless=headless)
    context = await browser.new_context(storage_state=str(AUTH_STATE_PATH))
    return playwright, browser, context


def fetch_sent_leads(client: Client):
    resp = (
        client.table("leads")
        .select("id, first_name, last_name, company_name")
        .eq("status", "SENT")
        .execute()
    )
    return resp.data or []


async def find_reply_for_lead(page: Page, lead: Dict[str, str]) -> Optional[str]:
    full_name = " ".join(filter(None, [lead.get("first_name"), lead.get("last_name")])).strip()
    if not full_name:
        return None
    locator = page.locator(f"text={full_name}").first
    if await locator.count() == 0:
        return None
    await locator.click()
    await page.wait_for_timeout(500)
    messages = await page.locator("div[role='main'] div[aria-label='Message body']").all_text_contents()
    return messages[-1] if messages else None


def mark_replied(client: Client, lead_id: str, reply_text: str) -> None:
    client.table("leads").update({"status": "REPLIED", "ai_tags": {"reply": reply_text}}).eq(
        "id", lead_id
    ).execute()


async def main() -> None:
    client = supabase_client()
    leads = fetch_sent_leads(client)
    if not leads:
        print("No SENT leads to monitor.")
        return

    playwright, browser, context = await open_browser(headless=False)
    page = await context.new_page()
    await page.goto("https://www.linkedin.com/messaging/", wait_until="networkidle")

    try:
        for lead in leads:
            reply = await find_reply_for_lead(page, lead)
            if reply:
                mark_replied(client, lead["id"], reply)
                print(f"Reply detected for {lead['id']}")
    except Exception as exc:
        print(f"Monitor failed: {exc}", file=sys.stderr)
    finally:
        await browser.close()
        await playwright.stop()


if __name__ == "__main__":
    asyncio.run(main())
