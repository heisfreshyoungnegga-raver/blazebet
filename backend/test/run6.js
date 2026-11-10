// PHASE 2 regression tests — the route surgery (server.js) from the
// BlazeBet pre-go-live fix pass. SQLite, same harness style as run.js–run6b.js.
//   node test/run6.js
process.env.BLAZEBET_DB = require('node:path').join(__dirname, 'test6c.db');
for (const suf of ['', '-wal', '-shm']) require('node:fs').rmSync(process.env.BLAZEBET_DB + suf, { force: true });
// Provider keys are test values; all provider traffic is stubbed below.
process.env.FLUTTERWAVE_SECRET_KEY = 'test-flw-key';
process.env.SHINOBIPAY_SECRET_KEY = 'test-shin-key';
process.env.SHINOBIPAY_WEBHOOK_SECRET = 'test-shin-hook';
process.env.CRON_SECRET = 'test-cron-secret';
const assert = require('node:assert');
const db = require('../src/db');
const { cashoutValue } = require('../src/odds');
const { balloonMult } = require('../src/sessions');

// ---- provider + ESPN fetch stub (real fetch passes through to localhost) ----
const realFetch = global.fetch;
let flwCreateBody = null;
let flwVerifyAmount = 11600; // NGN major, what FLW reports as charged
let shinIntentStatus = 'succeeded';
let shinIntentAmount = 5000;
let shinIntentRef = 'dep_shin_1';
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('api.flutterwave.com')) {
    if (u.includes('/v3/payments')) {
      flwCreateBody = JSON.parse(opts.body);
      return { status: 200, json: async () => ({ status: 'success', data: { link: 'https://checkout.test/x' } }) };
    }
    if (u.includes('/verify_by_reference')) {
      const ref = new URL(u).searchParams.get('tx_ref');
      return { status: 200, json: async () => ({ status: 'success', data: { id: 'tx_1001', status: 'successful', amount: flwVerifyAmount, currency: 'NGN', tx_ref: ref } }) };
    }
    if (u.includes('/transactions/') && u.includes('/verify')) {
      const id = u.split('/transactions/')[1].split('/')[0];
      return { status: 200, json: async () => ({ status: 'success', data: { id, status: 'successful', amount: flwVerifyAmount, currency: 'NGN', tx_ref: flwCreateBody ? flwCreateBody.tx_ref : '' } }) };
    }
  }
  if (u.includes('akwapayapi.onrender.com')) {
    return { status: 200, json: async () => ({ status: shinIntentStatus, merchant_amount: shinIntentAmount, reference: shinIntentRef }) };
  }
  if (u.includes('site.api.espn.com')) {
    return { ok: true, json: async () => ({ events: [], leagues: [{ name: 'England Premier League' }] }) };
  }
  return realFetch(url, opts);
};

