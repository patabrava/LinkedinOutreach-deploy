"""Account-scoped LinkedIn acceptance discovery; never submits outbound actions."""
import re
import unicodedata
from datetime import date, datetime
from urllib.parse import unquote, urlsplit

ABC_SCOPES = {(30, 7), (31, 8), (32, 9)}
MONTHS = {
    'januar': 1, 'january': 1, 'februar': 2, 'february': 2, 'märz': 3, 'march': 3,
    'april': 4, 'mai': 5, 'may': 5, 'juni': 6, 'june': 6, 'juli': 7, 'july': 7,
    'august': 8, 'september': 9, 'oktober': 10, 'october': 10,
    'november': 11, 'dezember': 12, 'december': 12,
}


def profile_key(url):
    parsed = urlsplit(str(url or ''))
    path = unquote(parsed.path).rstrip('/').casefold()
    if (parsed.scheme != 'https' or parsed.hostname not in {'linkedin.com', 'www.linkedin.com'}
            or not re.fullmatch(r'/in/[^/]+', path)):
        return ''
    return unicodedata.normalize('NFC', path)


def name_matches(name, lead):
    def tokens(value):
        value = unicodedata.normalize('NFKD', str(value or '').casefold())
        return re.findall(r'\w+', ''.join(c for c in value if not unicodedata.combining(c)))
    actual = tokens(name)
    first, last = tokens(lead.get('first_name')), tokens(lead.get('last_name'))
    # Exact URL is checked separately. Allow a middle name, never a different first/surname.
    return bool(first and last and actual[:len(first)] == first and actual[-len(last):] == last)


def connected_date(text):
    german = re.search(r'Am (\d{1,2})\. (\w+) (\d{4}) vernetzt', text or '', re.I)
    english = re.search(r'Connected on (\w+) (\d{1,2}),? (\d{4})', text or '', re.I)
    if german:
        day, month, year = german.groups()
    elif english:
        month, day, year = english.groups()
    else:
        return None
    try:
        return date(int(year), MONTHS[month.casefold()], int(day))
    except (KeyError, ValueError):
        return None


def acceptance_hold(lead):
    if lead.get('stop_reason'):
        return lead['stop_reason']
    if lead.get('last_reply_at'):
        return 'reply_received'
    if lead.get('human_handoff_required'):
        return 'human_handoff_required'
    if lead.get('campaign_paused'):
        return 'campaign_paused'
    if lead.get('sequence_stopped_at'):
        return 'sequence_stopped'
    return None


def scoped_leads(leads, account):
    return [lead for lead in leads if lead.get('linkedin_account_id') == account
            and (lead.get('batch_id'), lead.get('sequence_id')) in ABC_SCOPES]


def match_connections(cards, leads, account):
    by_url = {profile_key(lead.get('linkedin_url')): lead for lead in scoped_leads(leads, account)
              if profile_key(lead.get('linkedin_url'))}
    matched = {}
    for card in cards:
        key = profile_key(card.get('url'))
        lead = by_url.get(key)
        when = connected_date(card.get('card', ''))
        if not lead or not when or not name_matches(card.get('name'), lead):
            continue
        hold = acceptance_hold(lead)
        matched[lead['id']] = {
            'lead_id': lead['id'], 'name': card['name'], 'profile_url': card['url'],
            'sequence_id': lead['sequence_id'], 'connected_on': when.isoformat(),
            'acceptance_recorded': bool(lead.get('connection_accepted_at')),
            'first_message_sent': bool(lead.get('sent_at')), 'hold_reason': hold,
            'needs_first_message': not lead.get('sent_at') and not hold,
        }
    return list(matched.values())


