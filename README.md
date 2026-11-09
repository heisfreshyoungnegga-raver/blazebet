# BlazeBet

Casino-first betting platform (Ghana). Live preview: https://blazebet.vercel.app

## Structure
- `backend/` — Node 24 server (no framework): auth, double-entry wallet ledger
  (main + stake-only bonus buckets, pesewa-integer money), sportsbook odds/cashout,
  23 provably-fair casino engines, admin + super-admin power pack, promo codes
  (launch code: WELCOME = GH₵10 stake-only bonus). Runs on SQLite locally, or
  Postgres (Neon) when `DATABASE_URL` is set. `railway.json` included — on Railway,
  set the service root directory to `backend`.
  - Run: `cd backend && npm install && npm start` (port 4180) · Tests: `npm test`
- `site/` — the static front-end (casino is the homepage; sportsbook home kept at
  `site/gh/home/`). Casino upgrades live in `site/casino-plus.js` + `.css`.

## Note on site images
This repo holds the site's code and text files. The 165 image/binary files are
listed in `site/IMAGES-NOT-IN-REPO.txt` and are not stored here (push-route
limits); the complete site bundle is the `blazebet-site.zip` package, and the
images are served from the Vercel deployment.
