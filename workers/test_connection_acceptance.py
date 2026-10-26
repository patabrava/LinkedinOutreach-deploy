"""Acceptance discovery exercises the real DOM reader, including nested scrolling."""
import asyncio
import importlib
import importlib.util
import unittest


ACCOUNT = '13f81aad-8a5d-4cad-b94d-15aecef6ee03'


class ConnectionAcceptanceTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('workers.connection_acceptance'),
                             'live acceptance discovery must precede queue reporting')
        return importlib.import_module('workers.connection_acceptance')

    def lead(self, **changes):
        return dict(id='lead', linkedin_account_id=ACCOUNT, batch_id=30, sequence_id=7,
                    first_name='Elin', last_name='Würfel',
                    linkedin_url='https://www.linkedin.com/in/elin-w%c3%bcrfel/',
                    connection_sent_at='2026-09-15T10:00:00+00:00', sent_at=None,
                    **changes)

    def test_exact_url_middle_name_and_held_contacts_are_reported_independently_of_queue(self):
        m = self.module()
        cards = [{'name':'Elin Lisa Würfel','url':'https://www.linkedin.com/in/elin-w%C3%BCrfel/?x=1',
                  'card':'Elin Lisa Würfel\nAm 22. Oktober 2026 vernetzt'}]
        matched = m.match_connections(cards, [self.lead()], ACCOUNT)
        self.assertEqual(len(matched), 1)
        self.assertTrue(matched[0]['needs_first_message'])
        self.assertEqual(matched[0]['connected_on'], '2026-10-22')
        held = m.match_connections(cards, [self.lead(stop_reason='reply_received')], ACCOUNT)
        self.assertFalse(held[0]['needs_first_message'])
        self.assertEqual(held[0]['hold_reason'], 'reply_received')

    def test_cross_account_cop_wrong_url_and_wrong_name_never_establish_acceptance(self):
        m = self.module()
        card = {'name':'Wrong Person','url':self.lead()['linkedin_url'],
                'card':'Wrong Person\nAm 22. Oktober 2026 vernetzt'}
        self.assertEqual(m.match_connections([card], [self.lead()], ACCOUNT), [])
        card['name'] = 'Elin Würfel'
        other = self.lead(); other['linkedin_account_id'] = 'other'
        cop = self.lead(); cop.update(batch_id=33, sequence_id=10)
        self.assertEqual(m.match_connections([card], [other, cop], ACCOUNT), [])
        card['url'] = 'https://example.com/in/elin-würfel'
        self.assertEqual(m.match_connections([card], [self.lead()], ACCOUNT), [])

    def test_live_reader_scrolls_main_and_stops_only_after_invitation_cutoff(self):
        m = self.module()
        from playwright.async_api import async_playwright
        async def run():
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(headless=True)
                try:
                    page = await browser.new_page()
                    html = '''<div>Sortieren nach: Neu hinzugefügt</div>
                    <main style="height:220px;overflow-y:auto"><section style="height:450px">
                    <a href="https://www.linkedin.com/in/elin-w%C3%BCrfel/">Elin Lisa Würfel</a>
                    <p>Am 22. Oktober 2026 vernetzt</p></section></main>
                    <script>document.querySelector('main').onscroll=()=>{
                    if(document.querySelector('#older'))return;
                    document.querySelector('main').insertAdjacentHTML('beforeend',
                    '<section id="older"><a href="https://www.linkedin.com/in/old/">Older Contact</a><p>Am 14. September 2026 vernetzt</p></section>');};</script>'''
                    await page.route('https://www.linkedin.com/**', lambda route: route.fulfill(body=html, content_type='text/html; charset=utf-8'))
                    result = await m.scan_connections(page, [self.lead()], ACCOUNT, settle_ms=10)
                    self.assertTrue(result['complete'], result)
                    self.assertEqual(result['cutoff_date'], '2026-09-15')
                    self.assertEqual(result['scanned_connections'], 2)
                    self.assertEqual(result['accepted'][0]['lead_id'], 'lead')
                    # A short/stuck list without reaching the cutoff is explicitly incomplete.
                    await page.route('https://www.linkedin.com/**', lambda route: route.fulfill(body=html.split('<script>')[0], content_type='text/html; charset=utf-8'))
                    partial = await m.scan_connections(page, [self.lead()], ACCOUNT, max_scrolls=2, settle_ms=10)
                    self.assertFalse(partial['complete'])
                    self.assertEqual(partial['reason'], 'connections_coverage_incomplete')
                finally:
                    await browser.close()
        asyncio.run(run())

    def test_primary_profile_uses_own_heading_and_degree_not_sidebar(self):
        m = self.module()
        from playwright.async_api import async_playwright
        async def run():
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(headless=True)
                try:
                    page = await browser.new_page()
                    await page.route('https://www.linkedin.com/**', lambda route: route.fulfill(body='<main/>', content_type='text/html'))
                    await page.goto(self.lead()['linkedin_url'])
                    await page.set_content('<main><section><h2>Elin Lisa Würfel</h2><p>· 1.</p><a href="/messaging/">Nachricht</a></section><aside><h2>Other</h2></aside></main>')
                    container = await m.verified_primary_profile(page, self.lead())
                    self.assertIn('Elin Lisa Würfel', await container.inner_text())
                    # Current LinkedIn profiles nest the name ten parents below its own action.
                    nested = '<div>' * 9 + '<h2>Elin Lisa Würfel</h2>' + '</div>' * 9
                    await page.set_content('<main><section>' + nested + '<p>· 1.</p><a href="/messaging/">Nachricht</a></section><aside><h2>Other</h2></aside></main>')
                    container = await m.verified_primary_profile(page, self.lead())
                    self.assertEqual(await container.evaluate('e => e.tagName'), 'SECTION')
                    await page.set_content('<main><section><h2>Elin Lisa Würfel</h2><p>· 2.</p><a>Nachricht</a></section><aside><h2>Other</h2><p>· 1.</p></aside></main>')
                    with self.assertRaisesRegex(RuntimeError, 'connection_not_verified'):
                        await m.verified_primary_profile(page, self.lead())
                    await page.set_content('<main><h2>Wrong Person</h2><p>· 1.</p><aside>Elin Würfel</aside></main>')
                    with self.assertRaisesRegex(RuntimeError, 'profile_identity_mismatch'):
                        await m.verified_primary_profile(page, self.lead())
                finally:
                    await browser.close()
        asyncio.run(run())
