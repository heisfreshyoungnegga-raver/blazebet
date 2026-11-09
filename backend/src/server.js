const http = require('node:http');
const crypto = require('node:crypto');
const db = require('./db');
const { one, all, run, execSql, getSetting, setSetting } = db;
const prep = (sql) => ({ get: (...a) => one(sql, ...a), all: (...a) => all(sql, ...a), run: (...a) => run(sql, ...a) });
const { hashPassword, verifyPassword, newToken, sha256, floatStream } = require('./crypto');
const wallet = require('./wallet');
const { buildBook, potential, cashoutValue } = require('./odds');
const { GAMES } = require('./games');
const { SESSION_GAMES } = require('./sessions');
const { crashPoint } = require('./crypto');
const PORT = process.env.PORT || 4180;
const toMinor = (ghs) => Math.round(parseFloat(ghs) * 100);
const toGhs = (minor) => minor / 100;


const SDK_JS = `// BlizBet API SDK - include with <script src="https://YOUR-API/sdk.js"></script>
window.BlizBet = (() => {
  let base = '', token = localStorage.getItem('bb_token') || '';
  async function call(m, p, body) { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; }
  return {
    setBase(u) { base = u; }, get token() { return token; },
    async register(phone, password, name, promoCode, ref) { const j = await call('POST', '/api/auth/register', { phone, password, name, promoCode, ref }); token = j.token; localStorage.setItem('bb_token', token); return j; },
    async login(phone, password) { const j = await call('POST', '/api/auth/login', { phone, password }); token = j.token; localStorage.setItem('bb_token', token); return j; },
    logout() { token = ''; localStorage.removeItem('bb_token'); },
    me: () => call('GET', '/api/me'), wallet: () => call('GET', '/api/wallet'),
    request: (type, amount, method) => call('POST', '/api/wallet/request', { type, amount, method }),
    matches: () => call('GET', '/api/matches'), placeBet: (stake, legs) => call('POST', '/api/bets', { stake, legs }),
    myBets: () => call('GET', '/api/bets'), cashout: (id) => call('POST', '/api/bets/' + id + '/cashout', {}),
    games: () => call('GET', '/api/casino/games'), play: (game, choice, stake) => call('POST', '/api/casino/play', { game, choice, stake }),
    sessionStart: (game, stake, options) => call('POST', '/api/casino/session/start', { game, stake, options }),
    sessionAct: (id, action, extra) => call('POST', '/api/casino/session/' + id + '/action', { action, ...(extra || {}) }),
    sessionGet: (id) => call('GET', '/api/casino/session/' + id), history: () => call('GET', '/api/casino/history'),
  };
})();`;

async function seedMatches() {
  if ((await one('SELECT COUNT(*) c FROM matches')).c) return;
  const demos = [
    ['Premier League','Arsenal','Chelsea', [0.42,0.27,0.31]], ['Premier League','Man City','Liverpool',[0.48,0.26,0.26]],
    ['La Liga','Real Madrid','Barcelona',[0.38,0.27,0.35]], ['Serie A','Inter','Juventus',[0.40,0.30,0.30]],
    ['Bundesliga','Bayern','Dortmund',[0.55,0.23,0.22]], ['Ghana Premier League','Hearts of Oak','Asante Kotoko',[0.36,0.32,0.32]],
  ];
  const ins = prep('INSERT INTO matches(league,home,away,starts_at) VALUES(?,?,?,?)');
  const oddsIns = prep('INSERT INTO settings(key,value) VALUES(?,?)');
  for (const [i, [lg, h, a, probs]] of demos.entries()) {
    const r = await ins.run(lg, h, a, new Date(Date.now() + (i + 2) * 3600e3).toISOString());
    await oddsIns.run('match_odds:' + r.id, JSON.stringify(buildBook(probs, await getSetting('book_margin', 0.06))));
  }
}

