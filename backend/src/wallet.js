// Double-entry ledger wallet (async data layer). Balances are DERIVED from
// ledger_entries, never stored. Every posting carries an idempotency key.
const db = require('./db');
async function balance(userId, bucket) {
  const r = await db.one('SELECT COALESCE(SUM(delta_minor),0) s FROM ledger_entries WHERE user_id=? AND bucket=?', userId, bucket);
  return Number(r.s);
}
async function post(userId, bucket, deltaMinor, kind, ref, idemKey) {
  if (!Number.isInteger(deltaMinor) || deltaMinor === 0) throw new Error('bad_amount');
  if (idemKey) { const dup = await db.one('SELECT id FROM ledger_entries WHERE idem_key=?', idemKey); if (dup) return { duplicate: true }; }
  if (deltaMinor < 0 && (await balance(userId, bucket)) + deltaMinor < 0) throw new Error('insufficient_funds');
  await db.run('INSERT INTO ledger_entries(user_id,bucket,delta_minor,kind,ref,idem_key) VALUES(?,?,?,?,?,?)', userId, bucket, deltaMinor, kind, ref || null, idemKey || null);
  return { posted: true };
}
async function debitStake(userId, amountMinor, kind, ref, idemKey) {
  // Bonus bucket is spent first; the two postings share one transaction.
  return db.tx(async () => {
    const bonusUse = Math.min(await balance(userId, 'bonus'), amountMinor);
    const mainUse = amountMinor - bonusUse;
    if ((await balance(userId, 'main')) < mainUse) throw new Error('insufficient_funds');
    if (bonusUse) await post(userId, 'bonus', -bonusUse, kind, ref, idemKey ? idemKey + ':b' : null);
    if (mainUse) await post(userId, 'main', -mainUse, kind, ref, idemKey ? idemKey + ':m' : null);
    return { bonusUse, mainUse };
  });
}

// H4 — split a payout pro-rata between the bonus and main buckets, in the
// same proportions as the stake that funded it. A stake funded from bonus
// stays bonus until turned over (Oddaroa rule: withdrawals capped at
// balance - bonus); only the main-funded share of a win becomes withdrawable.
//   creditWinnings(userId, stakeBonusMinor, stakeMainMinor, payoutMinor[, idemKey])
//   - stakeBonusMinor / stakeMainMinor: the split returned by debitStake()
//     for the stake that produced this payout (both integers, >= 0).
//   - payoutMinor: total payout to credit (integer, > 0; 0/no-op returns
//     { bonus: 0, main: 0 } without posting).
//   - idemKey (optional): base key; postings use idemKey+':b' / idemKey+':m'
//     (same suffix convention as debitStake), so a retry dedupes per bucket.
//   Returns { bonus, main } (minor units actually credited per bucket).
//   Runs inside db.tx (joins the caller's tx when nested).
// PHASE-2 WIRING: replace every `wallet.post(u.id,'main',payout,...)` on a
// credit path with creditWinnings, passing the stake split the route already
// knows: casino instant (server.js /api/casino/play — capture debitStake's
// return), casino sessions (/api/casino/session/:id/action), sports bet
// settlement + cashout (/api/admin/results settle, /api/bets/:id/cashout —
// the bet's stake split must be recorded at placement: store
// debitStake's {bonusUse, mainUse} on the bets row, e.g. new columns
// stake_bonus_minor / stake_main_minor, and read them back at settle/cashout
// time). Kind/ref of the postings are derived from idemKey when given;
// pass kind explicitly via the 5th-arg object form if a distinct kind is
// needed: creditWinnings(uid, b, m, payout, { idemKey, kind, ref }).
async function creditWinnings(userId, stakeBonusMinor, stakeMainMinor, payoutMinor, idemKeyOrOpts) {
  const opts = typeof idemKeyOrOpts === 'string' ? { idemKey: idemKeyOrOpts }
    : (idemKeyOrOpts && typeof idemKeyOrOpts === 'object' ? idemKeyOrOpts : {});
  const idemKey = opts.idemKey || null, kind = opts.kind || 'casino_payout', ref = opts.ref || null;
  if (!Number.isInteger(payoutMinor) || payoutMinor < 0) throw new Error('bad_amount');
  if (!Number.isInteger(stakeBonusMinor) || !Number.isInteger(stakeMainMinor)
    || stakeBonusMinor < 0 || stakeMainMinor < 0) throw new Error('bad_amount');
  if (payoutMinor === 0) return { bonus: 0, main: 0 };
  const total = stakeBonusMinor + stakeMainMinor;
  if (total <= 0) throw new Error('bad_amount');
  const bonusShare = Math.floor(payoutMinor * stakeBonusMinor / total);
  const mainShare = payoutMinor - bonusShare;
  return db.tx(async () => {
    if (bonusShare > 0) await post(userId, 'bonus', bonusShare, kind, ref, idemKey ? idemKey + ':b' : null);
    if (mainShare > 0) await post(userId, 'main', mainShare, kind, ref, idemKey ? idemKey + ':m' : null);
    return { bonus: bonusShare, main: mainShare };
  });
}

