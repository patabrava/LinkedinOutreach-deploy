"""One explicit daily run; manual scheduler remains follow-up-only.

Run with workers/sender/venv/bin/python workers/daily_campaign.py --execute.
Without --execute, no campaign state or outbound action is changed.
"""
import argparse
import asyncio
import json
import os
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

SCOPES = ((30,7),(31,8),(32,9),(33,10))
ACCOUNTS = ('13f81aad-8a5d-4cad-b94d-15aecef6ee03','a4ecaa71-4297-4f19-b186-4b53a552e6a8')
STAGES = ('invite','first_message','nudge','cop_initial')


def berlin_day_start(now=None):
    now = now or datetime.now(timezone.utc)
    return now.astimezone(ZoneInfo('Europe/Berlin')).replace(hour=0,minute=0,second=0,microsecond=0).astimezone(timezone.utc).isoformat()


def in_scope(lead):
    return (lead.get('batch_id'),lead.get('sequence_id')) in SCOPES


def remaining_capacity(message_limit,invite_limit,invites,initials,followups):
    return {'messages':max(0,message_limit-initials-followups),'invites':max(0,invite_limit-invites)}


def invite_limit_signal(rows, now=None):
    now=now or datetime.now(timezone.utc)
    signals=[]; successes=[]
    for row in rows:
        for key,target in [('connection_sent_at',successes),('updated_at',signals)]:
            value=row.get(key)
            if not value: continue
            if key=='updated_at' and not re.search(r'weekly.*limit|wöchentlich.*limit',str(row.get('error_message') or ''),re.I): continue
            try: stamp=datetime.fromisoformat(value.replace('Z','+00:00'))
            except ValueError: continue
            if stamp.tzinfo and now-timedelta(days=7)<=stamp<=now: target.append(stamp)
    return bool(signals and (not successes or max(signals)>=max(successes)))


async def run_account(adapter, *, execute=False, stage_limit=1, stages=STAGES):
    acceptance_check = await adapter.reconcile_acceptances(execute)
    scan = await adapter.scan(execute)
    touched=set(); replied={r['lead_id'] for r in scan['replies']}
    report={'scan_complete':scan['complete'],'replies':scan['replies'], 'scan_blockers':scan['blocked'],
            'stages':{},'halted':False,'suggestions':[], 'acceptance_check':acceptance_check}
    for stage in stages:
        summary={'sent':0,'skipped':0,'outcomes':[]}
        report['stages'][stage]=summary
        for lead in adapter.candidates(stage):
            key=lead.get('lead_id') or lead['id']
            if key in touched or key in replied or key in scan['blocked']:
                summary['skipped']+=1; continue
            if stage=='nudge' and key not in scan['verified']:
                summary['skipped']+=1; continue
            if stage_limit and len(summary['outcomes'])>=stage_limit:
                summary['skipped']+=1; continue
            capacity=adapter.capacity()
            budget='invites' if stage=='invite' else 'messages'
            if not capacity[budget] or (stage=='cop_initial' and not capacity['invites']):
                summary['outcomes'].append({'lead_id':key,'status':capacity.get('invite_blocker','daily_limit') if budget=='invites' else 'daily_limit'}); break
            if not execute:
                summary['outcomes'].append({'lead_id':key,'status':'eligible_not_executed'}); continue
            # An attempt is reserved before browser interaction, including ambiguous outcomes.
            touched.add(key)
            status=await adapter.send(stage,lead)
            summary['outcomes'].append({'lead_id':key,'status':status})
            if status=='sent': summary['sent']+=1
            if status in {'unconfirmed','limit_reached','auth_challenge'}:
                report['halted']=True; break
        if report['halted']: break
    report['suggestions']=await adapter.suggestions(execute)
    return report