function send(res, code, obj) { const body = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' }); res.end(body); }
async function auth(req, roles) {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  const s = tok && await one('SELECT user_id FROM sessions WHERE token=?', tok);
  if (!s) return null;
  const u = await one('SELECT id,phone,name,role,status,ref_code FROM users WHERE id=?', s.user_id);
  if (!u || u.status === 'blocked') return null;
  if (roles && !roles.includes(u.role)) return null;
  return u;
}
const routes = [];
async function audit(adminId, action, target, detail) { try { await run('INSERT INTO admin_actions(admin_id,action,target,detail) VALUES(?,?,?,?)', adminId, action, String(target || ''), String(detail || '')); } catch {} }
const route = (m, p, fn) => routes.push([m, new RegExp('^' + p.replace(/:\w+/g, '(\\w+)') + '$'), fn]);

route('POST', '/api/auth/register', async (req, res, b) => {
  if (await getSetting('registration_open', 1) === 0 && !b.invite) return send(res, 403, { error: 'registration_closed' });
  if (!b.phone || !b.password) return send(res, 400, { error: 'phone_and_password_required' });
  const count = (await one('SELECT COUNT(*) c FROM users')).c;
  let role = count === 0 ? 'super_admin' : 'player'; let referredBy = null;
  if (b.ref) { const ref = await one('SELECT id FROM users WHERE ref_code=?', String(b.ref).toUpperCase()); if (ref) referredBy = ref.id; }
  if (b.invite) { const inv = await one("SELECT * FROM admin_invites WHERE token=? AND used_by IS NULL AND expires_at > CURRENT_TIMESTAMP", String(b.invite));
    if (!inv) return send(res, 400, { error: 'invalid_or_expired_invite' }); role = inv.role; }
  let promo = null;
  if (b.promoCode) { promo = await one("SELECT * FROM promo_codes WHERE code=? AND active=1 AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) AND (max_uses=0 OR uses < max_uses)", String(b.promoCode).toUpperCase());
    if (!promo) return send(res, 400, { error: 'invalid_promo_code' }); }
  try {
    const r = await run('INSERT INTO users(phone,name,pass_hash,role,referred_by) VALUES(?,?,?,?,?)', b.phone, b.name || '', hashPassword(b.password), role, referredBy);
    const uid = Number(r.id);
    await run('UPDATE users SET ref_code=? WHERE id=?', 'BB' + uid.toString(36).toUpperCase().padStart(4, '0'), uid);
    if (b.invite) await run('UPDATE admin_invites SET used_by=? WHERE token=?', uid, String(b.invite));
    if (promo) { await run('INSERT INTO promo_redemptions(code,user_id) VALUES(?,?)', promo.code, uid);
      await run('UPDATE promo_codes SET uses=uses+1 WHERE code=?', promo.code);
      await wallet.post(uid, 'bonus', promo.bonus_minor, 'promo_bonus', 'promo:' + promo.code, 'promo:' + promo.code + ':' + uid); }
    const token = newToken(); await run('INSERT INTO sessions(token,user_id) VALUES(?,?)', token, uid);
    const wb = toMinor(await getSetting('welcome_bonus_ghs', 0)); if (wb > 0) await wallet.post(uid, 'bonus', wb, 'welcome_bonus', 'user:' + uid, 'welcome:' + uid);
    send(res, 201, { token, user: { id: uid, phone: b.phone, role }, promoApplied: promo ? { code: promo.code, bonus: toGhs(promo.bonus_minor) } : null });
  } catch (e) { send(res, 409, { error: 'account_exists' }); }
});
const loginFails = new Map(); // phone -> {fails, lockedUntil}
route('POST', '/api/auth/login', async (req, res, b) => {
  const key = String(b.phone || ''); const rec = loginFails.get(key);
  if (rec && rec.lockedUntil > Date.now()) return send(res, 429, { error: 'locked_try_later' });
  const u = await one('SELECT * FROM users WHERE phone=?', b.phone || '');
  if (u && u.status === 'blocked') return send(res, 403, { error: 'account_blocked' });
  if (!u || !verifyPassword(b.password || '', u.pass_hash)) {
    const r = rec || { fails: 0, lockedUntil: 0 }; r.fails++;
    if (r.fails >= 10) { r.lockedUntil = Date.now() + 15 * 60e3; r.fails = 0; }
    loginFails.set(key, r); return send(res, 401, { error: 'invalid_credentials' }); }
  loginFails.delete(key);
  const token = newToken(); await run('INSERT INTO sessions(token,user_id) VALUES(?,?)', token, u.id);
  send(res, 200, { token, user: { id: u.id, phone: u.phone, role: u.role } });
});
route('POST', '/api/auth/change-password', async (req, res, b) => { const u0 = await auth(req); if (!u0) return send(res, 401, { error: 'unauthorized' });
  const u = await one('SELECT * FROM users WHERE id=?', u0.id);
  if (!verifyPassword(b.current || '', u.pass_hash)) return send(res, 400, { error: 'wrong_current_password' });
  if (!b.next || String(b.next).length < 6) return send(res, 400, { error: 'password_too_short' });
  await run('UPDATE users SET pass_hash=? WHERE id=?', hashPassword(b.next), u.id);
  send(res, 200, { changed: true }); });
route('GET', '/api/me', async (req, res) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  send(res, 200, { user: u, wallet: { main: toGhs(await wallet.balance(u.id, 'main')), bonus: toGhs(await wallet.balance(u.id, 'bonus')) } }); });
route('GET', '/api/wallet', async (req, res) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const tx = (await all('SELECT bucket,delta_minor,kind,ref,created_at FROM ledger_entries WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id))
    .map(t => ({ ...t, amount: toGhs(t.delta_minor), delta_minor: undefined }));
  send(res, 200, { main: toGhs(await wallet.balance(u.id, 'main')), bonus: toGhs(await wallet.balance(u.id, 'bonus')), transactions: tx }); });
route('POST', '/api/wallet/request', async (req, res, b) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const amount = toMinor(b.amount || 0); if (!['deposit','withdrawal'].includes(b.type) || amount <= 0) return send(res, 400, { error: 'bad_request' });
  if (b.type === 'withdrawal' && await wallet.balance(u.id, 'main') < amount) return send(res, 400, { error: 'insufficient_funds' });
  const r = await run('INSERT INTO payment_requests(user_id,type,amount_minor,method) VALUES(?,?,?,?)', u.id, b.type, amount, b.method || 'momo');
  send(res, 201, { requestId: Number(r.id), status: 'pending' }); });
