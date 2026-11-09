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
module.exports = { balance, post, debitStake };
