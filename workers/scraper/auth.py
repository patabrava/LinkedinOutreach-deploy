"""Utilities for handling LinkedIn authentication state."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
import os
import sys
from typing import Literal, Optional, Tuple

from playwright.async_api import Browser, BrowserContext, Playwright, TimeoutError, async_playwright

__all__ = [
    "AUTH_STATUS_PATH",
    "AUTH_STATE_PATH",
    "LinkedinAuthStatus",
    "read_auth_status",
    "write_auth_status",
    "update_auth_status",
    "open_browser",
    "save_storage_state",
    "is_logged_in",
    "require_auth_state",
    "shutdown",
]

AUTH_STATE_PATH = Path(__file__).parent / "auth.json"
AUTH_STATUS_PATH = Path(__file__).parent / "auth_status.json"
AUTH_STATUS_BACKUP_PATH = Path(__file__).parent / "auth_status.json.bak"


@dataclass
class LinkedinAuthStatus:
    credentials_saved: bool = False
    session_state: Literal[
        "no_credentials",
        "credentials_saved",
        "session_active",
        "session_expired",
        "login_required",
    ] = "no_credentials"
    auth_file_present: bool = False
    last_verified_at: Optional[str] = None
    last_login_attempt_at: Optional[str] = None
    last_login_result: Optional[str] = None
    last_error: Optional[str] = None


def _default_auth_status() -> LinkedinAuthStatus:
    return LinkedinAuthStatus()


def _status_to_payload(status: LinkedinAuthStatus) -> str:
    return json.dumps(asdict(status), indent=2, ensure_ascii=False) + "\n"


def _read_status_path(path: Path) -> Optional[LinkedinAuthStatus]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return None
        defaults = asdict(_default_auth_status())
        values = {key: raw.get(key, defaults[key]) for key in defaults}
        return LinkedinAuthStatus(**values)
    except Exception:
        return None


def read_auth_status() -> LinkedinAuthStatus:
    """Read the non-secret auth status sidecar or return a safe default."""
    for candidate in (AUTH_STATUS_PATH, AUTH_STATUS_BACKUP_PATH):
        if candidate.exists():
            loaded = _read_status_path(candidate)
            if loaded is not None:
                return loaded

    if AUTH_STATUS_PATH.exists() or AUTH_STATUS_BACKUP_PATH.exists():
        return LinkedinAuthStatus(
            session_state="login_required",
            last_error="LinkedIn auth status file is unreadable. Reconnect LinkedIn from Settings.",
        )

    return _default_auth_status()


def write_auth_status(status: LinkedinAuthStatus) -> None:
    """Persist auth status using stable snake_case keys."""
    payload = _status_to_payload(status)
    tmp_path = AUTH_STATUS_PATH.with_suffix(".json.tmp")
    tmp_path.write_text(payload, encoding="utf-8")
    tmp_path.replace(AUTH_STATUS_PATH)
    AUTH_STATUS_BACKUP_PATH.write_text(payload, encoding="utf-8")


def update_auth_status(**updates) -> LinkedinAuthStatus:
    """Merge updates into the current auth status and persist them."""
    current = asdict(read_auth_status())
    for key, value in updates.items():
        if key not in current:
            raise KeyError(f"Unknown auth status field: {key}")
        current[key] = value
    status = LinkedinAuthStatus(**current)
    write_auth_status(status)
    return status


def _should_force_headless(requested_headless: bool) -> bool:
    """Keep local desktop sessions visible, but force headless mode in Linux containers."""
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


async def open_browser(headless: bool = True) -> Tuple[Playwright, Browser, BrowserContext]:
    """Start Playwright and return playwright, browser, and a context with saved cookies."""
    storage_state = str(AUTH_STATE_PATH) if AUTH_STATE_PATH.exists() else None
    playwright = await async_playwright().start()
    effective_headless = _should_force_headless(headless)
    browser = await playwright.chromium.launch(headless=effective_headless)
    context = await browser.new_context(storage_state=storage_state)
    return playwright, browser, context


async def save_storage_state(context: BrowserContext, path: Path = AUTH_STATE_PATH) -> None:
    """Persist cookies/session to disk after a successful login."""
    await context.storage_state(path=str(path))


async def is_logged_in(context: BrowserContext) -> bool:
    """Return True if the current context appears to be authenticated on LinkedIn."""
    page = await context.new_page()
    try:
        await page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=20_000)
        await page.wait_for_timeout(2_000)
        # Check if we're on the feed (authenticated) or redirected to login
        current_url = page.url
        is_authenticated = "/feed" in current_url and "/login" not in current_url
        return is_authenticated
    except Exception:
        return False
    finally:
        await page.close()


def require_auth_state() -> None:
    """Guard that auth.json exists."""
    if not AUTH_STATE_PATH.exists():
        raise FileNotFoundError(
            "LinkedIn auth is not configured. Open Settings, save your LinkedIn credentials, "
            "and re-login so the scraper can create a fresh session."
        )


async def shutdown(playwright: Playwright, browser: Browser) -> None:
    await browser.close()
    await playwright.stop()