def campaign_report(report, leads):
    """Run outcomes versus current inventory; never imply an exhaustive inbox scan."""
    result={name:{'invites_sent':0,'first_messages_sent':0,'nudges_sent':0,'inmails_sent':0,
                  'replies_detected':0,'autoreplies_sent':0,'completed_sequences':0,'newly_accepted_leads':0,
                  'paused_leads':0,'handoff_leads':0,'suppressed_leads':0,
                  'not_yet_due_nudges':0,'skipped_or_blocked_attempts':0,'blockers':[]}
            for name in ('DEGURA A','DEGURA B','DEGURA C','COP')}
    names={7:'DEGURA A',8:'DEGURA B',9:'DEGURA C',10:'COP'}
    by_id={r['id']:r for r in leads if in_scope(r)}
    for row in by_id.values():
        group=result[names[row['sequence_id']]]
        group['paused_leads']+=bool(row.get('campaign_paused'))
        group['handoff_leads']+=bool(row.get('human_handoff_required'))
        group['suppressed_leads']+=bool(row.get('stop_reason'))
    fields={'invite':'invites_sent','first_message':'first_messages_sent','nudge':'nudges_sent','cop_initial':'inmails_sent'}
    for stage,summary in report.get('stages',{}).items():
        for outcome in summary['outcomes']:
            row=by_id.get(outcome.get('lead_id'))
            if not row: continue
            group=result[names[row['sequence_id']]]
            if outcome['status']=='sent':
                group[fields[stage]]+=1
                if stage=='nudge' and (row.get('sequence_step') or 0)>=3: group['completed_sequences']+=1
            else:
                group['skipped_or_blocked_attempts']+=1
                if outcome['status'] not in {'pending','eligible_not_executed'}: group['blockers'].append(outcome['status'])
    for reply in report.get('replies',[]):
        result[names[reply['campaign']]]['replies_detected']+=1
    for key,reason in report.get('scan_blockers',{}).items():
        if key in by_id: result[names[by_id[key]['sequence_id']]]['blockers'].append(reason)
    for group in result.values(): group['blockers']=sorted(set(group['blockers']))
    return result


async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute',action='store_true')
    parser.add_argument('--account-id',choices=ACCOUNTS)
    parser.add_argument('--stage-limit',type=int,default=1,help='Attempts per stage/account; 0 uses remaining quota')
    parser.add_argument('--scan-limit',type=int,default=0,help='Optional bounded scan; unscanned nudges stay blocked')
    parser.add_argument('--reconcile-only',action='store_true',help='Persist inbound/drafts without any outbound stage')
    parser.add_argument('--check-followups',action='store_true',help='Read-only ABC acceptance and due-queue check; never sends or writes campaign state')
    parser.add_argument('--followups-only',action='store_true',help='ABC acceptance-triggered first messages and due nudges only; excludes invitations and COP')
    parser.add_argument('--headed',action='store_true',help='Show the terminal-controlled browser during the run')
    parser.add_argument('--output',type=Path,default=Path('output/playwright/daily-campaign'))
    args=parser.parse_args()
    if args.stage_limit<0 or args.scan_limit<0: parser.error('limits must be nonnegative')
    if args.check_followups and args.execute: parser.error('--check-followups is read-only; use --followups-only --execute for sending')
    from daily_campaign_live import DailyAdapter
    args.output.mkdir(parents=True,exist_ok=True)
    run_id=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    results={'run_id':run_id,'execute':args.execute,'accounts':{}}
    for account in ([args.account_id] if args.account_id else ACCOUNTS):
        try:
            async with DailyAdapter(account,args.output/run_id,args.scan_limit,headed=args.headed) as adapter:
                if args.check_followups or args.followups_only:
                    adapter.leads=[lead for lead in adapter.leads if lead['sequence_id'] in (7,8,9)]
                    adapter.followups_only=True
                if args.check_followups:
                    check=await adapter.check_followups()
                    results['accounts'][account]={'check':check,'halted':not check['acceptance_check']['complete']}
                else:
                    stages=() if args.reconcile_only else (('first_message','nudge') if args.followups_only else STAGES)
                    results['accounts'][account]=await run_account(adapter,execute=args.execute,stage_limit=args.stage_limit,stages=stages)
                    results['accounts'][account]['campaigns']=adapter.report_inventory(results['accounts'][account])
        except Exception as exc:
            results['accounts'][account]={'halted':True,'blocker':type(exc).__name__+': '+str(exc)[:300]}
    # Report contains IDs for local reconciliation, never credentials; screenshot files remain private.
    target=args.output/(run_id+'.json')
    target.write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    os.chmod(target,0o600)
    print(json.dumps({'report':str(target.resolve()),'accounts':results['accounts']},ensure_ascii=False,default=str))
    return int(any(r.get('halted') for r in results['accounts'].values()))


if __name__=='__main__':
    raise SystemExit(asyncio.run(main()))
