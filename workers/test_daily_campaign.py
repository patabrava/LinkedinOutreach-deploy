import asyncio
import importlib.util
import unittest
from datetime import datetime, timezone


class DailyCampaignTests(unittest.TestCase):
    def test_bubble_reader_preserves_rendered_line_breaks_and_complete_url(self):
        from playwright.async_api import async_playwright
        from workers.thread_reader import extract_last_bubble
        async def check():
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(headless=True)
                try:
                    page = await browser.new_page()
                    await page.set_content('<li class="msg-s-message-list__event"><span class="msg-s-message-group__name">Katharina Hoffmann</span><p class="msg-s-event-listitem__body">Hello Laura.<br><br>Complete message.<br>https://example.com/?a=1&amp;b=2</p></li>')
                    self.assertEqual((await extract_last_bubble(page))['text'],
                                     'Hello Laura. Complete message. https://example.com/?a=1&b=2')
                finally:
                    await browser.close()
        asyncio.run(check())

    def test_acceptance_reconciliation_precedes_inbox_and_empty_queue(self):
        adapter = MemoryAdapter()
        adapter.candidates = lambda _stage: []
        result = asyncio.run(self.m.run_account(adapter, execute=False, stages=('nudge',)))
        self.assertEqual(adapter.calls[:2], ['acceptances', 'scan'])
        self.assertEqual(result['acceptance_check']['needs_first_message'], 12)
        self.assertEqual(result['stages']['nudge']['outcomes'], [])

    def test_first_message_guard_recognizes_named_own_sender_after_recipient_check(self):
        from workers.daily_campaign_live import DailyAdapter
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from pathlib import Path
        async def check():
            adapter = DailyAdapter('13f81aad-8a5d-4cad-b94d-15aecef6ee03', Path('/tmp'))
            adapter.stage = 'first_message'; adapter.lead = {'first_name':'Laura','sequence_id':7}
            adapter.capture = AsyncMock(); adapter.capacity = lambda: {'messages':1}
            adapter.sender = SimpleNamespace(PostSendVerificationError=RuntimeError, CampaignControlHeld=RuntimeError,
                SURFACE_MESSAGE='message', require_first_message_channel=lambda *args: None,
                find_direct_message_editor=AsyncMock(return_value=(object(),'')),
                assert_direct_message_editor_matches_lead=AsyncMock(),
                extract_last_bubble=AsyncMock(return_value={'sender':'Katharina Hoffmann','text':'Prior note','is_outbound':False}),
                classify_last_sender=lambda *args:'unknown', lead_display_name=lambda lead:'Laura Bayer',
                sender_name_is_own_account=lambda name:name=='Katharina Hoffmann',
                load_sequence_messages=lambda *args:{'first_message':'Approved next message'},
                typed_text_matches=lambda *args:(False, {}))
            adapter.client = object()
            await adapter.before_submit(object())
            self.assertTrue(adapter.attempted)
            adapter.sender.assert_direct_message_editor_matches_lead.assert_awaited_once()
            adapter.attempted = False
            adapter.sender.extract_last_bubble.return_value['sender'] = 'Unrelated Person'
            with self.assertRaisesRegex(RuntimeError,'latest_sender_ambiguous'):
                await adapter.before_submit(object())
            self.assertFalse(adapter.attempted)
        asyncio.run(check())
    def test_invite_recipient_supports_profile_h2_without_accepting_sidebar_names(self):
        from playwright.async_api import async_playwright
        from workers.daily_campaign_live import DailyAdapter
        from types import SimpleNamespace
        async def check():
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(headless=True)
                try:
                    page = await browser.new_page()
                    await page.route('https://www.linkedin.com/**', lambda route: route.fulfill(body='<main></main>', content_type='text/html'))
                    await page.goto('https://www.linkedin.com/in/melina-li%C3%9Fner-a9a299180/')
                    adapter = DailyAdapter('a4ecaa71-4297-4f19-b186-4b53a552e6a8', __import__('pathlib').Path('/tmp'))
                    adapter.stage = 'invite'
                    adapter.lead = {'first_name':'Melina','last_name':'Lißner','linkedin_url':'https://www.linkedin.com/in/melina-li%c3%9fner-a9a299180'}
                    adapter.sender = SimpleNamespace(PostSendVerificationError=RuntimeError, CampaignControlHeld=RuntimeError,
                        lead_display_name=lambda lead: 'Melina Lißner')
                    from workers.scraper.scraper import normalize_person_name
                    adapter.scraper = SimpleNamespace(normalize_person_name=normalize_person_name)
                    async def capture(*args): return ''
                    adapter.capture = capture
                    adapter.capacity = lambda: {'invites':1,'messages':1}
                    for tag in ('h1','h2'):
                        adapter.attempted = False
                        await page.set_content(f'<main><{tag}>Melina Lißner</{tag}><h2>Aktivitäten</h2></main>')
                        await adapter.before_submit(page)
                        self.assertTrue(adapter.attempted)
                    for content in ('<main><h2>Wrong Person</h2><aside><h2>Melina Lißner</h2></aside></main>',
                                    '<main><h2 hidden>Melina Lißner</h2><h2>Wrong Person</h2></main>',
                                    '<main></main>'):
                        adapter.attempted = False
                        await page.set_content(content)
                        with self.assertRaisesRegex(RuntimeError,'invite_recipient_header_mismatch'):
                            await adapter.before_submit(page)
                        self.assertFalse(adapter.attempted)
                    adapter.attempted = False
                    await page.goto('https://www.linkedin.com/in/wrong-profile/')
                    await page.set_content('<main><h2>Melina Lißner</h2></main>')
                    with self.assertRaisesRegex(RuntimeError,'invite_recipient_header_mismatch'):
                        await adapter.before_submit(page)
                    self.assertFalse(adapter.attempted)
                finally:
                    await browser.close()
        asyncio.run(check())

    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('workers.daily_campaign'), 'daily entry point missing')
        from workers import daily_campaign
        self.m = daily_campaign

    def test_berlin_midnight_and_dst(self):
        self.assertEqual(self.m.berlin_day_start(datetime(2026,10,3,0,30,tzinfo=timezone.utc)), '2026-10-02T22:00:00+00:00')
        self.assertEqual(self.m.berlin_day_start(datetime(2026,12,3,0,30,tzinfo=timezone.utc)), '2026-12-02T23:00:00+00:00')

    def test_exact_pairs_not_cross_product(self):
        self.assertTrue(self.m.in_scope({'batch_id':30,'sequence_id':7}))
        self.assertFalse(self.m.in_scope({'batch_id':30,'sequence_id':8}))

    def test_shared_message_capacity(self):
        self.assertEqual(self.m.remaining_capacity(50, 120, 3, 12, 39), {'messages':0,'invites':117})

    def test_report_preserves_campaign_partitions(self):
        report={'stages':{'first_message':{'outcomes':[{'lead_id':'a','status':'sent'}]},
                          'nudge':{'outcomes':[{'lead_id':'b','status':'sent'}]}},
                'replies':[{'lead_id':'c','campaign':10,'route':'cop_human_handling'}],
                'suggestions':[{'lead_id':'c','campaign':10,'requires_human':True}],
                'scan_blockers':{'a':'thread_mismatch'}}
        rows=[{'id':'a','sequence_id':7,'batch_id':30,'sequence_step':1},
              {'id':'b','sequence_id':8,'batch_id':31,'sequence_step':3},
              {'id':'c','sequence_id':10,'batch_id':33,'human_handoff_required':True}]
        result=self.m.campaign_report(report,rows)
        self.assertEqual(result['DEGURA A']['first_messages_sent'],1)
        self.assertEqual(result['DEGURA B']['completed_sequences'],1)
        self.assertEqual(result['COP']['replies_detected'],1)
        self.assertEqual(result['COP']['autoreplies_sent'],0)

    def test_inbound_first_and_one_outbound_per_lead(self):
        adapter = MemoryAdapter()
        result = asyncio.run(self.m.run_account(adapter, execute=True, stage_limit=1))
        self.assertEqual(adapter.calls[:2], ['acceptances', 'scan'])
        self.assertNotIn('replied', adapter.sent)
        self.assertEqual(adapter.sent.count('shared'), 1)
        self.assertEqual(result['stages']['invite']['sent'],1)
        self.assertEqual(result['stages']['nudge']['sent'],1)

    def test_no_implicit_execution(self):
        adapter = MemoryAdapter()
        asyncio.run(self.m.run_account(adapter, execute=False, stage_limit=1))
        self.assertEqual(adapter.sent, [])

    def test_partial_scan_does_not_clear_unscanned_nudges(self):
        adapter = MemoryAdapter()
        adapter.scan_result = {'verified':set(), 'blocked':{}, 'replies':[], 'complete':False}
        result = asyncio.run(self.m.run_account(adapter, execute=True, stage_limit=1))
        self.assertEqual(result['stages']['nudge']['sent'],0)
        self.assertFalse(result['scan_complete'])

    def test_unconfirmed_send_halts_account(self):
        adapter = MemoryAdapter()
        adapter.outcome = 'unconfirmed'
        result = asyncio.run(self.m.run_account(adapter, execute=True, stage_limit=1))
        self.assertTrue(result['halted'])
        self.assertEqual(len(adapter.sent),1)

    def test_sales_tail_ignores_inbox_preview_and_verifies_recipient(self):
        from workers.daily_campaign_live import sales_tail
        body='Other Lead\npreview\n13:56\nHenrik\nSie  10:55\nOwn message\nHenrik Schober-Oschmann  11:59\nHat Ihre InMail angenommen\nA question?\nDatei anhängen\nEmpfängerinformationen\nHenrik Schober-Oschmann\n'
        bubble=sales_tail(body,'Henrik Schober-Oschmann')
        self.assertEqual(bubble['text'],'A question?')
        self.assertFalse(bubble['is_outbound'])
        with self.assertRaisesRegex(RuntimeError,'recipient_panel_mismatch'):
            sales_tail(body,'Wrong Person')

    def test_sales_profile_identity_discards_search_context_only(self):
        from workers.daily_campaign_live import sales_identity
        self.assertEqual(sales_identity('https://www.linkedin.com/sales/lead/ACw123,NAME_SEARCH,abc'),'ACw123')
        self.assertEqual(sales_identity('https://www.linkedin.com/in/someone'),'')

    def test_recent_invite_limit_signal_needs_newer_confirmed_invite(self):
        gate=getattr(self.m,'invite_limit_signal',None)
        self.assertTrue(callable(gate),'missing quota-signal gate')
        now=datetime(2026,10,3,10,tzinfo=timezone.utc)
        rows=[{'error_message':'Probable LinkedIn weekly invite limit reached','updated_at':'2026-10-01T17:10:00+00:00'}]
        self.assertTrue(gate(rows,now))
        self.assertFalse(gate(rows+[{'connection_sent_at':'2026-10-02T17:10:00+00:00'}],now))

    def test_recipient_header_must_match_even_when_latest_bubble_is_ours(self):
        sys_path=__import__('sys').path
        from pathlib import Path
        sys_path.insert(0,str(Path(__file__).parent/'scraper'))
        import scraper
        guard=getattr(scraper,'verified_inbox_tail',None)
        self.assertTrue(callable(guard),'missing recipient header guard')
        lead={'first_name':'Barbara','last_name':'Panas-Stenzel'}
        bubble={'sender':'Sandra Molinero','text':'Own response','is_outbound':False}
        self.assertIsNone(guard('Other Person',bubble,lead,'Sandra Molinero'))
        self.assertTrue(guard('Barbara Panas-Stenzel',bubble,lead,'Sandra Molinero')['is_outbound'])


class MemoryAdapter:
    def __init__(self):
        self.calls=[]; self.sent=[]; self.outcome='sent'
        self.scan_result={'verified':{'shared','next','replied'}, 'blocked':{}, 'replies':[{'lead_id':'replied'}], 'complete':True}
    async def reconcile_acceptances(self, execute):
        self.calls.append('acceptances')
        return {'complete': True, 'needs_first_message': 12}
    async def scan(self, execute):
        self.calls.append('scan'); return self.scan_result
    def capacity(self):
        return {'messages':50,'invites':50}
    def candidates(self, stage):
        ids={'invite':['shared'],'first_message':['shared'],'nudge':['replied','shared','next'],'cop_initial':[]}
        return [{'id':x} for x in ids[stage]]
    async def send(self, stage, lead):
        self.calls.append(stage); self.sent.append(lead['id']); return self.outcome
    async def suggestions(self, execute):
        return []