// H7 — reject any casino play whose worst-case payout exceeds the platform
// max payout. Throws Error('above_max_payout') (same error the sportsbook
// placement route already returns) when floor(stakeMinor * maxMultiplier)
// exceeds the cap; otherwise returns the worst-case payout in minor units.
//   assertWithinMaxPayout(stakeMinor, maxMultiplier, settings)
//   - settings: a plain number (max payout in MINOR units), or an object
//     { max_payout_minor } (minor) or { max_payout_ghs } (GHS, x100).
//     Pass the live setting, e.g. `await getSetting('max_payout_ghs', 200000)`.
// PHASE-2 WIRING: call in POST /api/casino/play with
// gameMaxMultiplier(game, choice) from games.js, and in
// POST /api/casino/session/start with the session game's max multiplier
// (mines: minesMult(25-mines, mines); towers: towerMult(5); balloon: 9.02
// max cashable mult at 12 pumps; goalladder: LADDER[4]=2.13; poker: 250;
// hilo/redblack/skyclimb: use the 500 cap — their multipliers are deck/time
// bounded but effectively uncapped, so gate at 500 like crashPoint).
function assertWithinMaxPayout(stakeMinor, maxMultiplier, settings) {
  if (!Number.isInteger(stakeMinor) || stakeMinor < 0) throw new Error('bad_amount');
  if (!(maxMultiplier > 0) || !Number.isFinite(maxMultiplier)) throw new Error('bad_amount');
  let maxMinor;
  if (typeof settings === 'number') maxMinor = settings;
  else if (settings && Number.isFinite(settings.max_payout_minor)) maxMinor = settings.max_payout_minor;
  else if (settings && Number.isFinite(settings.max_payout_ghs)) maxMinor = Math.floor(settings.max_payout_ghs * 100);
  else throw new Error('bad_amount');
  const worst = Math.floor(stakeMinor * maxMultiplier);
  if (worst > maxMinor) throw new Error('above_max_payout');
  return worst;
}

