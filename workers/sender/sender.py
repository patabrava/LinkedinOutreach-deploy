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

# Import shared logger
sys.path.insert(0, str(Path(__file__).parent.parent))
from shared_logger import get_logger

load_dotenv()

# Initialize logger
logger = get_logger("sender")

# Reuse the scraper's persisted auth state to avoid drift between workers.
AUTH_STATE_PATH = (Path(__file__).parent.parent / "scraper" / "auth.json").resolve()
DAILY_SEND_DEFAULT = 42


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


async def open_browser(headless: bool = False) -> Tuple[Playwright, Browser, BrowserContext]:
    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(headless=headless)
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


def fetch_next_lead(client: Client) -> Optional[Dict[str, Any]]:
    """Legacy function - fetch a single approved lead."""
    leads = fetch_approved_leads(client, 1)
    return leads[0] if leads else None


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

async def open_message_surface(page: Page) -> str:
    """Open a messaging surface on a LinkedIn profile page.
    
    CRITICAL: All selectors must be scoped to lazy-column test ID to avoid
    clicking buttons in the messaging inbox or other parts of the page.
    """
    await wiggle_mouse(page)

    logger.debug("Starting open_message_surface")

    # Scope all interactions to the profile page's main content area
    # Try lazy-column test ID first, with fallback to main profile section
    profile_container = None
    try:
        profile_container = page.get_by_test_id("lazy-column")
        await profile_container.wait_for(state="visible", timeout=5_000)
        logger.debug("Profile container found via lazy-column test ID")
    except Exception as e:
        logger.warn("lazy-column test ID not found, trying fallback selectors", error=e)
        # Fallback to main profile section
        try:
            profile_container = page.locator("main.scaffold-layout__main, section.artdeco-card").first
            await profile_container.wait_for(state="visible", timeout=5_000)
            logger.debug("Profile container found via fallback selector")
        except Exception as e2:
            logger.error("No profile container found with any selector", error=e2)
            # Last resort: use page itself (risky but better than failing)
            profile_container = page
            logger.warn("Using page-level selectors as last resort")

    # PATH 1: Try Message link (for existing connections)
    # Scoped to profile container to avoid inbox Message buttons
    message_link = profile_container.get_by_role("link", name=re.compile(r"(Message|Nachricht)", re.I))
    message_link_count = await message_link.count()
    logger.debug(f"Message link check", data={"count": message_link_count})

    if message_link_count > 0:
        logger.debug("Found Message link - user is in network")
        try:
            await message_link.first.click(timeout=8_000)
            # Wait for messaging overlay
            await page.wait_for_selector(
                "div.msg-overlay-conversation-bubble, section[role='dialog'] div[role='textbox'][contenteditable='true'], div.msg-form__contenteditable[contenteditable='true']",
                timeout=10_000,
            )
            await random_pause()
            logger.debug("Message link path successful")
            return "message"
        except Exception as e:
            logger.debug(f"Message link path failed", error=e)

    # PATH 2: Direct invite link inside profile container (Invite <Name> to ...)
    invite_link = profile_container.get_by_role("link", name=re.compile(r"(Invite .+ to|Einladen .+ zu)", re.I))
    invite_link_count = await invite_link.count()
    logger.debug("Invite link check", data={"count": invite_link_count})

    if invite_link_count > 0:
        logger.debug("Found invite link inside profile container")
        try:
            await invite_link.first.click(timeout=8_000)
            await page.wait_for_selector("section[role='dialog'], div[role='dialog']", timeout=8_000)
            await random_pause()

            add_note_btn = page.get_by_role("button", name=re.compile(r"(Nachricht hinzufügen|Add a note|Notiz hinzufügen)", re.I))
            add_note_count = await add_note_btn.count()
            logger.debug("Add note button after invite link", data={"count": add_note_count})

            if add_note_count > 0:
                await add_note_btn.first.click(timeout=6_000)
                await page.wait_for_timeout(500)
                logger.debug("Connect with note dialog opened via invite link")
                return "connect_note"
            logger.debug("Invite link path with direct connect")
            return "connect"
        except Exception as e:
            logger.debug("Invite link path failed", error=e)

    # PATH 3: Direct Vernetzen / Als Kontakt button on profile card
    direct_connect_btn = profile_container.get_by_role(
        "button",
        name=re.compile(r"(Vernetzen|Als Kontakt|als Kontakt)", re.I),
    )
    direct_connect_count = await direct_connect_btn.count()
    logger.debug("Direct connect button check", data={"count": direct_connect_count})

    if direct_connect_count > 0:
        logger.debug("Clicking direct connect button on profile")
        try:
            await direct_connect_btn.first.click(timeout=8_000)
            await page.wait_for_selector("section[role='dialog'], div[role='dialog']", timeout=8_000)
            await random_pause()

            add_note_btn = page.get_by_role("button", name=re.compile(r"(Nachricht hinzufügen|Add a note|Notiz hinzufügen)", re.I))
            add_note_count = await add_note_btn.count()
            logger.debug("Add note button after direct connect", data={"count": add_note_count})

            if add_note_count > 0:
                await add_note_btn.first.click(timeout=6_000)
                await page.wait_for_timeout(500)
                logger.debug("Connect with note dialog opened via direct connect button")
                return "connect_note"
            logger.debug("Direct connect without note")
            return "connect"
        except Exception as e:
            logger.debug("Direct connect path failed", error=e)

    # PATH 4: Try More button -> Invite flow (fallback)
    # Scoped to profile container - allow partial match for "Mehr" or "More"
    more_button = profile_container.get_by_role("button", name=re.compile(r"(More|Mehr)", re.I))
    more_button_count = await more_button.count()
    logger.debug(f"More button check", data={"count": more_button_count})

    if more_button_count > 0:
        logger.debug("Found More button - attempting invite flow")
        try:
            await more_button.first.click(timeout=8_000)
            await page.wait_for_timeout(300)

            # Look for Invite/Connect menuitem (can include name like "Invite Antonio-Jean")
            invite_menuitem = page.get_by_role("menuitem", name=re.compile(r"(Invite|Einladen|Connect|Vernetzen)", re.I))
            invite_count = await invite_menuitem.count()
            logger.debug(f"Invite menuitem check", data={"count": invite_count})

            if invite_count > 0:
                logger.debug("Clicking Invite menuitem")
                await invite_menuitem.first.click(timeout=8_000)

                # Wait for connection dialog
                await page.wait_for_selector("section[role='dialog'], div[role='dialog']", timeout=8_000)
                await random_pause()

                # Click "Add a note" button
                add_note_btn = page.get_by_role("button", name=re.compile(r"(Nachricht hinzufügen|Add a note|Notiz hinzufügen)", re.I))
                add_note_count = await add_note_btn.count()
                logger.debug(f"Add a note button check", data={"count": add_note_count})

                if add_note_count > 0:
                    logger.debug("Clicking Add a note button")
                    await add_note_btn.first.click(timeout=6_000)
                    await page.wait_for_timeout(500)
                    logger.debug("Connect with note dialog opened")
                    return "connect_note"
                else:
                    logger.debug("No Add a note button - sending without note")
                    return "connect"
            else:
                logger.warn("No Invite menuitem found in More dropdown")
        except Exception as e:
            logger.debug(f"More button path failed", error=e)

    logger.error("All messaging surface paths exhausted")
    raise RuntimeError("No messaging surface found. Check if profile is 3rd-degree or has restrictions.")


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
        logger.debug("Sending connection request with note")

        # LinkedIn limits note to 300 characters
        safe_message = (message or "").strip()

        if len(safe_message) > 300:
            logger.warn(f"Message too long ({len(safe_message)} chars), truncating to 300")
            # Intelligently truncate at sentence/word boundary
            safe_message = safe_message[:297] + "..."
        else:
            logger.debug(f"Message fits in connection note limit ({len(safe_message)}/300 chars)")

        # Use the exact selector provided by user (support English & German labels)
        note_box_selectors = [
            lambda: page.get_by_role("textbox", name=re.compile(r"Please limit personal note to", re.I)),
            lambda: page.get_by_role("textbox", name=re.compile(r"Ihre persönliche Nachricht", re.I)),
            lambda: page.get_by_role("textbox", name=re.compile(r"Nachricht hinzufügen", re.I)),
            lambda: page.locator("textarea[name='message']"),
            lambda: page.locator("textarea[id='custom-message']"),
            lambda: page.locator("div[role='dialog'] textarea"),
        ]
        note_box = None
        note_box_count = 0
        for builder in note_box_selectors:
            try:
                candidate = builder()
                count = await candidate.count()
                if count > 0:
                    note_box = candidate
                    note_box_count = count
                    break
            except Exception:
                continue
        logger.debug(f"Note textbox check", data={"count": note_box_count})

        if note_box and note_box_count > 0:
            logger.debug(f"Typing note textbox with {len(safe_message)} characters")
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
            logger.error("Note textbox not found in connect dialog")
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
            logger.debug("Send button found, waiting for it to be enabled")

            # Wait for button to be enabled AND give extra time for any final DOM updates
            for attempt in range(30):
                if await send_btn.is_enabled():
                    logger.debug(f"Send button enabled after {attempt} attempts")
                    break
                await page.wait_for_timeout(300)

            # Additional safety pause before clicking to ensure typing is truly complete
            await page.wait_for_timeout(800)

            await send_btn.click()
            logger.debug("Send button clicked")
            await random_pause()
            return
        except Exception as e:
            logger.error("Failed to click Send button in connect dialog", error=e)
            raise

    # Direct message composer path (for existing connections)
    logger.debug("Sending direct message")

    # Find message input box
    editor_candidates = [
        "div.msg-form__contenteditable[contenteditable='true']",
        "div.msg-form__textarea",
        "section[role='dialog'] div[role='textbox'][contenteditable='true']",
        "div[aria-label*='Write a message'][contenteditable='true']",
        "div[role='textbox'][contenteditable='true']:not([id^='g-recaptcha'])",
    ]

    editor = None
    for sel in editor_candidates:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=3_000)
            editor = loc
            logger.debug(f"Found message editor using selector: {sel}")
            break
        except Exception:
            continue

    if editor is None:
        logger.error("No message editor found")
        raise RuntimeError("Could not find message input box")

    await editor.click()
    await human_type(page, message)
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
                logger.debug(f"Direct message text verification passed", data={"expected": expected_length, "actual": actual_length})
                break
            else:
                logger.debug(f"Direct message text still being entered", data={"expected": expected_length, "actual": actual_length, "attempt": verification_attempt})
                await page.wait_for_timeout(200)
        except Exception as e:
            logger.warn(f"Direct message text verification attempt {verification_attempt} failed", error=e)
            await page.wait_for_timeout(200)
    else:
        logger.warn("Could not verify full direct message text was entered, proceeding anyway")

    # Find and click Send button
    send_btn = page.locator("button:has-text('Send'), button:has-text('Senden'), button[aria-label*='Send']").first
    try:
        await send_btn.wait_for(state="visible", timeout=10_000)

        # Additional safety pause before clicking to ensure typing is truly complete
        await page.wait_for_timeout(800)

        await send_btn.click()
        logger.debug("Direct message sent")
        await random_pause()
    except Exception as e:
        logger.error("Failed to click Send button for direct message", error=e)
        raise