route('GET', '/api/matches', async (req, res) => {
  const ms = [];
  for (const m of await all("SELECT * FROM matches WHERE status='upcoming' ORDER BY starts_at"))
    ms.push({ ...m, odds1x2: await getSetting('match_odds:' + m.id, null) });
  send(res, 200, { matches: ms }); });
route('POST', '/api/bets', async (req, res, b) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  if (await getSetting('maintenance', 0) && u.role === 'player') return send(res, 503, { error: 'maintenance' });
  const stake = toMinor(b.stake || 0); const legs = Array.isArray(b.legs) ? b.legs : [];
  if (stake <= 0 || !legs.length) return send(res, 400, { error: 'bad_bet' });
  const minStake = toMinor(await getSetting('min_stake_ghs', 1)); if (stake < minStake) return send(res, 400, { error: 'below_min_stake' });
  const resolved = [];
  for (const l of legs) { const m = await one("SELECT * FROM matches WHERE id=? AND status='upcoming'", l.matchId);
    if (m && m.betting_locked) return send(res, 400, { error: 'betting_locked', matchId: l.matchId });
    if (!m) return send(res, 400, { error: 'match_not_open', matchId: l.matchId });
    const book = await getSetting('match_odds:' + m.id, null); const idx = { '1': 0, 'X': 1, '2': 2 }[l.pick];
    if (!book || idx === undefined) return send(res, 400, { error: 'bad_pick' });
    resolved.push({ match_id: m.id, pick: l.pick, odds: book[idx], fair_prob: 1 / (book[idx] * (1 + await getSetting('book_margin', 0.06))) }); }
  const pot = potential(stake, resolved.map(r => r.odds));
  if (pot > toMinor(await getSetting('max_payout_ghs', 200000))) return send(res, 400, { error: 'above_max_payout' });
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  let betIdOut;
  try { await db.tx(async () => {
    const r = await run('INSERT INTO bets(user_id,stake_minor,potential_minor,code) VALUES(?,?,?,?)', u.id, stake, pot, 'BB' + code);
    betIdOut = Number(r.id);
    const ins = prep('INSERT INTO bet_legs(bet_id,match_id,market,pick,odds,fair_prob) VALUES(?,?,?,?,?,?)');
    for (const l of resolved) await ins.run(Number(r.id), l.match_id, '1X2', l.pick, l.odds, l.fair_prob);
    await wallet.debitStake(u.id, stake, 'bet_stake', 'bet:' + r.id, 'bet:' + r.id);
    }); send(res, 201, { betId: betIdOut, code: 'BB' + code, stake: toGhs(stake), potential: toGhs(pot) });
  } catch (e) { send(res, 400, { error: e.message }); } });
route('GET', '/api/bets', async (req, res) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const bets = (await all('SELECT * FROM bets WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id))
    .map(x => ({ ...x, stake: toGhs(x.stake_minor), potential: toGhs(x.potential_minor), payout: x.payout_minor == null ? null : toGhs(x.payout_minor) }));
  send(res, 200, { bets }); });
route('POST', '/api/bets/:id/cashout', async (req, res, b, id) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const bet = await one('SELECT * FROM bets WHERE id=? AND user_id=?', id, u.id);
  if (!bet || bet.status !== 'open') return send(res, 400, { error: 'bet_not_open' });
  const legs = await all('SELECT status,fair_prob FROM bet_legs WHERE bet_id=?', id);
  const value = cashoutValue(bet.potential_minor, legs, await getSetting('cashout_margin', 0.10));
  if (!value) return send(res, 400, { error: 'no_cashout_value' });
  try { await db.tx(async () => { await run("UPDATE bets SET status='cashed_out',payout_minor=?,settled_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'", value, id);
    await wallet.post(u.id, 'main', value, 'cashout', 'bet:' + id, 'cashout:' + id); });
    send(res, 200, { betId: +id, cashout: toGhs(value) }); } catch (e) { send(res, 400, { error: e.message }); } });
route('GET', '/api/casino/games', async (req, res) => send(res, 200, { games: Object.entries(GAMES).map(([slug, g]) => ({ slug, name: g.name, mode: 'instant' })), sessionGames: Object.entries(SESSION_GAMES).map(([slug, g]) => ({ slug, name: g.name, mode: 'session' })) }));
route('POST', '/api/casino/play', async (req, res, b) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  if (await getSetting('maintenance', 0) && u.role === 'player') return send(res, 503, { error: 'maintenance' });
  const g = GAMES[b.game]; const stake = toMinor(b.stake || 0);
  if (!g) return send(res, 400, { error: 'unknown_game' });
  if (stake < toMinor(await getSetting('casino_min_ghs', 1)) || stake > toMinor(await getSetting('casino_max_ghs', 1000))) return send(res, 400, { error: 'stake_out_of_range' });
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const seedHash = sha256(serverSeed);
  let playOut;
  try { await db.tx(async () => {
    const r = await run('INSERT INTO casino_rounds(user_id,game,stake_minor,choice,seed_hash) VALUES(?,?,?,?,?)', u.id, b.game, stake, String(b.choice ?? ''), seedHash);
    const roundId = Number(r.id);
    await wallet.debitStake(u.id, stake, 'casino_stake', 'round:' + roundId, 'round:' + roundId);
    const f = floatStream(serverSeed, String(u.id), roundId);
    const { detail, multiplier } = g.play(String(b.choice ?? ''), f);
    const payout = Math.floor(stake * multiplier);
    if (payout > 0) await wallet.post(u.id, 'main', payout, 'casino_payout', 'round:' + roundId, 'payout:' + roundId);
    await run('UPDATE casino_rounds SET result=?,multiplier=?,payout_minor=?,seed_reveal=? WHERE id=?', JSON.stringify(detail), multiplier, payout, serverSeed, roundId);
    playOut = { roundId, detail, multiplier, payout };
    });
    send(res, 200, { roundId: playOut.roundId, game: b.game, detail: playOut.detail, multiplier: playOut.multiplier, payout: toGhs(playOut.payout), balance: toGhs(await wallet.balance(u.id, 'main')), proof: { seedHash, seedReveal: serverSeed } });
  } catch (e) { send(res, 400, { error: e.message }); } });
