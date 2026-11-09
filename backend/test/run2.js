// Phase 2 tests: session games, poker evaluator, settings, void settlement, throttle, SDK.
process.env.BLIZBET_DB = require('node:path').join(__dirname, 'test2.db');
for (const suf of ['', '-wal', '-shm']) require('node:fs').rmSync(process.env.BLIZBET_DB + suf, { force: true });
const assert = require('node:assert');
const { evaluatePoker, minesMult } = require('../src/sessions');
const C = (v, s) => ({ v, s });
assert.strictEqual(evaluatePoker([C(1,0),C(10,0),C(11,0),C(12,0),C(13,0)])[1], 250);
assert.strictEqual(evaluatePoker([C(9,0),C(9,1),C(9,2),C(4,0),C(4,1)])[0], 'Full House');
assert.strictEqual(evaluatePoker([C(10,0),C(10,1),C(3,2),C(5,0),C(8,1)])[1], 0, 'pair of 10s pays nothing');
assert.strictEqual(evaluatePoker([C(11,0),C(11,1),C(3,2),C(5,0),C(8,1)])[1], 1, 'jacks pay 1x');
assert(Math.abs(minesMult(1, 1) - 1.01) < 0.011);
console.log('poker/mines unit OK');
(async () => {
  process.env.PORT = 4200; require('../src/server');
  const base = 'http://127.0.0.1:4200';
  const call = async (m, p, body, tok) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j; try { j = await r.json(); } catch { j = {}; } return { s: r.status, j, raw: r }; };
  await new Promise(r => setTimeout(r, 300));
  const admin = await call('POST', '/api/auth/register', { phone: '+233700000001', password: 'adminpass' });
  const player = await call('POST', '/api/auth/register', { phone: '+233700000002', password: 'playerpass' });
  const AT = admin.j.token, PT = player.j.token;
  const dep = await call('POST', '/api/wallet/request', { type: 'deposit', amount: 1000 }, PT);
  await call('POST', '/api/admin/queue/' + dep.j.requestId, { action: 'confirm' }, AT);
  const bal = async () => (await call('GET', '/api/me', null, PT)).j.wallet.main;
  assert.strictEqual(await bal(), 1000);
  // settings: player blocked, super updates
  assert.strictEqual((await call('POST', '/api/admin/settings', { settings: { cashout_margin: 0.05 } }, PT)).s, 403);
  assert.strictEqual((await call('POST', '/api/admin/settings', { settings: { cashout_margin: 0.05 } }, AT)).s, 200);
  const stg = await call('GET', '/api/admin/settings', null, AT); assert.strictEqual(stg.j.settings.cashout_margin, 0.05);
  // admin match + void settlement refunds stake on single-leg ticket
  const mk = await call('POST', '/api/admin/matches', { league: 'Test', home: 'Alpha', away: 'Beta', probs: [0.5, 0.3, 0.2] }, AT);
  assert.strictEqual(mk.s, 201, JSON.stringify(mk.j));
  const b4 = await bal();
  const bet = await call('POST', '/api/bets', { stake: 20, legs: [{ matchId: mk.j.matchId, pick: '1' }] }, PT);
  assert.strictEqual(bet.s, 201); assert.strictEqual(await bal(), b4 - 20);
  const vd = await call('POST', '/api/admin/results', { results: [{ matchId: mk.j.matchId, result: 'void' }] }, AT);
  assert.strictEqual(vd.j.settled, 1);
  assert.strictEqual(await bal(), b4, 'void leg refunds full stake');
  // mines session: up to 6 rounds, pick one tile then cashout; require at least one clean cashout, secrets hidden while active
  let cashed = false, revealed = false;
  for (let i = 0; i < 6 && !cashed; i++) {
    const s = await call('POST', '/api/casino/session/start', { game: 'mines', stake: 10, options: { mines: 3 } }, PT);
    assert.strictEqual(s.s, 201, JSON.stringify(s.j)); assert(!('mines' in s.j.view), 'mines hidden while active'); assert(s.j.proof.seedHash);
    const a = await call('POST', '/api/casino/session/' + s.j.sessionId + '/action', { action: 'pick', tile: i }, PT);
    assert.strictEqual(a.s, 200, JSON.stringify(a.j));
    if (a.j.status !== 'active') { revealed = revealed || ('mines' in a.j.view); continue; }
    const c = await call('POST', '/api/casino/session/' + s.j.sessionId + '/action', { action: 'cashout' }, PT);
    assert.strictEqual(c.j.status, 'won'); assert(c.j.multiplier >= 1.08 && c.j.multiplier <= 1.10, 'one safe pick vs 3 mines ~1.09x, got ' + c.j.multiplier);
    assert.strictEqual(c.j.proof.seedReveal.length, 64); cashed = true;
  }
  assert(cashed, 'expected a clean mines cashout within 6 rounds');
  // hilo session: guess until first correct then cashout, or accept a loss; contract check
  const h = await call('POST', '/api/casino/session/start', { game: 'hilo', stake: 5 }, PT);
  assert.strictEqual(h.s, 201); assert(h.j.view.current && h.j.view.current.v >= 1);
  const ha = await call('POST', '/api/casino/session/' + h.j.sessionId + '/action', { action: 'higher' }, PT);
  assert([200].includes(ha.s) && ['active', 'lost', 'won'].includes(ha.j.status), JSON.stringify(ha.j));
  if (ha.j.status === 'active' && ha.j.view.correct > 0) { const hc = await call('POST', '/api/casino/session/' + h.j.sessionId + '/action', { action: 'cashout' }, PT); assert.strictEqual(hc.j.status, 'won'); }
  // skyclimb session starts and polls
  const sk = await call('POST', '/api/casino/session/start', { game: 'skyclimb', stake: 5 }, PT);
  assert.strictEqual(sk.s, 201); const skg = await call('GET', '/api/casino/session/' + sk.j.sessionId, null, PT);
  assert(skg.j.view.currentMult >= 1, 'climb multiplier live');
  if (skg.j.status === 'active') { const skc = await call('POST', '/api/casino/session/' + sk.j.sessionId + '/action', { action: 'cashout' }, PT);
    assert(['won', 'lost'].includes(skc.j.status), 'skyclimb settles on cashout attempt: ' + skc.j.status); }
  else assert.strictEqual(skg.j.status, 'lost', 'a low crash point busts on poll, as designed');
  // poker session: draw settles immediately
  const pk = await call('POST', '/api/casino/session/start', { game: 'poker', stake: 5 }, PT);
  assert.strictEqual(pk.s, 201); assert.strictEqual(pk.j.view.hand.length, 5);
  const pkd = await call('POST', '/api/casino/session/' + pk.j.sessionId + '/action', { action: 'draw', hold: [0, 1] }, PT);
  assert(['won', 'lost'].includes(pkd.j.status), 'poker draw settles');
  // login throttle: 10 fails then correct password still locked (429)
  await call('POST', '/api/auth/register', { phone: '+233700000009', password: 'rightpass' });
  for (let i = 0; i < 10; i++) await call('POST', '/api/auth/login', { phone: '+233700000009', password: 'wrong' });
  const locked = await call('POST', '/api/auth/login', { phone: '+233700000009', password: 'rightpass' });
  assert.strictEqual(locked.s, 429, '11th attempt locked even with right password');
  // change password
  const cpBad = await call('POST', '/api/auth/change-password', { current: 'nope', next: 'newpass1' }, PT); assert.strictEqual(cpBad.s, 400);
  const cp = await call('POST', '/api/auth/change-password', { current: 'playerpass', next: 'newpass1' }, PT); assert.strictEqual(cp.s, 200);
  assert.strictEqual((await call('POST', '/api/auth/login', { phone: '+233700000002', password: 'newpass1' })).s, 200);
  // stats + SDK
  const stats = await call('GET', '/api/admin/stats', null, AT); assert(stats.j.users >= 3 && typeof stats.j.ggr === 'number', JSON.stringify(stats.j));
  const sdk = await (await fetch(base + '/sdk.js')).text(); assert(sdk.includes('window.BlizBet'), 'SDK served');
  console.log('phase2 HTTP OK - settings, void refund, mines cashout, hilo, skyclimb, poker, throttle 429, change-password, stats GGR GH₵' + stats.j.ggr);
  console.log('ALL PHASE 2 TESTS PASS');
  process.exit(0);
})().catch(e => { console.error('TEST FAIL:', e.message); process.exit(1); });