(async () => {
  require('../src/server').start(4206);
  const base = 'http://127.0.0.1:4206';
  const call = async (m, p, body, tok, headers) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
  await new Promise(r => setTimeout(r, 300));
  const bal = async (tok) => (await call('GET', '/api/me', null, tok)).j.wallet;
  const mkMatch = async (tok, home, away, startsAt) => {
    const r = await call('POST', '/api/admin/matches', { league: 'Test', home, away, probs: [0.5, 0.3, 0.2], ...(startsAt ? { startsAt } : {}) }, tok);
    assert.strictEqual(r.s, 201, JSON.stringify(r.j)); return r.j.matchId;
  };
  const fund = async (tok, amount, adminTok) => {
    const dep = await call('POST', '/api/wallet/request', { type: 'deposit', amount }, tok);
    assert.strictEqual(dep.s, 201, JSON.stringify(dep.j));
    const conf = await call('POST', '/api/admin/queue/' + dep.j.requestId, { action: 'confirm' }, adminTok);
    assert.strictEqual(conf.s, 200, JSON.stringify(conf.j));
  };

  // ---- auth: password floor, phone canonicalisation, TTL, logout, throttle ----
  assert.strictEqual((await call('POST', '/api/auth/register', { phone: '+233900000001', password: 'short' })).j.error, 'password_too_short');
  const admin = await call('POST', '/api/auth/register', { phone: '0244000001', password: 'adminpass', name: 'Boss' });
  assert.strictEqual(admin.s, 201, JSON.stringify(admin.j));
  assert.strictEqual(admin.j.user.phone, '+233244000001', 'local format canonicalised to +233');
  assert.strictEqual(admin.j.user.role, 'super_admin', 'first user is super_admin');
  const AT = admin.j.token;
  assert.strictEqual((await call('POST', '/api/auth/login', { phone: '0244000001', password: 'adminpass' })).s, 200, 'login with local format');
  assert.strictEqual((await call('POST', '/api/auth/login', { phone: '233244000001', password: 'adminpass' })).s, 200, 'login with 233 format');
  assert.strictEqual((await call('POST', '/api/auth/register', { phone: '+233244000001', password: 'adminpass' })).s, 409, 'same number, other format, is the same account');
  // session TTL: a 31-day-old session is dead and its row is deleted
  await db.run('INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)', 'oldtoken123', admin.j.user.id, '2026-10-01 00:00:00');
  assert.strictEqual((await call('GET', '/api/me', null, 'oldtoken123')).s, 401, 'expired session rejected');
  assert.strictEqual(await db.one('SELECT token FROM sessions WHERE token=?', 'oldtoken123'), undefined, 'expired session row deleted');
  // logout revokes server-side and is idempotent
  const lt = (await call('POST', '/api/auth/login', { phone: '+233244000001', password: 'adminpass' })).j.token;
  assert.strictEqual((await call('POST', '/api/auth/logout', {}, lt)).s, 200);
  assert.strictEqual((await call('GET', '/api/me', null, lt)).s, 401, 'logged-out token dead');
  assert.strictEqual((await call('POST', '/api/auth/logout', {}, lt)).s, 200, 'second logout still 200');
  // password change kills all sessions
  const ct = (await call('POST', '/api/auth/login', { phone: '+233244000001', password: 'adminpass' })).j.token;
  assert.strictEqual((await call('POST', '/api/auth/change-password', { current: 'adminpass', next: 'adminpass2' }, ct)).s, 200);
  assert.strictEqual((await call('GET', '/api/me', null, ct)).s, 401, 'old session dead after password change');
  assert.strictEqual((await call('POST', '/api/auth/login', { phone: '+233244000001', password: 'adminpass2' })).s, 200);
  const AT2 = (await call('POST', '/api/auth/login', { phone: '+233244000001', password: 'adminpass2' })).j.token;
  // throttle is per phone+IP: 10 fails from one IP lock that IP only
  const thr = await call('POST', '/api/auth/register', { phone: '+233900000101', password: 'rightpass' });
  assert.strictEqual(thr.s, 201);
  for (let i = 0; i < 10; i++) assert.strictEqual((await call('POST', '/api/auth/login', { phone: '+233900000101', password: 'wrong' }, null, { 'x-forwarded-for': '1.2.3.4' })).s, 401);
  assert.strictEqual((await call('POST', '/api/auth/login', { phone: '+233900000101', password: 'rightpass' }, null, { 'x-forwarded-for': '1.2.3.4' })).s, 429, 'locked IP gets 429 even with the right password');
  assert.strictEqual((await call('POST', '/api/auth/login', { phone: '+233900000101', password: 'rightpass' }, null, { 'x-forwarded-for': '5.6.7.8' })).s, 200, 'another IP is not locked');
  console.log('auth OK - password floor, +233 canonicalisation, 30d TTL, logout revoke, password-change revokes, phone+IP throttle');

  // ---- invites + promos: one-time claim, app-code expiry, atomic cap ----
  const inv = await call('POST', '/api/admin/invites', { role: 'admin', hours: 24 }, AT2);
  assert.strictEqual(inv.s, 201);
  const admin2 = await call('POST', '/api/auth/register', { phone: '+233900000102', password: 'admin2pass', invite: inv.j.token });
  assert.strictEqual(admin2.s, 201); assert.strictEqual(admin2.j.user.role, 'admin');
  assert.strictEqual((await call('POST', '/api/auth/register', { phone: '+233900000103', password: 'x123456', invite: inv.j.token })).s, 400, 'invite is one-time');
  const A2T = admin2.j.token;
  await db.run('INSERT INTO admin_invites(token,created_by,role,expires_at) VALUES(?,?,?,?)', 'expiredtok1', admin.j.user.id, 'admin', new Date(Date.now() - 3600e3).toISOString());
  assert.strictEqual((await call('POST', '/api/auth/register', { phone: '+233900000104', password: 'x123456', invite: 'expiredtok1' })).j.error, 'invalid_or_expired_invite', 'expired invite rejected in app code');
  await call('POST', '/api/admin/promos', { code: 'VIP1', bonus: 5, maxUses: 1 }, AT2);
  assert.strictEqual((await call('POST', '/api/auth/register', { phone: '+233900000105', password: 'playerpass', promoCode: 'VIP1' })).s, 201);
  assert.strictEqual((await call('POST', '/api/auth/register', { phone: '+233900000106', password: 'playerpass', promoCode: 'VIP1' })).s, 400, 'capped promo rejects the second claim');
  const promos = await call('GET', '/api/admin/promos', null, AT2);
  assert.strictEqual(promos.j.promos.find(x => x.code === 'VIP1').uses, 1, 'uses counter moved exactly once');
  console.log('invite/promo OK - one-time invite, expired invite, capped promo');

  // ---- referral + commission exactly once (manual queue rail) ----
  const ref = await call('POST', '/api/auth/register', { phone: '+233900000107', password: 'refpass' });
  const refCode = (await call('GET', '/api/me', null, ref.j.token)).j.user.ref_code;
  const player = await call('POST', '/api/auth/register', { phone: '+233900000108', password: 'playerpass', ref: refCode });
  const PT = player.j.token;
  await fund(PT, 600, AT2);
  assert.strictEqual((await bal(ref.j.token)).main, 30, 'first deposit pays 5% = GH₵30');
  await fund(PT, 200, AT2);
  assert.strictEqual((await bal(ref.j.token)).main, 30, 'second deposit pays no commission');
  const refs = await call('GET', '/api/referrals', null, ref.j.token);
  assert.strictEqual(refs.j.referred, 1, 'referred count is a number, not null: ' + JSON.stringify(refs.j));
  assert.strictEqual(refs.j.commissionEarned, 30, 'commissionEarned is a number: ' + JSON.stringify(refs.j));
  console.log('referral OK - 5% once on first deposit, referrals endpoint returns real numbers');

  // ---- bets: duplicate legs, kickoff guard, idempotency, code format, fair_prob ----
  const m1 = await mkMatch(AT2, 'Alpha', 'Beta');
  const m2 = await mkMatch(AT2, 'Gamma', 'Delta');
  assert.strictEqual((await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m1, pick: '1' }, { matchId: m1, pick: 'X' }] }, PT)).s, 409, 'two legs on one match rejected');
  assert.strictEqual((await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m1, pick: '1' }, { matchId: m1, pick: '1' }] }, PT)).j.error, 'duplicate_leg');
  const past = await mkMatch(AT2, 'Old', 'Stale', new Date(Date.now() - 3600e3).toISOString());
  assert(!(await call('GET', '/api/matches')).j.matches.some(m => m.id === past), 'started match leaves the public board');
  assert.strictEqual((await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: past, pick: '1' }] }, PT)).j.error, 'match_not_open', 'past-kickoff match not bettable');
  const b0 = await bal(PT);
  const bet1 = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m1, pick: '1' }], idemKey: 'idem-1' }, PT);
  assert.strictEqual(bet1.s, 201, JSON.stringify(bet1.j));
  assert(/^BB[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(bet1.j.code), '5-char mixed booking code: ' + bet1.j.code);
  assert.strictEqual(await bal(PT).then(w => w.main), b0.main - 10, 'stake debited once');
  const bet1r = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m1, pick: '1' }], idemKey: 'idem-1' }, PT);
  assert.strictEqual(bet1r.s, 201);
  assert.strictEqual(bet1r.j.betId, bet1.j.betId, 'idempotent retry returns the same bet');
  assert.strictEqual(await bal(PT).then(w => w.main), b0.main - 10, 'retry did not debit twice');
  const loaded = await call('GET', '/api/bets/code/' + bet1.j.code);
  assert.strictEqual(loaded.s, 200);
  assert(!('user_id' in loaded.j.bet) && !('idem_key' in loaded.j.bet), 'public bet hides user_id + idem_key');
  const myBets = await call('GET', '/api/bets', null, PT);
  const leg = myBets.j.bets.find(x => x.id === bet1.j.betId).legs[0];
  const board = (await call('GET', '/api/matches')).j.matches.find(m => m.id === m1);
  const [o1, ox, o2] = board.odds1x2;
  const expectFair = (1 / o1) / (1 / o1 + 1 / ox + 1 / o2);
  assert(Math.abs(leg.fair_prob - expectFair) < 1e-9, `fair_prob normalised: ${leg.fair_prob} vs ${expectFair}`);
  console.log('bets OK - duplicate_leg 409, kickoff guard, idemKey dedupe, BB+5 code, fair_prob normalised, pubBet hides user_id');

  // ---- cashout: double-cashout 409, finished-but-unsettled refused ----
  const co1 = await call('POST', '/api/bets/' + bet1.j.betId + '/cashout', {}, PT);
  assert.strictEqual(co1.s, 200, JSON.stringify(co1.j));
  assert(co1.j.cashout > 0 && co1.j.cashout < bet1.j.potential);
  assert.strictEqual((await call('POST', '/api/bets/' + bet1.j.betId + '/cashout', {}, PT)).s, 409, 'second cashout is already_decided');
  const bet2 = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m2, pick: '1' }] }, PT);
  assert.strictEqual(bet2.s, 201);
  await db.run("UPDATE matches SET status='finished' WHERE id=?", m2);
  assert.strictEqual((await call('POST', '/api/bets/' + bet2.j.betId + '/cashout', {}, PT)).j.error, 'cashout_unavailable', 'finished-but-unsettled leg blocks cashout');
  console.log('cashout OK - double cashout 409, finished-but-unsettled refused');

  // ---- admin results with scores: DC/OU/BTTS/CS win, loser loses, HT stays pending, void refunds ----
  const m3 = await mkMatch(AT2, 'M3H', 'M3A'), m4 = await mkMatch(AT2, 'M4H', 'M4A');
  const m5 = await mkMatch(AT2, 'M5H', 'M5A'), m6 = await mkMatch(AT2, 'M6H', 'M6A');
  const multi = await call('POST', '/api/bets', { stake: 10, legs: [
    { matchId: m3, market: 'DC', pick: '1X' }, { matchId: m4, market: 'OU25', pick: 'Over' },
    { matchId: m5, market: 'BTTS', pick: 'Yes' }, { matchId: m6, market: 'CS', pick: '2:1' }] }, PT);
  assert.strictEqual(multi.s, 201, JSON.stringify(multi.j));
  const mb0 = await bal(PT);
  const res = await call('POST', '/api/admin/results', { results: [
    { matchId: m3, homeScore: 2, awayScore: 1 }, { matchId: m4, homeScore: 3, awayScore: 0 },
    { matchId: m5, homeScore: 2, awayScore: 1 }, { matchId: m6, homeScore: 2, awayScore: 1 }] }, AT2);
  assert.strictEqual(res.s, 200); assert.strictEqual(res.j.settled, 1, 'multi settled once: ' + JSON.stringify(res.j));
  const mb1 = await bal(PT);
  assert(Math.abs(mb1.main - (mb0.main + multi.j.potential)) < 0.001, `DC+OU+BTTS+CS multi pays potential: ${mb0.main} -> ${mb1.main}, pot ${multi.j.potential}`);
  const settledBet = (await call('GET', '/api/bets', null, PT)).j.bets.find(x => x.id === multi.j.betId);
  assert.strictEqual(settledBet.status, 'won');
  assert(settledBet.legs.every(l => l.status === 'won'), 'every exotic leg won, none force-lost');
  const m7 = await mkMatch(AT2, 'M7H', 'M7A');
  const loser = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m7, market: 'OU25', pick: 'Under' }] }, PT);
  assert.strictEqual(loser.s, 201);
  await call('POST', '/api/admin/results', { results: [{ matchId: m7, homeScore: 2, awayScore: 1 }] }, AT2);
  assert.strictEqual((await call('GET', '/api/bets', null, PT)).j.bets.find(x => x.id === loser.j.betId).status, 'lost');
  const m8 = await mkMatch(AT2, 'M8H', 'M8A');
  const ht = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m8, market: 'HT1X2', pick: '1' }] }, PT);
  assert.strictEqual(ht.s, 201);
  await call('POST', '/api/admin/results', { results: [{ matchId: m8, homeScore: 2, awayScore: 1 }] }, AT2);
  const htBet = (await call('GET', '/api/bets', null, PT)).j.bets.find(x => x.id === ht.j.betId);
  assert.strictEqual(htBet.status, 'open', 'HT1X2 leg cannot settle from the FT score');
  assert.strictEqual(htBet.legs[0].status, 'pending');
  const m9 = await mkMatch(AT2, 'M9H', 'M9A');
  const vb = await call('POST', '/api/bets', { stake: 5, legs: [{ matchId: m9, pick: '1' }] }, PT);
  const vb0 = await bal(PT);
  const vres = await call('POST', '/api/admin/results', { results: [{ matchId: m9, result: 'void' }] }, AT2);
  assert.strictEqual(vres.j.settled, 1);
  assert.strictEqual((await call('GET', '/api/bets', null, PT)).j.bets.find(x => x.id === vb.j.betId).status, 'void');
  assert.strictEqual((await bal(PT)).main, vb0.main + 5, 'void refunds the full stake');
  console.log('results OK - DC/OU/BTTS/CS all win from scores, loser loses, HT1X2 stays pending, void refunds');

  // ---- bonus-split settlement: stake 60 bonus / 40 main wins pro-rata ----
  const p2 = await call('POST', '/api/auth/register', { phone: '+233900000109', password: 'playerpass' });
  const P2T = p2.j.token, P2ID = p2.j.user.id;
  const be = await call('POST', '/api/admin/users/' + P2ID + '/balance', { amount: 60, bucket: 'bonus', reason: 'test bonus' }, AT2);
  assert.strictEqual(be.s, 200, JSON.stringify(be.j));
  await fund(P2T, 40, AT2);
  assert.deepStrictEqual(await bal(P2T), { main: 40, bonus: 60 });
  const m10 = await mkMatch(AT2, 'M10H', 'M10A');
  const sbet = await call('POST', '/api/bets', { stake: 100, legs: [{ matchId: m10, pick: '1' }] }, P2T);
  assert.strictEqual(sbet.s, 201, JSON.stringify(sbet.j));
  assert.deepStrictEqual(await bal(P2T), { main: 0, bonus: 0 }, 'stake spent bonus-first');
  await call('POST', '/api/admin/results', { results: [{ matchId: m10, homeScore: 1, awayScore: 0 }] }, AT2);
  const w2 = await bal(P2T);
  const expBonusMinor = Math.floor(sbet.j.potential * 100 * 6000 / 10000);
  assert.strictEqual(w2.bonus, expBonusMinor / 100, `bonus share of payout: ${w2.bonus} vs ${expBonusMinor / 100}`);
  assert.strictEqual(w2.main, sbet.j.potential - expBonusMinor / 100, 'main share is the remainder');
  console.log('bonus split OK - GH₵100 win on 60/40 stake pays ' + (expBonusMinor / 100) + ' bonus / ' + (sbet.j.potential - expBonusMinor / 100) + ' main');

  // ---- cashout excludes void legs from the potential ----
  const m11 = await mkMatch(AT2, 'M11H', 'M11A'), m12 = await mkMatch(AT2, 'M12H', 'M12A');
  const cbet = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m11, pick: '1' }, { matchId: m12, pick: '1' }] }, PT);
  assert.strictEqual(cbet.s, 201);
  await call('POST', '/api/admin/results', { results: [{ matchId: m11, result: 'void' }] }, AT2);
  const clegs = (await call('GET', '/api/bets', null, PT)).j.bets.find(x => x.id === cbet.j.betId).legs;
  assert.strictEqual(clegs.find(l => l.match_id === m11).status, 'void');
  const liveLeg = clegs.find(l => l.match_id === m12);
  const adjPot = Math.floor(1000 * liveLeg.odds);
  const expectCo = cashoutValue(adjPot, clegs.map(l => ({ status: l.status, fair_prob: l.fair_prob })), 0.10);
  const co2 = await call('POST', '/api/bets/' + cbet.j.betId + '/cashout', {}, PT);
  assert.strictEqual(co2.s, 200, JSON.stringify(co2.j));
  assert.strictEqual(co2.j.cashout, expectCo / 100, `cashout repriced without the void leg: ${co2.j.cashout} vs ${expectCo / 100}`);
  console.log('cashout void-leg OK - potential recomputed without voided odds');

  // ---- queue: regular admin sees deposits only, no bank fields; double-decide 409 ----
  const p3 = await call('POST', '/api/auth/register', { phone: '+233900000110', password: 'playerpass' });
  const P3T = p3.j.token;
  await fund(P3T, 600, AT2);
  const wd = await call('POST', '/api/wallet/request', { type: 'withdrawal', amount: 50, bank: 'GCB Bank', accountNumber: '1234567890', accountName: 'P Three' }, P3T);
  assert.strictEqual(wd.s, 201, JSON.stringify(wd.j));
  const depPend = await call('POST', '/api/wallet/request', { type: 'deposit', amount: 50 }, P3T);
  assert.strictEqual(depPend.s, 201);
  const qAdmin = await call('GET', '/api/admin/queue', null, A2T);
  assert(qAdmin.j.requests.every(r => r.type === 'deposit'), 'regular admin sees deposits only: ' + JSON.stringify(qAdmin.j.requests.map(r => r.type)));
  assert(qAdmin.j.requests.every(r => !('bank' in r) && !('account_number' in r) && !('account_name' in r)), 'no bank fields leak to regular admins');
  const qSuper = await call('GET', '/api/admin/queue', null, AT2);
  const wdRow = qSuper.j.requests.find(r => r.id === wd.j.requestId);
  assert(wdRow && wdRow.bank === 'GCB Bank' && wdRow.account_number === '1234567890' && wdRow.account_name === 'P Three', 'super sees withdrawal bank details');
  assert.strictEqual((await call('POST', '/api/admin/queue/' + wd.j.requestId, { action: 'confirm' }, AT2)).s, 200);
  assert.strictEqual((await call('POST', '/api/admin/queue/' + wd.j.requestId, { action: 'confirm' }, AT2)).s, 409, 'double-decide is already_decided');
  // provider deposits count toward the GH₵600 withdrawal unlock (H3)
  const p4 = await call('POST', '/api/auth/register', { phone: '+233900000111', password: 'playerpass' });
  await db.run("INSERT INTO payment_attempts(user_id,provider,reference,amount_minor,status) VALUES(?,?,?,?,?)", p4.j.user.id, 'shinobipay', 'dep_test_p4', 60000, 'succeeded');
  // give P4 a spendable balance without a manual deposit (else the test
  // would pass via payment_requests, not via the provider attempt)
  assert.strictEqual((await call('POST', '/api/admin/users/' + p4.j.user.id + '/balance', { amount: 50, reason: 'test funds' }, AT2)).s, 200);
  const wd4 = await call('POST', '/api/wallet/request', { type: 'withdrawal', amount: 10 }, p4.j.token);
  assert.strictEqual(wd4.s, 201, 'provider deposit unlocks withdrawal: ' + JSON.stringify(wd4.j));
  console.log('queue OK - role filter, bank fields super-only, double-decide 409, provider deposits count');

  // ---- casino: bad choices rejected before debit, max-payout gate, mines guard ----
  const cb0 = await bal(PT);
  assert.strictEqual((await call('POST', '/api/casino/play', { game: 'dice', choice: 'banana', stake: 10 }, PT)).j.error, 'bad_choice');
  assert.strictEqual((await call('POST', '/api/casino/play', { game: 'keno', choice: '1,2,3', stake: 10 }, PT)).j.error, 'bad_choice');
  assert.strictEqual((await call('POST', '/api/casino/play', { game: 'limbo', choice: '500', stake: 1000 }, PT)).j.error, 'above_max_payout');
  assert.deepStrictEqual(await bal(PT), cb0, 'rejected plays debited nothing');
  assert.strictEqual((await call('POST', '/api/casino/play', { game: 'dice', choice: 'over', stake: 10 }, PT)).s, 200);
  const sess = await call('POST', '/api/casino/session/start', { game: 'mines', stake: 10, options: { mines: 3 } }, PT);
  assert.strictEqual(sess.s, 201, JSON.stringify(sess.j));
  assert.strictEqual((await call('POST', '/api/casino/session/' + sess.j.sessionId + '/action', { action: 'cashout' }, PT)).j.error, 'nothing_to_cash');
  console.log('casino OK - bad_choice before debit, above_max_payout gate, mines 0-pick cashout rejected');

  // ---- maintenance gate on deposit creation ----
  await call('POST', '/api/admin/settings', { settings: { maintenance: 1 } }, AT2);
  assert.strictEqual((await call('POST', '/api/wallet/deposit-flutterwave', { amount: 100 }, PT)).s, 503, 'maintenance blocks FLW deposit creation');
  await call('POST', '/api/admin/settings', { settings: { maintenance: 0 } }, AT2);
  console.log('maintenance OK - deposit creation gated');

  // ---- FLW FX: GH₵100 in -> ₦11,600 charged, GH₵100 credited; ₦100 never credits ----
  await call('POST', '/api/admin/settings', { settings: { fx_ngn_per_ghs: 116 } }, AT2);
  const p5 = await call('POST', '/api/auth/register', { phone: '+233900000112', password: 'playerpass' });
  const P5T = p5.j.token;
  await fund(P5T, 200, AT2);
  const flw = await call('POST', '/api/wallet/deposit-flutterwave', { amount: 100 }, P5T);
  assert.strictEqual(flw.s, 201, JSON.stringify(flw.j));
  assert.strictEqual(flwCreateBody.amount, 11600, 'FLW charged ₦11,600 for GH₵100 (fx 116)');
  assert.strictEqual(flwCreateBody.currency, 'NGN');
  assert.strictEqual(flw.j.charged_ngn, 11600);
  assert.strictEqual(flw.j.credit_ghs, 100);
  const attRow = await db.one('SELECT * FROM payment_attempts WHERE reference=?', flw.j.reference);
  assert.strictEqual(attRow.charged_minor, 1160000, 'charged NGN stored separately (minor)');
  assert.strictEqual(attRow.amount_minor, 10000, 'GH₵ credit stored separately (minor)');
  flwVerifyAmount = 11600;
  const st1 = await call('POST', '/api/wallet/deposit-flutterwave/status', { ref: flw.j.reference }, P5T);
  assert.strictEqual(st1.s, 200, JSON.stringify(st1.j));
  assert.strictEqual(st1.j.status, 'succeeded', '₦11,600 verified -> GH₵100 credited');
  assert.strictEqual((await bal(P5T)).main, 300, 'balance 200 + 100');
  const flw2 = await call('POST', '/api/wallet/deposit-flutterwave', { amount: 100 }, P5T);
  assert.strictEqual(flw2.s, 201);
  flwVerifyAmount = 100; // the old 1:1 bug amount — a ₦100 payment for a GH₵100 credit
  const st2 = await call('POST', '/api/wallet/deposit-flutterwave/status', { ref: flw2.j.reference }, P5T);
  assert.strictEqual(st2.j.error, 'amount_mismatch', '₦100 does not verify against ₦11,600 charged');
  assert.strictEqual((await bal(P5T)).main, 300, 'no credit from the mismatched payment');
  console.log('FLW FX OK - GH₵100 -> ₦11,600 charged / GH₵100 credited; 116x printer dead');

  // ---- ShinobiPay status endpoint (stubbed intent) ----
  await db.run("INSERT INTO payment_attempts(user_id,provider,reference,intent_id,amount_minor,status) VALUES(?,?,?,?,?,?)", p5.j.user.id, 'shinobipay', 'dep_shin_1', 'pi_test_1', 5000, 'awaiting');
  shinIntentAmount = 5000; shinIntentRef = 'dep_shin_1'; shinIntentStatus = 'succeeded';
  const sst = await call('POST', '/api/wallet/deposit-shinobipay/status', { ref: 'dep_shin_1' }, P5T);
  assert.strictEqual(sst.s, 200, JSON.stringify(sst.j));
  assert.strictEqual(sst.j.status, 'succeeded');
  assert.strictEqual((await bal(P5T)).main, 350, 'MoMo GH₵50 credited via status reconcile');
  await db.run("INSERT INTO payment_attempts(user_id,provider,reference,intent_id,amount_minor,status) VALUES(?,?,?,?,?,?)", p5.j.user.id, 'shinobipay', 'dep_shin_2', 'pi_test_2', 5000, 'awaiting');
  shinIntentRef = 'dep_shin_2'; shinIntentStatus = 'processing';
  const sst2 = await call('POST', '/api/wallet/deposit-shinobipay/status', { ref: 'dep_shin_2' }, P5T);
  assert.strictEqual(sst2.j.status, 'awaiting', 'still-processing intent is not credited');
  assert.strictEqual((await bal(P5T)).main, 350);
  console.log('ShinobiPay status OK - succeeded credits, processing does not');

  // ---- cron: 503 without secret, 401 on mismatch, 200 with the secret ----
  delete process.env.CRON_SECRET;
  assert.strictEqual((await call('GET', '/api/cron/espn-sync')).s, 503, 'cron without CRON_SECRET is 503');
  process.env.CRON_SECRET = 'test-cron-secret';
  assert.strictEqual((await call('GET', '/api/cron/espn-sync', null, null, { Authorization: 'Bearer nope' })).s, 401);
  const cron = await call('GET', '/api/cron/espn-sync', null, null, { Authorization: 'Bearer test-cron-secret' });
  assert.strictEqual(cron.s, 200, JSON.stringify(cron.j));
  assert(Array.isArray(cron.j.chunks), 'cron returns chunk report');
  console.log('cron OK - 503/401/200, chunks run: ' + cron.j.chunks.length);

  // ---- body cap + stats GGR includes cashed_out ----
  const big = await call('POST', '/api/auth/login', { phone: 'x', password: 'x'.repeat(1100000) });
  assert.strictEqual(big.s, 413, 'oversize body rejected: ' + big.s);
  const stats = await call('GET', '/api/admin/stats', null, AT2);
  const ggrRow = await db.one("SELECT COALESCE(SUM(stake_minor),0) s FROM bets WHERE status IN ('won','lost','cashed_out')");
  assert.strictEqual(stats.j.betStakes, ggrRow.s / 100, 'stats betStakes includes cashed_out bets');
  console.log('misc OK - body 413, stats GGR includes cashed_out');

  // ---- EV spot-checks (Balloon / Penalty priced below fair) ----
  assert.strictEqual(balloonMult(1), 1.05);
  assert(((13 - 1) / 13) * balloonMult(1) < 1, 'pump-1 EV 0.9692 < 1');
  assert((5 / 6) * 1.16 < 1 && (4 / 6) * 1.45 < 1, 'penalty EVs < 1');
  console.log('EV OK - balloon pump-1 0.9692, penalty corner/centre 0.9667');

  // ---- soft-delete count: after every user is soft-deleted, next register is super_admin ----
  await db.run("UPDATE users SET status='deleted', phone=phone || '#del' || id");
  const fresh = await call('POST', '/api/auth/register', { phone: '+233900000200', password: 'playerpass' });
  assert.strictEqual(fresh.s, 201, JSON.stringify(fresh.j));
  assert.strictEqual(fresh.j.user.role, 'super_admin', 'bootstrap counts live users only');
  console.log('soft-delete count OK - fresh super_admin after all users soft-deleted');

  console.log('ALL RUN6 TESTS PASS');
  process.exit(0);
})().catch(e => { console.error('TEST FAIL:', e.message); process.exit(1); });
