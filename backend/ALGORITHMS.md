# BlazeBet — Backend & Algorithms Spec (v1, 2026-11-09)

## Architecture
- Zero-dependency Node.js 24 HTTP API (built-in `node:sqlite`, `node:crypto`). Same code swaps
  SQLite -> Postgres later by replacing src/db.js only (all SQL is standard, money in integer minor units).
- Money is ALWAYS integer pesewas (GHS x100). No floats ever touch the ledger.
- Wallet = double-entry ledger (`ledger_entries`), balance is derived, never stored as a mutable number.
  Every posting carries an idempotency key; a duplicate key is a no-op that returns the original result.
- Two buckets per user: `main` (withdrawable) and `bonus` (stake-only). Stakes spend bonus first;
  winnings from bonus-funded stakes return to main pro-rata is out of scope for v1 (winnings to main).
- Roles: player / admin / super_admin. First registered account becomes super_admin (bootstrap), rest players.

## Odds algorithm (sportsbook)
- Fair probability p -> decimal odds with margin: odds = 1 / (p * (1 + margin/2)) style book building:
  given fair probs for a market, target overround = 1 + margin (default 6%): scale probs by overround,
  odds_i = 1 / scaled_p_i. Book % is therefore exactly (1+margin) before rounding to 2dp.
- Potential payout = stake x product(leg odds). Max payout cap is a Platform setting.
- Live reprice (for cashout on pending legs): fair prob from the leg's stored implied prob, decayed by
  score/time is a feed concern; v1 cashout uses stored probs (see below).

## Cashout algorithm
- cashout_value = potential_payout x PROD(fair_prob_i for each PENDING leg) x (1 - cashout_margin)
  (won legs count at prob 1, lost legs make the ticket worth 0). Default cashout_margin 10%, floor GH₵0.10.
  No cashout while any pending leg is live (config flag).

## Provably-fair RNG (casino)
- Per round: serverSeed (32B random, stored hashed as sha256 BEFORE play, revealed after settlement),
  clientSeed = user id, nonce = round id. Floats derived from HMAC_SHA256(serverSeed, clientSeed:nonce:cursor)
  mapped to [0,1) in 4-byte chunks - same construction as the Oddaroa Aviator.
- Crash point (Sky Climb / Crash): r in [0,1); if r < 0.03 -> instant bust 1.00x (the 3% house edge);
  else point = floor(0.97/(1-r) * 100)/100, capped at 500x. Expected return ~= 97%.
- Instant games settle atomically in ONE db transaction: debit stake -> resolve engine -> credit payout.
  A round can settle exactly once (status guard + idempotency key per round).
- Game RTPs are set by paytables in src/games.js (each game exports its paytable + theoretical RTP note).

## Betting settlement
- Legs settle from admin/feed results (won/lost/void). Ticket settles when all legs terminal:
  all won -> credit potential; any lost -> stake forfeit; all void -> refund; mix won+void -> recompute on won legs.
- Settlement is idempotent: tickets carry status and settled_at; the settler skips terminal tickets.

## Payments
- Deposits/withdrawals are REQUESTS in v1 (MoMo/manual), confirmed by admin (super for withdrawals),
  mirroring the Oddaroa queue. Provider rails (ShinobiPay/Flutterwave webhooks) plug into
  wallet.post() with the provider reference as idempotency key - no other changes needed.
