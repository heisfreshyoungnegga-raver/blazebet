const crypto = require('node:crypto');
// Password hashing: scrypt with per-user salt, stored as salt:hash (hex)
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  // L2: a malformed stored hash (corrupt/legacy row) used to throw inside
  // timingSafeEqual when the decoded bytes were not 64 long -> login 500.
  // Length-check first and return false instead of throwing.
  let expected;
  try { expected = Buffer.from(hash, 'hex'); } catch { return false; }
  if (expected.length !== 64) return false;
  let calc;
  try { calc = crypto.scryptSync(String(pw), salt, 64); } catch { return false; }
  return crypto.timingSafeEqual(calc, expected);
}
const newToken = () => crypto.randomBytes(32).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// Provably-fair float stream: HMAC_SHA256(seed, client:nonce:cursor) -> floats in [0,1)
function floatStream(serverSeed, clientSeed, nonce) {
  let cursor = 0, buf = null, idx = 0;
  return function nextFloat() {
    if (!buf || idx >= buf.length) {
      buf = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${cursor++}`).digest();
      idx = 0;
    }
    const v = buf.readUInt32BE(idx) / 0x100000000; idx += 4;
    return v;
  };
}
function crashPoint(nextFloat) {
  const r = nextFloat();
  if (r < 0.03) return 1.0;                       // 3% instant bust = house edge
  return Math.min(500, Math.floor((0.97 / (1 - r)) * 100) / 100);
}
module.exports = { hashPassword, verifyPassword, newToken, sha256, floatStream, crashPoint };
