// Parity-build tests: ESPN sync (stubbed feed), full market book,
// booking-code load, provider guards, withdrawal rule, admin matches.
process.env.BLAZEBET_DB = require('node:path').join(__dirname, 'test5.db');
for (const suf of ['', '-wal', '-shm']) require('node:fs').rmSync(process.env.BLAZEBET_DB + suf, { force: true });
const assert = require('node:assert');
const { expandOdds, marketsFromBook, lookupOdds, settleLeg } = require('../src/markets');
const espn = require('../src/espn');

(async () => {
  // ---- markets unit ----
  const flat = expandOdds(2.0, 3.5, 4.0);
  for (const k of ['o1', 'ox', 'o2', 'dc1x', 'dc12', 'dcx2', 'over25', 'under25', 'over05', 'under45', 'gg', 'ng'])
    assert(flat[k] > 1, 'expandOdds missing ' + k);
  const book = marketsFromBook([2.0, 3.5, 4.0]);
  const groups = Object.keys(book);
  assert(groups.length >= 10, 'market groups >= 10, got ' + groups.length + ': ' + groups.join(','));
  for (const g of ['1X2', 'DC', 'OU25', 'BTTS', 'HT1X2', 'CS', 'DNB', 'WTN']) assert(book[g], 'missing market ' + g);
  assert.strictEqual(lookupOdds([2.0, 3.5, 4.0], '1X2', '1'), 2.0, '1X2 price is the stored book, byte-identical');
  assert.strictEqual(lookupOdds([2.0, 3.5, 4.0], '1X2', 'X'), 3.5);
  assert(lookupOdds([2.0, 3.5, 4.0], 'BTTS', 'Yes') > 1);
  assert.strictEqual(lookupOdds([2.0, 3.5, 4.0], 'NOPE', '1'), null);
  assert.strictEqual(lookupOdds([2.0, 3.5, 4.0], 'CS', '2:1') > 1, true);
  assert.strictEqual(settleLeg('1X2', '1', 2, 1), 'won');
  assert.strictEqual(settleLeg('1X2', 'X', 2, 1), 'lost');
  assert.strictEqual(settleLeg('DNB', '1', 1, 1), 'void');
  assert.strictEqual(settleLeg('BTTS', 'Yes', 2, 1), 'won');
  assert.strictEqual(settleLeg('BTTS', 'No', 2, 0), 'won');
  assert.strictEqual(settleLeg('CS', '2:1', 2, 1), 'won');
  assert.strictEqual(settleLeg('OU25', 'Over', 2, 1), 'won');
  assert.strictEqual(settleLeg('WTN', 'Home', 2, 0), 'won');
  console.log('markets unit OK -', groups.length, 'groups:', groups.join(','));

  // ---- HTTP flow ----
  require('../src/server').start(4204);
  const base = 'http://127.0.0.1:4204';
  const call = async (m, p, body, tok, headers) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
  await new Promise(r => setTimeout(r, 300));
  const admin = await call('POST', '/api/auth/register', { phone: '+233900000001', password: 'adminpass' });
  assert.strictEqual(admin.s, 201); const AT = admin.j.token;
  const player = await call('POST', '/api/auth/register', { phone: '+233900000002', password: 'playerpass' });
  assert.strictEqual(player.s, 201); const PT = player.j.token;

  // ---- provider guards (no keys in this env) ----
  assert.deepStrictEqual((await call('POST', '/api/wallet/deposit-momo', { phone: '0244000000', amount: 100 }, PT)).j, { error: 'provider_not_configured' });
  assert.strictEqual((await call('POST', '/api/wallet/deposit-momo', { phone: '0244000000', amount: 100 }, PT)).s, 503);
  assert.strictEqual((await call('POST', '/api/wallet/deposit-flutterwave', { amount: 5000 }, PT)).s, 503);
  assert.strictEqual((await call('POST', '/api/wallet/deposit-flutterwave/status', { ref: 'flw_x' }, PT)).s, 503);
  assert.strictEqual((await call('POST', '/api/payments/shinobipay-webhook', {}, null)).s, 503);
  assert.strictEqual((await call('POST', '/api/payments/flutterwave-webhook', {}, null)).s, 503);
  console.log('provider guards OK - all six surfaces 503 provider_not_configured');

  // ---- withdrawal rule: < GH₵600 confirmed deposits blocks ----
  const poor = await call('POST', '/api/auth/register', { phone: '+233900000003', password: 'playerpass' });
  const poorT = poor.j.token;
  const depSmall = await call('POST', '/api/wallet/request', { type: 'deposit', amount: 100 }, poorT);
  await call('POST', '/api/admin/queue/' + depSmall.j.requestId, { action: 'confirm' }, AT);
  const wdBad = await call('POST', '/api/wallet/request', { type: 'withdrawal', amount: 50, bank: 'MTN MoMo', accountNumber: '0244000000', accountName: 'Poor Player' }, poorT);
  assert.strictEqual(wdBad.s, 400, JSON.stringify(wdBad.j));
  assert.strictEqual(wdBad.j.error, 'withdrawal_not_eligible');
  assert.strictEqual(wdBad.j.required, 600); assert.strictEqual(wdBad.j.deposited, 100);

  // ---- main player: GH₵600 deposit unlocks withdrawal with bank details ----
  const dep = await call('POST', '/api/wallet/request', { type: 'deposit', amount: 600 }, PT);
  await call('POST', '/api/admin/queue/' + dep.j.requestId, { action: 'confirm' }, AT);
  const wd = await call('POST', '/api/wallet/request', { type: 'withdrawal', amount: 100, bank: 'GCB Bank', accountNumber: '1234567890', accountName: 'Test Player' }, PT);
  assert.strictEqual(wd.s, 201, JSON.stringify(wd.j));
  const queue = await call('GET', '/api/admin/queue', null, AT);
  const wdRow = queue.j.requests.find(r => r.id === wd.j.requestId);
  assert(wdRow && wdRow.bank === 'GCB Bank' && wdRow.account_number === '1234567890' && wdRow.account_name === 'Test Player', 'bank details stored: ' + JSON.stringify(wdRow));
  console.log('withdrawal rule OK - blocked at GH₵100 deposited, allowed at GH₵600 with bank details');

  // ---- admin matches list ----
  const am = await call('GET', '/api/admin/matches', null, AT);
  assert(am.j.matches.length >= 6, 'admin matches list');
  assert(Array.isArray(am.j.matches[0].odds1x2) && am.j.matches[0].odds1x2.length === 3);
  assert.strictEqual((await call('GET', '/api/admin/matches', null, PT)).s, 403);
  console.log('admin matches OK -', am.j.matches.length, 'matches, odds attached');

  // ---- markets on a match + multi-market bet + booking code ----
  const m0 = (await call('GET', '/api/matches')).j.matches[0];
  const detail = await call('GET', '/api/matches/' + m0.id);
  assert.strictEqual(detail.s, 200);
  assert(detail.j.markets['1X2']['1'] === m0.odds1x2[0], 'detail 1X2 matches list odds');
  assert(detail.j.markets.BTTS && detail.j.markets.CS, 'detail has BTTS + Correct Score');
  assert.strictEqual((await call('GET', '/api/matches/999999')).s, 404);
  const bet1x2 = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m0.id, pick: '1' }] }, PT);
  assert.strictEqual(bet1x2.s, 201, JSON.stringify(bet1x2.j));
  assert.strictEqual(bet1x2.j.potential, Math.floor(1000 * m0.odds1x2[0]) / 100, '1X2 potential unchanged');
  const betBtts = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m0.id, market: 'BTTS', pick: 'Yes' }] }, PT);
  assert.strictEqual(betBtts.s, 201, JSON.stringify(betBtts.j));
  const betCs = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m0.id, market: 'CS', pick: '2:1' }] }, PT);
  assert.strictEqual(betCs.s, 201, JSON.stringify(betCs.j));
  assert.strictEqual((await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m0.id, market: 'CS', pick: '9:9' }] }, PT)).s, 400);
  const myBets = await call('GET', '/api/bets', null, PT);
  const withLegs = myBets.j.bets.find(b => b.id === betBtts.j.betId);
  assert(withLegs && withLegs.legs.length === 1 && withLegs.legs[0].market === 'BTTS' && withLegs.legs[0].home === m0.home, 'GET /api/bets carries legs + match names');
  const loaded = await call('GET', '/api/bets/code/' + betBtts.j.code); // public, no token
  assert.strictEqual(loaded.s, 200, JSON.stringify(loaded.j));
  assert.strictEqual(loaded.j.bet.code, betBtts.j.code);
  assert.strictEqual(loaded.j.bet.legs[0].pick, 'Yes');
  assert.strictEqual((await call('GET', '/api/bets/code/BB000000')).s, 404);
  console.log('markets + booking code OK - code', betBtts.j.code, 'loads publicly with legs');

  // ---- ESPN sync with a stubbed feed (upcoming -> finished settles the bet) ----
  const mkEv = (state, hs, as) => ({
    id: '700001', date: new Date(Date.now() + 3600e3).toISOString(),
    status: { type: { state } },
    competitions: [{
      odds: [{ moneyline: { home: { close: { odds: '-150' } }, away: { close: { odds: '+300' } } }, drawOdds: { moneyLine: '+260' },
        total: { over: { close: { line: 'o2.5', odds: '-110' } }, under: { close: { odds: '-110' } } } }],
      competitors: [
        { homeAway: 'home', score: String(hs), team: { displayName: 'Arsenal', id: '359' } },
        { homeAway: 'away', score: String(as), team: { displayName: 'Chelsea', id: '363' } },
      ],
    }],
  });
  let phase = 0;
  const stubFetch = async () => ({ ok: true, json: async () => ({ events: [phase === 0 ? mkEv('pre', 0, 0) : mkEv('post', 2, 1)], leagues: [{ name: 'England Premier League' }] }) });
  const sync1 = await espn.syncLeagues({ leagues: ['eng.1'], offsets: [0], fetchFn: stubFetch });
  assert.strictEqual(sync1.imported, 1, JSON.stringify(sync1));
  const espnMatch = (await call('GET', '/api/matches')).j.matches.find(m => m.espn_event_id === 'espn:700001');
  assert(espnMatch, 'ESPN match listed');
  assert(espnMatch.home_logo && espnMatch.home_logo.includes('espncdn'), 'logo stored: ' + espnMatch.home_logo);
  assert(Array.isArray(espnMatch.odds1x2) && espnMatch.odds1x2[0] > 1, 'ESPN odds converted: ' + JSON.stringify(espnMatch.odds1x2));
  // bet on it (home win), then flip the feed to finished 2-1 and re-sync
  const balBefore = (await call('GET', '/api/me', null, PT)).j.wallet.main;
  const ebet = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: espnMatch.id, pick: '1' }] }, PT);
  assert.strictEqual(ebet.s, 201, JSON.stringify(ebet.j));
  phase = 1;
  const sync2 = await espn.syncLeagues({ leagues: ['eng.1'], offsets: [0], fetchFn: stubFetch });
  assert.strictEqual(sync2.updated, 1, JSON.stringify(sync2));
  assert.strictEqual(sync2.settled, 1, 'finished match settled the bet: ' + JSON.stringify(sync2));
  const balAfter = (await call('GET', '/api/me', null, PT)).j.wallet.main;
  assert(Math.abs(balAfter - (balBefore - 10 + ebet.j.potential)) < 0.001, `ESPN auto-settle pays potential: ${balBefore} -> ${balAfter}, pot ${ebet.j.potential}`);
  // idempotent: a third sync must not pay again
  const sync3 = await espn.syncLeagues({ leagues: ['eng.1'], offsets: [0], fetchFn: stubFetch });
  assert.strictEqual(sync3.settled, 0, 're-sync settles nothing twice');
  assert.strictEqual((await call('GET', '/api/me', null, PT)).j.wallet.main, balAfter);
  const liveList = (await call('GET', '/api/matches')).j.matches.find(m => m.id === espnMatch.id);
  assert(!liveList, 'finished match leaves the upcoming/live list');
  console.log('ESPN sync OK - imported', sync1.imported, '| settled', sync2.settled, '| idempotent re-sync 0');

  // ---- admin espn-sync route is super-only (live ESPN not called here) ----
  assert.strictEqual((await call('POST', '/api/admin/espn-sync', {}, PT)).s, 403);

  console.log('ALL PARITY TESTS PASS');
  process.exit(0);
})().catch(e => { console.error('TEST FAIL:', e.message); process.exit(1); });
