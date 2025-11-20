"""Utilities for handling LinkedIn authentication state."""

from __future__ import annotations

from pathlib import Path
from typing import Tuple

from playwright.async_api import Browser, BrowserContext, Playwright, async_playwright

AUTH_STATE_PATH = Path(__file__).parent / "auth.json"


async def open_browser(headless: bool = True) -> Tuple[Playwright, Browser, BrowserContext]:
    """Start Playwright and return playwright, browser, and a context with saved cookies."""
    storage_state = str(AUTH_STATE_PATH) if AUTH_STATE_PATH.exists() else None
    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(headless=headless)
    context = await browser.new_context(storage_state=storage_state)
    return playwright, browser, context


async def save_storage_state(context: BrowserContext, path: Path = AUTH_STATE_PATH) -> None:
    """Persist cookies/session to disk after a successful login."""
    await context.storage_state(path=str(path))


def require_auth_state() -> None:
    """Guard that auth.json exists."""
    if not AUTH_STATE_PATH.exists():
        raise FileNotFoundError(
            f"Missing auth.json at {AUTH_STATE_PATH}. "
            "Login once via `playwright codegen --save-storage=auth.json "
            "https://www.linkedin.com/login`."
        )


async def shutdown(playwright: Playwright, browser: Browser) -> None:
    await browser.close()
    await playwright.stop()