route('GET', '/api/casino/history', async (req, res) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const rounds = (await all('SELECT id,game,stake_minor,choice,result,multiplier,payout_minor,created_at FROM casino_rounds WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id))
    .map(r => ({ ...r, stake: toGhs(r.stake_minor), payout: toGhs(r.payout_minor), result: r.result ? JSON.parse(r.result) : null }));
  send(res, 200, { rounds }); });
// Admin
route('GET', '/api/admin/queue', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  send(res, 200, { requests: (await all("SELECT * FROM payment_requests WHERE status='pending' ORDER BY id")).map(r => ({ ...r, amount: toGhs(r.amount_minor) })) }); });
route('POST', '/api/admin/queue/:id', async (req, res, b, id) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const r = await one("SELECT * FROM payment_requests WHERE id=? AND status='pending'", id);
  if (!r) return send(res, 400, { error: 'not_pending' });
  if (r.type === 'withdrawal' && u.role !== 'super_admin') return send(res, 403, { error: 'super_only_for_withdrawals' });
  if (!['confirm','reject'].includes(b.action)) return send(res, 400, { error: 'bad_action' });
  try { await db.tx(async () => { await run('UPDATE payment_requests SET status=?,decided_by=? WHERE id=?', b.action === 'confirm' ? 'confirmed' : 'rejected', u.id, id);
    if (b.action === 'confirm' && r.type === 'deposit') { await wallet.post(r.user_id, 'main', r.amount_minor, 'deposit', 'req:' + id, 'req:' + id);
      const dep = await one('SELECT referred_by FROM users WHERE id=?', r.user_id);
      const pct = await getSetting('commission_pct', 5);
      if (dep && dep.referred_by && pct > 0) { const comm = Math.floor(r.amount_minor * pct / 100);
        if (comm > 0) await wallet.post(dep.referred_by, 'main', comm, 'commission', 'req:' + id, 'commission:req:' + id); } }
    if (b.action === 'confirm' && r.type === 'withdrawal') await wallet.post(r.user_id, 'main', -r.amount_minor, 'withdrawal', 'req:' + id, 'req:' + id);
    }); send(res, 200, { requestId: +id, action: b.action }); } catch (e) { send(res, 400, { error: e.message }); } });
route('POST', '/api/admin/results', async (req, res, b) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  // b.results: [{matchId, result:'1'|'X'|'2'}] -> settle legs, then settle affected open bets idempotently
  const upd = prep("UPDATE bet_legs SET status=CASE WHEN ?='void' THEN 'void' WHEN pick=? THEN 'won' ELSE 'lost' END WHERE match_id=? AND status='pending'");
  const affected = new Set();
  for (const r of (b.results || [])) { await upd.run(r.result, r.result, r.matchId);
    await run("UPDATE matches SET status='finished' WHERE id=?", r.matchId);
    for (const x of await all('SELECT bet_id FROM bet_legs WHERE match_id=?', r.matchId)) affected.add(x.bet_id); }
  let settled = 0;
  for (const betId of affected) { const bet = await one("SELECT * FROM bets WHERE id=? AND status='open'", betId); if (!bet) continue;
    const legs = await all('SELECT status,odds FROM bet_legs WHERE bet_id=?', betId);
    if (legs.some(l => l.status === 'pending')) continue;
    const lost = legs.some(l => l.status === 'lost');
    const payout = lost ? 0 : Math.floor(bet.stake_minor * legs.filter(l => l.status === 'won').reduce((a, l) => a * l.odds, 1));
    const won = payout > 0;
    try { await db.tx(async () => { await run("UPDATE bets SET status=?,payout_minor=?,settled_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'", won ? 'won' : 'lost', payout, betId);
      if (won) await wallet.post(bet.user_id, 'main', payout, 'bet_payout', 'bet:' + betId, 'settle:' + betId);
      }); settled++; } catch (e) { } }
  send(res, 200, { settled }); });


