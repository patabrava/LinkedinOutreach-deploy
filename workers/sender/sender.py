"""Sender worker that types approved drafts as a human."""

from __future__ import annotations

import asyncio
import os
import random
import sys
from datetime import datetime, time as dtime
import re
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from dotenv import load_dotenv
from playwright.async_api import Browser, BrowserContext, Page, Playwright, async_playwright
from supabase import Client, create_client

load_dotenv()

# Reuse the scraper's persisted auth state to avoid drift between workers.
AUTH_STATE_PATH = (Path(__file__).parent.parent / "scraper" / "auth.json").resolve()
DAILY_SEND_DEFAULT = 20


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
    storage_state = str(AUTH_STATE_PATH) if AUTH_STATE_PATH.exists() else None
    context = await browser.new_context(storage_state=storage_state)
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
    resp = (
        client.table("leads")
        .select("id", count="exact")
        .eq("status", "SENT")
        .gte("sent_at", start_iso)
        .execute()
    )
    return getattr(resp, "count", None) or 0


def fetch_next_lead(client: Client) -> Optional[Dict[str, Any]]:
    resp = (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, company_name")
        .eq("status", "APPROVED")
        .order("updated_at", desc=True)
        .limit(1)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else None


def fetch_lead_by_id(client: Client, lead_id: str) -> Optional[Dict[str, Any]]:
    resp = (
        client.table("leads")
        .select("id, linkedin_url, first_name, last_name, company_name, status")
        .eq("id", lead_id)
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

    async def ensure_visible(locator) -> bool:
        try:
            if await locator.count() == 0:
                return False
            first = locator.first
            try:
                await first.scroll_into_view_if_needed(timeout=3_000)
            except Exception:
                pass
            await page.wait_for_timeout(150)
            return True
        except Exception:
            return False

    # Primary selectors
    message_btn = page.locator("button:has-text('Message'), a:has-text('Message'), button[aria-label^='Message']").first
    connect_btn = page.locator("button:has-text('Connect'), a:has-text('Connect'), button[aria-label^='Connect']").first
    add_note_btn = page.locator("button:has-text('Add a note')").first
    more_btn = page.locator("button[aria-label*='More'], button:has-text('More')").first

    # Try clicking Message directly
    if await ensure_visible(message_btn):
        try:
            await message_btn.click(timeout=10_000)
            # Wait for messaging overlay or compose area
            await page.wait_for_selector(
                "div.msg-overlay-conversation-bubble, section[role='dialog'] div[role='textbox'][contenteditable='true'], div.msg-form__contenteditable[contenteditable='true']",
                timeout=10_000,
            )
            await random_pause()
            return "message"
        except Exception:
            pass

    # Try overflow menu (More) path as specified by user
    # 1) Click More actions
    more_actions = page.get_by_role("button", name=re.compile("^(More actions|Mehr|More)$", re.I))
    if await ensure_visible(more_actions):
        try:
            await more_actions.first.click(timeout=8_000)
            await page.wait_for_timeout(300)
            # 2) Click Connect/Invite (Invite <Name> to ...)
            # LinkedIn often uses Invite <Name> to connect
            invite_btn = page.get_by_role(
                "button",
                name=re.compile(r"^(Invite|Connect).*to", re.I),
            )
            if await invite_btn.count() == 0:
                # Fallbacks: menuitem or generic Connect
                invite_btn = page.get_by_role("menuitem", name=re.compile(r"^(Invite|Connect).*to|^Connect$", re.I))
            if await invite_btn.count() > 0:
                await invite_btn.first.click(timeout=8_000)
                # 3) Ensure dialog appears
                await page.wait_for_selector("section[role='dialog'], div[role='dialog']", timeout=8_000)
                await random_pause()
                # 4) Click Add a note
                add_note = page.get_by_role("button", name=re.compile("^Add a note$", re.I))
                if await add_note.count() > 0:
                    await add_note.first.click(timeout=6_000)
                    await page.wait_for_selector("div[role='dialog']", timeout=6_000)
                    await random_pause()
                    return "connect_note"
                return "connect"
        except Exception:
            pass

    # As a fallback, try clicking Connect directly on the page
    if await ensure_visible(connect_btn):
        try:
            await connect_btn.click(timeout=8_000)
            await page.wait_for_selector("section[role='dialog'], div[role='dialog']", timeout=8_000)
            await random_pause()
            add_note = page.get_by_role("button", name=re.compile("^Add a note$", re.I))
            if await add_note.count() > 0:
                await add_note.first.click(timeout=6_000)
                await page.wait_for_selector("div[role='dialog']", timeout=6_000)
                await random_pause()
                return "connect_note"
            return "connect"
        except Exception:
            pass

    raise RuntimeError("No messaging surface found (maybe 3rd-degree without premium).")


async def send_message(page: Page, message: str, surface: str) -> None:
    # Prefer specific message composer containers; avoid recaptcha fields
    # Choose candidates based on the surface we opened
    editor_candidates = [
        "div.msg-form__contenteditable[contenteditable='true']",
        "div[role='textbox'][contenteditable='true']:not([id^='g-recaptcha'])",
        "section[role='dialog'] div[role='textbox'][contenteditable='true']",
        "div[aria-label*='Write a message'][contenteditable='true']",
        "textarea:not([id^='g-recaptcha'])",
    ]
    if surface == "connect_note":
        # Add-a-note modal uses a different textarea; prefer role-based
        editor_candidates = [
            # Precise role-based target as requested
            "role=textbox[name=/Please limit personal note to/i]",
            "textarea[name='message']",
            "textarea[id='custom-message']",
            "div[role='dialog'] textarea",
        ] + editor_candidates
    editor = None
    for sel in editor_candidates:
        loc = page.locator(sel) if not sel.startswith("role=") else page.get_by_role("textbox", name=re.compile("Please limit personal note to", re.I))
        try:
            await loc.first.wait_for(state="visible", timeout=6_000)
            editor = loc.first
            break
        except Exception:
            continue
    if editor is None:
        # fallback to any visible textbox that's not recaptcha
        loc = page.locator("div[role='textbox']:not([id^='g-recaptcha'])").first
        await loc.wait_for(state="visible", timeout=10_000)
        editor = loc

    await editor.click()
    # In the Add-a-note modal, LinkedIn limits note length (typically 300 chars). Use a safe cap.
    if surface == "connect_note":
        safe_message = (message or "").strip()
        # LinkedIn "Add a note" is restricted to 200 characters. Enforce strict cap.
        if len(safe_message) > 200:
            # Truncate to 200 characters exactly. Prefer hard cut to guarantee limit.
            safe_message = safe_message[:200]
        # Prefer role-based textbox per user's instruction
        note_box = page.get_by_role("textbox", name=re.compile("Please limit personal note to", re.I))
        if await note_box.count() > 0:
            await note_box.first.fill(safe_message)
        else:
            await human_type(page, safe_message)
        await random_pause()
        # Target the dialog-local Send button and ensure it's enabled
        dialog = page.locator("section[role='dialog'], div[role='dialog']").first
        send_btn = dialog.locator(
            "button:has-text('Send invitation'), button:has-text('Send'), button[aria-label='Send'], button[aria-label='Send invitation']"
        ).first
        await send_btn.wait_for(state="visible", timeout=10_000)
        # Wait until enabled (button can be disabled until text is entered)
        for _ in range(30):
            try:
                if await send_btn.is_enabled():
                    break
            except Exception:
                pass
            # Nudge input events if not enabled yet
            try:
                if await note_box.count() > 0:
                    await note_box.first.focus()
                    await page.keyboard.type(" ")
                    await page.keyboard.press("Backspace")
            except Exception:
                pass
            await page.wait_for_timeout(300)
        await send_btn.click()
        await random_pause()
        return

    # Direct message composer path
    await human_type(page, message)
    await random_pause()
    send_btn = page.locator("button:has-text('Send'), button[aria-label='Send now']").first
    await send_btn.wait_for(state="visible", timeout=10_000)
    await send_btn.click()
    await random_pause()


def mark_sent(client: Client, lead_id: str) -> None:
    client.table("leads").update({"status": "SENT", "sent_at": datetime.utcnow().isoformat()}).eq(
        "id", lead_id
    ).execute()

async def send_connection_request(page: Page) -> bool:
    """Try to connect if not already connected. Returns True if a request was attempted."""
    connect = page.locator("button:has-text('Connect'), a:has-text('Connect')")
    if await connect.count() == 0:
        return False
    try:
        await connect.first.click(timeout=5_000)
        await random_pause()
    except Exception:
        return False

    # If modal opens, click "Send without a note" or "Send".
    for selector in [
        "button:has-text('Send without a note')",
        "button:has-text('Send now')",
        "button:has-text('Send')",
    ]:
        btn = page.locator(selector)
        if await btn.count() > 0:
            try:
                await btn.first.click(timeout=5_000)
                await random_pause()
                return True
            except Exception:
                continue
    return True


async def process_one(context: BrowserContext, client: Client, lead: Dict[str, Any]) -> None:
    draft = fetch_draft(client, lead["id"])
    if not draft:
        raise RuntimeError("Lead has no draft to send.")

    message = build_message(draft)
    page = await context.new_page()
    # Normalize to https to reduce redirects
    url = str(lead["linkedin_url"]).replace("http://", "https://")

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

    surface = await open_message_surface(page)
    await send_message(page, message, surface)
    mark_sent(client, lead["id"])
    await page.close()
    print(f"Sent message for lead {lead['id']}")


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
    password = value.get("password")
    if not email or not password:
        return None
    return {"email": email, "password": password}


async def is_logged_in(context: BrowserContext) -> bool:
    page = await context.new_page()
    try:
        await page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=30_000)
        await page.wait_for_timeout(1_000)
        return "/feed" in page.url and "/login" not in page.url
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
            lambda: page.locator("input#username"),
            lambda: page.locator("input[name='session_key']"),
        ]
        password_fallbacks = [
            lambda: page.get_by_role("textbox", name="Password"),
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
        if not email_filled or not pwd_filled:
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

        await page.wait_for_url("**/feed**", timeout=45_000)
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

    parser = argparse.ArgumentParser(description="Send approved drafts via LinkedIn.")
    parser.add_argument("--lead-id", help="Send only this lead id (bypass queue).")
    args = parser.parse_args()

    client = get_supabase_client()
    daily_limit = int(os.getenv("DAILY_SEND_LIMIT", str(DAILY_SEND_DEFAULT)))
    already_sent = sent_today_count(client)
    if already_sent >= daily_limit:
        print("Daily send limit reached; exiting.")
        return

    leads_to_send = []
    remaining = max(0, daily_limit - already_sent)

    if args.lead_id:
        lead = fetch_lead_by_id(client, args.lead_id)
        if not lead:
            print(f"No lead found with id {args.lead_id}")
            return
        leads_to_send.append(lead)
    else:
        while len(leads_to_send) < remaining:
            nxt = fetch_next_lead(client)
            if not nxt:
                break
            leads_to_send.append(nxt)

    if not leads_to_send:
        print("No APPROVED leads to send.")
        return

    playwright, browser, context = await open_browser(headless=False)
    try:
        # Ensure we are logged in before attempting to message anyone.
        await ensure_linkedin_auth(context, client)
        for lead in leads_to_send:
            try:
                await process_one(context, client, lead)
            except Exception as exc:
                print(f"Failed to send message for {lead['id']}: {exc}", file=sys.stderr)
                # keep status as APPROVED for retry
                client.table("leads").update({"status": "APPROVED"}).eq("id", lead["id"]).execute()
            await random_pause(2, 4)
    finally:
        await shutdown(playwright, browser)


if __name__ == "__main__":
    asyncio.run(main())
