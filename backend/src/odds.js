// Decimal-odds book building + payouts + cashout valuation. All pure functions.
function buildBook(fairProbs, margin = 0.06) {
  const over = 1 + margin;
  return fairProbs.map(p => Math.max(1.01, Math.floor((1 / (p * over)) * 100) / 100));
}
const impliedProb = (odds) => 1 / odds;
function potential(stakeMinor, oddsList) {
  return Math.floor(stakeMinor * oddsList.reduce((a, o) => a * o, 1));
}
function cashoutValue(potentialMinor, legs, margin = 0.10) {
  // legs: [{status:'pending'|'won'|'lost', fairProb}]
  if (legs.some(l => l.status === 'lost')) return 0;
  let p = 1;
  for (const l of legs) if (l.status === 'pending') p *= (l.fairProb ?? l.fair_prob);
  const v = Math.floor(potentialMinor * p * (1 - margin));
  return v >= 10 ? v : 0; // below GH₵0.10 -> not cashable
}
// L7-support — fair probabilities from book odds.
// The book odds ALREADY embed the margin (buildBook scales fair probs by
// 1+margin, so sum(1/odds) = 1+margin). The old placement code did
// fair_prob = 1/(odds*(1+margin)) — double-counting the margin and pricing
// cashouts ~6% low. Correct derivation: normalise the implied probabilities
// so they sum to 1:
//   fair_i = (1/odds_i) / sum_j(1/odds_j)
// `margin` is accepted for call-site compatibility and deliberately IGNORED:
// the normalisation already removes whatever margin the book carries; do not
// multiply or divide by (1+margin) again.
//   fairProbFromOdds(oddsArray[, margin]) -> number[] (same order, sum = 1)
// PHASE-2 WIRING: in server.js POST /api/bets, replace
//   fair_prob = 1/(odds*(1+margin))
// with the leg's entry from fairProbFromOdds(all leg odds of the ticket)
// (or per-market: fairProbFromOdds(the 3-way 1X2 book) for 1X2 legs — the
// normalisation must run over the odds of ONE market's complete outcome set,
// not over unrelated legs of a multi).
// STATS/GGR (server.js, Phase 2 — NOT this file): the admin stats query
// sums only won/lost bets; cashed_out tickets must be included —
// GGR = sum(stake_minor) - sum(payout_minor) over bets with status IN
// ('won','lost','cashed_out') (payout_minor is 0 for lost, = cashout value
// for cashed_out, = potential for won).
function fairProbFromOdds(oddsArray, margin) {
  void margin; // accepted, ignored by design — see note above
  if (!Array.isArray(oddsArray) || oddsArray.length === 0) throw new Error('bad_amount');
  const implied = oddsArray.map(o => {
    if (!(o > 1) || !Number.isFinite(o)) throw new Error('bad_amount');
    return 1 / o;
  });
  const total = implied.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error('bad_amount');
  return implied.map(p => p / total);
}
module.exports = { buildBook, impliedProb, potential, cashoutValue, fairProbFromOdds };