// ---- Phase 2: session games ----
function pubSession(row) {
  const g = SESSION_GAMES[row.game]; const st = JSON.parse(row.state); const settled = row.status !== 'active';
  return { sessionId: row.id, game: row.game, status: row.status, stake: toGhs(row.stake_minor),
    multiplier: row.multiplier, payout: toGhs(row.payout_minor), view: g.pub(st, settled),
    proof: settled ? { seedHash: row.seed_hash, seedReveal: row.seed_reveal } : { seedHash: row.seed_hash } };
}
route('POST', '/api/casino/session/start', async (req, res, b) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  if (await getSetting('maintenance', 0) && u.role === 'player') return send(res, 503, { error: 'maintenance' });
  const g = SESSION_GAMES[b.game]; const stake = toMinor(b.stake || 0);
  if (!g) return send(res, 400, { error: 'unknown_game' });
  if (stake < toMinor(await getSetting('casino_min_ghs', 1)) || stake > toMinor(await getSetting('casino_max_ghs', 1000))) return send(res, 400, { error: 'stake_out_of_range' });
  const serverSeed = crypto.randomBytes(32).toString('hex');
  let sidOut;
  try { await db.tx(async () => {
    const r = await run('INSERT INTO game_sessions(user_id,game,stake_minor,state,seed_hash) VALUES(?,?,?,?,?)', u.id, b.game, stake, '{}', sha256(serverSeed));
    const sid = Number(r.id); sidOut = sid;
    await wallet.debitStake(u.id, stake, 'casino_stake', 'session:' + sid, 'session:' + sid);
    const f = floatStream(serverSeed, String(u.id), sid);
    const st = g.start(f, b.options || {}, crashPoint);
    await run('UPDATE game_sessions SET state=?,seed_reveal=? WHERE id=?', JSON.stringify(st), serverSeed, sid);
    });
    send(res, 201, pubSession(await one('SELECT * FROM game_sessions WHERE id=?', sidOut)));
  } catch (e) { send(res, 400, { error: e.message }); } });
route('POST', '/api/casino/session/:id/action', async (req, res, b, id) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const row = await one("SELECT * FROM game_sessions WHERE id=? AND user_id=? AND status='active'", id, u.id);
  if (!row) return send(res, 400, { error: 'session_not_active' });
  const g = SESSION_GAMES[row.game];
  try {
    const out = g.act(JSON.parse(row.state), String(b.action || ''), b);
    const sid = row.id;
    await db.tx(async () => {
    if (out.settled) {
      const payout = out.won ? Math.floor(row.stake_minor * out.multiplier) : 0;
      if (payout > 0) await wallet.post(u.id, 'main', payout, 'casino_payout', 'session:' + sid, 'sessionpayout:' + sid);
      await run("UPDATE game_sessions SET state=?,status=?,multiplier=?,payout_minor=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", JSON.stringify(out.state), out.won ? 'won' : 'lost', out.multiplier, payout, sid);
    } else {
      await run("UPDATE game_sessions SET state=?,multiplier=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", JSON.stringify(out.state), out.state.mult ?? row.multiplier, sid);
    }
    });
    const fresh = await one('SELECT * FROM game_sessions WHERE id=?', sid);
    send(res, 200, { ...pubSession(fresh), message: out.message || null });
  } catch (e) { send(res, 400, { error: e.message }); } });
route('GET', '/api/casino/session/:id', async (req, res, b, id) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const row = await one('SELECT * FROM game_sessions WHERE id=? AND user_id=?', id, u.id);
  if (!row) return send(res, 404, { error: 'not_found' });
  // skyclimb: a plain poll can bust the session
  if (row.status === 'active' && row.game === 'skyclimb') {
    const g = SESSION_GAMES.skyclimb; const st = JSON.parse(row.state);
    if (g.currentMult(st) >= st.crash) await run("UPDATE game_sessions SET status='lost',multiplier=0,updated_at=CURRENT_TIMESTAMP WHERE id=?", id);
  }
  send(res, 200, pubSession(await one('SELECT * FROM game_sessions WHERE id=?', id))); });
// ---- Phase 2: admin settings, stats, match creation ----
const SETTING_KEYS = { book_margin: [0, 0.30], cashout_margin: [0, 0.50], casino_min_ghs: [0.1, 100], casino_max_ghs: [10, 100000], min_stake_ghs: [0.1, 1000], max_payout_ghs: [1000, 10000000], welcome_bonus_ghs: [0, 10000], commission_pct: [0, 100], maintenance: [0, 1], registration_open: [0, 1] };
route('GET', '/api/admin/settings', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const out = {}; for (const k of Object.keys(SETTING_KEYS)) out[k] = await getSetting(k, null); send(res, 200, { settings: out }); });
route('POST', '/api/admin/settings', async (req, res, b) => { const u = await auth(req, ['super_admin']); if (!u) return send(res, 403, { error: 'super_only' });
  for (const [k, v] of Object.entries(b.settings || {})) { const range = SETTING_KEYS[k];
    if (!range || typeof v !== 'number' || v < range[0] || v > range[1]) return send(res, 400, { error: 'bad_setting', key: k });
    await setSetting(k, v); }
  send(res, 200, { updated: true }); });
