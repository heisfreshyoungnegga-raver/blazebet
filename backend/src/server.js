const http = require('node:http');
const crypto = require('node:crypto');
const db = require('./db');
const { one, all, run, execSql, getSetting, setSetting } = db;
const prep = (sql) => ({ get: (...a) => one(sql, ...a), all: (...a) => all(sql, ...a), run: (...a) => run(sql, ...a) });
const { hashPassword, verifyPassword, newToken, sha256, floatStream } = require('./crypto');
const wallet = require('./wallet');
const { buildBook, potential, cashoutValue, fairProbFromOdds } = require('./odds');
const markets = require('./markets');
const espn = require('./espn');
const providers = require('./providers');
const { GAMES, validateChoice, gameMaxMultiplier } = require('./games');
const { SESSION_GAMES, actSessionGuarded, minesMult, towerMult, LADDER, balloonMult } = require('./sessions');
const { crashPoint } = require('./crypto');
const PORT = process.env.PORT || 4180;
const toMinor = (ghs) => Math.round(parseFloat(ghs) * 100);
const toGhs = (minor) => minor / 100;
// Sessions live 30 days (M1/M5); expired rows are deleted on sight.
const SESSION_TTL_MS = 30 * 24 * 3600e3;
// SQLite stores naive 'YYYY-MM-DD HH:MM:SS' (parsed by V8 as LOCAL time);
// Postgres returns ISO. Treat the naive form as UTC so ages/TTLs agree.
function parseDbTime(v) {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  const s = String(v);
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  return new Date(iso).getTime();
}
// Canonical Ghana phone: 0244123456 / 233244123456 / +233244123456 all become
// +233244123456 (L3) so one human cannot hold several accounts on one number.
function canonicalPhone(raw) {
  const d = String(raw || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) return '+' + d.slice(1).replace(/\D/g, '');
  const digits = d.replace(/\D/g, '');
  if (digits.startsWith('233') && digits.length >= 12) return '+' + digits;
  if (digits.startsWith('0')) return '+233' + digits.slice(1);
  if (digits.length === 9) return '+233' + digits;
  return '+' + digits;
}
// Booking codes: 'BB' + 5 chars from the 32-char mixed alphabet (no 0/O/1/I),
// Oddaroa-style, backed by a UNIQUE index + retry on collision (M4).
const BOOKING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newBookingCode() {
  let c = '';
  for (let i = 0; i < 5; i++) c += BOOKING_ALPHABET[crypto.randomInt(BOOKING_ALPHABET.length)];
  return 'BB' + c;
}
function isUniqueViolation(e) { return /duplicate key|UNIQUE constraint/i.test(String((e && e.message) || e)); }
// Worst-case multiplier a session game can pay, for the H7 max-payout gate.
function sessionMaxMultiplier(game, options) {
  switch (game) {
    case 'mines': { const n = Math.min(10, Math.max(1, parseInt((options || {}).mines) || 3)); return minesMult(25 - n, n); }
    case 'towers': return towerMult(5);
    case 'balloon': return balloonMult(12); // 9.01 max cashable mult at 12 pumps
    case 'goalladder': return LADDER[4]; // 2.13
    case 'poker': return 250;
    default: return 500; // hilo / redblack / skyclimb: deck/time-bounded, gate at the crash cap
  }
}


