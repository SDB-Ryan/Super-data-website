#!/usr/bin/env python3
"""Bourbon Boys league data puller.

What it does: reads our ESPN fantasy football league (public, read-only, no login) and writes
plain CSV files into a folder called bourbon-boys-data/ next to wherever you run it.
What it does NOT do: log in, use cookies, touch your ESPN account, or send data anywhere.
It only makes GET requests to ESPN's fantasy API.

Usage:  python3 pull_league.py            (writes ./bourbon-boys-data/)
        python3 pull_league.py some/dir   (writes there instead)
Needs only Python 3.8+. No pip installs.

Keep the table logic in step with puller.js (the in-browser twin). Same columns, same rounding.
"""
import datetime, gzip, json, math, os, subprocess, sys, urllib.error, urllib.parse, urllib.request

VERSION = '2026-09-19'
LEAGUE_ID = 747815753
SEASON = 2026
BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/%d' % SEASON
LEAGUE = '%s/segments/0/leagues/%d' % (BASE, LEAGUE_ID)
FREE_AGENT_LIMIT = 300

POS = {1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST'}
SLOT = {0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'DST', 17: 'K', 20: 'BENCH', 21: 'IR', 23: 'FLEX'}
SLOT_ORDER = {0: 0, 2: 1, 4: 2, 6: 3, 23: 4, 16: 5, 17: 6, 20: 7, 21: 8}
BENCH_SLOTS = (20, 21)
# ESPN stat id -> plain English. Kicker stats are left out on purpose: this league has no kicker.
STAT_NAMES = {
    3: 'Passing yard', 4: 'Passing TD', 15: 'Bonus: passing TD of 40+ yards', 16: 'Bonus: passing TD of 50+ yards',
    19: 'Passing 2-pt conversion', 20: 'Interception thrown', 211: 'Passing first down',
    24: 'Rushing yard', 25: 'Rushing TD', 26: 'Rushing 2-pt conversion', 35: 'Bonus: rushing TD of 40+ yards',
    36: 'Bonus: rushing TD of 50+ yards', 37: 'Bonus: 100-199 rushing yard game', 38: 'Bonus: 200+ rushing yard game',
    212: 'Rushing first down',
    42: 'Receiving yard', 43: 'Receiving TD', 44: 'Receiving 2-pt conversion', 45: 'Bonus: receiving TD of 40+ yards',
    46: 'Bonus: receiving TD of 50+ yards', 53: 'Reception', 56: 'Bonus: 100-199 receiving yard game',
    57: 'Bonus: 200+ receiving yard game', 213: 'Receiving first down',
    63: 'Fumble recovered for TD', 72: 'Fumble lost',
    89: 'D/ST: 0 points allowed', 90: 'D/ST: 1-6 points allowed', 91: 'D/ST: 7-13 points allowed',
    92: 'D/ST: 14-17 points allowed', 123: 'D/ST: 28-34 points allowed', 124: 'D/ST: 35-45 points allowed',
    125: 'D/ST: 46+ points allowed', 128: 'D/ST: under 100 yards allowed', 129: 'D/ST: 100-199 yards allowed',
    130: 'D/ST: 200-299 yards allowed', 131: 'D/ST: 300-349 yards allowed', 132: 'D/ST: 350-399 yards allowed',
    133: 'D/ST: 400-449 yards allowed', 134: 'D/ST: 450-499 yards allowed', 135: 'D/ST: 500-549 yards allowed',
    136: 'D/ST: 550+ yards allowed', 93: 'D/ST: blocked kick returned for TD', 95: 'D/ST: interception',
    96: 'D/ST: fumble recovered', 97: 'D/ST: blocked kick', 98: 'D/ST: safety', 99: 'D/ST: sack',
    101: 'Kickoff return TD', 102: 'Punt return TD', 103: 'Interception return TD', 104: 'Fumble return TD',
    106: 'D/ST: forced fumble', 206: '2-pt conversion return', 209: '1-pt safety',
}
KICKER_STATS = (74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 198, 199, 200, 201, 202, 203)
# Order the scoring list the way a person thinks about it.
STAT_ORDER = [53, 211, 212, 213, 3, 4, 19, 20, 15, 16, 24, 25, 26, 35, 36, 37, 38, 42, 43, 44, 45, 46, 56, 57, 72, 63]


# ---------- fetching ----------
def _headers(filt):
    # ESPN's API turns away clients with no browser-style User-Agent; this one says plainly what we are.
    h = {'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (bourbon-boys-league-puller)'}
    if filt is not None:
        h['X-Fantasy-Filter'] = json.dumps(filt, separators=(',', ':'))
    return h


def get(url, filt=None):
    """GET a JSON url. Falls back to the system `curl` if Python's certificates aren't set up
    (common on fresh python.org installs on a Mac)."""
    h = _headers(filt)
    try:
        req = urllib.request.Request(url, headers=dict(h, **{'Accept-Encoding': 'gzip'}))
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            if r.headers.get('Content-Encoding') == 'gzip':
                raw = gzip.decompress(raw)
        return json.loads(raw.decode('utf-8'))
    except urllib.error.HTTPError as e:
        sys.exit('ESPN said no (HTTP %s) for %s\nIf this is 401/403 the commissioner may have made the '
                 'league private again.' % (e.code, url))
    except (urllib.error.URLError, OSError) as e:
        cmd = ['curl', '-sS', '--fail', '--compressed', '--max-time', '60']
        for k, v in h.items():
            cmd += ['-H', '%s: %s' % (k, v)]
        try:
            out = subprocess.run(cmd + [url], capture_output=True, check=True).stdout
            return json.loads(out.decode('utf-8'))
        except Exception:
            sys.exit('Could not reach ESPN: %s\nCheck the internet connection and try again.' % e)


def kona(week, players_filter):
    return get('%s?view=kona_player_info&scoringPeriodId=%d' % (LEAGUE, week), {'players': players_filter})


def stats_filter(week):
    s = str(SEASON)
    # '00'=season actual, '10'=season projection, '12'=rest-of-season projection, '11'+week=that week's projection.
    # `value` asks for the most recent N games of actual points (week+1 covers every week so far).
    return {'value': week + 1,
            'additionalValue': ['00' + s, '10' + s, '12' + s] + ['11%s%d' % (s, w) for w in range(1, week + 1)]}


# ---------- formatting (mirrors puller.js exactly) ----------
def num(x):
    """Round to 2 places the same way the browser twin does; blank for missing."""
    if x is None:
        return ''
    v = math.floor(x * 100 + 0.5) / 100
    if v == 0:
        return '0'
    s = repr(v)
    return s[:-2] if s.endswith('.0') else s


def cell(v):
    s = '' if v is None else str(v)
    if any(c in s for c in ',"\n\r'):
        s = '"' + s.replace('"', '""') + '"'
    return s


def to_csv(cols, rows):
    lines = [','.join(cols)]
    for r in rows:
        lines.append(','.join(cell(r.get(c)) for c in cols))
    return '\n'.join(lines) + '\n'


def when(ms):
    return datetime.datetime.fromtimestamp(ms / 1000.0, tz=datetime.timezone.utc).strftime('%Y-%m-%d %H:%M')


# ---------- player helpers ----------
def stat_entry(pl, src, split, period=0):
    for s in pl.get('stats') or []:
        if (s.get('seasonId') == SEASON and s.get('statSourceId') == src
                and s.get('statSplitTypeId') == split and s.get('scoringPeriodId') == period):
            return s
    return None


def pts(pl, src, split, period=0):
    s = stat_entry(pl, src, split, period)
    return None if s is None else s.get('appliedTotal')


def injury(pl):
    s = pl.get('injuryStatus') or ''
    return '' if s in ('ACTIVE', 'NORMAL') else s


def build(progress=lambda msg: None):
    """Pull everything and return {'tables': {name: (cols, rows)}, 'rules': str, 'week': int, 'pulled_at': str}."""
    progress('league, teams, rosters, schedule')
    L = get(LEAGUE + '?view=mSettings&view=mTeam&view=mRoster&view=mStatus&view=mMatchupScore')
    progress('NFL bye weeks')
    pro = get(BASE + '?view=proTeamSchedules_wl')
    nfl = {t['id']: t.get('abbrev', '') for t in pro['settings']['proTeams']}
    bye = {t['id']: t.get('byeWeek') or '' for t in pro['settings']['proTeams']}
    status = L.get('status') or {}
    week = min(L.get('scoringPeriodId') or 1, status.get('finalScoringPeriod') or 18)

    slots = [0, 2, 4, 6, 16, 23]
    progress('stats for every rostered player')
    OT = kona(week, {'filterStatus': {'value': ['ONTEAM']}, 'filterSlotIds': {'value': slots}, 'limit': 400,
                     'sortPercOwned': {'sortPriority': 1, 'sortAsc': False},
                     'filterStatsForTopScoringPeriodIds': stats_filter(week)})
    progress('top %d free agents' % FREE_AGENT_LIMIT)
    FA = kona(week, {'filterStatus': {'value': ['FREEAGENT', 'WAIVERS']}, 'filterSlotIds': {'value': slots},
                     'limit': FREE_AGENT_LIMIT, 'sortPercOwned': {'sortPriority': 1, 'sortAsc': False},
                     'filterStatsForTopScoringPeriodIds': stats_filter(week)})
    progress('draft results')
    D = get(LEAGUE + '?view=mDraftDetail')
    tx_raw = []
    for sp in range(1, week + 1):
        progress('transactions, week %d' % sp)
        tx_raw += get('%s?view=mTransactions2&scoringPeriodId=%d' % (LEAGUE, sp)).get('transactions') or []

    members = {m['id']: (m.get('firstName') or '').strip() for m in L.get('members') or []}
    team_name = {t['id']: (t.get('name') or '').strip() for t in L['teams']}

    # every player we know about, by id
    players = {}
    for t in L['teams']:
        for e in (t.get('roster') or {}).get('entries') or []:
            players[e['playerId']] = e['playerPoolEntry']['player']
    for p in (OT.get('players') or []) + (FA.get('players') or []):
        players[p['id']] = p['player']
    picks = [p for p in (D.get('draftDetail') or {}).get('picks') or [] if p.get('playerId', -1) != -1]
    wanted = {p['playerId'] for p in picks}
    for x in tx_raw:
        wanted |= {i['playerId'] for i in x.get('items') or []}
    missing = sorted(i for i in wanted if i not in players)
    if missing:
        progress('names for %d dropped/old players' % len(missing))
        extra = kona(week, {'filterIds': {'value': missing}, 'limit': len(missing) + 10,
                            'filterStatsForTopScoringPeriodIds': stats_filter(week)})
        for p in extra.get('players') or []:
            players[p['id']] = p['player']

    def pname(pid):
        return (players.get(pid) or {}).get('fullName') or ('player #%d' % pid)

    def ppos(pid):
        return POS.get((players.get(pid) or {}).get('defaultPositionId'), '')

    def base_row(pl, entry):
        own = pl.get('ownership') or {}
        season = stat_entry(pl, 0, 0)
        return {
            'player': pl.get('fullName', ''), 'pos': POS.get(pl.get('defaultPositionId'), ''),
            'nfl_team': nfl.get(pl.get('proTeamId'), 'FA'), 'bye_week': bye.get(pl.get('proTeamId'), ''),
            'injury': injury(pl), 'game_started': 'yes' if entry.get('lineupLocked') else 'no',
            'season_pts': num(season.get('appliedTotal') if season else None),
            'avg_pts': num(season.get('appliedAverage') if season else None),
            'last_week_pts': num(pts(pl, 0, 1, week - 1)) if week > 1 else '',
            'this_week_pts_so_far': num(pts(pl, 0, 1, week)),
            'this_week_proj': num(pts(pl, 1, 1, week)),
            'rest_of_season_proj': num(pts(pl, 1, 2)),
            'pct_rostered': num(own.get('percentOwned')), 'pct_rostered_change': num(own.get('percentChange')),
            'player_id': pl.get('id'),
        }

    # ----- teams -----
    counts = ((L.get('settings') or {}).get('rosterSettings') or {}).get('lineupSlotCounts') or {}
    ir_max = counts.get('21', 0)
    roster_max = sum(n for sid, n in counts.items() if sid != '21')
    teams = []
    for t in L['teams']:
        ents = (t.get('roster') or {}).get('entries') or []
        on_ir = sum(1 for e in ents if e.get('lineupSlotId') == 21)
        rec = (t.get('record') or {}).get('overall') or {}
        tc = t.get('transactionCounter') or {}
        streak = ('%s%d' % ((rec.get('streakType') or '?')[0], rec.get('streakLength') or 0)) if rec.get('streakLength') else ''
        teams.append({
            'team_id': t['id'], 'team': team_name[t['id']], 'abbrev': t.get('abbrev', ''),
            'owners': ' & '.join(n for n in (members.get(o, '') for o in t.get('owners') or []) if n),
            'wins': rec.get('wins', 0), 'losses': rec.get('losses', 0), 'ties': rec.get('ties', 0),
            'points_for': num(rec.get('pointsFor')), 'points_against': num(rec.get('pointsAgainst')),
            'streak': streak, 'standing': t.get('playoffSeed', ''), 'waiver_order': t.get('waiverRank', ''),
            'adds_made': tc.get('acquisitions', 0), 'trades_made': tc.get('trades', 0),
            'players_rostered': len(ents), 'open_roster_spots': max(0, roster_max - (len(ents) - on_ir)),
            'open_ir_spots': max(0, ir_max - on_ir),
        })
    teams.sort(key=lambda r: (r['standing'] or 99, r['team_id']))

    # ----- rosters -----
    rosters = []
    for t in sorted(L['teams'], key=lambda t: t['id']):
        entries = (t.get('roster') or {}).get('entries') or []
        for e in sorted(entries, key=lambda e: (SLOT_ORDER.get(e['lineupSlotId'], 50), e['playerId'])):
            pl = players.get(e['playerId']) or e['playerPoolEntry']['player']
            r = {'team': team_name[t['id']], 'team_id': t['id'],
                 'slot': SLOT.get(e['lineupSlotId'], 'slot%s' % e['lineupSlotId']),
                 'starting': 'no' if e['lineupSlotId'] in BENCH_SLOTS else 'yes'}
            r.update(base_row(pl, e.get('playerPoolEntry') or {}))
            r['acquired_by'] = e.get('acquisitionType') or ''
            rosters.append(r)

    # ----- matchups -----
    matchups = []
    for m in sorted(L.get('schedule') or [], key=lambda m: (m.get('matchupPeriodId', 0), m.get('id', 0))):
        h, a = m.get('home') or {}, m.get('away') or {}
        wk = m.get('matchupPeriodId')
        win = {'HOME': team_name.get(h.get('teamId'), ''), 'AWAY': team_name.get(a.get('teamId'), ''),
               'TIE': 'tie'}.get(m.get('winner'), '')
        state = 'final' if win else ('in progress' if wk == status.get('currentMatchupPeriod') else 'not played yet')
        cur = state == 'in progress'

        def score(side):
            if state == 'not played yet':
                return ''
            return num(side.get('totalPointsLive') if cur and side.get('totalPointsLive') is not None else side.get('totalPoints'))

        def win_pct(side):
            return num(side['winProbability'] * 100) if cur and side.get('winProbability') is not None else ''
        matchups.append({
            'week': wk, 'status': state,
            'home_team': team_name.get(h.get('teamId'), 'BYE'), 'home_pts': score(h),
            'away_team': team_name.get(a.get('teamId'), 'BYE'), 'away_pts': score(a),
            'winner': win,
            'home_projected_final': num(h.get('totalProjectedPointsLive')) if cur else '',
            'away_projected_final': num(a.get('totalProjectedPointsLive')) if cur else '',
            'home_win_pct': win_pct(h), 'away_win_pct': win_pct(a),
            'playoffs': 'no' if m.get('playoffTierType', 'NONE') == 'NONE' else 'yes',
        })

    # ----- free agents -----
    free_agents = []
    for p in FA.get('players') or []:
        pl = p['player']
        if pl.get('defaultPositionId') not in (1, 2, 3, 4, 16):
            continue
        r = base_row(pl, p)
        if p.get('status') == 'WAIVERS':
            r['availability'] = 'on waivers - game already started' if p.get('lineupLocked') else 'on waivers - recently dropped'
        else:
            r['availability'] = 'free agent'
        free_agents.append(r)

    # ----- week by week -----
    fantasy_team = {r['player_id']: r['team'] for r in rosters}
    fa_ids = [r['player_id'] for r in free_agents]
    player_weeks = []
    for pid in [r['player_id'] for r in rosters] + fa_ids:
        pl = players[pid]
        for wk in range(1, week + 1):
            actual, proj = pts(pl, 0, 1, wk), pts(pl, 1, 1, wk)
            if actual is None and proj is None:
                continue
            player_weeks.append({'player': pl.get('fullName', ''), 'pos': POS.get(pl.get('defaultPositionId'), ''),
                                 'fantasy_team': fantasy_team.get(pid, 'free agent'), 'week': wk,
                                 'actual_pts': num(actual), 'projected_pts': num(proj), 'player_id': pid})

    # ----- draft -----
    draft = [{'overall_pick': p.get('overallPickNumber'), 'round': p.get('roundId'), 'pick_in_round': p.get('roundPickNumber'),
              'team': team_name.get(p.get('teamId'), ''), 'player': pname(p['playerId']), 'pos': ppos(p['playerId']),
              'now_on': fantasy_team.get(p['playerId'], 'free agent'), 'player_id': p['playerId']}
             for p in sorted(picks, key=lambda p: p.get('overallPickNumber', 0))]

    # ----- transactions (executed adds, drops, trades) -----
    kinds = {'FREEAGENT': 'free agent pickup', 'WAIVER': 'waiver claim', 'TRADE_ACCEPT': 'trade', 'TRADE_UPHOLD': 'trade'}
    transactions, seen = [], set()
    for x in sorted(tx_raw, key=lambda x: (x.get('proposedDate', 0), x.get('id', ''))):
        if x.get('status') != 'EXECUTED' or x.get('type') not in kinds:
            continue
        for i in x.get('items') or []:
            if i.get('type') not in ('ADD', 'DROP', 'TRADE'):
                continue
            key = (kinds[x['type']], i.get('type'), i.get('playerId'), i.get('fromTeamId'), i.get('toTeamId'),
                   x.get('scoringPeriodId'))
            if kinds[x['type']] == 'trade' and key in seen:
                continue
            seen.add(key)
            transactions.append({
                'date_utc': when(x.get('proposedDate', 0)), 'week': x.get('scoringPeriodId'),
                'team': team_name.get(x.get('teamId'), ''), 'kind': kinds[x['type']], 'action': i.get('type', '').lower(),
                'player': pname(i['playerId']), 'pos': ppos(i['playerId']),
                'from': team_name.get(i.get('fromTeamId'), 'free agents'), 'to': team_name.get(i.get('toTeamId'), 'free agents'),
                'player_id': i['playerId']})

    base_cols = ['player', 'pos', 'nfl_team', 'bye_week', 'injury', 'game_started', 'season_pts', 'avg_pts', 'last_week_pts',
                 'this_week_pts_so_far', 'this_week_proj', 'rest_of_season_proj', 'pct_rostered', 'pct_rostered_change']
    tables = {
        'teams': (['team_id', 'team', 'abbrev', 'owners', 'wins', 'losses', 'ties', 'points_for', 'points_against',
                   'streak', 'standing', 'waiver_order', 'adds_made', 'trades_made', 'players_rostered',
                   'open_roster_spots', 'open_ir_spots'], teams),
        'rosters': (['team', 'slot', 'starting'] + base_cols + ['acquired_by', 'team_id', 'player_id'], rosters),
        'matchups': (['week', 'status', 'home_team', 'home_pts', 'away_team', 'away_pts', 'winner',
                      'home_projected_final', 'away_projected_final', 'home_win_pct', 'away_win_pct', 'playoffs'], matchups),
        'free_agents': (base_cols + ['availability', 'player_id'], free_agents),
        'player_weeks': (['player', 'pos', 'fantasy_team', 'week', 'actual_pts', 'projected_pts', 'player_id'], player_weeks),
        'draft': (['overall_pick', 'round', 'pick_in_round', 'team', 'player', 'pos', 'now_on', 'player_id'], draft),
        'transactions': (['date_utc', 'week', 'team', 'kind', 'action', 'player', 'pos', 'from', 'to', 'player_id'], transactions),
    }
    return {'tables': tables, 'rules': rules_text(L, week), 'week': week,
            'league_name': (L.get('settings') or {}).get('name', 'Bourbon Boys')}


def rules_text(L, week):
    s = L.get('settings') or {}
    out = ['# %s - league rules (ESPN league %d, season %d)' % (s.get('name', 'Bourbon Boys'), LEAGUE_ID, SEASON), '',
           'Currently NFL week %d. %d teams. Head-to-head, one matchup per week.' % (week, s.get('size') or len(L['teams'])), '',
           'Every points number in these data files (season, weekly, projections) was already calculated by ESPN',
           "under THIS league's scoring below. Do not re-score players with standard or generic PPR assumptions.", '',
           '## Lineup']
    counts = (s.get('rosterSettings') or {}).get('lineupSlotCounts') or {}
    names = {0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 23: 'FLEX (RB/WR/TE)', 16: 'D/ST', 17: 'K', 20: 'bench', 21: 'IR'}
    parts = []
    for sid in (0, 2, 4, 6, 23, 16, 17, 20, 21):
        n = counts.get(str(sid), 0)
        if n:
            parts.append('%d %s' % (n, names[sid]))
    out.append('Start: ' + ', '.join(parts) + '.' + ('' if counts.get('17') else ' There is NO kicker.'))
    out += ['', '## Scoring (points per event)']
    items = {i['statId']: i for i in (s.get('scoringSettings') or {}).get('scoringItems') or []}

    def val(i):
        ov = i.get('pointsOverrides') or {}
        return ov.get('16') if (i.get('points') or 0) == 0 and '16' in ov else i.get('points')

    ordered = [k for k in STAT_ORDER if k in items] + sorted(k for k in items if k not in STAT_ORDER)
    for k in ordered:
        if k in KICKER_STATS:
            continue
        v = val(items[k])
        if not v:
            continue
        ov = items[k].get('pointsOverrides') or {}
        dst_only = (items[k].get('points') or 0) == 0 and '16' in ov
        label = STAT_NAMES.get(k) or '%s (ESPN stat #%d)' % ('D/ST: other defensive stat' if dst_only else 'Other', k)
        out.append('- %s: %s' % (label, num(v)))
    out += ['', 'What is unusual here: full PPR PLUS 1 point for every first down (passing, rushing and receiving).',
            'That inflates QB totals a lot (only 1 QB starts, so they are not worth as much as the raw totals suggest)',
            'and makes high-volume, chain-moving RBs, WRs and TEs worth more than in a normal PPR league.',
            'Passing TDs are worth less than rushing/receiving TDs.']
    acq = s.get('acquisitionSettings') or {}
    out += ['', '## Waivers and trades']
    if acq.get('isUsingAcquisitionBudget'):
        out.append('- Free-agent bidding (FAAB) with a $%s budget.' % acq.get('acquisitionBudget'))
    else:
        out.append('- Traditional waivers, no bidding. Priority is the waiver_order column in teams.csv (1 = first). '
                   'A successful claim sends that team to the back of the line.')
    days = [d.capitalize() for d in acq.get('waiverProcessDays') or []]
    if days:
        out.append('- Claims process on: %s, around %s:00 UTC (7am US Eastern in daylight time, 6am in winter). Dropped players sit on waivers for %s hours.'
                   % (', '.join(days), acq.get('waiverProcessHour'), acq.get('waiverHours')))
    out.append('- A player whose game has started is locked for the week: he cannot be moved in the lineup, and he cannot be the player you drop in a claim.')
    tr = s.get('tradeSettings') or {}
    if tr.get('deadlineDate'):
        out.append('- Trade deadline: %s UTC. Votes needed to veto a trade: %s.' % (when(tr['deadlineDate']), tr.get('vetoVotesRequired')))
    sch = s.get('scheduleSettings') or {}
    out += ['', '## Reading the data files',
            '- season_pts and avg_pts include any game already played in the current week, so mid-week some players have one more game counted than others.',
            "- game_started = yes means that player's game this week has kicked off: he is locked in place and cannot be dropped as part of a claim.",
            '- A 0 can mean he played and scored nothing, or that he did not play. Check news before reading much into it.',
            '- pct_rostered is the share of ALL ESPN leagues that roster the player (a popularity signal), not this league. pct_rostered_change is the 7-day trend.',
            "- injury is ESPN's tag: blank = healthy, else QUESTIONABLE, DOUBTFUL, OUT, INJURY_RESERVE, SUSPENSION. ESPN generally only lets OUT and INJURY_RESERVE players sit in the IR slot.",
            "- free_agents.csv is the 300 most-rostered available players, sorted by pct_rostered (not by quality). availability: 'free agent' can be added instantly with no effect on waiver order; both 'on waivers' kinds need a claim, which uses waiver priority.",
            '- teams.csv shows open_roster_spots and open_ir_spots. A team with an open spot can add a player without dropping anyone.',
            '- player_weeks.csv has actual points for every week so far; projected_pts is only available for the current week.']
    out += ['', '## Season', '- Regular season: %s weeks. %s teams make the playoffs.'
            % (sch.get('matchupPeriodCount'), sch.get('playoffTeamCount'))]
    return '\n'.join(out) + '\n'


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else 'bourbon-boys-data'
    print('Pulling the Bourbon Boys league from ESPN (read-only, no login)...')
    result = build(lambda msg: print('  - ' + msg))
    os.makedirs(out_dir, exist_ok=True)
    for name, (cols, rows) in result['tables'].items():
        with open(os.path.join(out_dir, name + '.csv'), 'w', encoding='utf-8', newline='') as f:
            f.write(to_csv(cols, rows))
        print('  wrote %-18s %4d rows' % (name + '.csv', len(rows)))
    with open(os.path.join(out_dir, 'league_rules.md'), 'w', encoding='utf-8', newline='') as f:
        f.write(result['rules'])
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    with open(os.path.join(out_dir, 'pulled_at.txt'), 'w', encoding='utf-8', newline='') as f:
        f.write('Pulled %s, during NFL week %d.\n' % (stamp, result['week']))
    print('Done. Files are in %s  (read league_rules.md first).' % os.path.abspath(out_dir))


if __name__ == '__main__':
    main()
