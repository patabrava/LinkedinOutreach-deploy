import sys
import unittest
from pathlib import Path
from datetime import datetime,timezone
sys.path.insert(0,str(Path(__file__).parent))
import sender


class DailySafetyTests(unittest.TestCase):
    def test_initial_receipt_preserves_exact_sent_body_and_failure_never_resends(self):
        from unittest.mock import MagicMock, patch
        lead = {'id': 'receipt-lead', 'sequence_id': 7, 'sequence_variant_id': 2}
        client = MagicMock()
        body = 'Hallo Ada,\n\nDetails https://example.org/?a=1&b=2\nViele Grüße'
        import tempfile
        folder = tempfile.TemporaryDirectory(); self.addCleanup(folder.cleanup)
        self.enterContext(patch.object(sender, 'AUTH_STATE_PATH', Path(folder.name) / 'auth.json'))
        with patch.object(sender, 'CURRENT_ACCOUNT_ID', 'sender-account'):
            sender.record_initial_message_receipt(client, lead, body, 'message', sent_at='2026-10-27T10:00:00Z')
        payload = client.table.return_value.insert.call_args.args[0]
        self.assertEqual(payload['metadata']['sent_text'], body)
        self.assertEqual(payload['metadata']['surface'], 'message')
        self.assertEqual(payload['linkedin_account_id'], 'sender-account')
        self.assertEqual(payload['sequence_variant_id'], 2)
        self.assertEqual(payload['occurred_at'], '2026-10-27T10:00:00Z')
        self.assertTrue(payload['metadata']['verified'])
        client.table.return_value.insert.return_value.execute.side_effect = RuntimeError('database offline')
        # Analytics failure cannot escape into the sender retry path after a verified submit.
        sender.record_initial_message_receipt(client, lead, body, 'message')

    def test_receipt_replay_keeps_original_timestamp_body_and_account(self):
        from unittest.mock import MagicMock, patch
        import tempfile, json
        client = MagicMock()
        lead = {'id':'receipt-lead','sequence_id':7,'sequence_variant_id':2}
        with tempfile.TemporaryDirectory() as folder, patch.object(sender, 'AUTH_STATE_PATH', Path(folder)/'auth.json'), patch.object(sender, 'CURRENT_ACCOUNT_ID', 'account-a'):
            client.table.return_value.insert.return_value.execute.side_effect = RuntimeError('offline')
            sender.record_initial_message_receipt(client, lead, 'Exact\nBody', 'message', sent_at='2026-10-27T01:00:00Z')
            pending = list((Path(folder)/'analytics-receipts').glob('*.json'))
            self.assertEqual(len(pending),1)
            self.assertEqual(pending[0].stat().st_mode & 0o777,0o600)
            with patch.object(sender, 'CURRENT_ACCOUNT_ID', 'account-b'):
                sender.reconcile_analytics_receipts(client)
            self.assertTrue(pending[0].exists())
            client.table.return_value.insert.return_value.execute.side_effect = None
            sender.reconcile_analytics_receipts(client)
            payload = client.table.return_value.insert.call_args.args[0]
            self.assertEqual(payload['occurred_at'],'2026-10-27T01:00:00Z')
            self.assertEqual(payload['metadata']['sent_text'],'Exact\nBody')
            self.assertFalse(pending[0].exists())

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
