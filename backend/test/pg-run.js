// Runs the four suites against the Neon test database (blizbet_test).
// Usage: node test/pg-run.js [suiteFile ...]  (default: all four)
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const envLocal = fs.readFileSync(__dirname + '/../.env.local', 'utf8');
const url = envLocal.match(/DATABASE_URL=(\S+)/)[1].replace(/\/[^/?]+(\?|$)/, '/blizbet_test$1');
const TABLES = ['promo_redemptions','promo_codes','admin_actions','support_messages','admin_invites','game_sessions','casino_rounds','bet_legs','bets','matches','payment_requests','ledger_entries','sessions','settings','users'];
async function reset() {
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS ' + TABLES.join(',') + ' CASCADE');
  await c.end();
}
(async () => {
  const suites = process.argv.slice(2).length ? process.argv.slice(2) : ['run.js','run2.js','run3.js','run4.js'];
  for (const s of suites) {
    await reset();
    console.log('--- ' + s + ' (postgres) ---');
    execFileSync('node', [__dirname + '/' + s], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
  }
  console.log('ALL PG SUITES DONE');
  process.exit(0);
})().catch(e => { console.error('PG RUN FAIL:', e.message); process.exit(1); });