async def scan_connections(page, leads, account, *, max_scrolls=200, settle_ms=1800):
    """Read visible cards through the earliest invite date, scrolling nested lists.

    A stalled/limited list is incomplete, never proof of no accepted contacts.
    Dates establish coverage only; persisted accepted timestamps are observation times.
    """
    leads = scoped_leads(leads, account)
    invitation_dates = [datetime.fromisoformat(lead['connection_sent_at'].replace('Z', '+00:00')).date()
                        for lead in leads if lead.get('connection_sent_at')]
    report = {'complete': False, 'reason': 'connections_coverage_incomplete',
              'scanned_connections': 0, 'cutoff_date': None, 'accepted': [], 'identity_conflicts': []}
    if not invitation_dates:
        report.update(complete=True, reason='no_campaign_invitations')
        return report
    cutoff = min(invitation_dates)
    report['cutoff_date'] = cutoff.isoformat()
    await page.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/',
                    wait_until='domcontentloaded', timeout=60000)
    await page.wait_for_selector('main', timeout=20000)
    await page.wait_for_timeout(settle_ms)
    if '/login' in page.url or '/checkpoint' in page.url:
        raise RuntimeError('acceptance_scan_auth_challenge')
    body = await page.locator('body').inner_text()
    if not re.search(r'(?:Sortieren nach:\s*Neu hinzugefügt|Sort by:\s*Recently added)', body, re.I):
        report['reason'] = 'connections_newest_first_not_verified'
        return report
    cards = {}
    stalled = 0
    for _ in range(max_scrolls):
        visible = await page.locator('main a[href*="/in/"]').evaluate_all(r'''elements =>
            elements.filter(e => e.innerText.trim()).map(e => {
                let parent = e;
                for (let depth = 0; depth < 7; depth++) {
                    if (/(?:Am .* vernetzt|Connected on)/.test(parent.innerText)) {
                        return {name:e.innerText.split('\n')[0].trim(),url:e.href,card:parent.innerText};
                    }
                    parent = parent.parentElement;
                    if (!parent || parent.tagName === 'MAIN') return null;
                }
                return null;
            }).filter(Boolean)''')
        previous = len(cards)
        for card in visible:
            key = profile_key(card['url'])
            if key and connected_date(card['card']):
                cards[key] = card
        report['scanned_connections'] = len(cards)
        report['accepted'] = match_connections(cards.values(), leads, account)
        by_url = {profile_key(lead.get('linkedin_url')): lead for lead in leads}
        report['identity_conflicts'] = [
            {'lead_id':by_url[key]['id'],'visible_name':card['name']}
            for key, card in cards.items() if key in by_url and not name_matches(card['name'],by_url[key])]
        dates = [connected_date(card['card']) for card in visible]
        dates = [when for when in dates if when]
        if dates:
            report['oldest_visible_date'] = min(dates).isoformat()
        if dates and min(dates) < cutoff:
            report.update(complete=True, reason='invitation_date_coverage_complete')
            break
        body = await page.locator('body').inner_text()
        total = re.search(r'([\d.,]+)\s+(?:Kontakte|connections)\b', body, re.I)
        if total and len(cards) >= int(re.sub(r'\D', '', total.group(1))):
            report.update(complete=True, reason='all_connections_read')
            break
        stalled = stalled + 1 if len(cards) == previous else 0
        if stalled >= 4:
            more = page.get_by_role('button', name=re.compile(r'^(Mehr anzeigen|Show more|Weitere Ergebnisse anzeigen)$', re.I))
            if await more.count() and await more.first.is_visible():
                await more.first.click()
                stalled = 0
            else:
                break
        await page.locator('body').evaluate(r'''body => {
            const lists = [...body.querySelectorAll('*')].filter(e =>
                e.clientHeight > 200 && e.scrollHeight > e.clientHeight + 50 &&
                /auto|scroll/.test(getComputedStyle(e).overflowY));
            for (const list of lists) list.scrollTop = list.scrollHeight;
            document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
        }''')
        await page.wait_for_timeout(settle_ms)
    return report


async def verified_primary_profile(page, lead):
    """Bind acceptance and the message action to the primary profile, not sidebars."""
    if not profile_key(page.url) or profile_key(page.url) != profile_key(lead.get('linkedin_url')):
        raise RuntimeError('profile_identity_mismatch')
    heading = page.locator('main h1:visible, main h2:visible').first
    if not await heading.count() or not name_matches(await heading.inner_text(), lead):
        raise RuntimeError('profile_identity_mismatch')
    container = heading
    for _ in range(8):
        container = container.locator('xpath=..')
        text = await container.inner_text()
        primary = text.split('Aktivitäten')[0].split('Activity')[0][:600]
        first_degree = bool(re.search(r'(?:^|\n)\s*[·•]?\s*(?:1\.|1st)(?:\s|$)', primary))
        actions = container.get_by_role('link', name=re.compile(r'^(Nachricht|Message)(?: an| to|$)', re.I))
        buttons = container.get_by_role('button', name=re.compile(r'^(Nachricht|Message)(?: an| to|$)', re.I))
        if await actions.count() or await buttons.count():
            if not first_degree:
                raise RuntimeError('connection_not_verified')
            return container
        if await container.evaluate('e => e.tagName') == 'MAIN':
            break
    raise RuntimeError('connection_not_verified')