def mark_processing(client: Client, lead_id: str) -> None:
    """Mark lead as PROCESSING to prevent re-fetching during the same run."""
    logger.db_query("update", "leads", {"leadId": lead_id}, {"status": "PROCESSING"})
    client.table("leads").update({"status": "PROCESSING"}).eq("id", lead_id).execute()
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    logger.debug(f"Lead marked as PROCESSING", {"leadId": lead_id})


def mark_sent(client: Client, lead_id: str) -> None:
    logger.db_query("update", "leads", {"leadId": lead_id}, {"status": "SENT"})
    client.table("leads").update({"status": "SENT", "sent_at": datetime.utcnow().isoformat()}).eq(
        "id", lead_id
    ).execute()
    logger.db_result("update", "leads", {"leadId": lead_id}, 1)
    logger.info(f"Lead marked as SENT", {"leadId": lead_id})


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
    lead_id = lead["id"]
    logger.message_send_start(lead_id, {"url": lead.get("linkedin_url")})

    draft = fetch_draft(client, lead_id)
    if not draft:
        logger.error("Lead has no draft to send", {"leadId": lead_id})
        raise RuntimeError("Lead has no draft to send.")

    message = build_message(draft)
    logger.message_send_start(lead_id, message_preview=message)

    page = await context.new_page()
    # Normalize to https to reduce redirects
    url = str(lead["linkedin_url"]).replace("http://", "https://")
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
        await send_message(page, message, surface, draft)
    except Exception as e:
        logger.error(f"Failed to send message through surface", {"leadId": lead_id}, error=e)
        raise

    mark_sent(client, lead_id)
    await page.close()

    logger.message_send_complete(lead_id)
    logger.info(f"Message sent successfully", {"leadId": lead_id})