route('GET', '/api/admin/stats', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const q = async (sql) => (await one(sql)).v;
  const betStakes = await q("SELECT COALESCE(SUM(stake_minor),0) v FROM bets WHERE status IN ('won','lost')");
  const betPayouts = await q("SELECT COALESCE(SUM(payout_minor),0) v FROM bets WHERE status IN ('won','lost')");
  const casStakes = (await q("SELECT COALESCE(SUM(stake_minor),0) v FROM casino_rounds")) + (await q("SELECT COALESCE(SUM(stake_minor),0) v FROM game_sessions WHERE status IN ('won','lost')"));
  const casPayouts = (await q("SELECT COALESCE(SUM(payout_minor),0) v FROM casino_rounds")) + (await q("SELECT COALESCE(SUM(payout_minor),0) v FROM game_sessions WHERE status IN ('won','lost')"));
  send(res, 200, { users: await q('SELECT COUNT(*) v FROM users'), openBets: await q("SELECT COUNT(*) v FROM bets WHERE status='open'"),
    pendingRequests: await q("SELECT COUNT(*) v FROM payment_requests WHERE status='pending'"),
    betStakes: toGhs(betStakes), betPayouts: toGhs(betPayouts), casinoStakes: toGhs(casStakes), casinoPayouts: toGhs(casPayouts),
    ggr: toGhs((betStakes - betPayouts) + (casStakes - casPayouts)) }); });
route('POST', '/api/admin/matches', async (req, res, b) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  if (!b.home || !b.away || !Array.isArray(b.probs) || b.probs.length !== 3) return send(res, 400, { error: 'bad_match' });
  const sum = b.probs.reduce((a, x) => a + x, 0); if (Math.abs(sum - 1) > 0.02) return send(res, 400, { error: 'probs_must_sum_to_1' });
  const r = await run('INSERT INTO matches(league,home,away,starts_at) VALUES(?,?,?,?)', b.league || 'Custom', b.home, b.away, b.startsAt || new Date(Date.now() + 3600e3).toISOString());
  const mid = Number(r.id);
  await setSetting('match_odds:' + mid, buildBook(b.probs, await getSetting('book_margin', 0.06)));
  send(res, 201, { matchId: mid, odds1x2: await getSetting('match_odds:' + mid, null) }); });

// ---- Phase 3: admin power pack (patterns ported from production PrimeStake/Oddaroa) ----
route('GET', '/api/referrals', async (req, res) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const count = await one('SELECT COUNT(*) c FROM users WHERE referred_by=?', u.id).c;
  const earned = await one("SELECT COALESCE(SUM(delta_minor),0) s FROM ledger_entries WHERE user_id=? AND kind='commission'", u.id).s;
  send(res, 200, { refCode: u.ref_code, referred: count, commissionEarned: toGhs(earned), commissionPct: await getSetting('commission_pct', 5) }); });
route('GET', '/api/admin/users', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const q = (req.url.split('q=')[1] || '').split('&')[0];
  const rows = [];
  for (const x of await all('SELECT id,phone,name,role,status,ref_code,referred_by,created_at FROM users WHERE phone LIKE ? ORDER BY id DESC LIMIT 100', '%' + decodeURIComponent(q) + '%'))
    rows.push({ ...x, main: toGhs(await wallet.balance(x.id, 'main')), bonus: toGhs(await wallet.balance(x.id, 'bonus')) });
  send(res, 200, { users: rows }); });
route('GET', '/api/admin/users/:id', async (req, res, b, id) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const target = await one('SELECT id,phone,name,role,status,ref_code,referred_by,created_at FROM users WHERE id=?', id);
  if (!target) return send(res, 404, { error: 'not_found' });
  const tx = (await all('SELECT bucket,delta_minor,kind,ref,created_at FROM ledger_entries WHERE user_id=? ORDER BY id DESC LIMIT 30', id))
    .map(x => ({ ...x, amount: toGhs(x.delta_minor), delta_minor: undefined }));
  const bets = await all('SELECT id,stake_minor,potential_minor,payout_minor,status,code,created_at FROM bets WHERE user_id=? ORDER BY id DESC LIMIT 20', id);
  send(res, 200, { user: { ...target, main: toGhs(await wallet.balance(+id, 'main')), bonus: toGhs(await wallet.balance(+id, 'bonus')) }, transactions: tx, bets }); });
route('POST', '/api/admin/users/:id/balance', async (req, res, b, id) => { const u = await auth(req, ['super_admin']); if (!u) return send(res, 403, { error: 'super_only' });
  const amount = toMinor(b.amount || 0); if (!amount || !b.reason) return send(res, 400, { error: 'amount_and_reason_required' });
  try { await wallet.post(+id, b.bucket === 'bonus' ? 'bonus' : 'main', amount, 'admin_adjust', 'admin:' + u.id, 'adj:' + Date.now() + ':' + id);
    await audit(u.id, 'balance_edit', id, (amount > 0 ? '+' : '') + toGhs(amount) + ' - ' + b.reason);
    send(res, 200, { userId: +id, main: toGhs(await wallet.balance(+id, 'main')), bonus: toGhs(await wallet.balance(+id, 'bonus')) }); }
  catch (e) { send(res, 400, { error: e.message }); } });
