"""Sender worker that types approved drafts as a human."""

from __future__ import annotations

import asyncio
import os
import random
import sys
from datetime import datetime, time as dtime
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from dotenv import load_dotenv
from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright
from supabase import Client, create_client

load_dotenv()

AUTH_STATE_PATH = Path(__file__).parent / "auth.json"


def get_supabase_client() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
    return create_client(url, key)


def require_auth_state() -> None:
    if not AUTH_STATE_PATH.exists():
        raise FileNotFoundError(
            f"Missing auth.json at {AUTH_STATE_PATH}. "
            "Copy it from the scraper worker or create it via playwright codegen."
        )


async def open_browser(headless: bool = False) -> Tuple[Playwright, Browser, BrowserContext]:
    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(headless=headless)
    context = await browser.new_context(storage_state=str(AUTH_STATE_PATH))
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


def sent_today(client: Client, limit: int) -> bool:
    start_iso = today_utc_iso()
    resp = (
        client.table("leads")
        .select("id", count="exact")
        .eq("status", "SENT")
        .gte("sent_at", start_iso)
        .execute()
    )
    count = getattr(resp, "count", None) or 0
    return count >= limit


def fetch_next_lead(client: Client) -> Optional[Dict[str, Any]]:
    resp = (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, company_name")
        .eq("status", "APPROVED")
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def fetch_draft(client: Client, lead_id: str) -> Optional[Dict[str, Any]]:
    resp = (
        client.table("drafts")
        .select("*")
        .eq("lead_id", lead_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def build_message(draft: Dict[str, Any]) -> str:
    opener = draft.get("opener") or ""
    body = draft.get("body_text") or draft.get("body") or ""
    cta = draft.get("cta_text") or ""
    final = draft.get("final_message")
    if final:
        return final
    parts = [opener.strip(), body.strip(), cta.strip()]
    return "\n\n".join([p for p in parts if p])


async def open_message_surface(page: Page) -> str:
    await wiggle_mouse(page)
    message_btn = page.locator("button:has-text('Message'), a:has-text('Message')").first
    connect_btn = page.locator("button:has-text('Connect')").first
    add_note_btn = page.locator("button:has-text('Add a note')").first

    if await message_btn.count() > 0:
        await message_btn.click()
        await random_pause()
        return "message"

    if await connect_btn.count() > 0:
        await connect_btn.click()
        await random_pause()
        if await add_note_btn.count() > 0:
            await add_note_btn.click()
            await random_pause()
            return "connect_note"
        return "connect"

    raise RuntimeError("No messaging surface found (maybe 3rd-degree without premium).")


async def send_message(page: Page, message: str) -> None:
    textarea = page.locator("textarea, div[role='textbox']").first
    await textarea.click()
    await human_type(page, message)
    await random_pause()
    send_btn = page.locator("button:has-text('Send'), button[aria-label='Send now']").first
    await send_btn.click()
    await random_pause()


def mark_sent(client: Client, lead_id: str) -> None:
    client.table("leads").update({"status": "SENT", "sent_at": datetime.utcnow().isoformat()}).eq(
        "id", lead_id
    ).execute()


async def process_one(context: BrowserContext, client: Client, lead: Dict[str, Any]) -> None:
    draft = fetch_draft(client, lead["id"])
    if not draft:
        raise RuntimeError("Lead has no draft to send.")

    message = build_message(draft)
    page = await context.new_page()
    await page.goto(lead["linkedin_url"], wait_until="networkidle")
    await random_pause()

    await open_message_surface(page)
    await send_message(page, message)
    mark_sent(client, lead["id"])
    await page.close()
    print(f"Sent message for lead {lead['id']}")


async def main() -> None:
    require_auth_state()
    client = get_supabase_client()
    daily_limit = int(os.getenv("DAILY_SEND_LIMIT", "20"))
    if sent_today(client, daily_limit):
        print("Daily send limit reached; exiting.")
        return

    lead = fetch_next_lead(client)
    if not lead:
        print("No APPROVED leads to send.")
        return

    playwright, browser, context = await open_browser(headless=False)
    try:
        await process_one(context, client, lead)
    except Exception as exc:
        print(f"Failed to send message: {exc}", file=sys.stderr)
    finally:
        await shutdown(playwright, browser)


if __name__ == "__main__":
    asyncio.run(main())
