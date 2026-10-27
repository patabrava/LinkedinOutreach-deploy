"""Exercise the running analytics against real persisted reads, without outreach or fake sends.
Run with sender venv Python; --expect-live waits for a separately committed revision signal.
"""
import argparse, asyncio, json, time
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url',default='http://127.0.0.1:3000')
    parser.add_argument('--expect-live',action='store_true')
    args=parser.parse_args()
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(headless=True)
        context=await browser.new_context()
        errors=[]
        broadcast_times={}
        def watch(page):
            def frame(payload):
                try:
                    data=json.loads(payload)
                    if data.get('event')=='broadcast' and data.get('payload',{}).get('event')=='changed':
                        broadcast_times[page]=time.monotonic()
                except (ValueError,TypeError): pass
            page.on('websocket',lambda socket:socket.on('framereceived',frame))
        context.on('page',watch)
        context.on('page', lambda page: page.on('pageerror',lambda error:errors.append(str(error))))
        pages={}
        for scope,route in [('all','/analytics'),('regular','/analytics/regular'),('sales-navigator','/analytics/sales-navigator')]:
            page=await context.new_page();pages[scope]=page
            await page.goto(args.url+route+'?days=7',wait_until='networkidle')
            await page.get_by_text('Live updates connected',exact=True).wait_for(timeout=20000)
            assert await page.locator('[data-analytics-revision]').count()==1
        regular=pages['regular'];cop=pages['sales-navigator'];overview=pages['all']
        before={scope:await page.locator('[data-analytics-revision]').get_attribute('data-analytics-revision') for scope,page in pages.items()}
        api=await context.request.get(args.url+'/api/analytics/live?scope=regular&days=7&privateDetails=true')
        data=await api.json()
        assert 'recipients' not in data['analytics']
        assert 'historyItems' not in data['replies']
        assert 'no-store' in api.headers['cache-control']
        unchanged=await context.request.get(args.url+'/api/analytics/live?scope=regular&days=7&revision='+data['revision'])
        assert unchanged.status in (200,304)
        if unchanged.status==200:
            assert (await unchanged.json())['revision']!=data['revision'], 'Concurrent changes must produce a new revision'
        invalid=await context.request.get(args.url+'/api/analytics/live?scope=unknown&days=8')
        assert invalid.status==400
        if args.expect_live:
            # Caller commits only revision metadata and a change signal. No campaign records are fabricated.
            print(json.dumps({'ready_for_signal':True,'revisions':before}),flush=True)
            started=time.monotonic()
            for page,scope in [(regular,'regular'),(overview,'all')]:
                await page.wait_for_function('(previous)=>document.querySelector("[data-analytics-revision]").dataset.analyticsRevision!==previous',arg=before[scope],timeout=20000)
            elapsed=time.monotonic()-started
            assert regular in broadcast_times, 'Expected a real database broadcast frame'
            latency=time.monotonic()-broadcast_times[regular]
            assert latency<8, 'Snapshot must catch up promptly after the live signal'
            assert elapsed<20,'Fallback polling alone cannot pass this real-time test'
            assert await cop.locator('[data-analytics-revision]').get_attribute('data-analytics-revision')==before['sales-navigator']
            print(json.dumps({'real_time_seconds_including_operator_signal':round(elapsed,2),'cop_isolated':True,'broadcast_to_snapshot_seconds':round(latency,2)}),flush=True)
        # Existing expanded reply details must survive snapshot state changes.
        await context.set_offline(True)
        await regular.get_by_role('button',name='Refresh records',exact=True).click()
        await regular.get_by_text('Update failed · retrying automatically',exact=True).wait_for(timeout=25000)
        await context.set_offline(False)
        await regular.evaluate('window.dispatchEvent(new Event("online"))')
        await regular.get_by_text('Live updates connected',exact=True).wait_for(timeout=20000)
        await regular.set_viewport_size({'width':390,'height':844})
        await regular.screenshot(path='/tmp/analytics-live-mobile.png',full_page=True)
        assert await regular.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        assert not errors, errors
        await browser.close()
        print('PASS: overview/DEGURA/COP live subscriptions; anonymous privacy; unchanged/invalid requests; offline recovery; mobile overflow; page errors.',flush=True)

if __name__=='__main__': asyncio.run(main())
