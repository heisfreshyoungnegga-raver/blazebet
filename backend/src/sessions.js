// Stateful session games. ALL randomness is fixed at start from the session's
// provably-fair float stream; the layout lives only in the server-side state.
// Actions reveal/step through it. Public views never expose hidden layout
// until the session settles.
const ZONES = ['Top Left','Top Centre','Top Right','Bottom Left','Bottom Centre','Bottom Right'];
const LADDER = [1.3, 1.8, 2.6, 3.8, 5.5];
function shuffledDeck(f) {
  const deck = [];
  for (let s = 0; s < 4; s++) for (let v = 1; v <= 13; v++) deck.push({ v, s });
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(f() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}
function minesMult(picks, minesCount) {
  let m = 0.97;
  for (let i = 0; i < picks; i++) m *= (25 - i) / (25 - minesCount - i);
  return Math.floor(m * 100) / 100;
}
function evaluatePoker(hand) {
  const vs = hand.map(c => c.v).sort((a, b) => a - b), flush = hand.every(c => c.s === hand[0].s);
  const cnt = {}; vs.forEach(v => cnt[v] = (cnt[v] || 0) + 1);
  const groups = Object.values(cnt).sort((a, b) => b - a);
  const straight = vs.every((v, i) => i === 0 || v === vs[i - 1] + 1) || JSON.stringify(vs) === '[1,10,11,12,13]';
  const royal = straight && vs[0] === 1 && vs[4] === 13;
  if (straight && flush) return royal ? ['ROYAL FLUSH', 250] : ['Straight Flush', 50];
  if (groups[0] === 4) return ['Four of a Kind', 25];
  if (groups[0] === 3 && groups[1] === 2) return ['Full House', 9];
  if (flush) return ['Flush', 6];
  if (straight) return ['Straight', 4];
  if (groups[0] === 3) return ['Three of a Kind', 3];
  if (groups[0] === 2 && groups[1] === 2) return ['Two Pair', 2];
  const pairV = +Object.keys(cnt).find(k => cnt[k] === 2);
  if (groups[0] === 2 && (pairV >= 11 || pairV === 1)) return ['Jacks or Better', 1];
  return ['No win', 0];
}
const SESSION_GAMES = {
  mines: { name: 'Mines',
    start(f, opts) { const count = Math.min(10, Math.max(1, parseInt(opts.mines) || 3));
      const mines = new Set(); while (mines.size < count) mines.add(Math.floor(f() * 25));
      return { mines: [...mines], minesCount: count, picks: [] }; },
    act(st, a, p) { if (a === 'cashout') return cash(st, minesMult(st.picks.length, st.minesCount), 'Cashed out');
      const tile = +p.tile; if (!(tile >= 0 && tile < 25) || st.picks.includes(tile)) throw new Error('bad_tile');
      if (st.mines.includes(tile)) return lose(st, 'Mine hit');
      st.picks.push(tile); st.mult = minesMult(st.picks.length, st.minesCount);
      if (st.picks.length === 25 - st.minesCount) return cash(st, st.mult, 'Board cleared');
      return ok(st); },
    pub(st, settled) { return { picks: st.picks, minesCount: st.minesCount, nextMult: minesMult(st.picks.length + 1, st.minesCount), ...(settled ? { mines: st.mines } : {}) }; } },
  towers: { name: 'Towers',
    start(f) { return { bombs: Array.from({ length: 5 }, () => Math.floor(f() * 3)), floor: 0, picked: [] }; },
    act(st, a, p) { if (a === 'cashout') return st.floor ? cash(st, towerMult(st.floor), 'Cashed out') : (() => { throw new Error('nothing_to_cash'); })();
      const col = +p.col; if (!(col >= 0 && col < 3)) throw new Error('bad_col');
      if (col === st.bombs[st.floor]) return lose(st, 'Bomb on floor ' + (st.floor + 1));
      st.picked.push(col); st.floor++; st.mult = towerMult(st.floor);
      if (st.floor === 5) return cash(st, st.mult, 'Tower topped');
      return ok(st); },
    pub(st, settled) { return { floor: st.floor, picked: st.picked, nextMult: towerMult(st.floor + 1), ...(settled ? { bombs: st.bombs } : {}) }; } },
  hilo: { name: 'Hi-Lo Cards',
    start(f) { const deck = shuffledDeck(f); return { deck, idx: 1, current: deck[0], mult: 1, correct: 0 }; },
    act(st, a, p) { if (a === 'cashout') return st.correct ? cash(st, st.mult, 'Cashed out') : (() => { throw new Error('nothing_to_cash'); })();
      if (a !== 'higher' && a !== 'lower') throw new Error('bad_action');
      const next = st.deck[st.idx]; const remaining = st.deck.slice(st.idx);
      const hi = remaining.filter(c => c.v > st.current.v).length, lo = remaining.filter(c => c.v < st.current.v).length;
      if (next.v === st.current.v) return lose(st, 'Tie card - streak lost');
      const good = a === 'higher' ? next.v > st.current.v : next.v < st.current.v;
      if (!good) return lose(st, 'Wrong call');
      const step = 0.97 * remaining.length / (a === 'higher' ? hi : lo);
      st.mult = Math.floor(st.mult * step * 100) / 100; st.current = next; st.idx++; st.correct++;
      return ok(st); },
    pub(st) { return { current: st.current, multiplier: st.mult, correct: st.correct }; } },
  redblack: { name: 'Red-Black Streak',
    start(f) { const deck = shuffledDeck(f); return { deck, idx: 0, mult: 1, correct: 0, last: null }; },
    act(st, a, p) { if (a === 'cashout') return st.correct ? cash(st, st.mult, 'Cashed out') : (() => { throw new Error('nothing_to_cash'); })();
      if (a !== 'red' && a !== 'black') throw new Error('bad_action');
      const next = st.deck[st.idx]; const remaining = st.deck.slice(st.idx);
      const red = next.s === 1 || next.s === 2; const colCount = remaining.filter(c => (c.s === 1 || c.s === 2) === (a === 'red')).length;
      if ((a === 'red') !== red) return lose(st, 'Wrong colour');
      const step = 0.97 * remaining.length / colCount;
      st.mult = Math.floor(st.mult * step * 100) / 100; st.idx++; st.correct++; st.last = next;
      return ok(st); },
    pub(st) { return { last: st.last, multiplier: st.mult, correct: st.correct }; } },
  balloon: { name: 'Balloon Pop',
    start(f) { return { popAt: 3 + Math.floor(f() * 13), pumps: 0, mult: 1 }; },
    act(st, a) { if (a === 'cashout') return st.pumps ? cash(st, st.mult, 'Cashed out') : (() => { throw new Error('nothing_to_cash'); })();
      if (a !== 'pump') throw new Error('bad_action');
      st.pumps++; if (st.pumps >= st.popAt) return lose(st, 'Balloon popped');
      st.mult = Math.floor((1 + 0.25 * st.pumps) * 100) / 100; return ok(st); },
    pub(st, settled) { return { pumps: st.pumps, multiplier: st.mult, ...(settled ? { popAt: st.popAt } : {}) }; } },
  goalladder: { name: 'Goal Ladder',
    start(f) { return { keepers: Array.from({ length: 5 }, () => ZONES[Math.floor(f() * 6)]), goals: 0 }; },
    act(st, a, p) { if (a === 'cashout') return st.goals ? cash(st, LADDER[st.goals - 1], 'Cashed out') : (() => { throw new Error('nothing_to_cash'); })();
      if (a !== 'shoot') throw new Error('bad_action');
      const keeper = st.keepers[st.goals];
      if (keeper === p.zone || (keeper.includes('Centre') && String(p.zone || '').includes('Centre'))) return lose(st, 'Saved by the keeper');
      st.goals++; st.mult = LADDER[st.goals - 1];
      if (st.goals === 5) return cash(st, 5.5, 'Five from five');
      return ok(st); },
    pub(st, settled) { return { goals: st.goals, nextMult: LADDER[st.goals] || null, ...(settled ? { keepers: st.keepers } : {}) }; } },
  poker: { name: 'Video Poker',
    start(f) { const deck = shuffledDeck(f); return { deck, hand: deck.slice(0, 5), phase: 'hold' }; },
    act(st, a, p) { if (a !== 'draw' || st.phase !== 'hold') throw new Error('bad_action');
      const hold = new Set(Array.isArray(p.hold) ? p.hold : []);
      let i = 5; st.hand = st.hand.map((c, idx) => hold.has(idx) ? c : st.deck[i++]);
      const [name, mult] = evaluatePoker(st.hand);
      return mult > 0 ? { ...cash(st, mult, name), handName: name } : { ...lose(st, name), handName: name }; },
    pub(st) { return { hand: st.hand, phase: st.phase }; } },
  skyclimb: { name: 'Sky Climb (live)',
    start(f, opts, crashPoint) { return { crash: crashPoint(f), startedAt: Date.now() }; },
    currentMult(st) { return Math.floor(Math.pow(1.06, (Date.now() - st.startedAt) / 120) * 100) / 100; },
    act(st, a) { const m = this.currentMult(st);
      if (m >= st.crash) return lose(st, 'Flew away at ' + st.crash.toFixed(2) + 'x');
      if (a === 'cashout') return cash(st, Math.floor(m * 100) / 100, 'Cashed out at ' + m.toFixed(2) + 'x');
      if (a === 'poll') return ok(st);
      throw new Error('bad_action'); },
    pub(st, settled) { return { currentMult: this.currentMult(st), ...(settled ? { crash: st.crash } : {}) }; } },
};
function towerMult(floor) { return Math.floor(Math.pow(1.455, floor) * 100) / 100; }
function ok(st) { return { settled: false, state: st }; }
function cash(st, mult, msg) { return { settled: true, won: true, multiplier: Math.max(1, mult), message: msg, state: st }; }
function lose(st, msg) { return { settled: true, won: false, multiplier: 0, message: msg, state: st }; }
module.exports = { SESSION_GAMES, evaluatePoker, minesMult, towerMult };
