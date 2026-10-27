"""Live adapters for the scoped daily campaign contract; no generated outreach copy."""
import asyncio
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

try:
    from .daily_campaign import ACCOUNTS, SCOPES, berlin_day_start, in_scope, remaining_capacity, invite_limit_signal, campaign_report
    from .connection_acceptance import scan_connections, acceptance_hold, scoped_leads
except ImportError:
    from daily_campaign import ACCOUNTS, SCOPES, berlin_day_start, in_scope, remaining_capacity, invite_limit_signal, campaign_report
    from connection_acceptance import scan_connections, acceptance_hold, scoped_leads

ROOT=Path(__file__).resolve().parents[1]


def paginated(query, size=500):
    result=[]; offset=0
    while True:
        response=query.range(offset,offset+size-1).execute()
        if getattr(response,'error',None) or not isinstance(response.data,list):
            raise RuntimeError('database_read_failed')
        result.extend(response.data)
        if len(response.data)<size: return result
        offset+=size


def sales_identity(url):
    match=re.search(r'/sales/(?:lead|people)/([^,/?]+)',str(url or ''))
    return match.group(1) if match else ''


def sales_tail(body, full_name):
    """Parse only the opened conversation, not inbox-card previews."""
    marker='Empfängerinformationen\n'+full_name
    if marker not in body and 'Recipient information\n'+full_name not in body:
        raise RuntimeError('sales_recipient_panel_mismatch')
    end=body.find('Datei anhängen')
    if end<0: end=body.find('Attach file')
    if end<0: raise RuntimeError('sales_conversation_boundary_missing')
    # Thread sender headers carry a time; card previews do not have this header order.
    events=list(re.finditer(r'(?:^|\n)(Sie|You|'+re.escape(full_name)+r')\s+(\d{1,2}:\d{2})(?:\s*\n)',body[:end]))
    if not events: raise RuntimeError('sales_latest_sender_ambiguous')
    event=events[-1]
    text=body[event.end():end].strip()
    text=re.sub(r'^(?:Hat Ihre InMail angenommen|Accepted your InMail)\s*','',text).strip()
    if not text: raise RuntimeError('sales_empty_bubble')
    return {'sender':event.group(1),'text':text,'is_outbound':event.group(1) in {'Sie','You'}}


class ReplyRenderer:
    """Compile and call the existing exact TypeScript renderer; never duplicate copy."""
    def __init__(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='daily-replies-')
        compiler=ROOT/'node_modules/.bin/tsc'
        subprocess.run([str(compiler),str(ROOT/'apps/web/lib/deguraCampaign.ts'),
                        '--target','ES2020','--module','commonjs','--skipLibCheck',
                        '--outDir',self.tmp.name],check=True,capture_output=True)
        self.module=next(Path(self.tmp.name).rglob('deguraCampaign.js'))
    def render(self,payload):
        code='const fs=require("fs"); const m=require(process.argv[1]); process.stdout.write(m.buildDeguraReplyDraft(JSON.parse(fs.readFileSync(0,"utf8"))));'
        return subprocess.run(['node','-e',code,str(self.module)],input=json.dumps(payload),
                              text=True,check=True,capture_output=True).stdout
    def close(self): self.tmp.cleanup()


