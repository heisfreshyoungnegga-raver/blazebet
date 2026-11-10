// Full market book derived from a 1X2 decimal-odds book.
// Ported from the Oddaroa/xlotbet expandOdds + fullBookFromOdds maths
// (Poisson goal model, mu = 2.7 total goals, 45/55 half split).
// Pure functions, zero dependencies.
//
// Market ids (used in bet legs and in GET /api/matches/:id):
//   1X2   picks '1' | 'X' | '2'
//   DC    picks '1X' | '12' | 'X2'
//   OU05/OU15/OU25/OU35/OU45  picks 'Over' | 'Under'
//   BTTS  picks 'Yes' | 'No'
//   HT1X2 picks '1' | 'X' | '2'  (first half)
//   CS    picks 'h:a' e.g. '2:1'  (full-time correct score, 0..5 each side)
//   DNB   picks '1' | '2'  (draw no bet — void on a draw)
//   WTN   picks 'Home' | 'Away'  (win to nil)

function poissonCdf(k, mu) {
  let term = Math.exp(-mu), sum = term;
  for (let i = 1; i <= k; i++) { term *= mu / i; sum += term; }
  return sum;
}
function pmf(lambda, maxG = 12) {
  const arr = [Math.exp(-lambda)];
  for (let k = 1; k <= maxG; k++) arr.push(arr[k - 1] * lambda / k);
  return arr;
}

// Flat expanded odds, keyed like xlotbet's expandOdds (o1/ox/o2, dc*,
// over/under**, gg/ng). Returns {} when the 1X2 line is incomplete.
function expandOdds(o1, ox, o2) {
  const odds = {};
  if (!(o1 > 1 && ox > 1 && o2 > 1)) return odds;
  odds.o1 = o1; odds.ox = ox; odds.o2 = o2;
  odds.dc1x = Math.round((o1 * ox) / (o1 + ox) * 100) / 100;
  odds.dc12 = Math.round((o1 * o2) / (o1 + o2) * 100) / 100;
  odds.dcx2 = Math.round((ox * o2) / (ox + o2) * 100) / 100;
  const raw = [1 / o1, 1 / ox, 1 / o2];
  const margin = raw[0] + raw[1] + raw[2];
  const pH = raw[0] / margin, pA = raw[2] / margin;
  const mu = 2.7;
  const muH = mu * (pH / (pH + pA || 1)) || mu / 2;
  const muA = Math.max(mu - muH, 0.15);
  const pHomeScores = 1 - Math.exp(-muH), pAwayScores = 1 - Math.exp(-muA);
  const fair = (p) => (p > 0.02 && p < 0.98) ? Math.round((1 / p) / (margin > 1 ? 1.05 : 1) * 100) / 100 : null;
  [0.5, 1.5, 2.5, 3.5, 4.5].forEach(line => {
    const suffix = String(line).replace('.', '');
    const pOver = 1 - poissonCdf(Math.floor(line), mu);
    const o = fair(pOver), u = fair(1 - pOver);
    if (o && o > 1.01) odds['over' + suffix] = o;
    if (u && u > 1.01) odds['under' + suffix] = u;
  });
  const gg = fair(pHomeScores * pAwayScores);
  const ng = fair(1 - pHomeScores * pAwayScores);
  if (gg && gg > 1.01) odds.gg = gg;
  if (ng && ng > 1.01) odds.ng = ng;
  Object.keys(odds).forEach(k => { if (!(odds[k] > 1)) delete odds[k]; });
  return odds;
}

