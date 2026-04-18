"""Utilities for handling LinkedIn authentication state."""

from __future__ import annotations

import datetime
import json
from dataclasses import asdict, dataclass
import os
from pathlib import Path
import shutil
import sys
from typing import Literal, Optional, Tuple

from playwright.async_api import Browser, BrowserContext, Playwright, TimeoutError, async_playwright

__all__ = [
    "AUTH_STATUS_PATH",
    "AUTH_STATE_PATH",
    "REMOTE_BROWSER_CDP_URL",
    "REMOTE_BROWSER_PROFILE_DIR",
    "LinkedinAuthStatus",
    "read_auth_status",
    "write_auth_status",
    "update_auth_status",
    "open_browser",
    "connect_remote_browser",
    "disconnect_remote_browser",
    "save_storage_state",
    "is_logged_in",
    "sync_remote_session_to_auth",
    "reset_remote_login_state",
    "require_auth_state",
    "shutdown",
]

def _resolve_auth_dir() -> Path:
    """Prefer the mounted runtime volume, then fall back to the repo-local worker dir."""
    candidates = [
        os.getenv("LINKEDIN_SCRAPER_DIR", "").strip(),
        "/data/scraper",
        str(Path(__file__).parent),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate).expanduser()
        if path.exists():
            return path.resolve()
    return Path(__file__).parent.resolve()


AUTH_DIR = _resolve_auth_dir()
AUTH_STATE_PATH = AUTH_DIR / "auth.json"
AUTH_STATUS_PATH = AUTH_DIR / "auth_status.json"
AUTH_STATUS_BACKUP_PATH = AUTH_DIR / "auth_status.json.bak"
REMOTE_BROWSER_CDP_URL = os.getenv("LINKEDIN_BROWSER_CDP_URL", "http://linkedin-browser:9222")
REMOTE_BROWSER_PROFILE_DIR = AUTH_DIR / "interactive-profile"


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


@dataclass
class RemoteSessionResetResult:
    auth_state_cleared: bool
    profile_dir_cleared: bool
    remote_browser_reachable: bool


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


def _now_iso_utc() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _resolve_credentials_saved(explicit: Optional[bool]) -> bool:
    if explicit is None:
        return read_auth_status().credentials_saved
    return explicit


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


async def connect_remote_browser() -> Tuple[Playwright, Browser, BrowserContext]:
    """Attach to the shared remote Chromium instance over CDP."""
    playwright = await async_playwright().start()
    browser = await playwright.chromium.connect_over_cdp(REMOTE_BROWSER_CDP_URL)
    context = browser.contexts[0] if browser.contexts else await browser.new_context()
    return playwright, browser, context


async def disconnect_remote_browser(playwright: Playwright) -> None:
    """Disconnect from the remote browser without shutting the container browser down."""
    await playwright.stop()


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


async def sync_remote_session_to_auth(credentials_saved: Optional[bool] = None) -> None:
    """Export the authenticated remote browser session into the shared auth.json."""
    playwright, browser, context = await connect_remote_browser()
    try:
        has_credentials = _resolve_credentials_saved(credentials_saved)
        if not await is_logged_in(context):
            update_auth_status(
                credentials_saved=has_credentials,
                session_state="login_required",
                auth_file_present=AUTH_STATE_PATH.exists(),
                last_login_attempt_at=_now_iso_utc(),
                last_login_result="failed",
                last_error="Remote browser is open, but LinkedIn is not logged in yet.",
            )
            raise RuntimeError("Remote LinkedIn browser is not authenticated yet.")

        await save_storage_state(context, path=AUTH_STATE_PATH)
        update_auth_status(
            credentials_saved=has_credentials,
            session_state="session_active",
            auth_file_present=True,
            last_verified_at=_now_iso_utc(),
            last_login_result="success",
            last_error=None,
        )
    finally:
        del browser
        await disconnect_remote_browser(playwright)


async def reset_remote_login_state(credentials_saved: Optional[bool] = None) -> RemoteSessionResetResult:
    """Clear exported auth and only clear the remote profile when the remote browser is offline."""
    remote_browser_reachable = False
    try:
        playwright, browser, _context = await connect_remote_browser()
        remote_browser_reachable = True
        del browser
        await disconnect_remote_browser(playwright)
    except Exception:
        remote_browser_reachable = False

    auth_state_cleared = False
    for target in (AUTH_STATE_PATH,):
        try:
            existed = target.exists()
            target.unlink(missing_ok=True)
            auth_state_cleared = auth_state_cleared or existed
        except Exception:
            pass

    profile_dir_cleared = False
    if not remote_browser_reachable:
        shutil.rmtree(REMOTE_BROWSER_PROFILE_DIR, ignore_errors=True)
        profile_dir_cleared = not REMOTE_BROWSER_PROFILE_DIR.exists()

    has_credentials = _resolve_credentials_saved(credentials_saved)
    update_auth_status(
        credentials_saved=has_credentials,
        session_state="login_required" if has_credentials else "no_credentials",
        auth_file_present=AUTH_STATE_PATH.exists(),
        last_login_attempt_at=_now_iso_utc(),
        last_login_result="verification_required" if has_credentials else "failed",
        last_error=(
            "Remote browser is still running, so only auth.json was cleared. Restart the linkedin-browser service to fully reset the interactive LinkedIn session."
            if remote_browser_reachable
            else "Remote browser auth artifacts were cleared. Open the remote LinkedIn browser from Settings and sign in again."
        ),
    )
    return RemoteSessionResetResult(
        auth_state_cleared=auth_state_cleared,
        profile_dir_cleared=profile_dir_cleared,
        remote_browser_reachable=remote_browser_reachable,
    )


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