class DailyAdapter:
    def __init__(self,account,output,scan_limit=0,*,headed=False):
        if account not in ACCOUNTS: raise ValueError('unsupported_account')
        self.account=account; self.output=output/account; self.scan_limit=scan_limit
        self.headed=headed
        self.context=None; self.browser=None; self.playwright=None; self.renderer=None; self.lock=None
        self.stage='preflight'; self.lead=None; self.attempted=False; self.counter=0
        self.seen_replies=[]; self.leads=[]; self.blocked={}; self.scan_verified=set()
        self.accepted_ids=set(); self.followups_only=False

    async def __aenter__(self):
        try: return await self.open()
        except BaseException:
            await self.__aexit__()
            raise

    async def open(self):
        sys.path.insert(0,str(ROOT/'workers/sender'))
        import sender
        import scraper
        self.sender=sender; self.scraper=scraper
        self.client=sender.get_supabase_client()
        sender.configure_runtime_account(self.client,self.account)
        scraper.configure_runtime_account(self.account)
        folder=sender.AUTH_STATE_PATH.parent
        folder.mkdir(parents=True,exist_ok=True)
        self.lock=open(folder/'daily_campaign.lock','a')
        try: fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise RuntimeError('account_daily_run_already_active')
        for pidfile in folder.glob('*.pid'):
            raw=pidfile.read_text().strip()
            if raw.isdigit():
                try: os.kill(int(raw),0)
                except ProcessLookupError: continue
                raise RuntimeError('account_worker_already_active')
        if not sender.AUTH_STATE_PATH.exists(): raise RuntimeError('saved_account_session_missing')
        self.output.mkdir(parents=True,exist_ok=True)
        self.playwright,self.browser,self.context=await sender.open_browser(headless=not self.headed)
        page=await self.context.new_page()
        await page.goto('https://www.linkedin.com/feed/',wait_until='domcontentloaded',timeout=60000)
        await page.wait_for_timeout(4000)
        body=await page.locator('body').inner_text()
        if '/login' in page.url or '/checkpoint' in page.url: raise RuntimeError('auth_challenge')
        if scraper.normalize_person_name(sender.CURRENT_ACCOUNT_DISPLAY_NAME) not in scraper.normalize_person_name(body):
            raise RuntimeError('saved_session_account_identity_mismatch')
        await self.capture(page,'account-identity')
        await page.close()
        self.leads=[r for r in paginated(self.client.table('leads').select('*').eq('linkedin_account_id',self.account).order('id')) if in_scope(r)]
        self.renderer=ReplyRenderer()
        self.original_hook=getattr(sender,'DAILY_BEFORE_SUBMIT',None)
        sender.DAILY_BEFORE_SUBMIT=self.before_submit
        return self

    async def __aexit__(self,*_args):
        if hasattr(self,'original_hook'): self.sender.DAILY_BEFORE_SUBMIT=self.original_hook
        if self.context:
            for page in self.context.pages:
                try: await self.capture(page,'final-surface')
                except Exception: pass
        if self.browser: await self.browser.close()
        if self.playwright: await self.playwright.stop()
        if self.renderer: self.renderer.close()
        if self.lock: self.lock.close()

    async def capture(self,page,label):
        self.counter+=1
        filename=self.output/f'{self.counter:04d}-{self.stage}-{label}.png'
        await page.screenshot(path=str(filename),full_page=True)
        os.chmod(filename,0o600)
        return str(filename.resolve())

    def capacity(self):
        s=self.sender
        capacity=remaining_capacity(s.CURRENT_DAILY_MESSAGE_LIMIT,s.CURRENT_DAILY_INVITE_LIMIT,
                                  s.connect_only_sent_today_count(self.client),
                                  s.sent_today_count(self.client),s.followups_sent_today_count(self.client))
        rows=paginated(self.client.table('leads').select('error_message,updated_at,connection_sent_at')
                       .eq('linkedin_account_id',self.account).order('id'))
        if invite_limit_signal(rows):
            capacity['invites']=0
            capacity['invite_blocker']='recent_weekly_invite_limit'
        return capacity

    def report_inventory(self,report):
        leads=paginated(self.client.table('leads').select('*').eq('linkedin_account_id',self.account).order('id'))
        result=campaign_report(report,leads)
        by_id={r['id']:r for r in leads if in_scope(r)}
        rows=paginated(self.client.table('followups').select('*').eq('linkedin_account_id',self.account)
                       .eq('status','APPROVED').eq('followup_type','NUDGE').order('id'))
        names={7:'DEGURA A',8:'DEGURA B',9:'DEGURA C',10:'COP'}
        original={r['id']:r for r in self.leads}
        for lead in by_id.values():
            if lead.get('connection_accepted_at') and not original.get(lead['id'],{}).get('connection_accepted_at'):
                result[names[lead['sequence_id']]]['newly_accepted_leads']+=1
        for row in rows:
            lead=by_id.get(row['lead_id'])
            if lead and row.get('next_send_at') and not self.sender._followup_is_due(row,datetime.now(timezone.utc)):
                result[names[lead['sequence_id']]]['not_yet_due_nudges']+=1
        return result

    async def reconcile_acceptances(self,execute=False):
        self.stage='acceptance'
        page=await self.context.new_page()
        try:
            report=await scan_connections(page,self.leads,self.account)
            report['screenshot']=await self.capture(page,'connections-coverage')
        finally:
            await page.close()
        self.accepted_ids={item['lead_id'] for item in report['accepted']}
        if execute:
            observed_at=datetime.now(timezone.utc).isoformat()
            for item in report['accepted']:
                if not item['acceptance_recorded']:
                    # Acceptance time means first verified observation, not an invented time of day.
                    self.client.table('leads').update({'connection_accepted_at':observed_at}).eq(
                        'id',item['lead_id']).eq('linkedin_account_id',self.account).is_(
                        'connection_accepted_at','null').execute()
        known=self.accepted_ids | {lead['id'] for lead in scoped_leads(self.leads,self.account)
                                  if lead.get('connection_accepted_at')}
        backlog=[lead for lead in scoped_leads(self.leads,self.account)
                 if lead['id'] in known and not lead.get('sent_at')]
        report['accepted_without_first_message']=[{
            'lead_id':lead['id'],'name':self.sender.lead_display_name(lead),
            'sequence_id':lead['sequence_id'],'hold_reason':acceptance_hold(lead),
            'acceptance_source':'live_connection' if lead['id'] in self.accepted_ids else 'stored_acceptance',
            'requires_live_thread_check':True
        } for lead in backlog]
        report['needs_first_message']=sum(not acceptance_hold(lead) for lead in backlog)
        report['held_first_messages']=sum(bool(acceptance_hold(lead)) for lead in backlog)
        return report

    async def check_followups(self):
        """Queue counts cannot stand in for a live acceptance check."""
        acceptance=await self.reconcile_acceptances(False)
        by_id={lead['id']:lead for lead in scoped_leads(self.leads,self.account)}
        rows=paginated(self.client.table('followups').select('*').eq('linkedin_account_id',self.account)
                       .in_('status',['APPROVED','RETRY_LATER','PROCESSING']).order('id'))
        due=[{'followup_id':row['id'],'lead_id':row['lead_id'],
              'name':self.sender.lead_display_name(by_id[row['lead_id']]),
              'sequence_id':by_id[row['lead_id']]['sequence_id'],'status':row['status'],
              'hold_reason':acceptance_hold(by_id[row['lead_id']]),'next_send_at':row.get('next_send_at')}
             for row in rows if row['lead_id'] in by_id and row.get('followup_type')=='NUDGE'
             and self.sender._followup_is_due(row,datetime.now(timezone.utc))]
        return {'acceptance_check':acceptance,'due_nudges':due,
                'approved_due_nudges':sum(row['status']=='APPROVED' for row in due),
                'outbound_submits':0,'campaign_state_writes':0}

    async def persist_reply(self,lead,bubble,execute):
        fingerprint=hashlib.sha256(bubble['text'].encode()).hexdigest()
        item={'lead_id':lead['id'],'campaign':lead['sequence_id'],'name':self.sender.lead_display_name(lead),
              'fingerprint':fingerprint,'route':'cop_human_handling' if lead['sequence_id']==10 else None}
        if execute:
            self.scraper.cancel_active_nudges_for_reply(self.client,lead['id'])
            existing=paginated(self.client.table('followups').select('id,reply_id,last_message_text,status')
                               .eq('lead_id',lead['id']).eq('linkedin_account_id',self.account).eq('followup_type','REPLY'))
            if not any(r.get('reply_id')==fingerprint or r.get('last_message_text')==bubble['text'][:2000] for r in existing):
                self.scraper.upsert_followup_for_reply(self.client,lead['id'],fingerprint,bubble['text'],
                    datetime.now(timezone.utc).isoformat(),last_message_text=bubble['text'],last_message_from='lead')
        self.seen_replies.append(item)
        return item

    async def scan(self,execute):
        self.stage='inbox'
        pending=[r for r in self.leads if r.get('sent_at') or r.get('connection_sent_at') or r.get('last_reply_at') or r.get('status')=='SENT']
        direct=[r for r in pending if r['sequence_id']!=10 and (r.get('sent_at') or r.get('last_reply_at'))]
        if self.followups_only:
            due_ids={row['lead_id'] for row in self.candidates('nudge')}
            direct=[lead for lead in direct if lead['id'] in due_ids]
        # Oldest scan first, stable order; no offset is applied after Python filtering.
        direct.sort(key=lambda r:(r.get('last_inbox_scan_at') or '',r['id']))
        chosen=direct[:self.scan_limit] if self.scan_limit else direct
        page=await self.context.new_page()
        await self.scraper.navigate_to_inbox(page)
        await self.capture(page,'direct-inbox')
        for lead in chosen:
            try:
                info=await self.scraper.search_conversation_by_name(page,lead,self.sender.CURRENT_ACCOUNT_DISPLAY_NAME)
                # search already verifies the recipient header and own-account sender.
                if not info:
                    self.blocked[lead['id']]='direct_thread_not_verified'; continue
                sender=str(info.get('sender') or '').strip()
                if not sender and not info.get('is_outbound'):
                    self.blocked[lead['id']]='latest_sender_ambiguous'; continue
                verdict=self.sender.classify_last_sender(info,self.sender.lead_display_name(lead),lead.get('first_name') or '')
                if verdict=='unknown' and self.sender.sender_name_is_own_account(sender): verdict='us'
                if verdict=='unknown': self.blocked[lead['id']]='latest_sender_ambiguous'; continue
                self.scan_verified.add(lead['id'])
                await self.capture(page,'recipient-thread')
                if verdict=='lead': await self.persist_reply(lead,info,execute)
                if execute: self.scraper.update_inbox_scan_timestamp(self.client,lead['id'],datetime.now(timezone.utc).isoformat())
            except Exception as exc: self.blocked[lead['id']]=type(exc).__name__+':'+str(exc)[:100]
        await page.close()
        cop=[r for r in pending if r['sequence_id']==10]
        sales_complete=await self.scan_sales(cop,execute) if cop else True
        return {'verified':self.scan_verified,'blocked':self.blocked,'replies':self.seen_replies,
                'complete':len(chosen)==len(direct) and sales_complete and not self.blocked}

    async def scan_sales(self,leads,execute):
        page=await self.context.new_page()
        try:
            await page.goto('https://www.linkedin.com/sales/inbox/messages/',wait_until='domcontentloaded',timeout=60000)
            await page.wait_for_selector('a[href*="/sales/inbox/2-"]',timeout=30000)
            if await page.title()!='Inbox | Sales Navigator': raise RuntimeError('sales_inbox_unavailable')
            await self.capture(page,'sales-inbox')
            # Read thread links, loading the list until exhausted. Never use a DM fallback.
            exhausted=False
            for _ in range(100):
                more=page.get_by_role('button',name=re.compile(r'^(Weitere laden|Load more)$'))
                if not await more.count(): exhausted=True; break
                await more.click(); await page.wait_for_timeout(600)
            cards=await page.locator('a[href*="/sales/inbox/"]').evaluate_all('(els)=>els.map(e=>({name:(e.innerText||"").split("\\n")[0].trim(),href:e.href}))')
            selected=[]
            for card in cards:
                matches=[r for r in leads if self.scraper.normalize_person_name(self.sender.lead_display_name(r))==self.scraper.normalize_person_name(card['name'])]
                if len(matches)==1 and card['href'] not in [c['href'] for _,c in selected]: selected.append((matches[0],card))
            chosen=selected[:self.scan_limit] if self.scan_limit else selected
            for lead,card in chosen:
                try:
                    await page.goto(card['href'],wait_until='domcontentloaded',timeout=60000)
                    await page.wait_for_selector('a[href*="/sales/lead/"]',timeout=30000)
                    await page.wait_for_timeout(1500)
                    verification=(lead.get('profile_data') or {}).get('cop_employer_verification') or {}
                    expected=sales_identity(verification.get('inspected_sales_profile_url'))
                    # Both the stored public-profile mapping and live exact Sales lead anchor must agree.
                    if verification.get('profile_url','').rstrip('/')!=lead['linkedin_url'].rstrip('/') or not expected:
                        raise RuntimeError('sales_public_profile_mapping_missing')
                    anchors=await page.locator('a[href*="/sales/lead/"]').evaluate_all('(els)=>els.map(e=>({url:e.href,name:e.innerText.trim()}))')
                    full=self.sender.lead_display_name(lead)
                    if not any(sales_identity(a['url'])==expected and self.scraper.normalize_person_name(a['name'])==self.scraper.normalize_person_name(full) for a in anchors):
                        raise RuntimeError('sales_recipient_identity_mismatch')
                    bubble=sales_tail(await page.locator('body').inner_text(),full)
                    await self.capture(page,'sales-recipient-thread')
                    self.scan_verified.add(lead['id'])
                    if not bubble['is_outbound']: await self.persist_reply(lead,bubble,execute)
                    if execute: self.scraper.update_inbox_scan_timestamp(self.client,lead['id'],datetime.now(timezone.utc).isoformat())
                except Exception as exc: self.blocked[lead['id']]=type(exc).__name__+':'+str(exc)[:100]
            # Unlisted conversations are unverified, even if the visible list was exhausted.
            return exhausted and len(chosen)==len(leads)
        finally: await page.close()

    def candidates(self,stage):
        self.stage=stage
        leads=[r for r in paginated(self.client.table('leads').select('*').eq('linkedin_account_id',self.account).order('id')) if in_scope(r)]
        if stage=='nudge':
            by_id={r['id']:r for r in leads}
            rows=paginated(self.client.table('followups').select('*').eq('linkedin_account_id',self.account)
                           .eq('status','APPROVED').eq('followup_type','NUDGE').order('next_send_at'))
            now=datetime.now(timezone.utc)
            return [{**r,'lead':by_id[r['lead_id']]} for r in rows if r['lead_id'] in by_id
                    and r.get('next_send_at') and self.sender._followup_is_due(r,now)
                    and not by_id[r['lead_id']].get('campaign_paused')]
        rows=[]
        for lead in leads:
            if lead.get('campaign_paused') or lead.get('human_handoff_required') or lead.get('stop_reason'): continue
            if lead.get('sent_at'): continue
            cop=lead['sequence_id']==10
            if stage=='invite' and not cop and lead['status']=='NEW' and not lead.get('connection_sent_at'): rows.append(lead)
            if stage=='first_message' and not cop and (lead['id'] in self.accepted_ids or lead.get('connection_accepted_at')): rows.append(lead)
            if stage=='cop_initial' and cop and lead['status']=='NEW': rows.append(lead)
        rows.sort(key=lambda r:r.get('source_last_activity_at') or '',reverse=True)
        return rows

    async def before_submit(self,page):
        if self.attempted:
            raise self.sender.PostSendVerificationError('daily_run_refuses_second_submit_after_unconfirmed_click')
        await self.capture(page,'before-submit')
        if self.stage=='invite':
            # LinkedIn's newer profile layout uses h2 for the primary name.
            # Bind the first visible profile heading to the exact queued URL;
            # incidental names in recommendations cannot establish identity.
            headings=await page.locator('main h1:visible, main h2:visible').all_inner_texts()
            actual=urlsplit(page.url); expected=urlsplit(self.lead.get('linkedin_url') or '')
            profile_matches=(actual.scheme=='https' and actual.hostname in {'linkedin.com','www.linkedin.com'}
                             and expected.hostname in {'linkedin.com','www.linkedin.com'}
                             and unquote(actual.path).rstrip('/').casefold()==unquote(expected.path).rstrip('/').casefold()
                             and expected.path.startswith('/in/'))
            if not profile_matches or not headings or self.scraper.normalize_person_name(headings[0])!=self.scraper.normalize_person_name(self.sender.lead_display_name(self.lead)):
                raise self.sender.CampaignControlHeld('invite_recipient_header_mismatch')
        capacity=self.capacity()
        if not capacity['invites' if self.stage=='invite' else 'messages']:
            raise self.sender.CampaignControlHeld('daily_limit')
        if self.stage in {'first_message','nudge'}:
            if self.lead['sequence_id']==10:
                info=sales_tail(await page.locator('body').inner_text(),self.sender.lead_display_name(self.lead))
            else:
                editor,_=await self.sender.find_direct_message_editor(page)
                await self.sender.assert_direct_message_editor_matches_lead(page,editor,self.lead)
                info=await self.sender.extract_last_bubble(page)
            if self.stage=='nudge' and not info:
                raise self.sender.CampaignControlHeld('latest_sender_ambiguous')
        if self.stage=='first_message':
            self.sender.require_first_message_channel(self.lead,self.sender.SURFACE_MESSAGE)
            if info:
                verdict=self.sender.classify_last_sender(info,self.sender.lead_display_name(self.lead),self.lead.get('first_name') or '')
                if verdict=='unknown' and self.sender.sender_name_is_own_account(str(info.get('sender') or '').strip()):
                    verdict='us'
                if verdict=='lead':
                    await self.persist_reply(self.lead,info,True)
                    raise self.sender.CampaignControlHeld('reply_received')
                if verdict!='us' or (not info.get('sender') and not info.get('is_outbound')):
                    raise self.sender.CampaignControlHeld('latest_sender_ambiguous')
                expected=self.sender.load_sequence_messages(self.client,self.lead).get('first_message') or ''
                if expected and self.sender.typed_text_matches(info.get('text') or '',expected)[0]:
                    raise self.sender.CampaignControlHeld('first_touch_already_visible_requires_reconciliation')
        elif self.stage=='nudge':
            verdict=self.sender.classify_last_sender(info,self.sender.lead_display_name(self.lead),self.lead.get('first_name') or '')
            if verdict=='unknown' and self.sender.sender_name_is_own_account(str(info.get('sender') or '').strip()):
                verdict='us'
            if verdict=='lead':
                await self.persist_reply(self.lead,info,True)
                raise self.sender.CampaignControlHeld('reply_received')
            if verdict!='us' or (not info.get('sender') and not info.get('is_outbound')):
                raise self.sender.CampaignControlHeld('latest_sender_ambiguous')
        self.attempted=True

    async def send(self,stage,row):
        self.stage=stage; self.lead=row.get('lead') or row; self.attempted=False
        if stage=='cop_initial':
            # The manual COP adapter sends an invitation first and persists the
            # InMail before full-bubble verification. It cannot satisfy this run's
            # InMail-only/verified-send contract; never invoke it as a substitute.
            return 'blocked:cop_initial_manual_invite_flow_requires_review'
        # Capture every worker-owned page immediately before it closes, including blocked surfaces.
        original_new=self.context.new_page
        async def new_page():
            page=await original_new(); original_close=page.close
            async def close(*args,**kwargs):
                await self.capture(page,'after-worker')
                return await original_close(*args,**kwargs)
            page.close=close
            return page
        self.context.new_page=new_page
        try:
            if stage=='invite':
                if not self.sender.mark_invite_processing(self.client,row['id']): return 'claim_conflict'
                result=await self.sender.process_invite_one(self.context,self.client,row)
            elif stage=='first_message':
                if not self.sender.mark_message_only_processing(self.client,row): return 'claim_conflict'
                result=await self.sender.process_message_only_one(self.context,self.client,row)
            elif stage=='nudge':
                claimed=self.sender.claim_followup(self.client,row,self.account)
                if not claimed: return 'claim_conflict'
                claimed['lead']=row['lead']
                result=await self.sender.process_followup_one(self.context,self.client,claimed)
            else:
                result=await self.sender.process_inmail_and_invite_one(self.context,self.client,row)
            if self.attempted and result!='sent':
                self.quarantine_unconfirmed()
                return 'unconfirmed'
            if stage=='first_message' and result=='paused' and not self.attempted:
                self.client.table('leads').update({'status':'CONNECT_ONLY_SENT'}).eq('id',row['id']).eq(
                    'linkedin_account_id',self.account).eq('status','PROCESSING').is_('sent_at','null').execute()
            return result
        except Exception as exc:
            if self.attempted:
                self.quarantine_unconfirmed()
                return 'unconfirmed'
            return 'blocked:'+type(exc).__name__+':'+str(exc)[:120]
        finally: self.context.new_page=original_new

    def quarantine_unconfirmed(self):
        self.client.table('leads').update({'human_handoff_required':True,
            'human_handoff_reason':'outbound_unconfirmed_requires_live_reconciliation'}).eq('id',self.lead['id']).eq('linkedin_account_id',self.account).execute()
        self.scraper.cancel_active_nudges_for_reply(self.client,self.lead['id'])

    async def suggestions(self,execute):
        result=[]
        leads={r['id']:r for r in self.leads}
        rows=paginated(self.client.table('followups').select('*').eq('linkedin_account_id',self.account)
                       .eq('followup_type','REPLY').eq('status','PENDING_REVIEW').order('id'))
        for row in rows:
            lead=leads.get(row['lead_id'])
            if not lead: continue
            item={'lead_id':lead['id'],'name':self.sender.lead_display_name(lead),'campaign':lead['sequence_id'],
                  'route':row.get('reply_route'),'requires_human':bool(row.get('requires_human'))}
            if lead['sequence_id']==10 or item['requires_human']:
                item['requires_human']=True; item['suggestion']=None
            else:
                seq=self.client.table('outreach_sequences').select('*').eq('id',lead['sequence_id']).single().execute().data
                variants=self.client.table('outreach_sequence_variants').select('variant_key').eq('id',lead['sequence_variant_id']).execute().data
                if not variants: item['blocker']='variant_missing'; result.append(item); continue
                draft=self.renderer.render({'campaignKey':seq['campaign_key'],'route':row.get('reply_route') or '',
                    'firstName':lead.get('first_name') or '', 'companyName':lead.get('company_name') or '',
                    'bookingUrl':seq.get('booking_url') or '', 'guideUrl':seq.get('guide_url') or '',
                    'variantKey':variants[0]['variant_key'],'sourceTouch':str(row.get('source_touch') or 'reply'),
                    'accountSlot':self.sender.CURRENT_ACCOUNT_BROWSER_SLOT})
                item['suggestion']=draft or None
                if execute and draft:
                    self.client.table('followups').update({'draft_text':draft}).eq('id',row['id']).eq('status','PENDING_REVIEW').execute()
            result.append(item)
        return result
