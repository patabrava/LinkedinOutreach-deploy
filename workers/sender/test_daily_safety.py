import sys
import unittest
from pathlib import Path
from datetime import datetime,timezone
sys.path.insert(0,str(Path(__file__).parent))
import sender


class DailySafetyTests(unittest.TestCase):
    def test_stale_overlay_cleanup_executes_valid_javascript_and_closes_chat(self):
        import asyncio
        from playwright.async_api import async_playwright
        async def check():
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(headless=True)
                try:
                    page = await browser.new_page()
                    await page.set_content('''<div class="msg-overlay-conversation-bubble">
                    <button aria-label="Unterhaltung schließen" onclick="this.parentElement.remove()">×</button>
                    </div><button id="other">Keep unrelated action</button>''')
                    self.assertEqual(await sender.close_existing_chat_overlays(page), 1)
                    self.assertEqual(await page.locator('.msg-overlay-conversation-bubble').count(), 0)
                    self.assertEqual(await page.locator('#other').count(), 1)
                finally:
                    await browser.close()
        asyncio.run(check())

    def test_sender_berlin_quota_boundary(self):
        from unittest.mock import patch
        with patch.object(sender,'datetime') as clock:
            clock.now.return_value=datetime(2026,10,3,0,30,tzinfo=timezone.utc)
            clock.utcnow.return_value=datetime(2026,10,3,0,30)
            clock.combine.side_effect=datetime.combine
            self.assertEqual(sender.today_utc_iso(),'2026-10-02T22:00:00+00:00')

    def test_managed_first_messages_cannot_switch_channel(self):
        guard=getattr(sender,'require_first_message_channel',None)
        self.assertTrue(callable(guard),'missing direct-message-only guard')
        lead={'batch_id':30,'sequence_id':7}
        with self.assertRaisesRegex(RuntimeError,'direct_message_required'):
            guard(lead,sender.SURFACE_SALES_NAVIGATOR)
        guard(lead,sender.SURFACE_MESSAGE)

    def test_daily_postsend_requires_own_sender_even_with_exact_text(self):
        import asyncio
        from unittest.mock import AsyncMock, patch
        page=AsyncMock()
        bubble={'text':'Exact approved content','sender':'Recipient','is_outbound':False}
        async def check():
            with patch.object(sender,'DAILY_BEFORE_SUBMIT',object()), patch.object(sender,'extract_last_bubble',AsyncMock(return_value=bubble)):
                with self.assertRaises(sender.PostSendVerificationError):
                    await sender.verify_latest_outbound_message(page,'Exact approved content',timeout_ms=10)
        asyncio.run(check())
