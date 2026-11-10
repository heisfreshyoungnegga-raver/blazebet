// ESPN fixture sync (keyless ESPN scoreboards), ported from the
// xlotbet reference (api/_espn.js) to this backend's zero-dep db layer
// (one/all/run/getSetting/setSetting from ./db; node fetch built-in).
// Upserts matches by espn_event_id, stores logos/scores/status
// (upcoming/live/finished), and auto-settles finished matches' legs
// (credit winners exactly once, idempotent via wallet idem keys and
// bets.settled_at).
const db = require('./db');
const { one, all, run, getSetting, setSetting } = db;
const wallet = require('./wallet');
const { settleLeg } = require('./markets');

const LEAGUES = {
  'eng.1': 'England Premier League',
  'esp.1': 'Spain LaLiga',
  'ita.1': 'Italy Serie A',
  'ger.1': 'Germany Bundesliga',
  'fra.1': 'France Ligue 1',
  'por.1': 'Portugal Primeira Liga',
  'ned.1': 'Netherlands Eredivisie',
  'uefa.champions': 'UEFA Champions League',
  'uefa.europa': 'UEFA Europa League',
  'gha.1': 'Ghana Premier League',
  'usa.1': 'MLS',
  'uefa.nations': 'UEFA Nations League',
  'concacaf.nations.league': 'CONCACAF Nations League',
  'fifa.friendly': 'International Friendlies',
};