// H2 — ONE referral-commission payer for both deposit rails.
//   payReferralCommission(userId, depositAmountMinor, idemKey)
//   - userId: the depositor; depositAmountMinor: the completed deposit.
//   - idemKey: the deposit's own idempotency key (e.g. 'req:<id>' for the
//     manual queue, 'deposit:<provider>:<ref>' for provider settle) — used
//     ONLY as the audit ref; the commission ledger posting uses the fixed
//     key 'commission:first:<userId>' so a second attempt dedupes in the
//     ledger even if the claim check raced.
//   Gate: a single atomic first-completed-deposit claim. The first caller to
//   insert its row into referral_commissions (PRIMARY KEY user_id) wins;
//   every later call — any rail, any deposit — sees the row and pays nothing.
//   The INSERT uses ON CONFLICT(user_id) DO NOTHING (valid SQLite + PG) and
//   the winner is decided by reading back which idem_key holds the row, so
//   no check-then-act window exists. Runs inside db.tx (joins the caller's
//   tx, so the claim lands in the SAME transaction as the first credit —
//   AREA A's B1 fix makes that tx real on PG).
//   Returns { paid: true, referrerId, amountMinor } on first deposit,
//   { paid: false, reason } otherwise ('no_referrer' | 'no_commission_pct' |
//   'zero_commission' | 'already_claimed').
//   NOTE (DDL): referral_commissions is created lazily here because db.js
//   (AREA A) owns the schema; AREA A / Phase 2 should move this DDL into
//   db.js init() — SQLite: user_id INTEGER PRIMARY KEY, referrer_id INTEGER
//   NOT NULL, deposit_minor INTEGER NOT NULL, idem_key TEXT UNIQUE,
//   created_at TEXT DEFAULT (datetime('now')); PG: same with BIGINT /
//   TIMESTAMPTZ DEFAULT now().
// PHASE-2 WIRING: replace BOTH inline commission blocks with this call —
//   server.js POST /api/admin/queue/:id (manual confirm): replace lines
//     228-231 with `await payReferralCommission(r.user_id, r.amount_minor, 'req:'+id)`
//     INSIDE the existing db.tx (it joins the tx).
//   providers.js creditAttemptOnce(): replace the prevAttempts/prevManual
//     count block (lines ~95-104) with
//     `await payReferralCommission(row.user_id, row.amount_minor, idem)`
//     inside its db.tx. Delete the now-dead count queries.
async function ensureReferralCommissionsTable() {
  const ddl = db.isPG
    ? "CREATE TABLE IF NOT EXISTS referral_commissions(user_id BIGINT PRIMARY KEY, referrer_id BIGINT NOT NULL, deposit_minor BIGINT NOT NULL, idem_key TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    : "CREATE TABLE IF NOT EXISTS referral_commissions(user_id INTEGER PRIMARY KEY, referrer_id INTEGER NOT NULL, deposit_minor INTEGER NOT NULL, idem_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')))";
  try { await db.execSql(ddl); } catch (e) { /* concurrent create / already exists */ }
}
async function payReferralCommission(userId, depositAmountMinor, idemKey) {
  if (!Number.isInteger(depositAmountMinor) || depositAmountMinor <= 0) throw new Error('bad_amount');
  await ensureReferralCommissionsTable();
  return db.tx(async () => {
    const dep = await db.one('SELECT referred_by FROM users WHERE id=?', userId);
    if (!dep || !dep.referred_by) return { paid: false, reason: 'no_referrer' };
    const pct = await db.getSetting('commission_pct', 5);
    if (!(pct > 0)) return { paid: false, reason: 'no_commission_pct' };
    const comm = Math.floor(depositAmountMinor * pct / 100);
    if (comm <= 0) return { paid: false, reason: 'zero_commission' };
    // Atomic claim: exactly one row per user_id can ever exist.
    await db.run(
      'INSERT INTO referral_commissions(user_id,referrer_id,deposit_minor,idem_key) VALUES(?,?,?,?) ON CONFLICT(user_id) DO NOTHING',
      userId, dep.referred_by, depositAmountMinor, String(idemKey || ''));
    const claim = await db.one('SELECT * FROM referral_commissions WHERE user_id=?', userId);
    if (!claim || String(claim.idem_key || '') !== String(idemKey || '')) {
      return { paid: false, reason: 'already_claimed' };
    }
    await post(dep.referred_by, 'main', comm, 'commission', String(idemKey || null),
      'commission:first:' + userId);
    return { paid: true, referrerId: dep.referred_by, amountMinor: comm };
  });
}
module.exports = { balance, post, debitStake, creditWinnings, assertWithinMaxPayout, payReferralCommission };
