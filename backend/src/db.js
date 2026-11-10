// BlazeBet data layer v2 - one async API, two drivers:
//   DATABASE_URL set  -> Postgres (Neon in production)
//   otherwise         -> SQLite file (local dev + test suites)
// All SQL in the codebase uses ? placeholders; the PG driver translates to $n.
// Transactions: db.tx(fn) pins the whole transaction to ONE dedicated
// pooled client on Postgres (pool.connect + BEGIN/COMMIT on that client,
// released in finally) so a mid-transaction failure rolls everything
// back; SQLite keeps its single-connection BEGIN/COMMIT. AsyncLocalStorage
// tracks the open transaction so nested calls join it.
const { AsyncLocalStorage } = require('node:async_hooks');
const als = new AsyncLocalStorage();

// H3: fail fast when running under Vercel without a database URL instead
// of silently falling back to the bundled SQLite file (read-only FS on
// Vercel -> opaque boot failure; writable FS -> split-brain data).
if (process.env.VERCEL && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL not configured (VERCEL is set but DATABASE_URL is empty)');
}
const PG = !!process.env.DATABASE_URL;
let raw; // async (sql, params) -> { rows, id }
let rawOnClient = null; // PG only: async (client, sql, params) -> { rows, id }
let pool = null; // PG only: the pg.Pool (module scope so tx() can connect())
let chain = Promise.resolve();
function withLock(fn) { const p = chain.then(fn, fn); chain = p.then(() => {}, () => {}); return p; }

const ID_TABLES = new Set(['users','payment_requests','matches','bets','bet_legs','casino_rounds','game_sessions','support_messages','admin_actions','payment_attempts']);
function pgSql(sql) { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); }

function pgPrepare(sql) {
  let s = pgSql(sql); let wantId = false;
  const m = s.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
  if (m && ID_TABLES.has(m[1].toLowerCase()) && !/RETURNING/i.test(s)) { s += ' RETURNING id'; wantId = true; }
  return { s, wantId };
}