function americanToDecimal(v) {
  const n = Number(String(v).replace('+', ''));
  if (!Number.isFinite(n) || n === 0) return null;
  const dec = n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
  return Math.round(dec * 100) / 100;
}
function logoOf(team) {
  if (!team) return null;
  if (team.logo) return team.logo;
  if (Array.isArray(team.logos) && team.logos[0] && team.logos[0].href) return team.logos[0].href;
  if (team.id) return 'https://a.espncdn.com/i/teamlogos/soccer/500/' + team.id + '.png';
  return null;
}
function poissonCdf(k, mu) {
  let term = Math.exp(-mu), sum = term;
  for (let i = 1; i <= k; i++) { term *= mu / i; sum += term; }
  return sum;
}
function solveMu(pOver25) {
  let lo = 0.3, hi = 7;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = 1 - poissonCdf(2, mid);
    if (p < pOver25) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
function addTotalLadder(odds) {
  if (!odds.over25 || !odds.under25) return;
  const rawOver = 1 / odds.over25, rawUnder = 1 / odds.under25;
  const margin = rawOver + rawUnder;
  const mu = solveMu(rawOver / margin);
  [0.5, 1.5, 3.5, 4.5].forEach(line => {
    const suffix = String(line).replace('.', '');
    const pOver = 1 - poissonCdf(Math.floor(line), mu);
    const pUnder = 1 - pOver;
    if (pOver < 0.03 || pOver > 0.97) return;
    const o = Math.round((1 / pOver) / margin * 100) / 100;
    const u = Math.round((1 / pUnder) / margin * 100) / 100;
    if (o > 1.01) odds['over' + suffix] = o;
    if (u > 1.01) odds['under' + suffix] = u;
  });
}
function oddsFromEspn(comp) {
  const o = (comp.odds || [])[0];
  if (!o) return {};
  const odds = {};
  const ml = o.moneyline || {};
  const home = americanToDecimal(ml.home && ml.home.close && ml.home.close.odds);
  const away = americanToDecimal(ml.away && ml.away.close && ml.away.close.odds);
  const draw = americanToDecimal((o.drawOdds && o.drawOdds.moneyLine) ?? (ml.draw && ml.draw.close && ml.draw.close.odds));
  if (home) odds.o1 = home;
  if (draw) odds.ox = draw;
  if (away) odds.o2 = away;
  const tot = o.total || {};
  const totLine = /^o(\d+\.\d)$/.exec((tot.over && tot.over.close && tot.over.close.line) || '');
  if (totLine) {
    const suffix = totLine[1].replace('.', '');
    const over = americanToDecimal(tot.over.close.odds);
    const under = americanToDecimal(tot.under && tot.under.close && tot.under.close.odds);
    if (over) odds['over' + suffix] = over;
    if (under) odds['under' + suffix] = under;
  }
  addTotalLadder(odds);
  if (odds.o1 && odds.ox) odds.dc1x = Math.round((odds.o1 * odds.ox) / (odds.o1 + odds.ox) * 100) / 100;
  if (odds.o1 && odds.o2) odds.dc12 = Math.round((odds.o1 * odds.o2) / (odds.o1 + odds.o2) * 100) / 100;
  if (odds.ox && odds.o2) odds.dcx2 = Math.round((odds.ox * odds.o2) / (odds.ox + odds.o2) * 100) / 100;
  Object.keys(odds).forEach(k => { if (!(odds[k] > 1)) delete odds[k]; });
  return odds;
}
function mapEvent(ev, leagueName) {
  const comp = (ev.competitions || [])[0];
  if (!comp) return null;
  const home = comp.competitors.find(c => c.homeAway === 'home');
  const away = comp.competitors.find(c => c.homeAway === 'away');
  if (!home || !away) return null;
  const stateName = ev.status && ev.status.type && ev.status.type.state;
  const status = stateName === 'in' ? 'live' : stateName === 'post' ? 'finished' : 'upcoming';
  return {
    espn_event_id: 'espn:' + ev.id,
    league: leagueName,
    home: home.team.displayName || home.team.name,
    away: away.team.displayName || away.team.name,
    home_logo: logoOf(home.team),
    away_logo: logoOf(away.team),
    starts_at: ev.date,
    status,
    home_score: Number(home.score || 0),
    away_score: Number(away.score || 0),
    odds: oddsFromEspn(comp),
  };
}

async function upsertMatch(m) {
  const existing = await one('SELECT id FROM matches WHERE espn_event_id=?', m.espn_event_id);
  let id, isNew = false;
  if (existing) {
    id = existing.id;
    await run('UPDATE matches SET league=?,home=?,away=?,starts_at=?,status=?,home_score=?,away_score=?,home_logo=?,away_logo=? WHERE id=?',
      m.league, m.home, m.away, m.starts_at, m.status, m.home_score, m.away_score, m.home_logo, m.away_logo, id);
  } else {
    const r = await run('INSERT INTO matches(league,home,away,starts_at,status,home_score,away_score,espn_event_id,home_logo,away_logo) VALUES(?,?,?,?,?,?,?,?,?,?)',
      m.league, m.home, m.away, m.starts_at, m.status, m.home_score, m.away_score, m.espn_event_id, m.home_logo, m.away_logo);
    id = Number(r.id); isNew = true;
  }
  // ESPN 1X2 wins where present; never blank odds the admin priced.
  if (m.odds.o1 && m.odds.ox && m.odds.o2) {
    await setSetting('match_odds:' + id, [m.odds.o1, m.odds.ox, m.odds.o2]);
  }
  return { id, isNew };
}

// Settle every pending leg on one finished match from its final score,
// then settle any open bets whose legs are all decided. Idempotent:
// legs already settled are skipped and wallet.post dedupes on the
// 'settle:<betId>' idempotency key. Returns bets settled.
async function settleFinishedMatch(matchId, hs, as) {
  const legs = await all("SELECT * FROM bet_legs WHERE match_id=? AND status='pending'", matchId);
  const affected = new Set();
  for (const leg of legs) {
    const outcome = settleLeg(leg.market || '1X2', leg.pick, hs, as);
    if (!outcome) continue; // undecidable from the score (e.g. HT markets)
    await run('UPDATE bet_legs SET status=? WHERE id=? AND status=?', outcome, leg.id, 'pending');
    affected.add(leg.bet_id);
  }
  let settled = 0;
  for (const betId of affected) {
    const bet = await one("SELECT * FROM bets WHERE id=? AND status='open'", betId);
    if (!bet) continue;
    const bl = await all('SELECT status,odds FROM bet_legs WHERE bet_id=?', betId);
    if (bl.some(l => l.status === 'pending')) continue;
    const lost = bl.some(l => l.status === 'lost');
    const payout = lost ? 0 : Math.floor(bet.stake_minor * bl.filter(l => l.status === 'won').reduce((a, l) => a * l.odds, 1));
    const won = payout > 0;
    try {
      await db.tx(async () => {
        await run("UPDATE bets SET status=?,payout_minor=?,settled_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'", won ? 'won' : 'lost', payout, betId);
        if (won) await wallet.post(bet.user_id, 'main', payout, 'bet_payout', 'bet:' + betId, 'settle:' + betId);
      });
      settled++;
    } catch (e) { /* idempotency / race: already settled */ }
  }
  return settled;
}

function ymdOf(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ---- B2: chunked sync (one league x one day per chunk) ----
// A serverless invocation has ~10-15s; a single ESPN day-fetch carries
// its own 8s abort, so one (league, dayOffset) pair is the largest unit
// that reliably fits. Rotation state lives in the 'espn_sync_cursor'
// settings row: { leagueIndex, offsetIndex } into LEAGUES x
// ROTATION_OFFSETS. Offsets put today first so live scores refresh
// before yesterday/tomorrow's fixtures.
const CHUNK_TIME_BUDGET_MS = 8000;
const ESPN_CURSOR_KEY = 'espn_sync_cursor';
const ROTATION_OFFSETS = [0, -1, 1, 2, 3];
function leagueSlugs() { return Object.keys(LEAGUES); }

// Sync one league x one day offset. opts: { league, dayOffset = 0,
// fetchFn?, timeBudgetMs? }. Upserts are idempotent and settlement is
// idempotent, so re-running a chunk is safe. Returns the chunk report;
// partial:true means the time budget ran out mid-chunk (the caller
// must NOT advance the cursor - the same chunk re-runs next time).
async function syncChunk(opts = {}) {
  const started = Date.now();
  const slug = opts.league;
  const offset = opts.dayOffset == null ? 0 : opts.dayOffset;
  const fetchFn = opts.fetchFn || fetch;
  const budget = opts.timeBudgetMs || CHUNK_TIME_BUDGET_MS;
  if (!LEAGUES[slug]) throw new Error('unknown_league:' + slug);
  const out = { league: slug, dayOffset: offset, matches: 0, with_odds: 0, imported: 0, updated: 0, settled: 0, failed: false, partial: false };
  let data;
  try { data = await fetchDay(fetchFn, slug, ymdOf(offset)); }
  catch (e) { out.failed = true; out.error = String((e && e.message) || e); out.ms = Date.now() - started; return out; }
  const leagueName = (data.leagues && data.leagues[0] && data.leagues[0].name) || LEAGUES[slug];
  for (const ev of data.events || []) {
    if (Date.now() - started > budget) { out.partial = true; break; }
    const m = mapEvent(ev, leagueName);
    if (!m) continue;
    const { isNew } = await upsertMatch(m);
    if (isNew) out.imported++; else out.updated++;
    out.matches++;
    if (m.odds.o1) out.with_odds++;
    if (m.status === 'finished') {
      const row = await one('SELECT id,home_score,away_score FROM matches WHERE espn_event_id=?', m.espn_event_id);
      if (row) out.settled += await settleFinishedMatch(row.id, row.home_score, row.away_score);
    }
  }
  out.ms = Date.now() - started;
  return out;
}

// Run as many chunks as fit in the time budget (default 8s), advancing
// the stored cursor after each completed chunk. This is what the cron
// endpoint calls once per invocation: GET/POST /api/cron/espn-sync
// (guarded by CRON_SECRET - see vercel.json). Returns
// { chunks, cursor: { league, dayOffset }, wrapped, live } where
// wrapped means a full 14-league x 5-offset rotation finished inside
// this invocation. A failed chunk still advances the cursor (it is
// retried on the next rotation); a partial chunk does not.
async function syncNextChunk(opts = {}) {
  const started = Date.now();
  const budget = opts.timeBudgetMs || CHUNK_TIME_BUDGET_MS;
  const fetchFn = opts.fetchFn || fetch;
  const slugs = leagueSlugs();
  const offsets = ROTATION_OFFSETS;
  let cursor = await getSetting(ESPN_CURSOR_KEY, { leagueIndex: 0, offsetIndex: 0 });
  if (!cursor || !Number.isInteger(cursor.leagueIndex) || !Number.isInteger(cursor.offsetIndex)) cursor = { leagueIndex: 0, offsetIndex: 0 };
  cursor.leagueIndex = ((cursor.leagueIndex % slugs.length) + slugs.length) % slugs.length;
  cursor.offsetIndex = ((cursor.offsetIndex % offsets.length) + offsets.length) % offsets.length;
  const chunks = [];
  let wrapped = false;
  while (Date.now() - started < budget) {
    const chunk = await syncChunk({ league: slugs[cursor.leagueIndex], dayOffset: offsets[cursor.offsetIndex], fetchFn, timeBudgetMs: budget });
    chunks.push(chunk);
    if (chunk.partial) break; // cursor stays: same chunk re-runs next time
    cursor.offsetIndex++;
    if (cursor.offsetIndex >= offsets.length) {
      cursor.offsetIndex = 0;
      cursor.leagueIndex++;
      if (cursor.leagueIndex >= slugs.length) { cursor.leagueIndex = 0; wrapped = true; }
    }
    await setSetting(ESPN_CURSOR_KEY, cursor);
    if (wrapped) break; // at most one full rotation per invocation
  }
  const live = (await one("SELECT COUNT(*) c FROM matches WHERE status='live'")).c;
  return { chunks, cursor: { league: slugs[cursor.leagueIndex], dayOffset: offsets[cursor.offsetIndex] }, wrapped, live };
}

module.exports = { LEAGUES, mapEvent, oddsFromEspn, upsertMatch, settleFinishedMatch, syncLeagues, syncChunk, syncNextChunk, CHUNK_TIME_BUDGET_MS, ESPN_CURSOR_KEY, ROTATION_OFFSETS, americanToDecimal };
async function fetchDay(fetchFn, slug, ymd) {
  const r = await fetchFn('https://site.api.espn.com/apis/site/v2/sports/soccer/' + slug + '/scoreboard?dates=' + ymd + '&limit=100', {
    headers: { 'User-Agent': 'BlazeBet/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('espn_' + r.status);
  return r.json();
}

// Full sweep: every league, one scoreboard per day offset.
// opts: { leagues?: string[], offsets?: number[], fetchFn?, timeBudgetMs? }
//
// CHUNK-SAFE (B2): a serverless invocation cannot afford the old
// 14-league x 5-day synchronous sweep (far beyond the 10-15s function
// limit). The sweep now runs one (league, day-offset) chunk at a time
// and stops when timeBudgetMs (default 8000) is spent, returning
// { partial: true, next: { league, dayOffset } } so the caller can
// resume. The default sweep persists its position in the
// 'espn_sync_cursor' settings row, so repeated invocations (cron or
// repeated admin clicks) rotate through leagues instead of restarting.
// Explicit opts.leagues / opts.offsets (tests, one-off admin sweeps)
// always start at the top and never touch the stored cursor.
async function syncLeagues(opts = {}) {
  const started = Date.now();
  const budget = opts.timeBudgetMs || CHUNK_TIME_BUDGET_MS;
  const fetchFn = opts.fetchFn || fetch;
  const explicit = !!(opts.leagues || opts.offsets);
  const slugs = opts.leagues || leagueSlugs();
  const offsets = opts.offsets || ROTATION_OFFSETS;
  let li = 0, oi = 0;
  if (!explicit) {
    const c = await getSetting(ESPN_CURSOR_KEY, { leagueIndex: 0, offsetIndex: 0 });
    if (c && Number.isInteger(c.leagueIndex)) li = ((c.leagueIndex % slugs.length) + slugs.length) % slugs.length;
    if (c && Number.isInteger(c.offsetIndex)) oi = ((c.offsetIndex % offsets.length) + offsets.length) % offsets.length;
  }
  const report = {};
  let imported = 0, updated = 0, settled = 0, partial = false;
  outer: for (; li < slugs.length; li++) {
    for (; oi < offsets.length; oi++) {
      if (Date.now() - started > budget) { partial = true; break outer; }
      const chunk = await syncChunk({ league: slugs[li], dayOffset: offsets[oi], fetchFn, timeBudgetMs: budget });
      const r = report[slugs[li]] || (report[slugs[li]] = { matches: 0, with_odds: 0, failed: false });
      r.matches += chunk.matches; r.with_odds += chunk.with_odds; r.failed = r.failed || chunk.failed;
      imported += chunk.imported; updated += chunk.updated; settled += chunk.settled;
      if (chunk.partial) { partial = true; break outer; }
      if (!explicit) {
        let nli = li, noi = oi + 1;
        if (noi >= offsets.length) { noi = 0; nli = li + 1; }
        await setSetting(ESPN_CURSOR_KEY, nli >= slugs.length ? { leagueIndex: 0, offsetIndex: 0 } : { leagueIndex: nli, offsetIndex: noi });
      }
    }
    oi = 0; // the next league starts at its first offset
  }
  const live = (await one("SELECT COUNT(*) c FROM matches WHERE status='live'")).c;
  return {
    report, imported, updated, settled, live, partial,
    next: partial ? { league: slugs[li], dayOffset: offsets[oi] } : { league: slugs[0], dayOffset: offsets[0] },
  };
}
