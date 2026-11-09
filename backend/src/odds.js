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
module.exports = { buildBook, impliedProb, potential, cashoutValue };
