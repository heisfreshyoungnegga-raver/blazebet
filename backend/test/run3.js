// Phase 3 tests: admin power pack (ported from production PrimeStake/Oddaroa patterns).
process.env.BLAZEBET_DB = require('node:path').join(__dirname, 'test3.db');
for (const suf of ['', '-wal', '-shm']) require('node:fs').rmSync(process.env.BLAZEBET_DB + suf, { force: true });
const assert = require('node:assert');
(async () => {
  require('../src/server').start(4201);
  const base = 'http://127.0.0.1:4201';
  const call = async (m, p, body, tok) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
  await new Promise(r => setTimeout(r, 300));
  const admin = await call('POST', '/api/auth/register', { phone: '+233800000001', password: 'adminpass' });
  const AT = admin.j.token;
  // invite -> second admin
  const inv = await call('POST', '/api/admin/invites', { role: 'admin', hours: 24 }, AT);
  assert.strictEqual(inv.s, 201, JSON.stringify(inv.j));
  const admin2 = await call('POST', '/api/auth/register', { phone: '+233800000002', password: 'admin2pass', invite: inv.j.token });
  assert.strictEqual(admin2.s, 201); assert.strictEqual(admin2.j.user.role, 'admin', 'invite mints admin: ' + JSON.stringify(admin2.j));
  assert.strictEqual((await call('POST', '/api/auth/register', { phone: '+233800000099', password: 'x123456', invite: inv.j.token })).s, 400, 'invite is one-time');
  // player via referral of a referrer user
  const ref = await call('POST', '/api/auth/register', { phone: '+233800000003', password: 'refpass' });
  const refMe = await call('GET', '/api/referrals', null, ref.j.token);
  assert(refMe.j.refCode, 'ref code issued');
  const player = await call('POST', '/api/auth/register', { phone: '+233800000004', password: 'playerpass', ref: refMe.j.refCode });
  const PT = player.j.token, PID = player.j.user.id;
  // deposit 200 -> referrer earns 5% commission = 10
  const dep = await call('POST', '/api/wallet/request', { type: 'deposit', amount: 200 }, PT);
  await call('POST', '/api/admin/queue/' + dep.j.requestId, { action: 'confirm' }, AT);
  const refBal = (await call('GET', '/api/me', null, ref.j.token)).j.wallet.main;
  assert.strictEqual(refBal, 10, 'commission 5% of 200 = 10, got ' + refBal);
  // users list + detail (admin2 allowed)
  const users = await call('GET', '/api/admin/users', null, admin2.j.token); assert(users.j.users.length >= 4);
  const detail = await call('GET', '/api/admin/users/' + PID, null, AT);
  assert.strictEqual(detail.j.user.main, 200);
  // balance edit is super-only, audited, moves money exactly
  assert.strictEqual((await call('POST', '/api/admin/users/' + PID + '/balance', { amount: 50, reason: 'goodwill' }, admin2.j.token)).s, 403);
  const be = await call('POST', '/api/admin/users/' + PID + '/balance', { amount: 50, reason: 'goodwill' }, AT);
  assert.strictEqual(be.j.main, 250);
  const beNeg = await call('POST', '/api/admin/users/' + PID + '/balance', { amount: -1000, reason: 'clawback test' }, AT);
  assert.strictEqual(beNeg.s, 400, 'cannot drive balance negative');
  // worksheet sees today's confirm + balance edits
  const ws = await call('GET', '/api/admin/worksheet', null, AT);
  assert(ws.j.queueWork.some(r => r.type === 'deposit' && r.status === 'confirmed' && r.n === 1), JSON.stringify(ws.j));
  assert(ws.j.actions.some(a => a.action === 'balance_edit'), 'audit log records balance edits');
  // match lock blocks betting
  const matches = await call('GET', '/api/matches'); const m0 = matches.j.matches[0];
  await call('POST', '/api/admin/matches/' + m0.id + '/lock', { locked: true }, AT);
  const lockedBet = await call('POST', '/api/bets', { stake: 5, legs: [{ matchId: m0.id, pick: '1' }] }, PT);
  assert.strictEqual(lockedBet.j.error, 'betting_locked');
  await call('POST', '/api/admin/matches/' + m0.id + '/lock', { locked: false }, AT);
  const okBet = await call('POST', '/api/bets', { stake: 5, legs: [{ matchId: m0.id, pick: '1' }] }, PT);
  assert.strictEqual(okBet.s, 201);
  // super voids the bet -> full refund
  const vd = await call('POST', '/api/admin/bets/' + okBet.j.betId + '/void', {}, AT);
  assert.strictEqual(vd.j.refunded, 5);
  assert.strictEqual((await call('GET', '/api/me', null, PT)).j.wallet.main, 250);
  // support roundtrip
  await call('POST', '/api/support', { body: 'I need help with my deposit' }, PT);
  const threads = await call('GET', '/api/admin/support', null, admin2.j.token);
  assert(threads.j.threads.some(x => x.user_id === PID && x.msgs === 1), JSON.stringify(threads.j));
  await call('POST', '/api/admin/support/' + PID + '/reply', { body: 'We are on it' }, admin2.j.token);
  const thread = await call('GET', '/api/support', null, PT);
  assert.strictEqual(thread.j.messages.length, 2); assert.strictEqual(thread.j.messages[1].sender, 'admin');
  // maintenance blocks players, not admins
  await call('POST', '/api/admin/settings', { settings: { maintenance: 1 } }, AT);
  assert.strictEqual((await call('POST', '/api/casino/play', { game: 'dice', choice: 'over', stake: 5 }, PT)).s, 503);
  await call('POST', '/api/admin/settings', { settings: { maintenance: 0 } }, AT);
  assert.strictEqual((await call('POST', '/api/casino/play', { game: 'dice', choice: 'over', stake: 5 }, PT)).s, 200);
  // block: sessions killed, login refused
  await call('POST', '/api/admin/users/' + PID + '/block', { blocked: true }, admin2.j.token);
  assert.strictEqual((await call('GET', '/api/me', null, PT)).s, 401, 'blocked user session dead');
  assert.strictEqual((await call('POST', '/api/auth/login', { phone: '+233800000004', password: 'playerpass' })).s, 403, 'blocked login refused');
  await call('POST', '/api/admin/users/' + PID + '/block', { blocked: false }, AT);
  assert.strictEqual((await call('POST', '/api/auth/login', { phone: '+233800000004', password: 'playerpass' })).s, 200);
  // promote + delete guards
  assert.strictEqual((await call('POST', '/api/admin/users/' + PID + '/role', { role: 'admin' }, AT)).s, 200);
  assert.strictEqual((await call('DELETE', '/api/admin/users/' + PID, null, AT)).s, 400, 'user with balance cannot be deleted');
  console.log('phase3 HTTP OK - invites, commission GH₵10, users/detail, balance edit + audit, worksheet, match lock, bet void refund, support chat, maintenance gate, block/unblock, role change');
  console.log('ALL PHASE 3 TESTS PASS');
  process.exit(0);
})().catch(e => { console.error('TEST FAIL:', e.message); process.exit(1); });