# ------------------------- FOLLOW-UP FLOW -------------------------
def fetch_next_followup(client: Client) -> Optional[Dict[str, Any]]:
    logger.db_query("select", "followups", {"status": "APPROVED"})
    resp = (
        client.table("followups")
        .select("*, lead:leads(id, linkedin_url)")
        .eq("status", "APPROVED")
        .order("updated_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    followup = rows[0] if rows else None
    logger.db_result("select", "followups", {"status": "APPROVED"}, 1 if followup else 0)
    if followup:
        logger.info(f"Fetched next APPROVED followup", {"followupId": followup["id"]})
    return followup


def build_followup_message(fu: Dict[str, Any]) -> str:
    # Prefer draft_text; fallback to sent_text if somehow present
    msg = (fu.get("draft_text") or fu.get("sent_text") or "").strip()
    return msg


def mark_followup_sent(client: Client, followup_id: str, message: str) -> None:
    now_iso = datetime.utcnow().isoformat()
    logger.db_query("update", "followups", {"followupId": followup_id}, {"status": "SENT"})
    client.table("followups").update(
        {"status": "SENT", "sent_text": message, "sent_at": now_iso}
    ).eq("id", followup_id).execute()
    logger.db_result("update", "followups", {"followupId": followup_id}, 1)
    logger.info(f"Followup marked as SENT", {"followupId": followup_id})


async def process_followup_one(context: BrowserContext, client: Client, followup: Dict[str, Any]) -> None:
    followup_id = followup["id"]
    lead = (followup.get("lead") or {})
    lead_id = lead.get("id")
    linkedin_url = str(lead.get("linkedin_url") or "").replace("http://", "https://")

    logger.info(f"Processing followup", {"followupId": followup_id, "leadId": lead_id})

    if not linkedin_url:
        logger.error("Followup has no linked lead URL", {"followupId": followup_id})
        raise RuntimeError("Followup has no linked lead URL")

    message = build_followup_message(followup)
    if not message:
        logger.error("Followup has no draft_text", {"followupId": followup_id})
        raise RuntimeError("Followup has no draft_text to send")

    logger.message_send_start(lead_id or "unknown", {"followupId": followup_id}, message)

    page = await context.new_page()
    await page.goto(linkedin_url, wait_until="domcontentloaded", timeout=60_000)
    await page.wait_for_timeout(1_000)
    surface = await open_message_surface(page)
    logger.debug(f"Message surface opened for followup", {"followupId": followup_id}, {"surface": surface})

    await send_message(page, message, surface)
    await page.close()
    mark_followup_sent(client, followup_id, message)

    logger.message_send_complete(lead_id or "unknown", {"followupId": followup_id})
    logger.info(f"Followup sent successfully", {"followupId": followup_id, "leadId": lead_id})


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

    parser = argparse.ArgumentParser(description="Send approved drafts or follow-ups via LinkedIn.")
    parser.add_argument("--lead-id", help="Send only this lead id (bypass queue).")
    parser.add_argument("--followup", action="store_true", help="Process APPROVED followups instead of initial outreach.")
    args = parser.parse_args()

    mode = "followup" if args.followup else "outreach"
    logger.operation_start(f"sender-{mode}", input_data={"lead_id": args.lead_id, "mode": mode})

    try:
        client = get_supabase_client()
       
        # Compute daily limit with a hard minimum of 42 to avoid getting stuck at 20
        env_limit = os.getenv("DAILY_SEND_LIMIT")
        try:
            parsed_limit = int(env_limit) if env_limit else DAILY_SEND_DEFAULT
        except Exception:
            parsed_limit = DAILY_SEND_DEFAULT
        daily_limit = max(parsed_limit, 42)
        logger.info("Daily send limit computed", data={"limit": daily_limit, "env": env_limit, "default": DAILY_SEND_DEFAULT})
        already_sent = sent_today_count(client)

        if already_sent >= daily_limit and not args.followup:
            logger.warn("Daily send limit reached", data={"limit": daily_limit, "sent": already_sent})
            return

        leads_to_send = []
        remaining = max(0, daily_limit - already_sent)

        if args.followup:
            # Process a batch of approved followups; keep simple cap of remaining slots
            items: list[Dict[str, Any]] = []
            for _ in range(max(1, daily_limit - already_sent)):
                fu = fetch_next_followup(client)
                if not fu:
                    break
                items.append(fu)
            if not items:
                logger.info("No APPROVED followups to send")
                return

            logger.info(f"Processing {len(items)} followups")
            playwright, browser, context = await open_browser(headless=False)
            try:
                logger.info("Browser opened, authenticating...")
                await ensure_linkedin_auth(context, client)

                for fu in items:
                    try:
                        await process_followup_one(context, client, fu)
                    except Exception as exc:
                        logger.error(f"Failed to send followup", {"followupId": fu.get('id')}, error=exc)
                    await random_pause(2, 4)

                logger.operation_complete("sender-followup", result={"sent": len(items)})
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