if (PG) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, v => Number(v));   // int8 (COUNT/SUM) -> Number
  types.setTypeParser(1700, v => Number(v)); // numeric -> Number
  // Pool, not a single Client: serverless instances freeze between
  // invocations and Neon suspends idle computes, which kills a lone TCP
  // connection (half-open socket -> queries hang forever). The pool
  // re-establishes dead connections and fails fast on timeouts instead.
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2, // serverless-friendly: each instance holds at most 2
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 8000, // M9: no statement may run longer than 8s
  });
  pool.on('error', (e) => console.error('pg pool error (reconnects on next query):', e.message));
  // Run one statement on a given client (pool or a checked-out tx client).
  async function pgRawOn(client, sql, params = []) {
    const { s, wantId } = pgPrepare(sql);
    const r = await client.query(s, params);
    return { rows: r.rows, id: wantId && r.rows[0] ? r.rows[0].id : undefined };
  }
  raw = async (sql, params = []) => pgRawOn(pool, sql, params);
  // Exposed for tx(): run a statement on the transaction's dedicated client.
  rawOnClient = async (client, sql, params = []) => pgRawOn(client, sql, params);
} else {
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path'); const fs = require('node:fs');
  const file = process.env.BLAZEBET_DB || path.join(__dirname, '..', 'data', 'blazebet.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sq = new DatabaseSync(file);
  sq.exec('PRAGMA journal_mode = WAL');
  raw = async (sql, params = []) => {
    const verb = sql.trimStart().slice(0, 6).toUpperCase();
    if (/^(BEGIN|COMMIT|ROLLBACK|PRAGMA|CREATE|ALTER|DROP)/.test(sql.trimStart().toUpperCase()) && !params.length) { sq.exec(sql); return { rows: [] }; }
    const st = sq.prepare(sql);
    if (verb === 'SELECT' || verb === 'WITH') return { rows: st.all(...params) };
    const info = st.run(...params);
    return { rows: [], id: Number(info.lastInsertRowid) };
  };
}

async function execRaw(sql, params) {
  const store = als.getStore();
  // Inside a PG transaction, statements must run on the transaction's
  // dedicated client (H1) - pool.query would check out another client.
  if (store && store.client) return rawOnClient(store.client, sql, params);
  return store ? raw(sql, params) : withLock(() => raw(sql, params));
}
async function one(sql, ...params) { const r = await execRaw(sql, params); return r.rows[0]; }
async function all(sql, ...params) { const r = await execRaw(sql, params); return r.rows; }
async function run(sql, ...params) { const r = await execRaw(sql, params); return { id: r.id }; }
async function execSql(sql) { await execRaw(sql, []); }
async function tx(fn) {
  if (als.getStore()) return fn(); // join the open transaction
  if (PG) {
    // H1: check out ONE dedicated client and run BEGIN/statements/
    // COMMIT on it, so a failure rolls the whole transaction back.
    // (pool.query per statement could land on different clients and
    // silently autocommit partial money writes.)
    return withLock(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await als.run({ tx: true, client }, fn);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        throw e;
      } finally { client.release(); }
    });
  }
  return withLock(async () => {
    await raw('BEGIN');
    try { const out = await als.run({ tx: true }, fn); await raw('COMMIT'); return out; }
    catch (e) { try { await raw('ROLLBACK'); } catch {} throw e; }
  });
}
const NOW = PG ? 'now()' : "datetime('now')";

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE NOT NULL, name TEXT DEFAULT '', pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player', status TEXT NOT NULL DEFAULT 'active', ref_code TEXT, referred_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS ledger_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, bucket TEXT NOT NULL, delta_minor INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, idem_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS payment_requests(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, amount_minor INTEGER NOT NULL, method TEXT DEFAULT 'momo', status TEXT NOT NULL DEFAULT 'pending', decided_by INTEGER, bank TEXT, account_number TEXT, account_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS matches(id INTEGER PRIMARY KEY AUTOINCREMENT, league TEXT, home TEXT, away TEXT, starts_at TEXT, status TEXT NOT NULL DEFAULT 'upcoming', home_score INTEGER, away_score INTEGER, betting_locked INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0, espn_event_id TEXT UNIQUE, home_logo TEXT, away_logo TEXT);
CREATE TABLE IF NOT EXISTS bets(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, stake_minor INTEGER NOT NULL, potential_minor INTEGER NOT NULL, payout_minor INTEGER, status TEXT NOT NULL DEFAULT 'open', code TEXT, settled_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS bet_legs(id INTEGER PRIMARY KEY AUTOINCREMENT, bet_id INTEGER NOT NULL, match_id INTEGER NOT NULL, market TEXT, pick TEXT, odds REAL NOT NULL, fair_prob REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS casino_rounds(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, game TEXT NOT NULL, stake_minor INTEGER NOT NULL, choice TEXT, result TEXT, multiplier REAL, payout_minor INTEGER NOT NULL DEFAULT 0, seed_hash TEXT, seed_reveal TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS game_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, game TEXT NOT NULL, stake_minor INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', multiplier REAL NOT NULL DEFAULT 1, payout_minor INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, seed_hash TEXT, seed_reveal TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_invites(token TEXT PRIMARY KEY, created_by INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'admin', expires_at TEXT NOT NULL, used_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS support_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS admin_actions(id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS promo_codes(code TEXT PRIMARY KEY, bonus_minor INTEGER NOT NULL, max_uses INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS promo_redemptions(code TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(code, user_id));
CREATE TABLE IF NOT EXISTS payment_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, provider TEXT NOT NULL DEFAULT 'shinobipay', reference TEXT UNIQUE NOT NULL, intent_id TEXT, amount_minor INTEGER NOT NULL, phone TEXT, network TEXT, currency TEXT NOT NULL DEFAULT 'GHS', status TEXT NOT NULL DEFAULT 'created', fail_reason TEXT, last_sequence INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), settled_at TEXT);
CREATE TABLE IF NOT EXISTS webhook_events(event_id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS login_attempts(phone TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '', fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(phone, ip));
CREATE TABLE IF NOT EXISTS referral_commissions(user_id INTEGER PRIMARY KEY, referrer_id INTEGER NOT NULL, deposit_minor INTEGER NOT NULL, idem_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));`;
const PG_DDL = `
CREATE TABLE IF NOT EXISTS users(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT DEFAULT '', pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player', status TEXT NOT NULL DEFAULT 'active', ref_code TEXT, referred_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ledger_entries(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, bucket TEXT NOT NULL, delta_minor BIGINT NOT NULL, kind TEXT NOT NULL, ref TEXT, idem_key TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS payment_requests(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, type TEXT NOT NULL, amount_minor BIGINT NOT NULL, method TEXT DEFAULT 'momo', status TEXT NOT NULL DEFAULT 'pending', decided_by BIGINT, bank TEXT, account_number TEXT, account_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS matches(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, league TEXT, home TEXT, away TEXT, starts_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'upcoming', home_score INTEGER, away_score INTEGER, betting_locked INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0, espn_event_id TEXT UNIQUE, home_logo TEXT, away_logo TEXT);
CREATE TABLE IF NOT EXISTS bets(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, stake_minor BIGINT NOT NULL, potential_minor BIGINT NOT NULL, payout_minor BIGINT, status TEXT NOT NULL DEFAULT 'open', code TEXT, settled_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS bet_legs(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, bet_id BIGINT NOT NULL, match_id BIGINT NOT NULL, market TEXT, pick TEXT, odds DOUBLE PRECISION NOT NULL, fair_prob DOUBLE PRECISION NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS casino_rounds(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, game TEXT NOT NULL, stake_minor BIGINT NOT NULL, choice TEXT, result TEXT, multiplier DOUBLE PRECISION, payout_minor BIGINT NOT NULL DEFAULT 0, seed_hash TEXT, seed_reveal TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS game_sessions(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, game TEXT NOT NULL, stake_minor BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'active', multiplier DOUBLE PRECISION NOT NULL DEFAULT 1, payout_minor BIGINT NOT NULL DEFAULT 0, state TEXT NOT NULL, seed_hash TEXT, seed_reveal TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_invites(token TEXT PRIMARY KEY, created_by BIGINT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', expires_at TIMESTAMPTZ NOT NULL, used_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS support_messages(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS admin_actions(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, admin_id BIGINT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS promo_codes(code TEXT PRIMARY KEY, bonus_minor BIGINT NOT NULL, max_uses INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS promo_redemptions(code TEXT NOT NULL, user_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(code, user_id));
CREATE TABLE IF NOT EXISTS payment_attempts(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, provider TEXT NOT NULL DEFAULT 'shinobipay', reference TEXT UNIQUE NOT NULL, intent_id TEXT, amount_minor BIGINT NOT NULL, phone TEXT, network TEXT, currency TEXT NOT NULL DEFAULT 'GHS', status TEXT NOT NULL DEFAULT 'created', fail_reason TEXT, last_sequence INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), settled_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS webhook_events(event_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS login_attempts(phone TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '', fails INTEGER NOT NULL DEFAULT 0, locked_until BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(phone, ip));
CREATE TABLE IF NOT EXISTS referral_commissions(user_id BIGINT PRIMARY KEY, referrer_id BIGINT NOT NULL, deposit_minor BIGINT NOT NULL, idem_key TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());`;

let initDone;
function init() {
  if (!initDone) {
    initDone = (async () => {
      // H2: each DDL statement is failure-isolated (a transient Neon wake
      // failure or a concurrent-cold-start pg_class race on one table must
      // not poison the rest of boot) - same guarded style as the migrations.
      const ddl = PG ? PG_DDL : SQLITE_DDL;
      for (const stmt of ddl.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
        try { await execSql(stmt); } catch (e) { console.error('ddl skipped:', stmt.slice(0, 60), '-', e.message); }
      }
      // Migrations for databases created before these columns existed.
      // SQLite forbids UNIQUE in ADD COLUMN, so the uniqueness lives in
      // the partial unique index below (PG: IF NOT EXISTS covers it).
      const migrations = PG ? [
        'ALTER TABLE matches ADD COLUMN IF NOT EXISTS espn_event_id TEXT',
        'ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_logo TEXT',
        'ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_logo TEXT',
        'ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS bank TEXT',
        'ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS account_number TEXT',
        'ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS account_name TEXT',
        'ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS ip TEXT',
        'ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS fails INTEGER',
        'ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS locked_until BIGINT',
        // Phase 2: bet stake split (pro-rata bonus/main credits at settle/
        // cashout), bet idempotency key, FLW charged-NGN amount (F-B1).
        'ALTER TABLE bets ADD COLUMN IF NOT EXISTS stake_bonus_minor BIGINT NOT NULL DEFAULT 0',
        'ALTER TABLE bets ADD COLUMN IF NOT EXISTS stake_main_minor BIGINT NOT NULL DEFAULT 0',
        'ALTER TABLE bets ADD COLUMN IF NOT EXISTS idem_key TEXT',
        'ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS charged_minor BIGINT',
      ] : [
        'ALTER TABLE matches ADD COLUMN espn_event_id TEXT',
        'ALTER TABLE matches ADD COLUMN home_logo TEXT',
        'ALTER TABLE matches ADD COLUMN away_logo TEXT',
        'ALTER TABLE payment_requests ADD COLUMN bank TEXT',
        'ALTER TABLE payment_requests ADD COLUMN account_number TEXT',
        'ALTER TABLE payment_requests ADD COLUMN account_name TEXT',
        'ALTER TABLE bets ADD COLUMN stake_bonus_minor INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE bets ADD COLUMN stake_main_minor INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE bets ADD COLUMN idem_key TEXT',
        'ALTER TABLE payment_attempts ADD COLUMN charged_minor INTEGER',
      ];
      for (const sql of migrations) { try { await execSql(sql); } catch {} }
      try { await execSql('CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_espn ON matches(espn_event_id) WHERE espn_event_id IS NOT NULL'); } catch {}
      // H5: indexes on the ledger/bets hot paths (balance() is a
      // SUM over ledger_entries per money request; without these every
      // check is a sequential scan of a table that only grows).
      const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_ledger_user_bucket ON ledger_entries(user_id, bucket)',
        'CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_bet_legs_bet ON bet_legs(bet_id)',
        'CREATE INDEX IF NOT EXISTS idx_bet_legs_match ON bet_legs(match_id)',
        'CREATE INDEX IF NOT EXISTS idx_attempts_phone ON payment_attempts(phone)',
        // Phase 2: booking codes are unique (M4) and bet placement is
        // idempotent per (user, idem_key) — both enforced by UNIQUE indexes.
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_code ON bets(code) WHERE code IS NOT NULL',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_idem ON bets(user_id, idem_key) WHERE idem_key IS NOT NULL',
      ];
      for (const sql of indexes) { try { await execSql(sql); } catch (e) { console.error('index skipped:', sql, '-', e.message); } }
      // No default promo code seeded - codes are created by the super admin only.
    })();
    // H2: never cache a rejected init promise - a failed boot must not
    // poison the warm instance forever; the next request retries init.
    initDone.catch(() => { initDone = null; });
  }
  return initDone;
}
async function getSetting(key, dflt) { const r = await one('SELECT value FROM settings WHERE key=?', key); return r ? JSON.parse(r.value) : dflt; }
async function setSetting(key, value) { await run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value)); }
// M9-support: fetch a whole settings prefix in ONE query (Phase 2 uses
// this to kill the /api/matches N+1: getSettingsByPrefix('match_odds:')).
// Returns a map key -> parsed JSON value (falls back to the raw string
// when a value is not JSON). LIKE wildcards in the prefix are escaped.
async function getSettingsByPrefix(prefix) {
  const esc = String(prefix).replace(/([\\%_])/g, '\\$1');
  const rows = await all("SELECT key, value FROM settings WHERE key LIKE ? ESCAPE '\\'", esc + '%');
  const out = {};
  for (const r of rows) { try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; } }
  return out;
}

// M2: persistent login throttle (replaces the per-instance in-memory Map
// in server.js, which resets on every Vercel cold start). Keyed by
// phone + IP so an attacker cannot lock a victim's account globally.
// Rule mirrors the old behaviour: 10 fails -> 15-min lock, fails reset.
const LOGIN_MAX_FAILS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
async function recordLoginFail(phone, ip) {
  const p = String(phone || ''), a = String(ip || '');
  return tx(async () => {
    const row = await one('SELECT fails, locked_until FROM login_attempts WHERE phone=? AND ip=?', p, a);
    const fails = (row ? Number(row.fails) : 0) + 1;
    if (fails >= LOGIN_MAX_FAILS) {
      const lockedUntil = Date.now() + LOGIN_LOCK_MS;
      if (row) await run('UPDATE login_attempts SET fails=0, locked_until=? WHERE phone=? AND ip=?', lockedUntil, p, a);
      else await run('INSERT INTO login_attempts(phone, ip, fails, locked_until) VALUES(?,?,0,?)', p, a, lockedUntil);
      return { locked: true, fails: 0, lockedUntil };
    }
    if (row) await run('UPDATE login_attempts SET fails=? WHERE phone=? AND ip=?', fails, p, a);
    else await run('INSERT INTO login_attempts(phone, ip, fails, locked_until) VALUES(?,?,?,0)', p, a, fails);
    return { locked: false, fails, lockedUntil: 0 };
  });
}
async function isLoginLocked(phone, ip) {
  const r = await one('SELECT locked_until FROM login_attempts WHERE phone=? AND ip=?', String(phone || ''), String(ip || ''));
  return !!(r && Number(r.locked_until) > Date.now());
}
async function clearLoginFails(phone, ip) {
  await run('DELETE FROM login_attempts WHERE phone=? AND ip=?', String(phone || ''), String(ip || ''));
}
module.exports = { one, all, run, execSql, tx, init, getSetting, setSetting, getSettingsByPrefix, recordLoginFail, isLoginLocked, clearLoginFails, LOGIN_MAX_FAILS, LOGIN_LOCK_MS, NOW, isPG: PG };