// Grouped market book for the match page / betslip.
// book1x2: [home, draw, away] decimal odds (the stored match_odds array).
function marketsFromBook(book1x2) {
  if (!Array.isArray(book1x2) || book1x2.length !== 3) return {};
  const [o1, ox, o2] = book1x2;
  if (!(o1 > 1 && ox > 1 && o2 > 1)) return {};
  const flat = expandOdds(o1, ox, o2);
  const raw = [1 / o1, 1 / ox, 1 / o2];
  const margin = raw[0] + raw[1] + raw[2];
  const pH = raw[0] / margin, pA = raw[2] / margin;
  const mu = 2.7;
  const muH = mu * (pH / (pH + pA || 1)) || mu / 2;
  const muA = Math.max(mu - muH, 0.15);
  const PH = pmf(muH), PA = pmf(muA);
  const H1 = pmf(muH * 0.45), A1 = pmf(muA * 0.45);
  const price = (p) => {
    if (!(p >= 0.002)) return null;
    const v = Math.round(((1 / p) / (margin > 1 ? 1.05 : 1)) * 100) / 100;
    return v >= 1.02 && v <= 500 ? v : null;
  };
  const gridP = (G1, G2, fn) => {
    let s = 0;
    for (let h = 0; h <= 12; h++) for (let a = 0; a <= 12; a++) if (fn(h, a)) s += G1[h] * G2[a];
    return s;
  };
  const res = (h, a) => (h > a ? 'Home' : h < a ? 'Away' : 'Draw');

  const markets = {};
  markets['1X2'] = { '1': o1, X: ox, '2': o2 };
  markets.DC = { '1X': flat.dc1x, '12': flat.dc12, X2: flat.dcx2 };
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    const suffix = String(line).replace('.', '');
    const key = 'OU' + suffix;
    const over = flat['over' + suffix], under = flat['under' + suffix];
    if (over && under) markets[key] = { Over: over, Under: under };
  }
  if (flat.gg && flat.ng) markets.BTTS = { Yes: flat.gg, No: flat.ng };
  // First-half 1X2 (45% of each team's goal mean).
  const ht = {
    '1': price(gridP(H1, A1, (h, a) => h > a)),
    X: price(gridP(H1, A1, (h, a) => h === a)),
    '2': price(gridP(H1, A1, (h, a) => h < a)),
  };
  if (ht['1'] && ht.X && ht['2']) markets.HT1X2 = ht;
  // Correct score 0:0 .. 5:5.
  const cs = {};
  for (let h = 0; h <= 5; h++) for (let a = 0; a <= 5; a++) {
    const o = price(PH[h] * PA[a]);
    if (o) cs[h + ':' + a] = o;
  }
  if (Object.keys(cs).length >= 10) markets.CS = cs;
  // Draw No Bet: win prob conditional on no draw.
  const pHomeWin = gridP(PH, PA, (h, a) => h > a);
  const pAwayWin = gridP(PH, PA, (h, a) => h < a);
  const dnb = { '1': price(pHomeWin / (pHomeWin + pAwayWin)), '2': price(pAwayWin / (pHomeWin + pAwayWin)) };
  if (dnb['1'] && dnb['2']) markets.DNB = dnb;
  // Win To Nil.
  const wtn = {
    Home: price(gridP(PH, PA, (h, a) => h > a && a === 0)),
    Away: price(gridP(PH, PA, (h, a) => a > h && h === 0)),
  };
  if (wtn.Home && wtn.Away) markets.WTN = wtn;
  return markets;
}

// Look up one pick's decimal odds from the stored 1X2 book.
// Returns null for an unknown market/pick. 1X2 prices are the stored
// book values byte-identically (no repricing).
function lookupOdds(book1x2, market, pick) {
  const markets = marketsFromBook(book1x2);
  const m = markets[market || '1X2'];
  if (!m) return null;
  const o = m[String(pick)];
  return typeof o === 'number' && o > 1 ? o : null;
}

// Settle one leg from a final score. Returns 'won' | 'lost' | 'void'
// (void only for DNB on a draw); null when the market cannot be
// decided from the score alone.
function settleLeg(market, pick, hs, as) {
  const h = Number(hs), a = Number(as);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  switch (market) {
    case '1X2': return (pick === '1' && h > a) || (pick === 'X' && h === a) || (pick === '2' && h < a) ? 'won' : 'lost';
    case 'DC': return (pick === '1X' && h >= a) || (pick === '12' && h !== a) || (pick === 'X2' && a >= h) ? 'won' : 'lost';
    case 'OU05': case 'OU15': case 'OU25': case 'OU35': case 'OU45': {
      const line = Number(market.slice(2)) / 10;
      const total = h + a;
      if (pick === 'Over') return total > line ? 'won' : 'lost';
      if (pick === 'Under') return total < line ? 'won' : 'lost';
      return null;
    }
    case 'BTTS': return (pick === 'Yes') === (h > 0 && a > 0) ? 'won' : 'lost';
    case 'HT1X2': return null; // half-time score not stored; settled manually
    case 'CS': return pick === h + ':' + a ? 'won' : 'lost';
    case 'DNB':
      if (h === a) return 'void';
      return (pick === '1' && h > a) || (pick === '2' && h < a) ? 'won' : 'lost';
    case 'WTN': return (pick === 'Home' && h > a && a === 0) || (pick === 'Away' && a > h && h === 0) ? 'won' : 'lost';
    default: return null;
  }
}

module.exports = { expandOdds, marketsFromBook, lookupOdds, settleLeg, poissonCdf };
