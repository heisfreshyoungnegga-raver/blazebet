# BlizBet Backend v1 (Phase 1 — built 2026-11-09)

Zero-dependency Node.js 24 API. Run: `npm start` (PORT env, default 4180). Test: `npm test`.
Data: SQLite at data/blizbet.db (BLIZBET_DB env to override). Money is integer pesewas everywhere.

## What's live in v1
- Auth: register/login (scrypt hashes, bearer sessions). First account = super_admin.
- Wallet: double-entry ledger, derived balances, main + bonus buckets (stakes spend bonus first),
  idempotency keys on every posting, deposit/withdrawal REQUESTS + admin confirm queue
  (withdrawals super-admin only, mirroring the Oddaroa accountability rules).
- Sportsbook: seeded fixtures with margin-built 1X2 books (ALGORITHMS.md), bet placement with
  stake/payout guards, booking codes, cashout (potential x pending-leg fair probs x (1-margin)),
  admin result settlement (idempotent, pays exactly once).
- Casino: 15 server-authoritative instant games (dice, sicbo, roulette, speedwheel, flip, evenodd,
  redblack, dragontiger, baccarat, andar, limbo, skyclimb auto-cash, penalty, keno, slots/fruit).
  Provably fair: seed hash shown before play, seed revealed after; settle-once, atomic with the wallet.
- Algorithms + formulas documented in ALGORITHMS.md.

## Phase 2 (next)
- Interactive session games server-side: Sky Climb live rounds, Mines, Towers, Hi-Lo, Red-Black streak,
  Balloon, Goal Ladder, Video Poker (engines need per-round state; client versions already exist).
- Live odds feed adapter (API-Football) replacing seeded fixtures + live reprice for cashout.
- Payment rails: ShinobiPay/Flutterwave webhooks -> wallet.post() with provider ref as idempotency key.
- Wire the static frontend pages to these endpoints; Postgres swap for production hosting.

## Phase 2 (added same day)
- Session games server-side (state fixed at start from the provably-fair seed; hidden layout never
  leaves the server until settlement): Mines (true combinatorial multipliers), Towers, Hi-Lo and
  Red-Black (per-step multipliers from real remaining-deck probabilities), Balloon Pop, Goal Ladder,
  Video Poker (full paytable evaluator), live Sky Climb (server-clock multiplier; polls can bust you).
  Endpoints: POST /api/casino/session/start, /session/:id/action, GET /session/:id.
- Hardening: login throttle (10 fails -> 15-min lock), change-password, super-admin settings API
  (margin/cashout/stake limits, range-validated), admin stats incl. GGR, admin match creation from
  fair probabilities, VOID results in settlement (payout recomputed without void legs; a fully-void
  ticket refunds the stake).
- Frontend SDK at GET /sdk.js (window.BlizBet): auth, wallet, bets, instant + session play.
- Tests: npm test runs Phase 1 + Phase 2 suites (both green, repeated runs stable).

## Phase 3 (admin power pack, same day)
Ported from the production PrimeStake/Oddaroa backend handler set (the best-proven of our backends):
- Users: list/search, detail (balances + ledger + bets), balance edit (super-only, reason required,
  cannot go negative, audit-logged), block/unblock (kills sessions, login refused 403), role change
  (super-only), delete (super-only, refused while the user holds balance or open bets).
- Admin invites: one-time, expiring token links that mint admin accounts on register.
- Referral commission: every user gets a ref code; register accepts ?ref=; deposit confirm pays the
  referrer commission_pct (default 5%, super-configurable) exactly once per deposit (idempotency key).
- Worksheet: per-admin per-day queue decisions + audit action counts (accountability, Oddaroa style).
- Bets admin: list/filter, super-only void with full stake refund.
- Matches: lock/unlock betting, feature flag.
- Support chat: two-way player <-> admin threads (Oddaroa push 91-93 pattern).
- Platform gates: maintenance mode (players 503, staff unaffected), registration open/closed switch.
- Audit log table records balance edits, blocks, role changes, invites, bet voids, match locks.

## Promo codes (registration)
- Register accepts promoCode (case-insensitive). No code is seeded by default; the super admin creates codes (bonus, cap, expiry) from the admin API.
  (bonus bucket), credited once per account at signup. Invalid/expired/capped codes reject
  the registration cleanly with invalid_promo_code - no half-created accounts.
- Admin: GET /api/admin/promos, POST /api/admin/promos (super-only: create/update with bonus,
  maxUses cap, expiry; active:false deactivates). Uses are counted and redemptions recorded.

## Neon / Postgres (2026-11-09)
- Neon project "blizbet" created (icy-fog-32024851, aws-us-west-2) with databases
  neondb (production) and blizbet_test. Full schema (15 tables) applied to BOTH via the
  Neon MCP route and verified with get_database_tables.
- Data layer v2 (src/db.js): one async API, two drivers - DATABASE_URL set = Postgres,
  unset = SQLite (local/tests). SQL stays in ? placeholders; the PG driver translates
  to $n, appends RETURNING id on inserts, and parses int8/numeric to Number.
  Transactions serialize on one connection (db.tx), matching the old semantics.
- All four suites pass on the async refactor (SQLite driver).
- BLOCKED from this sandbox: direct DB connections are denied by the user's Muse
  permission (Settings -> Permissions -> Direct network protocols -> Databases).
  The pg test battery (npm run test:pg) runs the same four suites against
  blizbet_test the moment that is set to Ask. Production hosting is unaffected -
  the server will connect from its host, not from this sandbox.
- .env.local (gitignored, mode 600) holds DATABASE_URL for local PG runs:
  start with:  set -a; . ./.env.local; PORT=4180 node src/server.js
