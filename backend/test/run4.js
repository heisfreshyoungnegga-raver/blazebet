// Promo code tests: admin-created code at registration.
process.env.BLAZEBET_DB = require('node:path').join(__dirname, 'test4.db');
for (const suf of ['', '-wal', '-shm']) require('node:fs').rmSync(process.env.BLAZEBET_DB + suf, { force: true });
const assert = require('node:assert');
(async () => {
  require('../src/server').start(4203);
  const base = 'http://127.0.0.1:4203';
  const call = async (m, p, body, tok) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
  await new Promise(r => setTimeout(r, 300));
  const admin = await call('POST', '/api/auth/register', { phone: '+233600000001', password: 'adminpass' });
  await call('POST', '/api/admin/promos', { code: 'LAUNCH', bonus: 10 }, admin.j.token);
  // lowercase works (case-insensitive), bonus lands in the stake-only bucket
  const p1 = await call('POST', '/api/auth/register', { phone: '+233600000002', password: 'playerpass', promoCode: 'launch' });
  assert.strictEqual(p1.s, 201, JSON.stringify(p1.j));
  assert.strictEqual(p1.j.promoApplied.code, 'LAUNCH'); assert.strictEqual(p1.j.promoApplied.bonus, 10);
  const me = await call('GET', '/api/me', null, p1.j.token);
  assert.strictEqual(me.j.wallet.bonus, 10, 'GH₵10 in bonus bucket'); assert.strictEqual(me.j.wallet.main, 0);
  // second user can also use OO (unlimited by default), uses counter moves
  const p2 = await call('POST', '/api/auth/register', { phone: '+233600000003', password: 'playerpass', promoCode: 'LAUNCH' });
  assert.strictEqual(p2.s, 201);
  // invalid code rejected, no account created
  const bad = await call('POST', '/api/auth/register', { phone: '+233600000004', password: 'playerpass', promoCode: 'NOPE' });
  assert.strictEqual(bad.s, 400); assert.strictEqual(bad.j.error, 'invalid_promo_code');
  assert.strictEqual((await call('POST', '/api/auth/login', { phone: '+233600000004', password: 'playerpass' })).s, 401);
  // no promo = clean register, promoApplied null
  const p3 = await call('POST', '/api/auth/register', { phone: '+233600000005', password: 'playerpass' });
  assert.strictEqual(p3.s, 201); assert.strictEqual(p3.j.promoApplied, null);
  // admin creates a capped code; cap enforced
  const mk = await call('POST', '/api/admin/promos', { code: 'vip5', bonus: 5, maxUses: 1 }, admin.j.token);
  assert.strictEqual(mk.s, 201); assert.strictEqual(mk.j.code, 'VIP5');
  assert.strictEqual((await call('POST', '/api/auth/register', { phone: '+233600000006', password: 'playerpass', promoCode: 'VIP5' })).s, 201);
  assert.strictEqual((await call('POST', '/api/auth/register', { phone: '+233600000007', password: 'playerpass', promoCode: 'VIP5' })).s, 400, 'cap reached');
  const list = await call('GET', '/api/admin/promos', null, admin.j.token);
  const oo = list.j.promos.find(x => x.code === 'LAUNCH'); assert.strictEqual(oo.uses, 2, 'LAUNCH used twice');
  // deactivate OO -> no longer accepted
  await call('POST', '/api/admin/promos', { code: 'LAUNCH', bonus: 10, active: false }, admin.j.token);
  assert.strictEqual((await call('POST', '/api/auth/register', { phone: '+233600000008', password: 'playerpass', promoCode: 'LAUNCH' })).s, 400);
  console.log('promo OK - admin-created code grants GH₵10 bonus (case-insensitive), invalid rejected cleanly, caps + deactivate enforced, uses tracked');
  console.log('ALL PROMO TESTS PASS');
  process.exit(0);
})().catch(e => { console.error('TEST FAIL:', e.message); process.exit(1); });
