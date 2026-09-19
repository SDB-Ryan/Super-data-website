/* Bourbon Boys league data puller - in-browser twin of pull_league.py.
 *
 * Reads our public ESPN league straight from the visitor's browser (read-only, no login, nothing
 * is sent anywhere else) and turns ESPN's ID codes into plain tables.
 * No styling in here on purpose. The page decides how things look.
 *
 *   await BBPull.pull({onProgress: msg => ...})   fetch + decode everything
 *   BBPull.teams()                                [{id, name, owners}] for a team picker
 *   BBPull.renderInto(element, teamId)            results as real text (AI block + tables)
 *   BBPull.copyText(teamId)                       one compact text block to paste into any chat AI
 *   BBPull.copyToClipboard(teamId)                copies that block; resolves true/false
 *   BBPull.downloadCSVs()                         one zip with the same files pull_league.py writes
 *   BBPull.downloadAIText(teamId)                 the copy block as a .txt (for chat apps that prefer uploads)
 *
 * Keep the table logic in step with pull_league.py. Same columns, same rounding.
 */
(function (root) {
  'use strict';
  var LEAGUE_ID = 747815753, SEASON = 2026;
  var BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + SEASON;
  var LEAGUE = BASE + '/segments/0/leagues/' + LEAGUE_ID;
  var FREE_AGENT_LIMIT = 300;

  var POS = {1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST'};
  var SLOT = {0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'DST', 17: 'K', 20: 'BENCH', 21: 'IR', 23: 'FLEX'};
  var SLOT_ORDER = {0: 0, 2: 1, 4: 2, 6: 3, 23: 4, 16: 5, 17: 6, 20: 7, 21: 8};
  var BENCH_SLOTS = [20, 21];
  var STAT_NAMES = {
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
    106: 'D/ST: forced fumble', 206: '2-pt conversion return', 209: '1-pt safety'
  };
  var KICKER_STATS = [74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 198, 199, 200, 201, 202, 203];
  var STAT_ORDER = [53, 211, 212, 213, 3, 4, 19, 20, 15, 16, 24, 25, 26, 35, 36, 37, 38, 42, 43, 44, 45, 46, 56, 57, 72, 63];
  // Shown in the team picker before the first pull. Names can change; after a pull, teams() is live.
  var FALLBACK_TEAMS = [
    [1, 'Plan B'], [2, 'Patty Danwinkles'], [3, 'RickShaw'], [4, 'Log of Truth'], [5, 'Frijoles Verdes'],
    [6, 'House of Pour Decisions'], [7, 'Team DolLewis'], [8, 'Don Cherry Poppers'], [9, 'Alaskan Draft Dodger'],
    [10, "Brian's Best Team"], [11, 'D Craig'], [12, "Kelly Stafford Haters' Society"]];

  // ---------- fetching ----------
  function get(url, filt) {
    var headers = {'Accept': 'application/json'};
    if (filt) headers['X-Fantasy-Filter'] = JSON.stringify(filt);
    return fetch(url, {headers: headers, credentials: 'omit', cache: 'no-store'}).then(function (r) {
      if (!r.ok) {
        throw new Error('ESPN said no (HTTP ' + r.status + '). If this is 401/403 the commissioner may have made the league private again.');
      }
      return r.json();
    });
  }
  function kona(week, playersFilter) {
    return get(LEAGUE + '?view=kona_player_info&scoringPeriodId=' + week, {players: playersFilter});
  }
  function statsFilter(week) {
    var s = String(SEASON), extra = ['00' + s, '10' + s, '12' + s];
    for (var w = 1; w <= week; w++) extra.push('11' + s + w);
    return {value: week + 1, additionalValue: extra};
  }

  // ---------- formatting (mirrors pull_league.py exactly) ----------
  function num(x) {
    if (x === null || x === undefined) return '';
    var v = Math.floor(x * 100 + 0.5) / 100;
    if (v === 0) return '0';
    return String(v);
  }
  function cell(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    if (/[,"\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function toCSV(cols, rows) {
    var lines = [cols.join(',')];
    rows.forEach(function (r) { lines.push(cols.map(function (c) { return cell(r[c]); }).join(',')); });
    return lines.join('\n') + '\n';
  }
  function when(ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
  function has(o, k) { return o !== null && o !== undefined && o[k] !== undefined && o[k] !== null; }
  function or(v, d) { return (v === undefined || v === null) ? d : v; }

  // ---------- player helpers ----------
  function statEntry(pl, src, split, period) {
    period = period || 0;
    var stats = pl.stats || [];
    for (var i = 0; i < stats.length; i++) {
      var s = stats[i];
      if (s.seasonId === SEASON && s.statSourceId === src && s.statSplitTypeId === split && s.scoringPeriodId === period) return s;
    }
    return null;
  }
  function pts(pl, src, split, period) {
    var s = statEntry(pl, src, split, period);
    return s === null ? null : or(s.appliedTotal, null);
  }
  function injury(pl) {
    var s = pl.injuryStatus || '';
    return (s === 'ACTIVE' || s === 'NORMAL') ? '' : s;
  }

  function build(progress) {
    progress = progress || function () {};
    var L, pro, OT, FA, D, txRaw = [], week, status, players = new Map();
    progress('league, teams, rosters, schedule');
    return Promise.all([
      get(LEAGUE + '?view=mSettings&view=mTeam&view=mRoster&view=mStatus&view=mMatchupScore'),
      get(BASE + '?view=proTeamSchedules_wl'),
      get(LEAGUE + '?view=mDraftDetail')
    ]).then(function (res) {
      L = res[0]; pro = res[1]; D = res[2];
      status = L.status || {};
      week = Math.min(L.scoringPeriodId || 1, status.finalScoringPeriod || 18);
      var slots = [0, 2, 4, 6, 16, 23];
      progress('player stats, top ' + FREE_AGENT_LIMIT + ' free agents, transactions');
      var calls = [
        kona(week, {filterStatus: {value: ['ONTEAM']}, filterSlotIds: {value: slots}, limit: 400,
          sortPercOwned: {sortPriority: 1, sortAsc: false}, filterStatsForTopScoringPeriodIds: statsFilter(week)}),
        kona(week, {filterStatus: {value: ['FREEAGENT', 'WAIVERS']}, filterSlotIds: {value: slots}, limit: FREE_AGENT_LIMIT,
          sortPercOwned: {sortPriority: 1, sortAsc: false}, filterStatsForTopScoringPeriodIds: statsFilter(week)})
      ];
      for (var sp = 1; sp <= week; sp++) calls.push(get(LEAGUE + '?view=mTransactions2&scoringPeriodId=' + sp));
      return Promise.all(calls);
    }).then(function (res) {
      OT = res[0]; FA = res[1];
      res.slice(2).forEach(function (t) { txRaw = txRaw.concat(t.transactions || []); });
      L.teams.forEach(function (t) {
        ((t.roster || {}).entries || []).forEach(function (e) { players.set(e.playerId, e.playerPoolEntry.player); });
      });
      (OT.players || []).concat(FA.players || []).forEach(function (p) { players.set(p.id, p.player); });
      var wanted = new Set();
      ((D.draftDetail || {}).picks || []).forEach(function (p) { if (or(p.playerId, -1) !== -1) wanted.add(p.playerId); });
      txRaw.forEach(function (x) { (x.items || []).forEach(function (i) { wanted.add(i.playerId); }); });
      var missing = Array.from(wanted).filter(function (i) { return !players.has(i); }).sort(function (a, b) { return a - b; });
      if (!missing.length) return null;
      progress('names for ' + missing.length + ' dropped/old players');
      return kona(week, {filterIds: {value: missing}, limit: missing.length + 10, filterStatsForTopScoringPeriodIds: statsFilter(week)});
    }).then(function (extra) {
      ((extra || {}).players || []).forEach(function (p) { players.set(p.id, p.player); });
      return assemble(L, pro, OT, FA, D, txRaw, week, status, players);
    });
  }

  function assemble(L, pro, OT, FA, D, txRaw, week, status, players) {
    var nfl = {}, bye = {}, members = {}, teamName = {};
    pro.settings.proTeams.forEach(function (t) { nfl[t.id] = or(t.abbrev, ''); bye[t.id] = t.byeWeek || ''; });
    (L.members || []).forEach(function (m) { members[m.id] = (m.firstName || '').trim(); });
    L.teams.forEach(function (t) { teamName[t.id] = (t.name || '').trim(); });
    function tn(id, dflt) { return has(teamName, id) ? teamName[id] : dflt; }
    function pname(pid) { return (players.get(pid) || {}).fullName || ('player #' + pid); }
    function ppos(pid) { return POS[(players.get(pid) || {}).defaultPositionId] || ''; }

    function baseRow(pl, entry) {
      var own = pl.ownership || {}, season = statEntry(pl, 0, 0);
      return {
        player: or(pl.fullName, ''), pos: POS[pl.defaultPositionId] || '',
        nfl_team: has(nfl, pl.proTeamId) ? nfl[pl.proTeamId] : 'FA', bye_week: has(bye, pl.proTeamId) ? bye[pl.proTeamId] : '',
        injury: injury(pl), game_started: (entry || {}).lineupLocked ? 'yes' : 'no',
        season_pts: num(season ? or(season.appliedTotal, null) : null),
        avg_pts: num(season ? or(season.appliedAverage, null) : null),
        last_week_pts: week > 1 ? num(pts(pl, 0, 1, week - 1)) : '',
        this_week_pts_so_far: num(pts(pl, 0, 1, week)),
        this_week_proj: num(pts(pl, 1, 1, week)),
        rest_of_season_proj: num(pts(pl, 1, 2)),
        pct_rostered: num(or(own.percentOwned, null)), pct_rostered_change: num(or(own.percentChange, null)),
        player_id: pl.id
      };
    }

    // ----- teams -----
    var counts = ((L.settings || {}).rosterSettings || {}).lineupSlotCounts || {};
    var irMax = counts['21'] || 0, rosterMax = 0;
    Object.keys(counts).forEach(function (sid) { if (sid !== '21') rosterMax += counts[sid]; });
    var teams = L.teams.map(function (t) {
      var ents = (t.roster || {}).entries || [];
      var onIr = ents.filter(function (e) { return e.lineupSlotId === 21; }).length;
      var rec = (t.record || {}).overall || {}, tc = t.transactionCounter || {};
      var streak = rec.streakLength ? ((rec.streakType || '?').charAt(0) + rec.streakLength) : '';
      return {
        team_id: t.id, team: teamName[t.id], abbrev: or(t.abbrev, ''),
        owners: (t.owners || []).map(function (o) { return members[o] || ''; }).filter(Boolean).join(' & '),
        wins: or(rec.wins, 0), losses: or(rec.losses, 0), ties: or(rec.ties, 0),
        points_for: num(or(rec.pointsFor, null)), points_against: num(or(rec.pointsAgainst, null)),
        streak: streak, standing: or(t.playoffSeed, ''), waiver_order: or(t.waiverRank, ''),
        adds_made: or(tc.acquisitions, 0), trades_made: or(tc.trades, 0),
        players_rostered: ents.length, open_roster_spots: Math.max(0, rosterMax - (ents.length - onIr)),
        open_ir_spots: Math.max(0, irMax - onIr)
      };
    });
    teams.sort(function (a, b) { return ((a.standing || 99) - (b.standing || 99)) || (a.team_id - b.team_id); });

    // ----- rosters -----
    var rosters = [];
    L.teams.slice().sort(function (a, b) { return a.id - b.id; }).forEach(function (t) {
      var entries = ((t.roster || {}).entries || []).slice().sort(function (a, b) {
        return (or(SLOT_ORDER[a.lineupSlotId], 50) - or(SLOT_ORDER[b.lineupSlotId], 50)) || (a.playerId - b.playerId);
      });
      entries.forEach(function (e) {
        var pl = players.get(e.playerId) || e.playerPoolEntry.player;
        var r = {team: teamName[t.id], team_id: t.id, slot: SLOT[e.lineupSlotId] || ('slot' + e.lineupSlotId),
          starting: BENCH_SLOTS.indexOf(e.lineupSlotId) >= 0 ? 'no' : 'yes'};
        var b = baseRow(pl, e.playerPoolEntry || {}); Object.keys(b).forEach(function (k) { r[k] = b[k]; });
        r.acquired_by = e.acquisitionType || '';
        rosters.push(r);
      });
    });

    // ----- matchups -----
    var matchups = (L.schedule || []).slice().sort(function (a, b) {
      return (or(a.matchupPeriodId, 0) - or(b.matchupPeriodId, 0)) || (or(a.id, 0) - or(b.id, 0));
    }).map(function (m) {
      var h = m.home || {}, a = m.away || {}, wk = m.matchupPeriodId;
      var win = {HOME: tn(h.teamId, ''), AWAY: tn(a.teamId, ''), TIE: 'tie'}[m.winner] || '';
      var state = win ? 'final' : (wk === status.currentMatchupPeriod ? 'in progress' : 'not played yet');
      var cur = state === 'in progress';
      function score(side) {
        if (state === 'not played yet') return '';
        return num(cur && has(side, 'totalPointsLive') ? side.totalPointsLive : or(side.totalPoints, null));
      }
      function winPct(side) { return cur && has(side, 'winProbability') ? num(side.winProbability * 100) : ''; }
      return {
        week: wk, status: state,
        home_team: tn(h.teamId, 'BYE'), home_pts: score(h), away_team: tn(a.teamId, 'BYE'), away_pts: score(a),
        winner: win,
        home_projected_final: cur ? num(or(h.totalProjectedPointsLive, null)) : '',
        away_projected_final: cur ? num(or(a.totalProjectedPointsLive, null)) : '',
        home_win_pct: winPct(h), away_win_pct: winPct(a),
        playoffs: or(m.playoffTierType, 'NONE') === 'NONE' ? 'no' : 'yes'
      };
    });

    // ----- free agents -----
    var freeAgents = [];
    (FA.players || []).forEach(function (p) {
      var pl = p.player;
      if ([1, 2, 3, 4, 16].indexOf(pl.defaultPositionId) < 0) return;
      var r = baseRow(pl, p);
      if (p.status === 'WAIVERS') r.availability = p.lineupLocked ? 'on waivers - game already started' : 'on waivers - recently dropped';
      else r.availability = 'free agent';
      freeAgents.push(r);
    });

    // ----- week by week -----
    var fantasyTeam = {};
    rosters.forEach(function (r) { fantasyTeam[r.player_id] = r.team; });
    var playerWeeks = [];
    rosters.map(function (r) { return r.player_id; }).concat(freeAgents.map(function (r) { return r.player_id; })).forEach(function (pid) {
      var pl = players.get(pid);
      for (var wk = 1; wk <= week; wk++) {
        var actual = pts(pl, 0, 1, wk), proj = pts(pl, 1, 1, wk);
        if (actual === null && proj === null) continue;
        playerWeeks.push({player: or(pl.fullName, ''), pos: POS[pl.defaultPositionId] || '',
          fantasy_team: has(fantasyTeam, pid) ? fantasyTeam[pid] : 'free agent', week: wk,
          actual_pts: num(actual), projected_pts: num(proj), player_id: pid});
      }
    });

    // ----- draft -----
    var draft = ((D.draftDetail || {}).picks || []).filter(function (p) { return or(p.playerId, -1) !== -1; })
      .sort(function (a, b) { return or(a.overallPickNumber, 0) - or(b.overallPickNumber, 0); })
      .map(function (p) {
        return {overall_pick: p.overallPickNumber, round: p.roundId, pick_in_round: p.roundPickNumber,
          team: tn(p.teamId, ''), player: pname(p.playerId), pos: ppos(p.playerId),
          now_on: has(fantasyTeam, p.playerId) ? fantasyTeam[p.playerId] : 'free agent', player_id: p.playerId};
      });

    // ----- transactions (executed adds, drops, trades) -----
    var kinds = {FREEAGENT: 'free agent pickup', WAIVER: 'waiver claim', TRADE_ACCEPT: 'trade', TRADE_UPHOLD: 'trade'};
    var transactions = [], seen = new Set();
    txRaw.slice().sort(function (a, b) {
      var d = or(a.proposedDate, 0) - or(b.proposedDate, 0);
      if (d) return d;
      var x = or(a.id, ''), y = or(b.id, '');
      return x < y ? -1 : (x > y ? 1 : 0);
    }).forEach(function (x) {
      if (x.status !== 'EXECUTED' || !kinds[x.type]) return;
      (x.items || []).forEach(function (i) {
        if (['ADD', 'DROP', 'TRADE'].indexOf(i.type) < 0) return;
        var key = [kinds[x.type], i.type, i.playerId, i.fromTeamId, i.toTeamId, x.scoringPeriodId].join('|');
        if (kinds[x.type] === 'trade' && seen.has(key)) return;
        seen.add(key);
        transactions.push({date_utc: when(or(x.proposedDate, 0)), week: x.scoringPeriodId, team: tn(x.teamId, ''),
          kind: kinds[x.type], action: (i.type || '').toLowerCase(), player: pname(i.playerId), pos: ppos(i.playerId),
          from: tn(i.fromTeamId, 'free agents'), to: tn(i.toTeamId, 'free agents'), player_id: i.playerId});
      });
    });

    var baseCols = ['player', 'pos', 'nfl_team', 'bye_week', 'injury', 'game_started', 'season_pts', 'avg_pts', 'last_week_pts',
      'this_week_pts_so_far', 'this_week_proj', 'rest_of_season_proj', 'pct_rostered', 'pct_rostered_change'];
    var tables = {
      teams: {cols: ['team_id', 'team', 'abbrev', 'owners', 'wins', 'losses', 'ties', 'points_for', 'points_against',
        'streak', 'standing', 'waiver_order', 'adds_made', 'trades_made', 'players_rostered',
        'open_roster_spots', 'open_ir_spots'], rows: teams},
      rosters: {cols: ['team', 'slot', 'starting'].concat(baseCols, ['acquired_by', 'team_id', 'player_id']), rows: rosters},
      matchups: {cols: ['week', 'status', 'home_team', 'home_pts', 'away_team', 'away_pts', 'winner',
        'home_projected_final', 'away_projected_final', 'home_win_pct', 'away_win_pct', 'playoffs'], rows: matchups},
      free_agents: {cols: baseCols.concat(['availability', 'player_id']), rows: freeAgents},
      player_weeks: {cols: ['player', 'pos', 'fantasy_team', 'week', 'actual_pts', 'projected_pts', 'player_id'], rows: playerWeeks},
      draft: {cols: ['overall_pick', 'round', 'pick_in_round', 'team', 'player', 'pos', 'now_on', 'player_id'], rows: draft},
      transactions: {cols: ['date_utc', 'week', 'team', 'kind', 'action', 'player', 'pos', 'from', 'to', 'player_id'], rows: transactions}
    };
    return {tables: tables, rules: rulesText(L, week), week: week,
      leagueName: (L.settings || {}).name || 'Bourbon Boys',
      pulledAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'};
  }

  function rulesText(L, week) {
    var s = L.settings || {};
    var out = ['# ' + (s.name || 'Bourbon Boys') + ' - league rules (ESPN league ' + LEAGUE_ID + ', season ' + SEASON + ')', '',
      'Currently NFL week ' + week + '. ' + (s.size || L.teams.length) + ' teams. Head-to-head, one matchup per week.', '',
      'Every points number in these data files (season, weekly, projections) was already calculated by ESPN',
      "under THIS league's scoring below. Do not re-score players with standard or generic PPR assumptions.", '',
      '## Lineup'];
    var counts = (s.rosterSettings || {}).lineupSlotCounts || {};
    var names = {0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 23: 'FLEX (RB/WR/TE)', 16: 'D/ST', 17: 'K', 20: 'bench', 21: 'IR'};
    var parts = [];
    [0, 2, 4, 6, 23, 16, 17, 20, 21].forEach(function (sid) {
      var n = counts[String(sid)] || 0;
      if (n) parts.push(n + ' ' + names[sid]);
    });
    out.push('Start: ' + parts.join(', ') + '.' + (counts['17'] ? '' : ' There is NO kicker.'));
    out.push('', '## Scoring (points per event)');
    var items = {};
    ((s.scoringSettings || {}).scoringItems || []).forEach(function (i) { items[i.statId] = i; });
    function val(i) {
      var ov = i.pointsOverrides || {};
      return ((i.points || 0) === 0 && ov['16'] !== undefined) ? ov['16'] : i.points;
    }
    function dstOnly(i) { return (i.points || 0) === 0 && (i.pointsOverrides || {})['16'] !== undefined; }
    var ids = Object.keys(items).map(Number);
    var ordered = STAT_ORDER.filter(function (k) { return items[k] !== undefined; })
      .concat(ids.filter(function (k) { return STAT_ORDER.indexOf(k) < 0; }).sort(function (a, b) { return a - b; }));
    ordered.forEach(function (k) {
      if (KICKER_STATS.indexOf(k) >= 0) return;
      var v = val(items[k]);
      if (!v) return;
      var label = STAT_NAMES[k] || ((dstOnly(items[k]) ? 'D/ST: other defensive stat' : 'Other') + ' (ESPN stat #' + k + ')');
      out.push('- ' + label + ': ' + num(v));
    });
    out.push('', 'What is unusual here: full PPR PLUS 1 point for every first down (passing, rushing and receiving).',
      'That inflates QB totals a lot (only 1 QB starts, so they are not worth as much as the raw totals suggest)',
      'and makes high-volume, chain-moving RBs, WRs and TEs worth more than in a normal PPR league.',
      'Passing TDs are worth less than rushing/receiving TDs.');
    var acq = s.acquisitionSettings || {};
    out.push('', '## Waivers and trades');
    if (acq.isUsingAcquisitionBudget) {
      out.push('- Free-agent bidding (FAAB) with a $' + acq.acquisitionBudget + ' budget.');
    } else {
      out.push('- Traditional waivers, no bidding. Priority is the waiver_order column in teams.csv (1 = first). ' +
        'A successful claim sends that team to the back of the line.');
    }
    var days = (acq.waiverProcessDays || []).map(function (d) { return d.charAt(0).toUpperCase() + d.slice(1).toLowerCase(); });
    if (days.length) {
      out.push('- Claims process on: ' + days.join(', ') + ', around ' + acq.waiverProcessHour + ':00 UTC (7am US Eastern in daylight time, 6am in winter). ' +
        'Dropped players sit on waivers for ' + acq.waiverHours + ' hours.');
    }
    out.push('- A player whose game has started is locked for the week: he cannot be moved in the lineup, and he cannot be the player you drop in a claim.');
    var tr = s.tradeSettings || {};
    if (tr.deadlineDate) out.push('- Trade deadline: ' + when(tr.deadlineDate) + ' UTC. Votes needed to veto a trade: ' + tr.vetoVotesRequired + '.');
    var sch = s.scheduleSettings || {};
    out.push('', "## Reading the data files",
      "- season_pts and avg_pts include any game already played in the current week, so mid-week some players have one more game counted than others.",
      "- game_started = yes means that player's game this week has kicked off: he is locked in place and cannot be dropped as part of a claim.",
      "- A 0 can mean he played and scored nothing, or that he did not play. Check news before reading much into it.",
      "- pct_rostered is the share of ALL ESPN leagues that roster the player (a popularity signal), not this league. pct_rostered_change is the 7-day trend.",
      "- injury is ESPN's tag: blank = healthy, else QUESTIONABLE, DOUBTFUL, OUT, INJURY_RESERVE, SUSPENSION. ESPN generally only lets OUT and INJURY_RESERVE players sit in the IR slot.",
      "- free_agents.csv is the 300 most-rostered available players, sorted by pct_rostered (not by quality). availability: 'free agent' can be added instantly with no effect on waiver order; both 'on waivers' kinds need a claim, which uses waiver priority.",
      "- teams.csv shows open_roster_spots and open_ir_spots. A team with an open spot can add a player without dropping anyone.",
      "- player_weeks.csv has actual points for every week so far; projected_pts is only available for the current week.");
    out.push('', '## Season', '- Regular season: ' + sch.matchupPeriodCount + ' weeks. ' + sch.playoffTeamCount + ' teams make the playoffs.');
    return out.join('\n') + '\n';
  }

  // ---------- the paste-into-any-AI block ----------
  function pad(s, n) { s = String(s === '' || s === null || s === undefined ? '-' : s); return s.length >= n ? s : s + new Array(n - s.length + 1).join(' '); }
  function rosterLines(rows, full) {
    if (full) {
      var out = ['slot  | player                   | pos | nfl | bye | injury       | game started | season | avg   | last wk | this wk so far | this wk proj | rest-of-season proj'];
      rows.forEach(function (r) {
        out.push([pad(r.slot, 5), pad(r.player, 24), pad(r.pos, 3), pad(r.nfl_team, 3), pad(r.bye_week, 3), pad(r.injury, 12), pad(r.game_started, 12), pad(r.season_pts, 6),
          pad(r.avg_pts, 5), pad(r.last_week_pts, 7), pad(r.this_week_pts_so_far, 14), pad(r.this_week_proj, 12), r.rest_of_season_proj || '-'].join(' | '));
      });
      return out;
    }
    return rows.map(function (r) {   // compact: season pts / this week's projection / rest-of-season projection
      return '  ' + pad(r.slot, 5) + ' ' + r.player + ' (' + r.pos + ' ' + r.nfl_team + ' bye' + (r.bye_week || '-') + (r.injury ? ' ' + r.injury : '') +
        ') ' + (r.season_pts || '-') + ' / ' + (r.this_week_proj || '-') + ' / ' + (r.rest_of_season_proj || '-');
    });
  }
  function copyText(teamId) {
    var d = api.data;
    if (!d) throw new Error('Pull the league data first.');
    var T = d.tables, week = d.week, out = [];
    teamId = Number(teamId) || 0;
    var me = T.teams.rows.filter(function (t) { return t.team_id === teamId; })[0];
    out.push('BOURBON BOYS FANTASY LEAGUE DATA - pulled ' + d.pulledAt + ', during NFL week ' + week + '.');
    out.push('Source: ESPN league ' + LEAGUE_ID + ' (public, read-only). Everything below is real league data, not an example.');
    if (me) out.push('MY TEAM IS: ' + me.team + ' (owners: ' + me.owners + '). Please give advice for this team. Open roster spots: ' +
      me.open_roster_spots + ', open IR spots: ' + me.open_ir_spots + ', waiver order: ' + me.waiver_order + '.');
    else out.push('(No team was picked. Ask me which team is mine before giving advice.)');
    // The paste block keeps offense scoring in full and boils the long D/ST table down to one line.
    var dstShown = false;
    d.rules.trim().split('\n').forEach(function (line) {
      var isDst = /^- (D\/ST|Kickoff return|Punt return|Interception return|Fumble return|2-pt conversion return|1-pt safety)/.test(line);
      if (!isDst) { out.push(line); return; }
      if (!dstShown) { out.push('- D/ST: sacks 1, turnovers 2, TDs 6, plus points-allowed and yards-allowed tiers (full table is in league_rules.md in the CSV download).'); dstShown = true; }
    });
    out.push('', '== STANDINGS ==');
    T.teams.rows.forEach(function (t) {
      out.push(pad(t.standing + '.', 4) + pad(t.team, 32) + ' ' + t.wins + '-' + t.losses + '-' + t.ties + '  PF ' + t.points_for + '  PA ' + t.points_against +
        '  waiver order ' + t.waiver_order + '  (' + t.owners + ')');
    });
    function matchLine(m) {
      var s = m.home_team + ' ' + (m.home_pts || '0') + '  vs  ' + m.away_team + ' ' + (m.away_pts || '0');
      if (m.status === 'in progress') s += '   [projected final ' + m.home_projected_final + ' - ' + m.away_projected_final + ', win odds ' + m.home_win_pct + '% / ' + m.away_win_pct + '%]';
      if (m.winner) s += '   winner: ' + m.winner;
      return s;
    }
    var cur = T.matchups.rows.filter(function (m) { return m.status === 'in progress'; });
    if (cur.length) { out.push('', '== THIS WEEK (week ' + cur[0].week + ', in progress) =='); cur.forEach(function (m) { out.push(matchLine(m)); }); }
    var finals = T.matchups.rows.filter(function (m) { return m.status === 'final'; });
    if (finals.length) {
      var lastWk = finals[finals.length - 1].week;
      out.push('', '== LAST COMPLETED WEEK (week ' + lastWk + ') ==');
      finals.filter(function (m) { return m.week === lastWk; }).forEach(function (m) { out.push(matchLine(m)); });
    }
    var oppName = '';
    if (me) {
      cur.forEach(function (m) { if (m.home_team === me.team) oppName = m.away_team; else if (m.away_team === me.team) oppName = m.home_team; });
      out.push('', '== MY ROSTER: ' + me.team + ' ==');
      out = out.concat(rosterLines(T.rosters.rows.filter(function (r) { return r.team_id === teamId; }), true));
      if (oppName) {
        out.push('', "== THIS WEEK'S OPPONENT: " + oppName + ' ==');
        out = out.concat(rosterLines(T.rosters.rows.filter(function (r) { return r.team === oppName; }), true));
      }
    }
    out.push('', '== ' + (me ? 'OTHER ' : 'ALL ') + 'ROSTERS ==  (numbers are: season points / this week projection / rest-of-season projection)');
    T.teams.rows.forEach(function (t) {
      if (me && (t.team_id === teamId || t.team === oppName)) return;
      out.push(t.team + ':');
      out = out.concat(rosterLines(T.rosters.rows.filter(function (r) { return r.team_id === t.team_id; }), false));
    });
    function n(v) { return v === '' ? -1e9 : Number(v); }
    function faLine(r) {
      return '  ' + pad(r.player, 24) + ' ' + pad(r.pos, 3) + ' ' + pad(r.nfl_team, 3) + ' bye ' + pad(r.bye_week, 2) + ' ' + pad(r.injury, 12) +
        ' season ' + pad(r.season_pts, 6) + ' last wk ' + pad(r.last_week_pts, 6) + ' this wk proj ' + pad(r.this_week_proj, 6) +
        ' ROS proj ' + pad(r.rest_of_season_proj, 7) + ' rostered ' + r.pct_rostered + '% (' + r.availability + ')';
    }
    out.push('', '== BEST AVAILABLE FREE AGENTS (by rest-of-season projection, under our scoring) ==');
    [['QB', 8], ['RB', 15], ['WR', 15], ['TE', 10], ['DST', 8]].forEach(function (pn) {
      out.push(pn[0] + ':');
      T.free_agents.rows.filter(function (r) { return r.pos === pn[0]; })
        .sort(function (a, b) { return n(b.rest_of_season_proj) - n(a.rest_of_season_proj); }).slice(0, pn[1]).forEach(function (r) { out.push(faLine(r)); });
    });
    out.push('', '== FREE AGENTS WHO SCORED THE MOST LAST WEEK ==');
    T.free_agents.rows.slice().sort(function (a, b) { return n(b.last_week_pts) - n(a.last_week_pts); }).slice(0, 15).forEach(function (r) { out.push(faLine(r)); });
    out.push('', '== LAST 25 ROSTER MOVES (oldest first) ==');
    T.transactions.rows.slice(-25).forEach(function (x) {
      out.push(x.date_utc + ' UTC  ' + x.team + ': ' + x.kind + ', ' + x.action + ' ' + x.player + ' (' + x.pos + ')' + (x.action === 'trade' ? ' from ' + x.from + ' to ' + x.to : ''));
    });
    out.push('', 'The full tables (every free agent, week-by-week points, the whole draft) are in the CSV download on the same page.');
    return out.join('\n') + '\n';
  }

  // ---------- files ----------
  function files() {
    var d = api.data;
    if (!d) throw new Error('Pull the league data first.');
    var out = [];
    Object.keys(d.tables).forEach(function (name) { out.push({name: name + '.csv', text: toCSV(d.tables[name].cols, d.tables[name].rows)}); });
    out.push({name: 'league_rules.md', text: d.rules});
    out.push({name: 'pulled_at.txt', text: 'Pulled ' + d.pulledAt + ', during NFL week ' + d.week + '.\n'});
    return out;
  }
  var CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = [];
      for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC_TABLE[n] = c >>> 0; }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function zipBytes(list, folder) {   // plain "store" zip, no compression, no libraries
    var enc = new TextEncoder(), parts = [], central = [], offset = 0, now = new Date();
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    list.forEach(function (f) {
      var name = enc.encode(folder + '/' + f.name), data = enc.encode(f.text), crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, list.length, true); end.setUint16(10, list.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    var all = parts.concat(central, [new Uint8Array(end.buffer)]);
    var total = all.reduce(function (a, b) { return a + b.length; }, 0), outBytes = new Uint8Array(total), pos = 0;
    all.forEach(function (b) { outBytes.set(b, pos); pos += b.length; });
    return outBytes;
  }
  function save(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  function downloadCSVs() { save(new Blob([zipBytes(files(), 'bourbon-boys-data')], {type: 'application/zip'}), 'bourbon-boys-data.zip'); }
  function downloadAIText(teamId) { save(new Blob([copyText(teamId)], {type: 'text/plain'}), 'bourbon-boys-for-my-ai.txt'); }
  function copyToClipboard(teamId) {
    var text = copyText(teamId);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove(); return ok;
  }

  // ---------- rendering: real text only, every value set with textContent (team names are user-typed) ----------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function tableEl(name, cols, rows) {
    var t = el('table', 'bb-table bb-table-' + name), thead = el('thead'), tr = el('tr');
    cols.forEach(function (c) { tr.appendChild(el('th', '', c.replace(/_/g, ' '))); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el('tbody');
    rows.forEach(function (r) { var row = el('tr'); cols.forEach(function (c) { row.appendChild(el('td', '', cell(r[c]).replace(/^"|"$/g, ''))); }); tb.appendChild(row); });
    t.appendChild(tb); return t;
  }
  function renderInto(target, teamId) {
    var d = api.data;
    if (!d) throw new Error('Pull the league data first.');
    target.textContent = '';
    target.appendChild(el('p', 'bb-status', 'League data pulled at ' + d.pulledAt + ', during NFL week ' + d.week + '. Straight from ESPN, read-only.'));
    target.appendChild(el('h2', 'bb-heading', 'Everything your AI needs (this is what "Copy for my AI" copies)'));
    target.appendChild(el('pre', 'bb-ai-text', copyText(teamId)));
    var T = d.tables, show = [['teams', 'Standings'], ['rosters', 'Every roster'], ['matchups', 'Schedule and scores'], ['free_agents', 'Free agents'], ['transactions', 'Roster moves']];
    show.forEach(function (s) {
      var det = el('details', 'bb-section bb-section-' + s[0]);
      det.appendChild(el('summary', '', s[1] + ' (' + T[s[0]].rows.length + ' rows)'));
      var hide = ['team_id', 'player_id'];
      det.appendChild(tableEl(s[0], T[s[0]].cols.filter(function (c) { return hide.indexOf(c) < 0; }), T[s[0]].rows));
      target.appendChild(det);
    });
  }

  var api = {
    LEAGUE_ID: LEAGUE_ID, SEASON: SEASON, data: null,
    pull: function (opts) { return build((opts || {}).onProgress).then(function (d) { api.data = d; return d; }); },
    teams: function () {
      if (api.data) return api.data.tables.teams.rows.map(function (t) { return {id: t.team_id, name: t.team, owners: t.owners}; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      return FALLBACK_TEAMS.map(function (t) { return {id: t[0], name: t[1], owners: ''}; });
    },
    renderInto: renderInto, copyText: copyText, copyToClipboard: copyToClipboard,
    downloadCSVs: downloadCSVs, downloadAIText: downloadAIText, files: files, zipBytes: zipBytes
  };
  root.BBPull = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
