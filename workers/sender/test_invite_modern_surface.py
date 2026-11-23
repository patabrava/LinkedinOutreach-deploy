"""Regression for LinkedIn's roleless invitation overlay; never sends externally."""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parent))
import sender
from playwright.async_api import async_playwright


class ModernInviteSurfaceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(headless=True)
        self.page = await self.browser.new_page()
        await self.page.route('https://www.linkedin.com/in/test-person/', lambda route: route.fulfill(status=200, content_type='text/html; charset=utf-8', body='''
        <main><section><h2>Test Person</h2><a aria-label="Test Person als Kontakt einladen" href="/in/test-person/" onclick="event.preventDefault();document.getElementById('initial').hidden=false">Vernetzen</a></section>
        <aside><button aria-label="Other Person als Kontakt einladen" onclick="window.wrong=true">Vernetzen</button></aside></main>
        <div id="initial" hidden><p>Eine Nachricht zu Ihrer Einladung hinzufügen?</p><a href="#" onclick="event.preventDefault();document.getElementById('initial').hidden=true;document.getElementById('composer').hidden=false">Nachricht hinzufügen</a><button onclick="window.sent=true">Ohne Nachricht senden</button></div>
        <div role="dialog"><p>Unrelated overlay</p><button onclick="window.wrong=true">Senden</button></div>
        <div id="composer" hidden><p>Fügen Sie eine Nachricht hinzu.</p><div data-testid="ui-core-tiptap-text-editor-wrapper"><div contenteditable="true" role="textbox" aria-placeholder="Bsp.: Wir kennen einander von …"></div></div><div id="customInviteNoteCounterRef">0/300</div><button onclick="document.getElementById('composer').hidden=true">Abbrechen</button><button onclick="window.sent=true">Senden</button></div>
        '''))
        await self.page.goto('https://www.linkedin.com/in/test-person/')

    async def asyncTearDown(self):
        await self.browser.close()
        await self.playwright.stop()

    async def test_opens_primary_note_editor_and_checks_full_text_before_submit(self):
        with patch.object(sender, 'close_existing_chat_overlays', AsyncMock()), patch.object(sender, 'wiggle_mouse', AsyncMock()), patch.object(sender, 'random_pause', AsyncMock()):
            self.assertEqual(await sender.open_message_surface(self.page, invite_only=True), 'connect_note')
            def hold():
                raise sender.CampaignControlHeld('test_hold_before_send')
            with self.assertRaises(sender.CampaignControlHeld):
                await sender.send_message(self.page, 'Hallo Test, eine Nachricht.', 'connect_note', before_send=hold)
        self.assertEqual(await self.page.locator('#composer [role=textbox]').inner_text(), 'Hallo Test, eine Nachricht.')
        self.assertFalse(await self.page.evaluate('Boolean(window.sent || window.wrong)'))

    async def test_disabled_send_never_runs_submit_hook(self):
        with patch.object(sender, 'close_existing_chat_overlays', AsyncMock()), patch.object(sender, 'wiggle_mouse', AsyncMock()), patch.object(sender, 'random_pause', AsyncMock()):
            await sender.open_message_surface(self.page, invite_only=True)
            await self.page.locator('#composer button').last.evaluate('(e) => e.disabled = true')
            hook = AsyncMock()
            with patch.object(sender, 'daily_before_submit', hook):
                with self.assertRaises(sender.CampaignControlHeld):
                    await sender.send_message(self.page, 'Hallo Test.', 'connect_note')
            hook.assert_not_awaited()
        self.assertFalse(await self.page.evaluate('Boolean(window.sent || window.wrong)'))
