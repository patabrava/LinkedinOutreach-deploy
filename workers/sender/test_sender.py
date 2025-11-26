#!/usr/bin/env python3
"""Diagnostic test for sender.py to verify button detection works."""

import asyncio
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from playwright.async_api import async_playwright
from shared_logger import get_logger

logger = get_logger("test-sender")


async def test_button_detection(profile_url: str):
    """Test button detection on a LinkedIn profile."""
    
    logger.info(f"Testing button detection on: {profile_url}")
    
    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(headless=False)
    context = await browser.new_context()
    page = await context.new_page()
    
    logger.info("Browser opened (testing without auth - you may need to log in manually)")
    
    try:
        # Navigate to profile
        logger.info(f"Navigating to {profile_url}")
        await page.goto(profile_url, wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(2_000)
        
        # Test 1: Check for lazy-column test ID
        logger.info("Test 1: Checking for lazy-column test ID")
        try:
            lazy_column = page.get_by_test_id("lazy-column")
            await lazy_column.wait_for(state="visible", timeout=5_000)
            logger.info("✓ lazy-column test ID found")
            profile_container = lazy_column
        except Exception as e:
            logger.warn(f"✗ lazy-column not found: {e}")
            # Try fallback
            try:
                profile_container = page.locator("main.scaffold-layout__main").first
                await profile_container.wait_for(state="visible", timeout=5_000)
                logger.info("✓ Using main.scaffold-layout__main as container")
            except Exception as e2:
                logger.error(f"✗ No profile container found: {e2}")
                profile_container = page
                logger.warn("Using page-level container (risky)")
        
        # Test 2: Check for Message link
        logger.info("Test 2: Checking for Message/Nachricht link")
        import re
        message_link = profile_container.get_by_role("link", name=re.compile(r"(Message|Nachricht)", re.I))
        message_count = await message_link.count()
        if message_count > 0:
            logger.info(f"✓ Found {message_count} Message link(s)")
        else:
            logger.info("✗ No Message link found (not in network)")
        
        # Test 3: Check for More/Mehr button
        logger.info("Test 3: Checking for More/Mehr button")
        more_button = profile_container.get_by_role("button", name=re.compile(r"(More|Mehr)", re.I))
        more_count = await more_button.count()
        if more_count > 0:
            logger.info(f"✓ Found {more_count} More/Mehr button(s)")
            
            # Try clicking it to see menu
            logger.info("Test 3a: Clicking More button to check menu")
            try:
                await more_button.first.click(timeout=5_000)
                await page.wait_for_timeout(500)
                
                # Check for Invite menuitem
                invite_menuitem = page.get_by_role("menuitem", name=re.compile(r"(Invite|Einladen|Connect|Vernetzen)", re.I))
                invite_count = await invite_menuitem.count()
                if invite_count > 0:
                    logger.info(f"✓ Found {invite_count} Invite/Connect menuitem(s)")
                else:
                    logger.warn("✗ No Invite menuitem found in More dropdown")
                
                # Close menu by pressing Escape
                await page.keyboard.press("Escape")
            except Exception as e:
                logger.error(f"✗ Failed to click More button: {e}")
        else:
            logger.warn("✗ No More/Mehr button found")
        
        # Take screenshot
        screenshot_path = "/tmp/sender_diagnosis.png"
        await page.screenshot(path=screenshot_path, full_page=True)
        logger.info(f"Screenshot saved to: {screenshot_path}")
        
        logger.info("\n=== DIAGNOSIS COMPLETE ===")
        logger.info("Press Enter to close browser...")
        input()
        
    finally:
        await browser.close()
        await playwright.stop()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_sender.py <linkedin_profile_url>")
        print("Example: python test_sender.py https://www.linkedin.com/in/john-doe")
        sys.exit(1)
    
    profile_url = sys.argv[1]
    asyncio.run(test_button_detection(profile_url))
