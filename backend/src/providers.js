// Deposit providers: ShinobiPay (GHS MoMo direct push) + Flutterwave
// (NGN hosted checkout). Ported from the xlotbet reference flows.
// Rules followed exactly:
//  - Without the provider keys, every surface answers
//    503 provider_not_configured and never calls the provider.
//  - Handlers NEVER credit the wallet; settlement happens only through
//    settleAttempt / settleFlwAttempt, driven by the webhook first.
//  - Settlement re-verifies with the provider and credits exactly once
//    (wallet ledger idempotency key) for exactly the attempt amount.
//  - Webhooks verify signature/hash against the raw body before
//    trusting anything; unverified events never credit.
const crypto = require('node:crypto');
const db = require('./db');
const { one, run, getSetting } = db;
const wallet = require('./wallet');

function shinobiConfig() {
  return {
    apiBase: (process.env.SHINOBIPAY_API_BASE || 'https://akwapayapi.onrender.com/v1').replace(/\/$/, ''),
    secretKey: process.env.SHINOBIPAY_SECRET_KEY || '',
    webhookSecret: process.env.SHINOBIPAY_WEBHOOK_SECRET || '',
  };
}
function flwConfig() {
  return {
    apiBase: 'https://api.flutterwave.com/v3',
    secretKey: process.env.FLUTTERWAVE_SECRET_KEY || '',
    webhookHash: process.env.FLUTTERWAVE_WEBHOOK_HASH || '',
  };
}
async function shinobiFetch(path, { method = 'GET', body, idempotencyKey } = {}) {
  const { apiBase, secretKey } = shinobiConfig();
  const headers = { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey);
  // M3: 8s timeout (a hung provider must not hang the deposit request
  // or the webhook settle path until the platform kills the function).
  const res = await fetch(apiBase + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function flwFetch(path, { method = 'GET', body } = {}) {
  const { apiBase, secretKey } = flwConfig();
  const res = await fetch(apiBase + path, {
    method,
    headers: { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000), // M3: see shinobiFetch
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
function mapIntentStatus(s) {
  switch (s) {
    case 'succeeded': return 'succeeded';
    case 'failed': return 'failed';
    case 'processing': return 'processing';
    case 'requires_action': return 'awaiting';
    case 'unknown': return 'unknown';
    default: return 'processing';
  }
}
function detectNetwork(localPhone) {
  const p = String(localPhone || '').slice(0, 3);
  if (['024', '025', '053', '054', '055', '059'].includes(p)) return 'MTN';
  if (['020', '050'].includes(p)) return 'TELECEL';
  if (['027', '057', '026', '056'].includes(p)) return 'AIRTELTIGO';
  return null;
}

// ShinobiPay webhook signature: HMAC-SHA256 over "<t>.<rawBody>",
// header "x-akwapay-signature: t=...,v1=...", 5-minute replay window.
function verifyShinobiSignature(rawBody, header, secret) {
  const parts = {};
  String(header || '').split(',').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(parts.t + '.' + rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// L5-support: constant-time Flutterwave webhook-hash compare for
// Phase 2 (server.js currently uses `!==` on the verif-hash header).
// Returns false on missing/empty inputs or length mismatch.
function verifyFlwHash(headerValue, secret) {
  if (!headerValue || !secret) return false;
  const a = Buffer.from(String(headerValue));
  const b = Buffer.from(String(secret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// M4-support: delete a webhook_events row by event id. Phase 2 calls
// this when a settle returns 'not_succeeded' (provider still processing)
// or 'unverified', so a redelivered webhook is NOT dropped as a
// duplicate and the provider retries instead of the deposit being acked
// 200 and lost forever. (settleAttempt/settleFlwAttempt already return
// 'not_succeeded' as a distinct outcome - it must be treated like
// 'unverified': delete the row + answer 500, never 200.)
async function deleteWebhookEvent(eventId) {
  if (!eventId) return;
  try { await run('DELETE FROM webhook_events WHERE event_id=?', String(eventId)); } catch {}
}

// M5: verify a Flutterwave transaction by its tx_ref (no webhook needed).
// Used by the Phase-2 status endpoint: the return-reconciler can settle
// a deposit even when the webhook never recorded the transaction id
// (intent_id is NULL until a webhook copies data.id into it).
// Returns { ok:true, id, txRef, amount, amountMinor, currency, status }
// where amount is in MAJOR units exactly as Flutterwave reports it
// (amountMinor = amount * 100, for comparison with amount_minor), or
// { ok:false, error, status } when the transaction is not successful.
// NOTE: this helper only verifies - it does not credit anything; the
// caller must still run settleFlwAttempt (after adopting the returned
// id into attempt.intent_id) to credit exactly once.
async function verifyFlwByRef(txRef) {
  const ref = String(txRef || '');
  if (!ref) return { ok: false, error: 'reference_required' };
  const got = await flwFetch('/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(ref));
  const d = (got.data && got.data.data) || {};
  if (got.status !== 200 || !d || d.status !== 'successful') {
    return { ok: false, error: 'not_successful', status: got.status, rawStatus: d.status || null };
  }
  const amount = Number(d.amount);
  return {
    ok: true,
    id: d.id != null ? String(d.id) : null,
    txRef: String(d.tx_ref || ref),
    amount,
    amountMinor: Math.round(amount * 100),
    currency: d.currency || null,
    status: d.status,
  };
}
// commission to the referrer (BlazeBet money rule) when this is the
// user's first completed deposit of any kind.
async function creditAttemptOnce(attempt, kind) {
  const idem = 'deposit:' + attempt.provider + ':' + attempt.reference;
  const already = await one('SELECT id FROM ledger_entries WHERE idem_key=?', idem);
  if (already) return 'already';
  return db.tx(async () => {
    const row = await one('SELECT * FROM payment_attempts WHERE id=? AND status<>?', attempt.id, 'succeeded');
    if (!row) return 'already';
    await run("UPDATE payment_attempts SET status='succeeded', settled_at=CURRENT_TIMESTAMP WHERE id=?", attempt.id);
    await wallet.post(row.user_id, 'main', row.amount_minor, 'deposit', attempt.provider + ':' + attempt.reference, idem);
    // First-deposit commission, one shared helper for both rails (H2):
    // atomic first-deposit claim, pays commission_pct exactly once.
    await wallet.payReferralCommission(row.user_id, row.amount_minor, idem);
    return 'credited';
  });
}

async function settleAttempt(attempt) {
  if (attempt.status === 'succeeded') return 'already';
  if (!attempt.intent_id) return 'not_succeeded';
  const got = await shinobiFetch('/payment_intents/' + encodeURIComponent(attempt.intent_id));
  const intent = got.data || {};
  if (got.status !== 200 || intent.status !== 'succeeded') return 'not_succeeded';
  const verified = Number(intent.merchant_amount) === Number(attempt.amount_minor)
    && (!intent.reference || intent.reference === attempt.reference);
  if (!verified) {
    try { await run('UPDATE payment_attempts SET fail_reason=? WHERE id=? AND status<>?', 'verify_mismatch merchant_amount=' + intent.merchant_amount + ' amount_minor=' + attempt.amount_minor, attempt.id, 'succeeded'); } catch {}
    return 'unverified';
  }
  return creditAttemptOnce(attempt, 'deposit');
}

async function settleFlwAttempt(attempt) {
  if (attempt.status === 'succeeded') return 'already';
  if (!attempt.intent_id) return 'not_succeeded';
  const got = await flwFetch('/transactions/' + encodeURIComponent(attempt.intent_id) + '/verify');
  const d = (got.data && got.data.data) || {};
  if (got.status !== 200 || d.status !== 'successful') return 'not_succeeded';
  // F-B1: Flutterwave charges NGN, not GH₵. The amount actually charged
  // (NGN, minor) is stored per attempt in charged_minor; the GH₵ credit
  // is amount_minor. Verify the NGN leg, credit the GH₵ leg — never the
  // other way round. Attempts created before charged_minor existed
  // (charged_minor 0/NULL) cannot verify and stay 'unverified'.
  const chargedNgnMinor = Number(attempt.charged_minor || 0);
  const verified = chargedNgnMinor > 0
    && Number(d.amount) === chargedNgnMinor / 100
    && d.currency === (attempt.currency || 'NGN')
    && String(d.tx_ref || '') === String(attempt.reference);
  if (!verified) {
    try { await run('UPDATE payment_attempts SET fail_reason=? WHERE id=? AND status<>?', 'verify_mismatch amount=' + d.amount + ' charged_ngn_minor=' + chargedNgnMinor + ' currency=' + (d.currency || '') + ' tx_ref=' + (d.tx_ref || ''), attempt.id, 'succeeded'); } catch {}
    return 'unverified';
  }
  return creditAttemptOnce(attempt, 'deposit');
}

module.exports = {
  shinobiConfig, flwConfig, shinobiFetch, flwFetch, mapIntentStatus,
  detectNetwork, verifyShinobiSignature, verifyFlwHash, deleteWebhookEvent,
  verifyFlwByRef, settleAttempt, settleFlwAttempt,
};
