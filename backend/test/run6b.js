// AREA B regression tests (B3/B4/H4/M10 + H2/H7/L7/markets).
// SQLite, same harness style as run.js–run5.js. Run ONLY this file:
//   node test/run6b.js        (do NOT run the full suite concurrently — Phase 2 runs it)
process.env.BLAZEBET_DB = require('node:path').join(__dirname, 'test6.db');
for (const suf of ['', '-wal', '-shm']) require('node:fs').rmSync(process.env.BLAZEBET_DB + suf, { force: true });
const assert = require('node:assert');
const db = require('../src/db');
const wallet = require('../src/wallet');
const { hashPassword } = require('../src/crypto');
const { floatStream } = require('../src/crypto');
const { GAMES, validateChoice, gameMaxMultiplier } = require('../src/games');
const { SESSION_GAMES, LADDER, balloonMult, actSessionGuarded } = require('../src/sessions');
const { fairProbFromOdds } = require('../src/odds');
const { settleLeg } = require('../src/markets');

(async () => {
  await db.init();

  // ---- B3: Balloon Pop can pop on pump 1; EV(k) = 0.97^k ----
  const popAts = new Set();
  for (let i = 0; i < 5000; i++) popAts.add(SESSION_GAMES.balloon.start(floatStream('b6', 'u', i)).popAt);
  assert.strictEqual(Math.min(...popAts), 1, 'popAt must reach 1 (pump 1 can bust)');
  assert.strictEqual(Math.max(...popAts), 13, 'popAt must reach 13');
  for (let k = 1; k <= 12; k++) {
    const ev = ((13 - k) / 13) * balloonMult(k);
    assert(ev < 1 && Math.abs(ev - Math.pow(0.97, k)) < 0.015, `balloon EV k=${k}: ${ev}`);
  }
  assert.strictEqual(balloonMult(1), 1.05, 'pump-1 mult 1.05');
  console.log('B3 OK - popAt 1..13, EV(k)=0.97^k, pump-1 EV 0.9692');

  // ---- B4: Penalty Kick + Goal Ladder priced from true probabilities ----
  assert.strictEqual(GAMES.penalty.play('Top Left', () => 0.99).multiplier, 1.16, 'corner pays x1.16 (keeper Bottom Right)');
  assert.strictEqual(GAMES.penalty.play('Top Centre', () => 0.99).multiplier, 1.45, 'centre pays x1.45');
  assert((5 / 6) * 1.16 < 1 && (4 / 6) * 1.45 < 1, 'penalty EVs < 1');
  assert(Math.abs((5 / 6) * 1.16 - 0.9667) < 0.001, 'penalty corner EV 0.9667');
  assert(Math.abs((4 / 6) * 1.45 - 0.9667) < 0.001, 'penalty centre EV 0.9667');
  assert.deepStrictEqual(LADDER, [1.16, 1.35, 1.57, 1.83, 2.13], 'ladder rebuilt, top x2.13 not x5.5');
  for (let k = 1; k <= 5; k++) {
    const ev = Math.pow(5 / 6, k) * LADDER[k - 1];
    assert(ev < 1 && ev > 0.8, `ladder rung ${k} EV ${ev}`);
    if (k > 1) assert(Math.abs(LADDER[k - 1] / LADDER[k - 2] - 1.164) < 0.003, 'ladder step ~1.164');
  }
  console.log('B4 OK - penalty corner EV 0.9667 / centre EV 0.9667; ladder EVs 0.967/0.938/0.909/0.883/0.856');

  // ---- H4: Mines 0-pick cashout throws; creditWinnings splits pro-rata ----
  let _i = 0; const cyc = () => ((_i++ % 25) + 0.5) / 25;
  const mst = SESSION_GAMES.mines.start(cyc, { mines: 3 });
  assert.throws(() => SESSION_GAMES.mines.act(mst, 'cashout', {}), /nothing_to_cash/);
  console.log('H4 OK - mines 0-pick cashout throws nothing_to_cash');
  // wallet split: stake GH₵100 funded GH₵60 bonus + GH₵40 main; GH₵100 payout -> 60 bonus / 40 main
  const u = await db.run('INSERT INTO users(phone,pass_hash,role) VALUES(?,?,?)', '+233600000001', hashPassword('pw'), 'player');
  const uid = Number(u.id);
  await wallet.post(uid, 'bonus', 6000, 'promo_bonus', 't:b', 't:b:' + uid);
  await wallet.post(uid, 'main', 4000, 'deposit', 't:m', 't:m:' + uid);
  const split = await wallet.debitStake(uid, 10000, 'casino_stake', 't:stake', 't:stake:' + uid);
  assert.deepStrictEqual(split, { bonusUse: 6000, mainUse: 4000 });
  const cr = await wallet.creditWinnings(uid, 6000, 4000, 10000, 't:payout:' + uid);
  assert.deepStrictEqual(cr, { bonus: 6000, main: 4000 }, 'payout split pro-rata to stake funding');
  assert.strictEqual(await wallet.balance(uid, 'bonus'), 6000, 'bonus-funded share stays bonus');
  assert.strictEqual(await wallet.balance(uid, 'main'), 4000, 'main-funded share returns to main');
  // odd payout rounds the remainder to main: GH₵10.01 on a 50/50 split -> 500 bonus / 501 main
  const cr2 = await wallet.creditWinnings(uid, 5000, 5000, 1001, 't:payout2:' + uid);
  assert.deepStrictEqual(cr2, { bonus: 500, main: 501 });
  console.log('H4 OK - creditWinnings splits pro-rata (60/40 stays 60/40; 1001 -> 500/501)');

  // ---- H2: one referral commission, first deposit only, both rails share it ----
  const ref = await db.run('INSERT INTO users(phone,pass_hash,role) VALUES(?,?,?)', '+233600000002', hashPassword('pw'), 'player');
  const refId = Number(ref.id);
  const dep1 = await db.run('INSERT INTO users(phone,pass_hash,role,referred_by) VALUES(?,?,?,?)', '+233600000003', hashPassword('pw'), 'player', refId);
  const depId = Number(dep1.id);
  await db.setSetting('commission_pct', 5);
  const first = await wallet.payReferralCommission(depId, 20000, 'req:1');
  assert.deepStrictEqual(first, { paid: true, referrerId: refId, amountMinor: 1000 }, 'first deposit pays 5%');
  assert.strictEqual(await wallet.balance(refId, 'main'), 1000);
  const second = await wallet.payReferralCommission(depId, 20000, 'deposit:shinobipay:REF2');
  assert.strictEqual(second.paid, false, 'second deposit (other rail) pays nothing');
  assert.strictEqual(second.reason, 'already_claimed');
  assert.strictEqual(await wallet.balance(refId, 'main'), 1000, 'no second commission credited');
  const noRef = await wallet.payReferralCommission(uid, 20000, 'req:9');
  assert.deepStrictEqual(noRef, { paid: false, reason: 'no_referrer' });
  console.log('H2 OK - first deposit pays 5% once (GH₵10.00); second deposit, other rail, pays nothing');

  // ---- H7: max-payout gate + 500 caps ----
  assert.strictEqual(GAMES.limbo.play('1000000', () => 0.999).detail.target, 500);
  assert.strictEqual(GAMES.skyclimb.play('999', () => 0.5).detail.target, 500);
  assert.strictEqual(gameMaxMultiplier('limbo', '1000000'), 500);
  assert.throws(() => wallet.assertWithinMaxPayout(100000, 500, { max_payout_ghs: 200000 }), /above_max_payout/,
    'GH₵1000 x 500 = GH₵500,000 exceeds the GH₵200,000 cap');
  assert.strictEqual(wallet.assertWithinMaxPayout(1000, 2.33, { max_payout_ghs: 200000 }), 2330);
  assert.strictEqual(wallet.assertWithinMaxPayout(1000, 2.33, 20000000), 2330, 'plain-number settings = minor units');
  console.log('H7 OK - limbo/skyclimb capped at 500; assertWithinMaxPayout rejects above cap');

  // ---- M10: validateChoice ----
  assert.strictEqual(validateChoice('dice', 'over'), null);
  assert.strictEqual(validateChoice('dice', 'banana'), 'bad_choice');
  assert.strictEqual(validateChoice('keno', '1,2,3,4,5'), null);
  assert.strictEqual(validateChoice('keno', '1,2,3'), 'bad_choice');
  assert.strictEqual(validateChoice('keno', '1,2,3,4,5,6'), 'bad_choice');
  assert.strictEqual(validateChoice('roulette', 'purple'), 'bad_choice');
  assert.strictEqual(validateChoice('speedwheel', '7'), null);
  assert.strictEqual(validateChoice('speedwheel', '10'), 'bad_choice');
  assert.strictEqual(validateChoice('limbo', '501'), 'bad_choice');
  assert.strictEqual(validateChoice('penalty', 'Middle'), 'bad_choice');
  assert.strictEqual(validateChoice('nope', 'x'), 'unknown_game');
  console.log('M10 OK - keno needs exactly 5 picks; dice/roulette/limbo/penalty sets enforced');

  // ---- L7: fairProbFromOdds normalises (no double margin) ----
  const fair = fairProbFromOdds([1.88, 3.14, 4.71], 0.06);
  assert(Math.abs(fair.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'fair probs sum to 1');
  assert(Math.abs(fair[0] - 0.5) < 0.02, 'fair recovers true prob');
  console.log('L7 OK - fairProbFromOdds([1.88,3.14,4.71]) sums to 1, recovers ~[0.50,0.30,0.20]');

  // ---- markets: Correct Score + BTTS leg settled from a score ----
  assert.strictEqual(settleLeg('CS', '2:1', 2, 1), 'won');
  assert.strictEqual(settleLeg('CS', '2:1', 1, 0), 'lost');
  assert.strictEqual(settleLeg('BTTS', 'Yes', 2, 1), 'won');
  assert.strictEqual(settleLeg('BTTS', 'No', 2, 0), 'won');
  assert.strictEqual(settleLeg('DC', '1X', 2, 1), 'won');
  assert.strictEqual(settleLeg('OU25', 'Under', 1, 0), 'won');
  assert.strictEqual(settleLeg('DNB', '1', 1, 1), 'void');
  assert.strictEqual(settleLeg('WTN', 'Away', 0, 2), 'won');
  assert.strictEqual(settleLeg('HT1X2', '1', 2, 1), null, 'HT legs never settle from the FT score');
  console.log('markets OK - CS+BTTS (and DC/OU/DNB/WTN) settle from score; HT1X2 returns null');

  // ---- H6-support: actSessionGuarded claims once; a throw leaves the session active ----
  const s = await db.run(
    "INSERT INTO game_sessions(user_id,game,stake_minor,status,state,seed_hash) VALUES(?,?,?,?,?,?)",
    uid, 'mines', 1000, 'active', '{}', 'hash');
  const sid = Number(s.id);
  const g1 = await actSessionGuarded(sid, async (row) => {
    assert.strictEqual(row.status, 'acting', 'fn sees the claimed row');
    await db.run("UPDATE game_sessions SET status='won',multiplier=1.1,payout_minor=1100 WHERE id=?", sid);
    return { done: true };
  });
  assert.strictEqual(g1.touched, 1, 'first guarded action claims the session');
  assert.deepStrictEqual(g1.result, { done: true });
  const g2 = await actSessionGuarded(sid, async () => ({ done: true }));
  assert.strictEqual(g2.touched, 0, 'second guarded action finds no active session');
  const s2 = await db.run(
    "INSERT INTO game_sessions(user_id,game,stake_minor,status,state,seed_hash) VALUES(?,?,?,?,?,?)",
    uid, 'mines', 1000, 'active', '{}', 'hash');
  const sid2 = Number(s2.id);
  await assert.rejects(actSessionGuarded(sid2, async () => { throw new Error('boom'); }), /boom/);
  const after = await db.one('SELECT status FROM game_sessions WHERE id=?', sid2);
  assert.strictEqual(after.status, 'active', 'throw rolls back: session stays active');
  console.log('H6 OK - actSessionGuarded claims once (touched 1 then 0); throw leaves session active');

  // ---- HTTP: Mines 0-pick cashout via the live session route ----
  // (super admin inserted directly: direct-inserted users above already
  // consumed the first-user bootstrap, so an HTTP register would be a player)
  const { randomBytes } = require('node:crypto');
  const adm = await db.run('INSERT INTO users(phone,pass_hash,role) VALUES(?,?,?)', '+233600000010', hashPassword('adminpass'), 'super_admin');
  const admTok = randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions(token,user_id) VALUES(?,?)', admTok, Number(adm.id));
  require('../src/server').start(4205);
  const base = 'http://127.0.0.1:4205';
  const call = async (m, p, body, tok) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
  await new Promise(r => setTimeout(r, 300));
  const player = await call('POST', '/api/auth/register', { phone: '+233600000011', password: 'playerpass' });
  assert.strictEqual(player.s, 201);
  const dep = await call('POST', '/api/wallet/request', { type: 'deposit', amount: 100 }, player.j.token);
  await call('POST', '/api/admin/queue/' + dep.j.requestId, { action: 'confirm' }, admTok);
  const sess = await call('POST', '/api/casino/session/start', { game: 'mines', stake: 10, options: { mines: 3 } }, player.j.token);
  assert.strictEqual(sess.s, 201, JSON.stringify(sess.j));
  const co = await call('POST', '/api/casino/session/' + sess.j.sessionId + '/action', { action: 'cashout' }, player.j.token);
  assert.strictEqual(co.s, 400, JSON.stringify(co.j));
  assert.strictEqual(co.j.error, 'nothing_to_cash', 'immediate mines cashout is rejected, no bonus conversion');
  const me = await call('GET', '/api/me', null, player.j.token);
  assert.strictEqual(me.j.wallet.main, 90, 'stake stays debited; nothing was refunded to main');
  console.log('HTTP OK - mines 0-pick cashout -> 400 nothing_to_cash, balance unchanged at GH₵90.00');
  console.log('ALL RUN6B TESTS PASS');
  process.exit(0);
})().catch(e => { console.error('TEST FAIL:', e.message); process.exit(1); });
