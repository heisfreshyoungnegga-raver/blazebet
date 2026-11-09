// BlizBet data layer v2 - one async API, two drivers:
//   DATABASE_URL set  -> Postgres (Neon in production)
//   otherwise         -> SQLite file (local dev + test suites)
// All SQL in the codebase uses ? placeholders; the PG driver translates to $n.
// Transactions: db.tx(fn) serializes on a single connection (AsyncLocalStorage
// tracks the open transaction so nested calls join it) - same semantics the
// SQLite single-connection design always had.
const { AsyncLocalStorage } = require('node:async_hooks');
const als = new AsyncLocalStorage();
const PG = !!process.env.DATABASE_URL;
let raw; // async (sql, params) -> { rows, id }
let chain = Promise.resolve();
function withLock(fn) { const p = chain.then(fn, fn); chain = p.then(() => {}, () => {}); return p; }

const ID_TABLES = new Set(['users','payment_requests','matches','bets','bet_legs','casino_rounds','game_sessions','support_messages','admin_actions']);
function pgSql(sql) { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); }

if (PG) {
  const { Client, types } = require('pg');
  types.setTypeParser(20, v => Number(v));   // int8 (COUNT/SUM) -> Number
  types.setTypeParser(1700, v => Number(v)); // numeric -> Number
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const ready = client.connect();
  raw = async (sql, params = []) => {
    await ready;
    let s = pgSql(sql); let wantId = false;
    const m = s.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
    if (m && ID_TABLES.has(m[1].toLowerCase()) && !/RETURNING/i.test(s)) { s += ' RETURNING id'; wantId = true; }
    const r = await client.query(s, params);
    return { rows: r.rows, id: wantId && r.rows[0] ? r.rows[0].id : undefined };
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path'); const fs = require('node:fs');
  const file = process.env.BLIZBET_DB || path.join(__dirname, '..', 'data', 'blizbet.db');
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

async function execRaw(sql, params) { return als.getStore() ? raw(sql, params) : withLock(() => raw(sql, params)); }
async function one(sql, ...params) { const r = await execRaw(sql, params); return r.rows[0]; }
async function all(sql, ...params) { const r = await execRaw(sql, params); return r.rows; }
async function run(sql, ...params) { const r = await execRaw(sql, params); return { id: r.id }; }
async function execSql(sql) { await execRaw(sql, []); }
async function tx(fn) {
  if (als.getStore()) return fn(); // join the open transaction
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
CREATE TABLE IF NOT EXISTS payment_requests(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, amount_minor INTEGER NOT NULL, method TEXT DEFAULT 'momo', status TEXT NOT NULL DEFAULT 'pending', decided_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS matches(id INTEGER PRIMARY KEY AUTOINCREMENT, league TEXT, home TEXT, away TEXT, starts_at TEXT, status TEXT NOT NULL DEFAULT 'upcoming', home_score INTEGER, away_score INTEGER, betting_locked INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS bets(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, stake_minor INTEGER NOT NULL, potential_minor INTEGER NOT NULL, payout_minor INTEGER, status TEXT NOT NULL DEFAULT 'open', code TEXT, settled_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS bet_legs(id INTEGER PRIMARY KEY AUTOINCREMENT, bet_id INTEGER NOT NULL, match_id INTEGER NOT NULL, market TEXT, pick TEXT, odds REAL NOT NULL, fair_prob REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS casino_rounds(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, game TEXT NOT NULL, stake_minor INTEGER NOT NULL, choice TEXT, result TEXT, multiplier REAL, payout_minor INTEGER NOT NULL DEFAULT 0, seed_hash TEXT, seed_reveal TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS game_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, game TEXT NOT NULL, stake_minor INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', multiplier REAL NOT NULL DEFAULT 1, payout_minor INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, seed_hash TEXT, seed_reveal TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_invites(token TEXT PRIMARY KEY, created_by INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'admin', expires_at TEXT NOT NULL, used_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS support_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS admin_actions(id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS promo_codes(code TEXT PRIMARY KEY, bonus_minor INTEGER NOT NULL, max_uses INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS promo_redemptions(code TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(code, user_id));`;
const PG_DDL = `
CREATE TABLE IF NOT EXISTS users(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT DEFAULT '', pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player', status TEXT NOT NULL DEFAULT 'active', ref_code TEXT, referred_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ledger_entries(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, bucket TEXT NOT NULL, delta_minor BIGINT NOT NULL, kind TEXT NOT NULL, ref TEXT, idem_key TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS payment_requests(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, type TEXT NOT NULL, amount_minor BIGINT NOT NULL, method TEXT DEFAULT 'momo', status TEXT NOT NULL DEFAULT 'pending', decided_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS matches(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, league TEXT, home TEXT, away TEXT, starts_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'upcoming', home_score INTEGER, away_score INTEGER, betting_locked INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS bets(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, stake_minor BIGINT NOT NULL, potential_minor BIGINT NOT NULL, payout_minor BIGINT, status TEXT NOT NULL DEFAULT 'open', code TEXT, settled_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS bet_legs(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, bet_id BIGINT NOT NULL, match_id BIGINT NOT NULL, market TEXT, pick TEXT, odds DOUBLE PRECISION NOT NULL, fair_prob DOUBLE PRECISION NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS casino_rounds(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, game TEXT NOT NULL, stake_minor BIGINT NOT NULL, choice TEXT, result TEXT, multiplier DOUBLE PRECISION, payout_minor BIGINT NOT NULL DEFAULT 0, seed_hash TEXT, seed_reveal TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS game_sessions(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, game TEXT NOT NULL, stake_minor BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'active', multiplier DOUBLE PRECISION NOT NULL DEFAULT 1, payout_minor BIGINT NOT NULL DEFAULT 0, state TEXT NOT NULL, seed_hash TEXT, seed_reveal TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_invites(token TEXT PRIMARY KEY, created_by BIGINT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', expires_at TIMESTAMPTZ NOT NULL, used_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS support_messages(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS admin_actions(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, admin_id BIGINT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS promo_codes(code TEXT PRIMARY KEY, bonus_minor BIGINT NOT NULL, max_uses INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS promo_redemptions(code TEXT NOT NULL, user_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(code, user_id));`;

let initDone;
function init() {
  if (!initDone) initDone = (async () => {
    await execSql(PG ? PG_DDL : SQLITE_DDL);
    // No default promo code seeded - codes are created by the super admin only.
  })();
  return initDone;
}
async function getSetting(key, dflt) { const r = await one('SELECT value FROM settings WHERE key=?', key); return r ? JSON.parse(r.value) : dflt; }
async function setSetting(key, value) { await run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value)); }
module.exports = { one, all, run, execSql, tx, init, getSetting, setSetting, NOW, isPG: PG };
