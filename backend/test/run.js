// BlazeBet backend test suite: unit (odds, crash distribution, wallet) + full HTTP flow.
process.env.BLAZEBET_DB = require('node:path').join(__dirname, 'test.db');
for (const suf of ['', '-wal', '-shm']) require('node:fs').rmSync(process.env.BLAZEBET_DB + suf, { force: true });
const assert = require('node:assert');
const { buildBook, potential, cashoutValue } = require('../src/odds');
const { floatStream, crashPoint } = require('../src/crypto');
(async () => {
  // odds: book overround equals 1+margin before rounding
  const book = buildBook([0.5, 0.3, 0.2], 0.06);
  const sum = book.reduce((a, o) => a + 1 / o, 0);
  assert(Math.abs(sum - 1.06) < 0.02, 'overround ~1.06, got ' + sum);
  assert.strictEqual(potential(1000, [2, 3]), 6000);
  assert.strictEqual(cashoutValue(10000, [{ status: 'pending', fairProb: 0.5 }], 0.1), 4500);
  assert.strictEqual(cashoutValue(10000, [{ status: 'lost', fairProb: 0.5 }], 0.1), 0);
  // crash distribution sanity: 100k draws, ~3% instant bust, mean in sane band
  const f = floatStream('test-seed', 'tester', 1); let wins = 0, total = 0; const N = 100000;
  for (let i = 0; i < N; i++) { const p = crashPoint(f); if (p >= 2) wins++; total += Math.min(p, 20); }
  const winRate = wins / N; // theory: 0.97/2 = 0.485 -> RTP at 2x auto-cash ~= 97%
  assert(winRate > 0.47 && winRate < 0.50, 'P(crash>=2x) ~0.485, got ' + winRate);
  console.log('unit OK - overround', sum.toFixed(3), '| P(crash>=2x)', winRate.toFixed(3), '| capped mean', (total / N).toFixed(2));
  // HTTP flow
  require('../src/server').start(4199);
  const base = 'http://127.0.0.1:4199';
  const call = async (m, p, body, tok) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json() }; };
  await new Promise(r => setTimeout(r, 300));
  const admin = await call('POST', '/api/auth/register', { phone: '+233500000001', password: 'adminpass', name: 'Boss' });
  assert.strictEqual(admin.s, 201); assert.strictEqual(admin.j.user.role, 'super_admin');
  const player = await call('POST', '/api/auth/register', { phone: '+233500000002', password: 'playerpass' });
  assert.strictEqual(player.s, 201); assert.strictEqual(player.j.user.role, 'player');
  const dep = await call('POST', '/api/wallet/request', { type: 'deposit', amount: 500 }, player.j.token);
  assert.strictEqual(dep.s, 201);
  const conf = await call('POST', '/api/admin/queue/' + dep.j.requestId, { action: 'confirm' }, admin.j.token);
  assert.strictEqual(conf.s, 200);
  let me = await call('GET', '/api/me', null, player.j.token);
  assert.strictEqual(me.j.wallet.main, 500, 'deposit credited: ' + JSON.stringify(me.j.wallet));
  const matches = await call('GET', '/api/matches');
  assert(matches.j.matches.length >= 6);
  const m = matches.j.matches[0];
  const bet = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m.id, pick: '1' }] }, player.j.token);
  assert.strictEqual(bet.s, 201, JSON.stringify(bet.j));
  const co = await call('POST', '/api/bets/' + bet.j.betId + '/cashout', {}, player.j.token);
  assert.strictEqual(co.s, 200, JSON.stringify(co.j)); assert(co.j.cashout > 0 && co.j.cashout < bet.j.potential);
  // second bet to settle as a win
  const bet2 = await call('POST', '/api/bets', { stake: 10, legs: [{ matchId: m.id, pick: '1' }] }, player.j.token);
  const before = (await call('GET', '/api/me', null, player.j.token)).j.wallet.main;
  const st = await call('POST', '/api/admin/results', { results: [{ matchId: m.id, result: '1' }] }, admin.j.token);
  assert.strictEqual(st.j.settled, 1);
  const after = (await call('GET', '/api/me', null, player.j.token)).j.wallet.main;
  assert(Math.abs(after - (before + bet2.j.potential)) < 0.001, `settlement pays potential: ${before} -> ${after}, pot ${bet2.j.potential}`);
  // casino: play dice until response, balance must move by exactly -stake+payout; seed proof verifies
  const { createHash } = require('node:crypto');
  const bal0 = after; let played = null;
  for (let i = 0; i < 5 && !played; i++) { const r = await call('POST', '/api/casino/play', { game: 'dice', choice: 'over', stake: 10 }, player.j.token); if (r.s === 200) played = r.j; }
  assert(played, 'casino play failed');
  assert.strictEqual(createHash('sha256').update(played.proof.seedReveal).digest('hex'), played.proof.seedHash, 'seed reveal matches hash');
  const bal1 = (await call('GET', '/api/me', null, player.j.token)).j.wallet.main;
  assert(Math.abs(bal1 - (bal0 - 10 + played.payout)) < 0.001, `casino atomic settle: ${bal0} -> ${bal1}, payout ${played.payout}`);
  // insufficient funds rejected without moving balance
  const broke = await call('POST', '/api/casino/play', { game: 'dice', choice: 'over', stake: 99999 }, player.j.token);
  assert.strictEqual(broke.s, 400);
  const bal2 = (await call('GET', '/api/me', null, player.j.token)).j.wallet.main;
  assert.strictEqual(bal1, bal2);
  console.log('HTTP flow OK - register/admin/player, deposit confirm, bet, cashout GH₵' + co.j.cashout + ', settlement, casino (payout GH₵' + played.payout + '), proof verified, funds guard');
  console.log('ALL TESTS PASS');
  process.exit(0);
})().catch(e => { console.error('TEST FAIL:', e.message); process.exit(1); });