route('POST', '/api/admin/users/:id/block', async (req, res, b, id) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const target = await one('SELECT role FROM users WHERE id=?', id); if (!target) return send(res, 404, { error: 'not_found' });
  if (target.role === 'super_admin') return send(res, 400, { error: 'cannot_block_super' });
  const to = b.blocked ? 'blocked' : 'active';
  await run('UPDATE users SET status=? WHERE id=?', to, id);
  if (b.blocked) await run('DELETE FROM sessions WHERE user_id=?', id);
  await audit(u.id, b.blocked ? 'block' : 'unblock', id, ''); send(res, 200, { userId: +id, status: to }); });
route('POST', '/api/admin/users/:id/role', async (req, res, b, id) => { const u = await auth(req, ['super_admin']); if (!u) return send(res, 403, { error: 'super_only' });
  if (!['player','admin','super_admin'].includes(b.role)) return send(res, 400, { error: 'bad_role' });
  if (+id === u.id) return send(res, 400, { error: 'cannot_change_own_role' });
  await run('UPDATE users SET role=? WHERE id=?', b.role, id);
  await audit(u.id, 'role_change', id, b.role); send(res, 200, { userId: +id, role: b.role }); });
route('DELETE', '/api/admin/users/:id', async (req, res, b, id) => { const u = await auth(req, ['super_admin']); if (!u) return send(res, 403, { error: 'super_only' });
  if (+id === u.id) return send(res, 400, { error: 'cannot_delete_self' });
  if (await wallet.balance(+id, 'main') !== 0 || await wallet.balance(+id, 'bonus') !== 0) return send(res, 400, { error: 'user_has_balance' });
  if (await one("SELECT COUNT(*) c FROM bets WHERE user_id=? AND status='open'", id).c) return send(res, 400, { error: 'user_has_open_bets' });
  await run('DELETE FROM sessions WHERE user_id=?', id);
  await run('UPDATE users SET status=\'deleted\', phone=phone || \'#del\' || id WHERE id=?', id);
  await audit(u.id, 'delete_user', id, ''); send(res, 200, { deleted: +id }); });
route('POST', '/api/admin/invites', async (req, res, b) => { const u = await auth(req, ['super_admin']); if (!u) return send(res, 403, { error: 'super_only' });
  const token = newToken().slice(0, 24); const hours = Math.min(168, Math.max(1, parseInt(b.hours) || 48));
  await run('INSERT INTO admin_invites(token,created_by,role,expires_at) VALUES(?,?,?,?)', token, u.id, b.role === 'super_admin' ? 'super_admin' : 'admin', new Date(Date.now() + hours * 3600e3).toISOString());
  await audit(u.id, 'invite_create', token, b.role || 'admin'); send(res, 201, { token, registerWith: { invite: token }, expiresInHours: hours }); });
route('GET', '/api/admin/invites', async (req, res) => { const u = await auth(req, ['super_admin']); if (!u) return send(res, 403, { error: 'super_only' });
  send(res, 200, { invites: await all("SELECT token,role,expires_at,used_by,created_at FROM admin_invites ORDER BY created_at DESC LIMIT 50") }); });
route('GET', '/api/admin/worksheet', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const day = (req.url.split('day=')[1] || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const scope = u.role === 'super_admin' && !req.url.includes('mine=1') ? '' : ' AND decided_by=' + u.id;
  const rows = await all(`SELECT decided_by, type, status, COUNT(*) n, COALESCE(SUM(amount_minor),0) total FROM payment_requests WHERE date(created_at)=? AND decided_by IS NOT NULL ${scope} GROUP BY decided_by,type,status`, day);
  const actions = await all(`SELECT action, COUNT(*) n FROM admin_actions WHERE date(created_at)=? ${u.role === 'super_admin' && !req.url.includes('mine=1') ? '' : ' AND admin_id=' + u.id} GROUP BY action`, day);
  send(res, 200, { day, queueWork: rows.map(r => ({ ...r, total: toGhs(r.total) })), actions }); });
route('GET', '/api/admin/bets', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const status = (req.url.split('status=')[1] || '').split('&')[0];
  const rows = (status ? await all('SELECT * FROM bets WHERE status=? ORDER BY id DESC LIMIT 100', status)
    : await all('SELECT * FROM bets ORDER BY id DESC LIMIT 100'))
    .map(x => ({ ...x, stake: toGhs(x.stake_minor), potential: toGhs(x.potential_minor), payout: x.payout_minor == null ? null : toGhs(x.payout_minor) }));
  send(res, 200, { bets: rows }); });
route('POST', '/api/admin/bets/:id/void', async (req, res, b, id) => { const u = await auth(req, ['super_admin']); if (!u) return send(res, 403, { error: 'super_only' });
  const bet = await one("SELECT * FROM bets WHERE id=? AND status='open'", id); if (!bet) return send(res, 400, { error: 'bet_not_open' });
  try { await db.tx(async () => { await run("UPDATE bets SET status='void',payout_minor=?,settled_at=CURRENT_TIMESTAMP WHERE id=?", bet.stake_minor, id);
    await run("UPDATE bet_legs SET status='void' WHERE bet_id=? AND status='pending'", id);
    await wallet.post(bet.user_id, 'main', bet.stake_minor, 'bet_refund', 'bet:' + id, 'voidbet:' + id);
    }); await audit(u.id, 'bet_void', id, 'refund ' + toGhs(bet.stake_minor)); send(res, 200, { betId: +id, refunded: toGhs(bet.stake_minor) }); }
  catch (e) { send(res, 400, { error: e.message }); } });