const SDK_JS = `// BlazeBet API SDK - include with <script src="https://YOUR-API/sdk.js"></script>
window.BlazeBet = (() => {
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
  // L7/M6: demo fixtures are dev-only. On Postgres (production) they are
  // seeded ONLY behind an explicit SEED_DEMO_MATCHES=1; local SQLite keeps
  // the old behaviour so dev/tests still get a board. Never seed demos
  // into production again.
  if (db.isPG && process.env.SEED_DEMO_MATCHES !== '1') return;
  if ((await one('SELECT COUNT(*) c FROM matches')).c) return;
  const demos = [
    ['Premier League','Arsenal','Chelsea', [0.42,0.27,0.31]], ['Premier League','Man City','Liverpool',[0.48,0.26,0.26]],
    ['La Liga','Real Madrid','Barcelona',[0.38,0.27,0.35]], ['Serie A','Inter','Juventus',[0.40,0.30,0.30]],
    ['Bundesliga','Bayern','Dortmund',[0.55,0.23,0.22]], ['Ghana Premier League','Hearts of Oak','Asante Kotoko',[0.36,0.32,0.32]],
  ];
  const ins = prep('INSERT INTO matches(league,home,away,starts_at) VALUES(?,?,?,?)');
  for (const [i, [lg, h, a, probs]] of demos.entries()) {
    const r = await ins.run(lg, h, a, new Date(Date.now() + (i + 2) * 3600e3).toISOString());
    // setSetting upserts: concurrent cold starts must not fail on the
    // settings primary key (a rejected seed poisons the boot promise).
    await setSetting('match_odds:' + r.id, buildBook(probs, await getSetting('book_margin', 0.06)));
  }
}

function send(res, code, obj) { const body = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' }); res.end(body); }
async function auth(req, roles) {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  const s = tok && await one('SELECT user_id, created_at FROM sessions WHERE token=?', tok);
  if (!s) return null;
  // M1/M5: sessions expire 30 days after creation; an expired token is
  // deleted on sight and no longer authenticates.
  if (Date.now() - parseDbTime(s.created_at) > SESSION_TTL_MS) {
    try { await run('DELETE FROM sessions WHERE token=?', tok); } catch {}
    return null;
  }
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
  if (String(b.password).length < 6) return send(res, 400, { error: 'password_too_short' });
  const phone = canonicalPhone(b.phone);
  if (!phone) return send(res, 400, { error: 'phone_and_password_required' });
  const passHash = hashPassword(b.password); // scrypt BEFORE the tx (was the invite race window)
  const inviteToken = b.invite ? String(b.invite) : null;
  const promoCode = b.promoCode ? String(b.promoCode).toUpperCase() : null;
  const refCode = b.ref ? String(b.ref).toUpperCase() : null;
  let out;
  try {
    // M6/H5: the whole flow is one transaction — user insert, ref_code,
    // invite claim, promo claim, bonus posts, session insert. Any failure
    // rolls everything back; no half-registered account, no burned promo.
    out = await db.tx(async () => {
      // Bootstrap counts only LIVE users: soft-deleted rows keep their
      // '#del<id>' phone suffix and status='deleted' (parity log #2).
      const count = (await one("SELECT COUNT(*) c FROM users WHERE status<>'deleted' AND phone NOT LIKE '%#del%'")).c;
      let role = count === 0 ? 'super_admin' : 'player';
      let referredBy = null;
      if (refCode) { const ref = await one('SELECT id FROM users WHERE ref_code=?', refCode); if (ref) referredBy = ref.id; }
      if (inviteToken) {
        const inv = await one('SELECT * FROM admin_invites WHERE token=? AND used_by IS NULL', inviteToken);
        if (!inv) throw new Error('invalid_or_expired_invite');
        // M7: expiry compared in application code, not against SQLite
        // CURRENT_TIMESTAMP text (ISO 'T' sorts after ' ' on the same day).
        if (!(parseDbTime(inv.expires_at) > Date.now())) throw new Error('invalid_or_expired_invite');
        role = inv.role;
      }
      let promo = null;
      if (promoCode) {
        // Lock the promo row on PG so the uses check + claim cannot race
        // (SQLite serialises via the process lock, plain read is enough).
        promo = db.isPG
          ? await one('SELECT * FROM promo_codes WHERE code=? FOR UPDATE', promoCode)
          : await one('SELECT * FROM promo_codes WHERE code=?', promoCode);
        if (!promo || !promo.active) throw new Error('invalid_promo_code');
        if (promo.expires_at && !(parseDbTime(promo.expires_at) > Date.now())) throw new Error('invalid_promo_code');
        if (!(promo.max_uses === 0 || Number(promo.uses) < Number(promo.max_uses))) throw new Error('invalid_promo_code');
      }
      const r = await run('INSERT INTO users(phone,name,pass_hash,role,referred_by) VALUES(?,?,?,?,?)', phone, b.name || '', passHash, role, referredBy);
      const uid = Number(r.id);
      await run('UPDATE users SET ref_code=? WHERE id=?', 'BB' + uid.toString(36).toUpperCase().padStart(4, '0'), uid);
      if (inviteToken) {
        // Atomic claim: only an unused invite can be claimed, and the
        // re-read proves THIS registration won it.
        await run('UPDATE admin_invites SET used_by=? WHERE token=? AND used_by IS NULL', uid, inviteToken);
        const chk = await one('SELECT used_by FROM admin_invites WHERE token=?', inviteToken);
        if (!chk || Number(chk.used_by) !== uid) throw new Error('invalid_or_expired_invite');
      }
      if (promo) {
        // Atomic promo claim (M8): conditional increment, then verify this
        // registration moved the counter (the row lock above makes the
        // re-read unambiguous on PG; SQLite is serialised).
        const usesBefore = Number(promo.uses);
        await run('UPDATE promo_codes SET uses=uses+1 WHERE code=? AND (max_uses=0 OR uses<max_uses)', promoCode);
        const after = await one('SELECT uses FROM promo_codes WHERE code=?', promoCode);
        if (!after || Number(after.uses) !== usesBefore + 1) throw new Error('invalid_promo_code');
        await run('INSERT INTO promo_redemptions(code,user_id) VALUES(?,?)', promo.code, uid);
        await wallet.post(uid, 'bonus', promo.bonus_minor, 'promo_bonus', 'promo:' + promo.code, 'promo:' + promo.code + ':' + uid);
      }
      const token = newToken();
      await run('INSERT INTO sessions(token,user_id) VALUES(?,?)', token, uid);
      const wb = toMinor(await getSetting('welcome_bonus_ghs', 0));
      if (wb > 0) await wallet.post(uid, 'bonus', wb, 'welcome_bonus', 'user:' + uid, 'welcome:' + uid);
      return { token, uid, role, promo };
    });
  } catch (e) {
    if (e.message === 'invalid_or_expired_invite' || e.message === 'invalid_promo_code') return send(res, 400, { error: e.message });
    return send(res, 409, { error: 'account_exists' });
  }
  send(res, 201, { token: out.token, user: { id: out.uid, phone, role: out.role }, promoApplied: out.promo ? { code: out.promo.code, bonus: toGhs(out.promo.bonus_minor) } : null });
});
route('POST', '/api/auth/login', async (req, res, b) => {
  const phone = canonicalPhone(b.phone || '');
  // M2: throttle is persistent (login_attempts table), keyed by phone+IP
  // so an attacker cannot lock a victim's account globally.
  const ip = (String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() || (req.socket && req.socket.remoteAddress) || '';
  if (await db.isLoginLocked(phone, ip)) return send(res, 429, { error: 'locked_try_later' });
  const u = await one('SELECT * FROM users WHERE phone=?', phone);
  if (u && u.status === 'blocked') return send(res, 403, { error: 'account_blocked' });
  if (!u || !verifyPassword(b.password || '', u.pass_hash)) {
    await db.recordLoginFail(phone, ip);
    return send(res, 401, { error: 'invalid_credentials' });
  }
  await db.clearLoginFails(phone, ip);
  const token = newToken(); await run('INSERT INTO sessions(token,user_id) VALUES(?,?)', token, u.id);
  send(res, 200, { token, user: { id: u.id, phone: u.phone, role: u.role } });
});
route('POST', '/api/auth/logout', async (req, res) => {
  // F-H6: server-side revocation. Fire-and-forget from the clients: 200
  // even when the token is already gone (or was never sent).
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  if (tok) { try { await run('DELETE FROM sessions WHERE token=?', tok); } catch {} }
  send(res, 200, { loggedOut: true });
});
route('POST', '/api/auth/change-password', async (req, res, b) => { const u0 = await auth(req); if (!u0) return send(res, 401, { error: 'unauthorized' });
  const u = await one('SELECT * FROM users WHERE id=?', u0.id);
  if (!verifyPassword(b.current || '', u.pass_hash)) return send(res, 400, { error: 'wrong_current_password' });
  if (!b.next || String(b.next).length < 6) return send(res, 400, { error: 'password_too_short' });
  await run('UPDATE users SET pass_hash=? WHERE id=?', hashPassword(b.next), u.id);
  // M5: a password change revokes every session, including this one.
  await run('DELETE FROM sessions WHERE user_id=?', u.id);
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
  if (b.type === 'withdrawal') {
    // H3/F-H4: completed deposits count from BOTH rails — confirmed
    // manual requests AND succeeded provider attempts (ShinobiPay/FLW).
    const dep = await one("SELECT COALESCE(SUM(amount_minor),0) s FROM payment_requests WHERE user_id=? AND type='deposit' AND status='confirmed'", u.id);
    const att = await one("SELECT COALESCE(SUM(amount_minor),0) s FROM payment_attempts WHERE user_id=? AND status='succeeded'", u.id);
    const depositedMinor = Number(dep.s) + Number(att.s);
    if (depositedMinor < 60000) return send(res, 400, { error: 'withdrawal_not_eligible', required: 600, deposited: depositedMinor / 100 });
  }
  const r = await run('INSERT INTO payment_requests(user_id,type,amount_minor,method,bank,account_number,account_name) VALUES(?,?,?,?,?,?,?)', u.id, b.type, amount, b.method || 'momo', b.bank || null, b.accountNumber || null, b.accountName || null);
  send(res, 201, { requestId: Number(r.id), status: 'pending' }); });
route('GET', '/api/matches', async (req, res) => {
  // M9: one prefix query for all match odds (was N+1 getSetting calls).
  // M3: started matches leave the public board — a match whose kickoff
  // has passed is not listed even if the feed has not flipped it yet.
  const oddsMap = await db.getSettingsByPrefix('match_odds:');
  const nowMs = Date.now();
  const ms = (await all("SELECT * FROM matches WHERE status IN ('upcoming','live') ORDER BY starts_at"))
    .filter(m => parseDbTime(m.starts_at) > nowMs)
    .map(m => ({ ...m, odds1x2: oddsMap['match_odds:' + m.id] ?? null }));
  send(res, 200, { matches: ms }); });
route('GET', '/api/matches/:id', async (req, res, b, id) => {
  const m = await one('SELECT * FROM matches WHERE id=?', id);
  if (!m) return send(res, 404, { error: 'not_found' });
  const book = await getSetting('match_odds:' + m.id, null);
  send(res, 200, { match: { ...m, odds1x2: book }, markets: markets.marketsFromBook(book) }); });
route('POST', '/api/bets', async (req, res, b) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  if (await getSetting('maintenance', 0) && u.role === 'player') return send(res, 503, { error: 'maintenance' });
  const stake = toMinor(b.stake || 0); const legs = Array.isArray(b.legs) ? b.legs : [];
  if (stake <= 0 || !legs.length) return send(res, 400, { error: 'bad_bet' });
  const minStake = toMinor(await getSetting('min_stake_ghs', 1)); if (stake < minStake) return send(res, 400, { error: 'below_min_stake' });
  // B2: one leg per match on a ticket (same-match correlated combos are
  // not offered); identical match+market+pick is included in this rule.
  const seenMatches = new Set();
  for (const l of legs) {
    const mid = Number(l.matchId);
    if (seenMatches.has(mid)) return send(res, 409, { error: 'duplicate_leg', matchId: mid });
    seenMatches.add(mid);
  }
  const idemKey = b.idemKey ? String(b.idemKey) : null;
  const nowMs = Date.now();
  const resolved = [];
  for (const l of legs) { const m = await one("SELECT * FROM matches WHERE id=? AND status='upcoming'", l.matchId);
    if (m && m.betting_locked) return send(res, 400, { error: 'betting_locked', matchId: l.matchId });
    if (!m) return send(res, 400, { error: 'match_not_open', matchId: l.matchId });
    // M3 kickoff guard: a match whose start time has passed is not
    // bettable even if the feed has not flipped its status yet.
    if (parseDbTime(m.starts_at) <= nowMs) return send(res, 400, { error: 'match_not_open', matchId: l.matchId });
    const book = await getSetting('match_odds:' + m.id, null);
    const market = l.market || '1X2';
    const odds = markets.lookupOdds(book, market, l.pick);
    if (!odds) return send(res, 400, { error: 'bad_pick' });
    // L7: fair_prob is the leg's share of its OWN market's normalised
    // implied probabilities (book odds already embed the margin — the old
    // 1/(odds*(1+margin)) double-counted it and priced cashouts ~6% low).
    const fullBook = markets.marketsFromBook(book);
    const mktOdds = fullBook[market] || {};
    const picks = Object.keys(mktOdds);
    const fairs = fairProbFromOdds(picks.map(k => mktOdds[k]));
    resolved.push({ match_id: m.id, market, pick: l.pick, odds, fair_prob: fairs[picks.indexOf(String(l.pick))] }); }
  const pot = potential(stake, resolved.map(r => r.odds));
  if (pot > toMinor(await getSetting('max_payout_ghs', 200000))) return send(res, 400, { error: 'above_max_payout' });
  // Placement is idempotent on the client's idemKey (F-B3: the betslip
  // sends one per submission). A retry returns the original bet with no
  // second debit. Booking codes are 5 chars from the 32-char mixed
  // alphabet (M4), UNIQUE-indexed, with a retry on collision.
  let placed = null;
  try {
    for (let attempt = 0; attempt < 3 && !placed; attempt++) {
      const code = newBookingCode();
      try {
        placed = await db.tx(async () => {
          if (idemKey) {
            const existing = await one('SELECT * FROM bets WHERE user_id=? AND idem_key=?', u.id, idemKey);
            if (existing) return { betId: Number(existing.id), code: existing.code, stake: existing.stake_minor, potential: existing.potential_minor };
          }
          const r = await run('INSERT INTO bets(user_id,stake_minor,stake_bonus_minor,stake_main_minor,potential_minor,code,idem_key) VALUES(?,?,?,?,?,?,?)', u.id, stake, 0, 0, pot, code, idemKey);
          const betId = Number(r.id);
          const ins = prep('INSERT INTO bet_legs(bet_id,match_id,market,pick,odds,fair_prob) VALUES(?,?,?,?,?,?)');
          for (const l of resolved) await ins.run(betId, l.match_id, l.market, l.pick, l.odds, l.fair_prob);
          // The debit runs in the SAME tx as the bet+legs (B1 kill-chain:
          // on PG a failed debit used to leave an unpaid open bet behind).
          // Its split is recorded on the bet row for pro-rata credits.
          const split = await wallet.debitStake(u.id, stake, 'bet_stake', 'bet:' + betId, 'bet:' + betId);
          await run('UPDATE bets SET stake_bonus_minor=?, stake_main_minor=? WHERE id=?', split.bonusUse, split.mainUse, betId);
          return { betId, code, stake, potential: pot };
        });
      } catch (e) {
        // Code collision (regenerate) or a concurrent same-key retry that
        // already placed the bet (next loop re-reads it and returns it).
        if (isUniqueViolation(e) && attempt < 2) continue;
        throw e;
      }
    }
  } catch (e) {
    if (isUniqueViolation(e)) return send(res, 409, { error: 'duplicate_bet' });
    return send(res, 400, { error: e.message });
  }
  if (!placed) return send(res, 400, { error: 'bet_failed' });
  send(res, 201, { betId: placed.betId, code: placed.code, stake: toGhs(placed.stake), potential: toGhs(placed.potential) });
});
async function legsForBet(betId) {
  return all('SELECT bl.id, bl.match_id, bl.market, bl.pick, bl.odds, bl.fair_prob, bl.status, m.home, m.away, m.league, m.starts_at, m.status AS match_status FROM bet_legs bl LEFT JOIN matches m ON m.id = bl.match_id WHERE bl.bet_id=? ORDER BY bl.id', betId);
}
function pubBet(x, legs) {
  // M4: the public representation never carries user_id, the idempotency
  // key, or the raw *_minor internals — only the converted money fields.
  const { user_id, stake_minor, potential_minor, payout_minor, idem_key, stake_bonus_minor, stake_main_minor, ...rest } = x;
  return { ...rest, stake: toGhs(x.stake_minor), potential: toGhs(x.potential_minor), payout: x.payout_minor == null ? null : toGhs(x.payout_minor), legs: legs || [] };
}
route('GET', '/api/bets', async (req, res) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const bets = [];
  for (const x of await all('SELECT * FROM bets WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id))
    bets.push(pubBet(x, await legsForBet(x.id)));
  send(res, 200, { bets }); });
route('GET', '/api/bets/code/:code', async (req, res, b, code) => {
  const bet = await one('SELECT * FROM bets WHERE code=?', String(code).toUpperCase());
  if (!bet) return send(res, 404, { error: 'bet_not_found' });
  send(res, 200, { bet: pubBet(bet, await legsForBet(bet.id)) }); });
route('POST', '/api/bets/:id/cashout', async (req, res, b, id) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const bet = await one('SELECT * FROM bets WHERE id=? AND user_id=?', id, u.id);
  if (!bet) return send(res, 400, { error: 'bet_not_open' });
  if (bet.status === 'cashed_out') return send(res, 409, { error: 'already_decided' });
  if (bet.status !== 'open') return send(res, 400, { error: 'bet_not_open' });
  let valueOut;
  try {
    valueOut = await db.tx(async () => {
      // M9: guarded flip first — claim the ticket inside the tx. A
      // concurrent cashout blocks on the row, re-evaluates, and finds no
      // 'open' row, so it answers 409 instead of double-reporting.
      await run("UPDATE bets SET status='cashing_out' WHERE id=? AND status='open'", id);
      const claimed = await one('SELECT * FROM bets WHERE id=?', id);
      if (!claimed || claimed.status !== 'cashing_out') throw new Error('already_decided');
      const legs = await all('SELECT bl.*, m.status AS match_status, m.starts_at FROM bet_legs bl LEFT JOIN matches m ON m.id = bl.match_id WHERE bl.bet_id=?', id);
      // H1: refuse when any pending leg's match is live, past kickoff, or
      // finished-but-unsettled — the bettor can see the real result.
      const nowMs = Date.now();
      for (const l of legs) {
        if (l.status !== 'pending') continue;
        if (l.match_status === 'live' || l.match_status === 'finished' || parseDbTime(l.starts_at) <= nowMs) throw new Error('cashout_unavailable');
      }
      // Recompute the potential excluding void legs (their odds no longer
      // multiply the ticket) before applying the cashout formula.
      const liveLegs = legs.filter(l => l.status !== 'void');
      const adjPotential = Math.floor(claimed.stake_minor * liveLegs.reduce((a, l) => a * l.odds, 1));
      const value = cashoutValue(adjPotential, legs.map(l => ({ status: l.status, fair_prob: l.fair_prob })), await getSetting('cashout_margin', 0.10));
      if (!value) throw new Error('no_cashout_value');
      await run("UPDATE bets SET status='cashed_out',payout_minor=?,settled_at=CURRENT_TIMESTAMP WHERE id=? AND status='cashing_out'", value, id);
      // H4: the cashout is credited pro-rata to how the stake was funded.
      const sb = Number(claimed.stake_bonus_minor || 0), sm = Number(claimed.stake_main_minor || 0);
      const [bb, mm] = (sb + sm) > 0 ? [sb, sm] : [0, claimed.stake_minor];
      await wallet.creditWinnings(u.id, bb, mm, value, { idemKey: 'cashout:' + id, kind: 'cashout', ref: 'bet:' + id });
      return value;
    });
  } catch (e) {
    if (e.message === 'already_decided') return send(res, 409, { error: 'already_decided' });
    if (e.message === 'cashout_unavailable') return send(res, 400, { error: 'cashout_unavailable' });
    if (e.message === 'no_cashout_value') return send(res, 400, { error: 'no_cashout_value' });
    return send(res, 400, { error: e.message });
  }
  send(res, 200, { betId: +id, cashout: toGhs(valueOut) }); });
route('GET', '/api/casino/games', async (req, res) => send(res, 200, { games: Object.entries(GAMES).map(([slug, g]) => ({ slug, name: g.name, mode: 'instant' })), sessionGames: Object.entries(SESSION_GAMES).map(([slug, g]) => ({ slug, name: g.name, mode: 'session' })) }));
route('POST', '/api/casino/play', async (req, res, b) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  if (await getSetting('maintenance', 0) && u.role === 'player') return send(res, 503, { error: 'maintenance' });
  const g = GAMES[b.game]; const stake = toMinor(b.stake || 0);
  if (!g) return send(res, 400, { error: 'unknown_game' });
  if (stake < toMinor(await getSetting('casino_min_ghs', 1)) || stake > toMinor(await getSetting('casino_max_ghs', 1000))) return send(res, 400, { error: 'stake_out_of_range' });
  // M10: unwinnable choices are rejected BEFORE any debit.
  const bad = validateChoice(b.game, b.choice);
  if (bad) return send(res, 400, { error: bad });
  // H7: worst-case payout must fit the platform cap.
  try { wallet.assertWithinMaxPayout(stake, gameMaxMultiplier(b.game, b.choice), { max_payout_ghs: await getSetting('max_payout_ghs', 200000) }); }
  catch (e) { return send(res, 400, { error: e.message }); }
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const seedHash = sha256(serverSeed);
  let playOut;
  try { await db.tx(async () => {
    const r = await run('INSERT INTO casino_rounds(user_id,game,stake_minor,choice,seed_hash) VALUES(?,?,?,?,?)', u.id, b.game, stake, String(b.choice ?? ''), seedHash);
    const roundId = Number(r.id);
    const split = await wallet.debitStake(u.id, stake, 'casino_stake', 'round:' + roundId, 'round:' + roundId);
    const f = floatStream(serverSeed, String(u.id), roundId);
    const { detail, multiplier } = g.play(String(b.choice ?? ''), f);
    const payout = Math.floor(stake * multiplier);
    // H4: winnings return pro-rata to how the stake was funded.
    if (payout > 0) await wallet.creditWinnings(u.id, split.bonusUse, split.mainUse, payout, { idemKey: 'payout:' + roundId, kind: 'casino_payout', ref: 'round:' + roundId });
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
  // M12/F-H2: regular admins see deposits only, and NEVER withdrawal bank
  // fields; the super admin sees everything, bank fields included.
  const isSuper = u.role === 'super_admin';
  const rows = isSuper
    ? await all("SELECT * FROM payment_requests WHERE status='pending' ORDER BY id")
    : await all("SELECT * FROM payment_requests WHERE status='pending' AND type='deposit' ORDER BY id");
  send(res, 200, { requests: rows.map(r => { const x = { ...r, amount: toGhs(r.amount_minor) }; if (!isSuper) { delete x.bank; delete x.account_number; delete x.account_name; } return x; }) }); });
route('POST', '/api/admin/queue/:id', async (req, res, b, id) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const r = await one('SELECT * FROM payment_requests WHERE id=?', id);
  if (!r) return send(res, 400, { error: 'not_pending' });
  if (r.status !== 'pending') return send(res, 409, { error: 'already_decided' });
  if (r.type === 'withdrawal' && u.role !== 'super_admin') return send(res, 403, { error: 'super_only_for_withdrawals' });
  if (!['confirm','reject'].includes(b.action)) return send(res, 400, { error: 'bad_action' });
  try { await db.tx(async () => {
    // M9: guarded flip — claim the request inside the tx; a concurrent
    // decide blocks, re-evaluates, and answers 409 already_decided.
    await run("UPDATE payment_requests SET status='deciding' WHERE id=? AND status='pending'", id);
    const claimed = await one('SELECT status FROM payment_requests WHERE id=?', id);
    if (!claimed || claimed.status !== 'deciding') throw new Error('already_decided');
    const finalStatus = b.action === 'confirm' ? 'confirmed' : 'rejected';
    if (b.action === 'confirm' && r.type === 'deposit') {
      await wallet.post(r.user_id, 'main', r.amount_minor, 'deposit', 'req:' + id, 'req:' + id);
      // H2: commission ONLY via the shared first-deposit helper.
      await wallet.payReferralCommission(r.user_id, r.amount_minor, 'req:' + id);
    }
    if (b.action === 'confirm' && r.type === 'withdrawal') await wallet.post(r.user_id, 'main', -r.amount_minor, 'withdrawal', 'req:' + id, 'req:' + id);
    await run('UPDATE payment_requests SET status=?,decided_by=? WHERE id=?', finalStatus, u.id, id);
  }); send(res, 200, { requestId: +id, action: b.action }); }
  catch (e) { if (e.message === 'already_decided') return send(res, 409, { error: 'already_decided' }); send(res, 400, { error: e.message }); } });
// Settle one open bet whose legs are all decided. Void legs count as a
// factor of 1; an all-void ticket refunds the stake with status 'void'.
// Payouts credit pro-rata to how the stake was funded (H4).
async function settleOpenBet(betId) {
  const bet = await one("SELECT * FROM bets WHERE id=? AND status='open'", betId);
  if (!bet) return false;
  const legs = await all('SELECT status,odds FROM bet_legs WHERE bet_id=?', betId);
  if (legs.some(l => l.status === 'pending')) return false;
  const lost = legs.some(l => l.status === 'lost');
  const allVoid = legs.length > 0 && legs.every(l => l.status === 'void');
  const payout = lost ? 0 : allVoid ? bet.stake_minor : Math.floor(bet.stake_minor * legs.filter(l => l.status === 'won').reduce((a, l) => a * l.odds, 1));
  const status = allVoid ? 'void' : (payout > 0 ? 'won' : 'lost');
  try {
    await db.tx(async () => {
      const still = await one("SELECT * FROM bets WHERE id=? AND status='open'", betId);
      if (!still) return;
      await run("UPDATE bets SET status=?,payout_minor=?,settled_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'", status, payout, betId);
      const chk = await one('SELECT status FROM bets WHERE id=?', betId);
      if (!chk || chk.status !== status) throw new Error('already_decided');
      if (payout > 0) {
        const sb = Number(bet.stake_bonus_minor || 0), sm = Number(bet.stake_main_minor || 0);
        const [bb, mm] = (sb + sm) > 0 ? [sb, sm] : [0, bet.stake_minor];
        await wallet.creditWinnings(bet.user_id, bb, mm, payout, { idemKey: 'settle:' + betId, kind: 'bet_payout', ref: 'bet:' + betId });
      }
    });
    return true;
  } catch (e) { return false; }
}
route('POST', '/api/admin/results', async (req, res, b) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  // H4/B5: b.results entries carry home/away scores and every pending leg
  // settles via markets.settleLeg (same as the ESPN path). Legacy
  // {matchId, result:'1'|'X'|'2'} still works (mapped to 1-0 / 1-1 / 0-1).
  // A void entry ({result:'void'} or {void:true}) voids every pending leg.
  // Legs settleLeg cannot decide from the FT score (HT1X2) stay pending.
  const affected = new Set();
  for (const r of (b.results || [])) {
    const matchId = r.matchId;
    if (r.result === 'void' || r.void === true) {
      await run("UPDATE bet_legs SET status='void' WHERE match_id=? AND status='pending'", matchId);
      await run("UPDATE matches SET status='finished' WHERE id=?", matchId);
    } else {
      let hs = r.homeScore, as = r.awayScore;
      if (hs == null || as == null) {
        if (r.result === '1') { hs = 1; as = 0; }
        else if (r.result === 'X') { hs = 1; as = 1; }
        else if (r.result === '2') { hs = 0; as = 1; }
        else return send(res, 400, { error: 'bad_result', matchId });
      }
      hs = Number(hs); as = Number(as);
      if (!Number.isFinite(hs) || !Number.isFinite(as) || hs < 0 || as < 0) return send(res, 400, { error: 'bad_result', matchId });
      for (const leg of await all("SELECT * FROM bet_legs WHERE match_id=? AND status='pending'", matchId)) {
        const outcome = markets.settleLeg(leg.market || '1X2', leg.pick, hs, as);
        if (!outcome) continue;
        await run('UPDATE bet_legs SET status=? WHERE id=? AND status=?', outcome, leg.id, 'pending');
      }
      await run('UPDATE matches SET status=?, home_score=?, away_score=? WHERE id=?', 'finished', hs, as, matchId);
    }
    for (const x of await all('SELECT bet_id FROM bet_legs WHERE match_id=?', matchId)) affected.add(x.bet_id);
  }
  let settled = 0;
  for (const betId of affected) { if (await settleOpenBet(betId)) settled++; }
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
  // H7: worst-case payout must fit the platform cap.
  try { wallet.assertWithinMaxPayout(stake, sessionMaxMultiplier(b.game, b.options || {}), { max_payout_ghs: await getSetting('max_payout_ghs', 200000) }); }
  catch (e) { return send(res, 400, { error: e.message }); }
  const serverSeed = crypto.randomBytes(32).toString('hex');
  let sidOut;
  try { await db.tx(async () => {
    const r = await run('INSERT INTO game_sessions(user_id,game,stake_minor,state,seed_hash) VALUES(?,?,?,?,?)', u.id, b.game, stake, '{}', sha256(serverSeed));
    const sid = Number(r.id); sidOut = sid;
    const split = await wallet.debitStake(u.id, stake, 'casino_stake', 'session:' + sid, 'session:' + sid);
    const f = floatStream(serverSeed, String(u.id), sid);
    const st = g.start(f, b.options || {}, crashPoint);
    // The stake split rides inside the session state (no schema change)
    // so the action handler can credit pro-rata when the session settles.
    st._stakeBonus = split.bonusUse; st._stakeMain = split.mainUse;
    await run('UPDATE game_sessions SET state=?,seed_reveal=? WHERE id=?', JSON.stringify(st), serverSeed, sid);
    });
    send(res, 201, pubSession(await one('SELECT * FROM game_sessions WHERE id=?', sidOut)));
  } catch (e) { send(res, 400, { error: e.message }); } });
route('POST', '/api/casino/session/:id/action', async (req, res, b, id) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const row = await one("SELECT * FROM game_sessions WHERE id=? AND user_id=? AND status='active'", id, u.id);
  if (!row) return send(res, 400, { error: 'session_not_active' });
  const g = SESSION_GAMES[row.game];
  let guarded;
  try {
    // H6: read + act + update happen inside ONE guarded tx — a second
    // concurrent action finds no 'active' row and answers 409.
    guarded = await actSessionGuarded(id, async (claimed) => {
      const out = g.act(JSON.parse(claimed.state), String(b.action || ''), b);
      const sid = claimed.id;
      const st = JSON.parse(claimed.state);
      const sb = Number(st._stakeBonus || 0), sm = Number(st._stakeMain || 0);
      const [bb, mm] = (sb + sm) > 0 ? [sb, sm] : [0, claimed.stake_minor];
      let payout = 0;
      if (out.settled) {
        payout = out.won ? Math.floor(claimed.stake_minor * out.multiplier) : 0;
        // H4: winnings return pro-rata to how the stake was funded.
        if (payout > 0) await wallet.creditWinnings(u.id, bb, mm, payout, { idemKey: 'sessionpayout:' + sid, kind: 'casino_payout', ref: 'session:' + sid });
        await run("UPDATE game_sessions SET state=?,status=?,multiplier=?,payout_minor=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", JSON.stringify(out.state), out.won ? 'won' : 'lost', out.multiplier, payout, sid);
      } else {
        await run("UPDATE game_sessions SET state=?,status='active',multiplier=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", JSON.stringify(out.state), out.state.mult ?? claimed.multiplier, sid);
      }
      return { out, payout };
    });
  } catch (e) { return send(res, 400, { error: e.message }); }
  if (!guarded || guarded.touched === 0) return send(res, 409, { error: 'session_already_settled' });
  const fresh = await one('SELECT * FROM game_sessions WHERE id=?', id);
  send(res, 200, { ...pubSession(fresh), message: guarded.result.out.message || null }); });
route('GET', '/api/casino/session/:id', async (req, res, b, id) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  const row = await one('SELECT * FROM game_sessions WHERE id=? AND user_id=?', id, u.id);
  if (!row) return send(res, 404, { error: 'not_found' });
  // skyclimb: a plain poll can bust the session (guarded: never overwrite
  // a session another request already settled).
  if (row.status === 'active' && row.game === 'skyclimb') {
    const g = SESSION_GAMES.skyclimb; const st = JSON.parse(row.state);
    if (g.currentMult(st) >= st.crash) await run("UPDATE game_sessions SET status='lost',multiplier=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'", id);
  }
  send(res, 200, pubSession(await one('SELECT * FROM game_sessions WHERE id=?', id))); });
// ---- Phase 2: admin settings, stats, match creation ----
const SETTING_KEYS = { book_margin: [0, 0.30], cashout_margin: [0, 0.50], casino_min_ghs: [0.1, 100], casino_max_ghs: [10, 100000], min_stake_ghs: [0.1, 1000], max_payout_ghs: [1000, 10000000], welcome_bonus_ghs: [0, 10000], commission_pct: [0, 100], maintenance: [0, 1], registration_open: [0, 1], fx_ngn_per_ghs: [1, 1000] };
route('GET', '/api/admin/settings', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const out = {}; for (const k of Object.keys(SETTING_KEYS)) out[k] = await getSetting(k, null); send(res, 200, { settings: out }); });
route('POST', '/api/admin/settings', async (req, res, b) => { const u = await auth(req, ['super_admin']); if (!u) return send(res, 403, { error: 'super_only' });
  for (const [k, v] of Object.entries(b.settings || {})) { const range = SETTING_KEYS[k];
    if (!range || typeof v !== 'number' || v < range[0] || v > range[1]) return send(res, 400, { error: 'bad_setting', key: k });
    await setSetting(k, v); }
  send(res, 200, { updated: true }); });
route('GET', '/api/admin/stats', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const q = async (sql) => (await one(sql)).v;
  const betStakes = await q("SELECT COALESCE(SUM(stake_minor),0) v FROM bets WHERE status IN ('won','lost','cashed_out')");
  const betPayouts = await q("SELECT COALESCE(SUM(payout_minor),0) v FROM bets WHERE status IN ('won','lost','cashed_out')");
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
route('GET', '/api/admin/matches', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  // M9: one prefix query for all match odds (was N+1 getSetting calls).
  const oddsMap = await db.getSettingsByPrefix('match_odds:');
  const ms = (await all('SELECT * FROM matches ORDER BY starts_at DESC, id DESC'))
    .map(m => ({ ...m, odds1x2: oddsMap['match_odds:' + m.id] ?? null }));
  send(res, 200, { matches: ms }); });
route('POST', '/api/admin/espn-sync', async (req, res) => { const u = await auth(req, ['super_admin']); if (!u) return send(res, 403, { error: 'super_only' });
  try {
    const r = await espn.syncLeagues();
    await audit(u.id, 'espn_sync', '', 'imported ' + r.imported + ' updated ' + r.updated + ' settled ' + r.settled + ' live ' + r.live);
    send(res, 200, { imported: r.imported, updated: r.updated, settled: r.settled, live: r.live, report: r.report });
  } catch (e) { console.error('espn sync failed:', e); send(res, 502, { error: 'espn_sync_failed' }); } });

// Cron trigger (B2): Vercel Cron hits this every 5 minutes (see
// blizbet-api/vercel.json). Guarded by CRON_SECRET — Vercel sends it as
// `Authorization: Bearer <CRON_SECRET>` for cron invocations. One call
// runs syncNextChunk(): as many league/day chunks as fit in the 8s
// budget, advancing the stored cursor. No role check — the secret IS the
// auth. If CRON_SECRET is unset the endpoint answers 503, never open.
async function cronEspnSync(req, res) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return send(res, 503, { error: 'cron_not_configured' });
  const presented = (req.headers.authorization || '').replace('Bearer ', '');
  const a = Buffer.from(presented), bb = Buffer.from(secret);
  if (a.length !== bb.length || !crypto.timingSafeEqual(a, bb)) return send(res, 401, { error: 'unauthorized' });
  try {
    const r = await espn.syncNextChunk();
    send(res, 200, r);
  } catch (e) { console.error('cron espn sync failed:', e); send(res, 502, { error: 'espn_sync_failed' }); }
}
route('GET', '/api/cron/espn-sync', cronEspnSync);
route('POST', '/api/cron/espn-sync', cronEspnSync);

// ---- Deposit providers (ShinobiPay MoMo + Flutterwave) ----
// Handlers never credit the wallet; settlement happens only through the
// webhooks below (re-verify + settle-once). Without keys: 503.
route('POST', '/api/wallet/deposit-momo', async (req, res, b) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  // L8: deposit creation respects maintenance (webhooks stay open so
  // in-flight attempts can still settle).
  if (await getSetting('maintenance', 0) && u.role === 'player') return send(res, 503, { error: 'maintenance' });
  if (!providers.shinobiConfig().secretKey) return send(res, 503, { error: 'provider_not_configured' });
  const amount = toMinor(b.amount || 0);
  if (amount < 100 || amount > 500000) return send(res, 400, { error: 'invalid_amount' });
  const digits = String(b.phone || '').replace(/[\s+]/g, '');
  const local = digits.startsWith('233') ? '0' + digits.slice(3) : digits;
  if (!/^0\d{9}$/.test(local)) return send(res, 400, { error: 'invalid_phone' });
  const intl = '233' + local.slice(1);
  let net = String(b.network || '').toUpperCase();
  if (!['MTN', 'TELECEL', 'AIRTELTIGO'].includes(net)) net = providers.detectNetwork(local) || '';
  if (!net) return send(res, 400, { error: 'invalid_network' });
  // Anti-storm guard: refuse without poking the provider when a prompt
  // is in flight (<10 min) or the number was blocked (<30 min). L3: an
  // 'unknown' (provider timeout) or 'processing' attempt is in flight too.
  const lastTry = await one('SELECT status, fail_reason, created_at FROM payment_attempts WHERE phone=? ORDER BY id DESC LIMIT 1', intl);
  if (lastTry) {
    const ageMin = (Date.now() - parseDbTime(lastTry.created_at)) / 60000;
    if ((lastTry.status === 'awaiting' || lastTry.status === 'created' || lastTry.status === 'unknown' || lastTry.status === 'processing') && ageMin < 10) return send(res, 409, { error: 'payment_in_progress' });
    if (lastTry.fail_reason === 'number_blocked' && ageMin < 30) return send(res, 429, { error: 'number_blocked' });
  }
  const reference = 'dep_' + crypto.randomUUID().replace(/-/g, '');
  const r = await run("INSERT INTO payment_attempts(user_id,provider,reference,amount_minor,phone,network,status) VALUES(?,?,?,?,?,'created')", u.id, 'shinobipay', reference, amount, intl, net);
  let created;
  try {
    created = await providers.shinobiFetch('/payment_intents', { method: 'POST', idempotencyKey: r.id,
      body: { amount, currency: 'GHS', method: 'mobile_money', network: net, customer: { phone: intl }, reference, description: 'BlazeBet wallet deposit' } });
  } catch (e) {
    await run("UPDATE payment_attempts SET status='unknown' WHERE id=?", r.id);
    return send(res, 202, { reference, status: 'unknown' });
  }
  const d = created.data || {};
  if (created.status === 201 && d.id) {
    await run('UPDATE payment_attempts SET intent_id=?, status=? WHERE id=?', d.id, providers.mapIntentStatus(d.status), r.id);
    // L8: the charged total comes from the provider intent when it
    // reports one; otherwise the field is omitted (never a hard-coded
    // 2.5% guess — the client discloses its own computed charge then).
    return send(res, 201, { reference, status: providers.mapIntentStatus(d.status), next_action: d.next_action || { type: 'await_prompt' }, ...(typeof d.amount === 'number' ? { charged_total_ghs: d.amount / 100 } : {}), credit_ghs: amount / 100 });
  }
  if (created.status === 429 && d.error && d.error.code === 'payment_in_progress' && d.intent_id) {
    await run("UPDATE payment_attempts SET intent_id=?, status='awaiting' WHERE id=?", d.intent_id, r.id);
    return send(res, 200, { reference, status: 'awaiting', resumed: true, next_action: { type: 'await_prompt' }, credit_ghs: amount / 100 });
  }
  const code = (d.error && d.error.code) || 'payment_failed';
  await run("UPDATE payment_attempts SET status='failed', fail_reason=? WHERE id=?", code, r.id);
  send(res, created.status >= 400 && created.status < 500 ? created.status : 402, { error: code, reference }); });
route('POST', '/api/wallet/deposit-flutterwave', async (req, res, b) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  if (await getSetting('maintenance', 0) && u.role === 'player') return send(res, 503, { error: 'maintenance' });
  if (!providers.flwConfig().secretKey) return send(res, 503, { error: 'provider_not_configured' });
  const amount = toMinor(b.amount || 0);
  if (amount < 100 || amount > 200000000) return send(res, 400, { error: 'invalid_amount' });
  // F-B1: the player types GH₵ but Flutterwave charges NGN. Convert at
  // the fx_ngn_per_ghs setting (default 116) and store BOTH legs: the GH₵
  // credit (amount_minor) and the NGN actually charged (charged_minor).
  // Settlement verifies against the NGN leg and credits the GH₵ leg.
  const fx = await getSetting('fx_ngn_per_ghs', 116);
  const ngnMinor = Math.round(amount * fx);
  const reference = 'flw_' + crypto.randomUUID().replace(/-/g, '');
  const r = await run("INSERT INTO payment_attempts(user_id,provider,reference,amount_minor,charged_minor,phone,network,currency,status) VALUES(?,?,?,?,?,?, 'FLUTTERWAVE','NGN','created')", u.id, 'flutterwave', reference, amount, ngnMinor, u.phone);
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'blazebet.vercel.app';
  let created;
  try {
    created = await providers.flwFetch('/payments', { method: 'POST',
      body: { tx_ref: reference, amount: ngnMinor / 100, currency: 'NGN', redirect_url: 'https://' + host + '/?flw_return=1',
        customer: { email: String(u.phone).replace('+', '') + '@blazebet.app', phonenumber: u.phone, name: u.name || 'BlazeBet player' },
        customizations: { title: 'BlazeBet', description: 'Wallet deposit' } } });
  } catch (e) {
    await run("UPDATE payment_attempts SET status='failed', fail_reason='network_error' WHERE id=?", r.id);
    return send(res, 502, { error: 'provider_unreachable' });
  }
  const link = created.data && created.data.data && created.data.data.link;
  if (created.status !== 200 || !link) {
    await run("UPDATE payment_attempts SET status='failed', fail_reason=? WHERE id=?", String((created.data && created.data.message) || 'create_failed').slice(0, 200), r.id);
    return send(res, 502, { error: 'provider_rejected' });
  }
  await run("UPDATE payment_attempts SET status='awaiting' WHERE id=?", r.id);
  send(res, 201, { reference, link, checkoutUrl: link, charged_ngn: ngnMinor / 100, credit_ghs: amount / 100, fx_ngn_per_ghs: fx }); });
route('POST', '/api/wallet/deposit-flutterwave/status', async (req, res, b) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  if (!providers.flwConfig().secretKey) return send(res, 503, { error: 'provider_not_configured' });
  const reference = String(b.ref || b.reference || '');
  if (!reference) return send(res, 400, { error: 'reference_required' });
  const attempt = await one('SELECT * FROM payment_attempts WHERE reference=? AND user_id=?', reference, u.id);
  if (!attempt) return send(res, 404, { error: 'attempt_not_found' });
  if (attempt.provider !== 'flutterwave') return send(res, 400, { error: 'wrong_provider' });
  let status = attempt.status;
  if (status !== 'succeeded') {
    if (!attempt.intent_id) {
      // M5: reconcile by tx_ref even when the webhook never recorded the
      // Flutterwave transaction id — then adopt it for settlement.
      const v = await providers.verifyFlwByRef(attempt.reference);
      if (v.ok) {
        // The verified NGN amount must equal what we asked FLW to charge.
        if (Number(v.amountMinor) !== Number(attempt.charged_minor || 0)) {
          return send(res, 200, { status, balance: toGhs(await wallet.balance(u.id, 'main')), error: 'amount_mismatch' });
        }
        await run('UPDATE payment_attempts SET intent_id=? WHERE id=? AND intent_id IS NULL', String(v.id), attempt.id);
        attempt.intent_id = String(v.id);
      }
    }
    if (attempt.intent_id) {
      const result = await providers.settleFlwAttempt(attempt);
      if (result === 'credited' || result === 'already') status = 'succeeded';
    }
  }
  send(res, 200, { status, balance: toGhs(await wallet.balance(u.id, 'main')) }); });
// ShinobiPay status/reconcile endpoint, mirroring the Flutterwave one
// (M4: a paid MoMo deposit must have a self-heal path when the webhook
// is delayed or was answered 500 for a still-processing intent).
route('POST', '/api/wallet/deposit-shinobipay/status', async (req, res, b) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  if (!providers.shinobiConfig().secretKey) return send(res, 503, { error: 'provider_not_configured' });
  const reference = String(b.ref || b.reference || '');
  if (!reference) return send(res, 400, { error: 'reference_required' });
  const attempt = await one('SELECT * FROM payment_attempts WHERE reference=? AND user_id=?', reference, u.id);
  if (!attempt) return send(res, 404, { error: 'attempt_not_found' });
  if (attempt.provider !== 'shinobipay') return send(res, 400, { error: 'wrong_provider' });
  let status = attempt.status;
  if (status !== 'succeeded' && attempt.intent_id) {
    const result = await providers.settleAttempt(attempt);
    if (result === 'credited' || result === 'already') status = 'succeeded';
  }
  send(res, 200, { status, balance: toGhs(await wallet.balance(u.id, 'main')) }); });

// ---- Payment webhooks (verify before trusting anything; credit once) ----
route('POST', '/api/payments/shinobipay-webhook', async (req, res) => {
  const { webhookSecret } = providers.shinobiConfig();
  if (!webhookSecret) return send(res, 503, { error: 'provider_not_configured' });
  const raw = req.rawBody || '';
  if (!providers.verifyShinobiSignature(raw, req.headers['x-akwapay-signature'], webhookSecret)) return send(res, 401, { error: 'invalid_signature' });
  let event; try { event = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'bad_json' }); }
  const data = event.data || {};
  const eventId = String(event.id || '');
  try {
    if (eventId) {
      if (await one('SELECT event_id FROM webhook_events WHERE event_id=?', eventId)) return send(res, 200, { ok: true, duplicate: true });
      await run('INSERT INTO webhook_events(event_id) VALUES(?)', eventId);
    }
    const attempt = await one('SELECT * FROM payment_attempts WHERE reference=? OR intent_id=?', String(data.reference || ''), String(data.intent_id || ''));
    if (!attempt) return send(res, 200, { ok: true, unmatched: true });
    const seq = Number(event.sequence || 0);
    if (seq && seq < Number(attempt.last_sequence || 0)) return send(res, 200, { ok: true, stale: true });
    if (seq) await run('UPDATE payment_attempts SET last_sequence=? WHERE id=?', seq, attempt.id);
    if (event.type === 'payment_intent.succeeded') {
      const result = await providers.settleAttempt(attempt);
      // M4: 'not_succeeded' (provider still processing) is treated like
      // 'unverified' — delete the dedupe row and answer 500 so the
      // provider retries. A 200 here would lose the deposit forever.
      if (result === 'unverified' || result === 'not_succeeded') {
        await providers.deleteWebhookEvent(eventId);
        return send(res, 500, { error: result === 'unverified' ? 'verification_failed' : 'not_succeeded' });
      }
      return send(res, 200, { ok: true, credited: result === 'credited' });
    }
    if (event.type === 'payment_intent.failed') {
      // L6: persist the provider's failure code so the anti-storm guard
      // can learn 'number_blocked' from the webhook, not just from the
      // creation response.
      const code = (data && (data.error_code || data.code || (data.error && data.error.code))) || null;
      if (code) await run("UPDATE payment_attempts SET status='failed', fail_reason=? WHERE id=? AND status<>?", String(code).slice(0, 200), attempt.id, 'succeeded');
      else await run("UPDATE payment_attempts SET status='failed' WHERE id=? AND status<>?", attempt.id, 'succeeded');
      return send(res, 200, { ok: true });
    }
    if (event.type === 'payment_intent.processing') {
      await run("UPDATE payment_attempts SET status='processing' WHERE id=? AND status IN ('created','awaiting','unknown')", attempt.id);
      return send(res, 200, { ok: true });
    }
    return send(res, 200, { ok: true, ignored: event.type || null });
  } catch (e) {
    console.error('shinobipay webhook error:', e);
    if (eventId) { try { await run('DELETE FROM webhook_events WHERE event_id=?', eventId); } catch {} }
    if (!res.headersSent) send(res, 500, { error: 'webhook_error' });
  } });
route('POST', '/api/payments/flutterwave-webhook', async (req, res, b) => {
  const { webhookHash, secretKey } = providers.flwConfig();
  if (!webhookHash || !secretKey) return send(res, 503, { error: 'provider_not_configured' });
  // L5: constant-time hash comparison (was plain !==).
  if (!providers.verifyFlwHash(String(req.headers['verif-hash'] || ''), webhookHash)) return send(res, 401, { error: 'invalid_hash' });
  const event = b || {}; const data = event.data || {};
  const eventId = 'flw:' + String(event.event || '') + ':' + String(data.id || data.tx_ref || '');
  try {
    if (await one('SELECT event_id FROM webhook_events WHERE event_id=?', eventId)) return send(res, 200, { ok: true, duplicate: true });
    await run('INSERT INTO webhook_events(event_id) VALUES(?)', eventId);
    if (event.event === 'charge.completed' && data.status === 'successful') {
      const attempt = await one("SELECT * FROM payment_attempts WHERE reference=? AND provider='flutterwave'", String(data.tx_ref || ''));
      if (!attempt) return send(res, 200, { ok: true, unmatched: true });
      if (data.id && !attempt.intent_id) {
        await run('UPDATE payment_attempts SET intent_id=? WHERE id=? AND intent_id IS NULL', String(data.id), attempt.id);
        attempt.intent_id = String(data.id);
      }
      const result = await providers.settleFlwAttempt(attempt);
      // M4: same rule as ShinobiPay — a still-processing intent is never
      // 200-acked; delete the dedupe row and answer 500 for a retry.
      if (result === 'unverified' || result === 'not_succeeded') {
        await providers.deleteWebhookEvent(eventId);
        return send(res, 500, { error: result === 'unverified' ? 'verification_failed' : 'not_succeeded' });
      }
      return send(res, 200, { ok: true, credited: result === 'credited' });
    }
    if (event.event === 'charge.completed' && data.status !== 'successful') {
      await run("UPDATE payment_attempts SET status='failed' WHERE reference=? AND provider='flutterwave' AND status<>?", String(data.tx_ref || ''), 'succeeded');
      return send(res, 200, { ok: true });
    }
    return send(res, 200, { ok: true, ignored: event.event || null });
  } catch (e) {
    console.error('flutterwave webhook error:', e);
    try { await run('DELETE FROM webhook_events WHERE event_id=?', eventId); } catch {}
    if (!res.headersSent) send(res, 500, { error: 'webhook_error' });
  } });

// ---- Phase 3: admin power pack (patterns ported from production PrimeStake/Oddaroa) ----
route('GET', '/api/referrals', async (req, res) => { const u = await auth(req); if (!u) return send(res, 401, { error: 'unauthorized' });
  // M1: await the row FIRST, then read .c/.s (member access binds tighter
  // than await — the old code read .c off the Promise and got undefined).
  const count = (await one('SELECT COUNT(*) c FROM users WHERE referred_by=?', u.id)).c;
  const earned = (await one("SELECT COALESCE(SUM(delta_minor),0) s FROM ledger_entries WHERE user_id=? AND kind='commission'", u.id)).s;
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
  try { await wallet.post(+id, b.bucket === 'bonus' ? 'bonus' : 'main', amount, 'admin_adjust', 'admin:' + u.id, 'adj:' + crypto.randomUUID() + ':' + id);
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
  // L4: the admin id is a bound parameter now, never interpolated into SQL.
  const mineOnly = u.role !== 'super_admin' || req.url.includes('mine=1');
  const rows = mineOnly
    ? await all('SELECT decided_by, type, status, COUNT(*) n, COALESCE(SUM(amount_minor),0) total FROM payment_requests WHERE date(created_at)=? AND decided_by IS NOT NULL AND decided_by=? GROUP BY decided_by,type,status', day, u.id)
    : await all('SELECT decided_by, type, status, COUNT(*) n, COALESCE(SUM(amount_minor),0) total FROM payment_requests WHERE date(created_at)=? AND decided_by IS NOT NULL GROUP BY decided_by,type,status', day);
  const actions = mineOnly
    ? await all('SELECT action, COUNT(*) n FROM admin_actions WHERE date(created_at)=? AND admin_id=? GROUP BY action', day, u.id)
    : await all('SELECT action, COUNT(*) n FROM admin_actions WHERE date(created_at)=? GROUP BY action', day);
  send(res, 200, { day, queueWork: rows.map(r => ({ ...r, total: toGhs(r.total) })), actions }); });
route('GET', '/api/admin/bets', async (req, res) => { const u = await auth(req, ['admin','super_admin']); if (!u) return send(res, 403, { error: 'forbidden' });
  const status = (req.url.split('status=')[1] || '').split('&')[0];
  const rows = (status ? await all('SELECT * FROM bets WHERE status=? ORDER BY id DESC LIMIT 100', status)
    : await all('SELECT * FROM bets ORDER BY id DESC LIMIT 100'))
    .map(x => ({ ...x, stake: toGhs(x.stake_minor), potential: toGhs(x.potential_minor), payout: x.payout_minor == null ? null : toGhs(x.payout_minor) }));
  send(res, 200, { bets: rows }); });
route('POST', '/api/admin/bets/:id/void', async (req, res, b, id) => { const u = await auth(req, ['super_admin']); if (!u) return send(res, 403, { error: 'super_only' });
  const bet = await one("SELECT * FROM bets WHERE id=? AND status='open'", id); if (!bet) return send(res, 400, { error: 'bet_not_open' });
  try { await db.tx(async () => {
    // Guarded flip: a concurrent void/settle cannot double-refund.
    await run("UPDATE bets SET status='voiding' WHERE id=? AND status='open'", id);
    const claimed = await one('SELECT status FROM bets WHERE id=?', id);
    if (!claimed || claimed.status !== 'voiding') throw new Error('already_decided');
    await run("UPDATE bets SET status='void',payout_minor=?,settled_at=CURRENT_TIMESTAMP WHERE id=? AND status='voiding'", bet.stake_minor, id);
    await run("UPDATE bet_legs SET status='void' WHERE bet_id=? AND status='pending'", id);
    // H4: the refund returns pro-rata to how the stake was funded.
    const sb = Number(bet.stake_bonus_minor || 0), sm = Number(bet.stake_main_minor || 0);
    const [bb, mm] = (sb + sm) > 0 ? [sb, sm] : [0, bet.stake_minor];
    await wallet.creditWinnings(bet.user_id, bb, mm, bet.stake_minor, { idemKey: 'voidbet:' + id, kind: 'bet_refund', ref: 'bet:' + id });
    }); await audit(u.id, 'bet_void', id, 'refund ' + toGhs(bet.stake_minor)); send(res, 200, { betId: +id, refunded: toGhs(bet.stake_minor) }); }
  catch (e) { if (e.message === 'already_decided') return send(res, 409, { error: 'already_decided' }); send(res, 400, { error: e.message }); } });
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

async function handle(req, res, rawBody) {
  req.rawBody = rawBody || '';
  // M11: never serve before boot (DDL + seeding) has finished. A failed
  // boot retries init once (Area A made init retryable) instead of
  // answering from a half-built database.
  try { await ready; } catch { try { await db.init(); } catch { return send(res, 503, { error: 'not_ready' }); } }
  if (req.method === 'OPTIONS') return send(res, 204, {});
  let body = {}; try { body = JSON.parse(rawBody || '{}'); } catch { return send(res, 400, { error: 'bad_json' }); }
  const pathOnly = req.url.split('?')[0];
  try {
    for (const [m, re, fn] of routes) { if (req.method !== m) continue; const mm = pathOnly.match(re); if (mm) return await fn(req, res, body, ...mm.slice(1)); }
    if (pathOnly === '/health') return send(res, 200, { ok: true, service: 'blazebet-backend', db: db.isPG ? 'postgres' : 'sqlite' });
    send(res, 404, { error: 'not_found' });
  } catch (e) { console.error('handler error:', e); if (!res.headersSent) send(res, 500, { error: 'internal' }); }
}
const server = http.createServer((req, res) => {
  // M10: bodies are capped at ~1 MB (webhooks and bet slips are tiny);
  // anything bigger is 413'd instead of buffered into memory.
  const chunks = []; let size = 0, tooBig = false;
  req.on('data', c => { if (tooBig) return; size += c.length; if (size > 1048576) { tooBig = true; send(res, 413, { error: 'body_too_large' }); req.destroy(); return; } chunks.push(c); });
  req.on('end', () => { if (!tooBig) handle(req, res, Buffer.concat(chunks).toString()); });
});
const ready = db.init().then(seedMatches);
if (require.main === module) {
  ready.then(() => server.listen(PORT, () => console.log('BlazeBet backend listening on :' + PORT + ' (db: ' + (db.isPG ? 'postgres' : 'sqlite') + ')'))).catch(e => { console.error('boot failed:', e); process.exit(1); });
}
// Vercel: api/index.js requires this module (no listen) and calls handle().
// Tests: call start(port) after require.
module.exports = { server, handle, ready, start: (port) => ready.then(() => new Promise((res) => server.listen(port || PORT, res))) };