route('POST', '/api/admin/matches/:id/lock', async (req, res, b, id) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  await run('UPDATE matches SET betting_locked=? WHERE id=?', b.locked ? 1 : 0, id);
  await audit(u.id, b.locked ? 'match_lock' : 'match_unlock', id, ''); send(res, 200, { matchId: +id, locked: !!b.locked }); });
route('POST', '/api/admin/matches/:id/feature', async (req, res, b, id) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  await run('UPDATE matches SET featured=? WHERE id=?', b.featured ? 1 : 0, id); send(res, 200, { matchId: +id, featured: !!b.featured }); });
// Support chat (two-way, pattern from Oddaroa push 91-93)
route('POST', '/api/support', async (req, res, b) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  if (!b.body || !String(b.body).trim()) return send(res, 400, { error: 'empty_message' });
  const r = await run('INSERT INTO support_messages(user_id,sender,body) VALUES(?,?,?)', u.id, 'user', String(b.body).slice(0, 2000));
  send(res, 201, { messageId: Number(r.id) }); });
route('GET', '/api/support', async (req, res) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  send(res, 200, { messages: await all('SELECT id,sender,body,created_at FROM support_messages WHERE user_id=? ORDER BY id', u.id) }); });
route('GET', '/api/admin/support', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const uid = req.url.split('user=')[1];
  if (uid) return send(res, 200, { messages: await all('SELECT id,sender,body,created_at FROM support_messages WHERE user_id=? ORDER BY id', uid.split('&')[0]) });
  const threads = await all(`SELECT t.user_id, u.phone, u.name, t.msgs, lm.body AS last_body, lm.created_at AS last_at
    FROM (SELECT user_id, MAX(id) AS last_id, COUNT(*) AS msgs FROM support_messages GROUP BY user_id) t
    JOIN support_messages lm ON lm.id = t.last_id JOIN users u ON u.id = t.user_id ORDER BY t.last_id DESC`);
  send(res, 200, { threads }); });
route('POST', '/api/admin/support/:id/reply', async (req, res, b, id) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  if (!b.body || !String(b.body).trim()) return send(res, 400, { error: 'empty_message' });
  await run('INSERT INTO support_messages(user_id,sender,body) VALUES(?,?,?)', id, 'admin', String(b.body).slice(0, 2000));
  send(res, 201, { replied: true }); });


route('GET', '/api/admin/promos', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  send(res, 200, { promos: (await all('SELECT code,bonus_minor,max_uses,uses,active,expires_at FROM promo_codes ORDER BY created_at DESC')).map(x => ({ ...x, bonus: toGhs(x.bonus_minor) })) }); });
route('POST', '/api/admin/promos', async (req, res, b) => { const u = await auth(req, ['super_admin']); if (!u) return send(res, 403, { error: 'super_only' });
  const code = String(b.code || '').toUpperCase().trim(); const bonus = toMinor(b.bonus || 0);
  if (!code || bonus <= 0) return send(res, 400, { error: 'code_and_bonus_required' });
  if (b.active === false || b.active === 0) { await run('UPDATE promo_codes SET active=0 WHERE code=?', code); await audit(u.id, 'promo_deactivate', code, ''); return send(res, 200, { code, active: false }); }
  await run('INSERT INTO promo_codes(code,bonus_minor,max_uses,expires_at) VALUES(?,?,?,?) ON CONFLICT(code) DO UPDATE SET bonus_minor=excluded.bonus_minor,max_uses=excluded.max_uses,active=1,expires_at=excluded.expires_at', code, bonus, parseInt(b.maxUses) || 0, b.expiresAt || null);
  await audit(u.id, 'promo_upsert', code, 'bonus ' + toGhs(bonus)); send(res, 201, { code, bonus: toGhs(bonus) }); });

// Frontend SDK
route('GET', '/sdk.js', async (req, res) => { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' }); res.end(SDK_JS); });

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', async () => {
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return send(res, 400, { error: 'bad_json' }); }
    const pathOnly = req.url.split('?')[0];
    try {
      for (const [m, re, fn] of routes) { if (req.method !== m) continue; const mm = pathOnly.match(re); if (mm) return await fn(req, res, body, ...mm.slice(1)); }
      if (pathOnly === '/health') return send(res, 200, { ok: true, service: 'blizbet-backend', db: db.isPG ? 'postgres' : 'sqlite' });
      send(res, 404, { error: 'not_found' });
    } catch (e) { console.error('handler error:', e); if (!res.headersSent) send(res, 500, { error: 'internal' }); }
  });
});
db.init().then(seedMatches).then(() => server.listen(PORT, () => console.log('BlizBet backend listening on :' + PORT + ' (db: ' + (db.isPG ? 'postgres' : 'sqlite') + ')'))).catch(e => { console.error('boot failed:', e); process.exit(1); });
module.exports = { server };
