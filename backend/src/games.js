// Server-authoritative instant game engines. Each: play(choice, f) -> {detail, multiplier}
// f() returns provably-fair floats in [0,1). Paytables define RTP (~95-97%).
const { crashPoint } = require('./crypto');
const die = (f) => 1 + Math.floor(f() * 6);
const card = (f) => 1 + Math.floor(f() * 13); // rank 1..13 (Ace..King), 10+ counts 10 in baccarat
const REDS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
const GAMES = {
  dice: { name: 'Dice Roll', play(c, f) { const a = die(f), b = die(f), t = a + b;
    const win = (c === 'under' && t < 7) || (c === 'seven' && t === 7) || (c === 'over' && t > 7);
    // P(under)=P(over)=15/36, P(seven)=6/36; pays priced at 0.97 factor:
    // EV under/over = 15/36*2.33 = 0.9708, EV seven = 6/36*5.82 = 0.9700.
    return { detail: { dice: [a, b], total: t }, multiplier: win ? (c === 'seven' ? 5.82 : 2.33) : 0 }; } },
  sicbo: { name: 'Sic Bo', play(c, f) { const d = [die(f), die(f), die(f)], t = d[0] + d[1] + d[2], triple = d[0] === d[1] && d[1] === d[2];
    const win = c === 'triple' ? triple : c === 'small' ? (t >= 4 && t <= 10 && !triple) : (t >= 11 && t <= 17 && !triple);
    return { detail: { dice: d, total: t, triple }, multiplier: win ? (c === 'triple' ? 30 : 2) : 0 }; } },
  roulette: { name: 'Roulette', play(c, f) { const n = Math.floor(f() * 37);
    const col = n === 0 ? 'green' : REDS.includes(n) ? 'red' : 'black';
    return { detail: { number: n, colour: col }, multiplier: c === col ? (col === 'green' ? 14 : 2) : 0 }; } },
  speedwheel: { name: 'Speed Wheel', play(c, f) { const n = Math.floor(f() * 10);
    const red = [1,3,5,7,9].includes(n); let win, mult = 2;
    if (c === 'red') win = red; else if (c === 'black') win = n !== 0 && !red;
    else if (c === 'even') win = n !== 0 && n % 2 === 0; else if (c === 'odd') win = n % 2 === 1;
    else { win = +c === n; mult = 9; }
    return { detail: { number: n }, multiplier: win ? mult : 0 }; } },
  flip: { name: 'Coin Flip', play(c, f) { const side = f() < 0.5 ? 'heads' : 'tails';
    return { detail: { side }, multiplier: c === side ? 1.96 : 0 }; } },
  evenodd: { name: 'Even or Odd', play(c, f) { const n = 1 + Math.floor(f() * 10);
    const par = n % 2 === 0 ? 'even' : 'odd'; return { detail: { number: n }, multiplier: c === par ? 1.96 : 0 }; } },
  redblack: { name: 'Red-Black (single card)', play(c, f) { const red = f() < 0.5; card(f);
    return { detail: { colour: red ? 'red' : 'black' }, multiplier: (c === 'red') === red ? 1.96 : 0 }; } },
  dragontiger: { name: 'Dragon Tiger', play(c, f) { const d = card(f), t = card(f);
    const res = d > t ? 'dragon' : t > d ? 'tiger' : 'tie';
    return { detail: { dragon: d, tiger: t, result: res }, multiplier: c === res ? (res === 'tie' ? 9 : 2) : 0 }; } },
  // Baccarat — real punto-banco tableau (L1). Cards drawn with replacement
  // from rank stream (value: Ace=1, 2-9 face, 10/J/Q/K=0); totals mod 10.
  // Naturals (8/9) stand; player draws on <=5; banker draws per the
  // standard third-card tableau keyed on the player's third card.
  // Standard payouts kept (player x2, banker x1.95 incl. commission, tie x9);
  // empirical EVs ~0.89 (see fix-b-checks.js) — honest casino margin, < 1.
  baccarat: { name: 'Baccarat', play(c, f) {
    const val = (r) => (r >= 10 ? 0 : r);
    const draw = () => val(card(f));
    const p1 = draw(), p2 = draw(), b1 = draw(), b2 = draw();
    let pt = (p1 + p2) % 10, bt = (b1 + b2) % 10, p3 = null, b3 = null;
    if (pt < 8 && bt < 8) {
      if (pt <= 5) { p3 = draw(); pt = (pt + p3) % 10; }
      const bankerDraws = p3 === null ? bt <= 5
        : bt <= 2 ? true
        : bt === 3 ? p3 !== 8
        : bt === 4 ? (p3 >= 2 && p3 <= 7)
        : bt === 5 ? (p3 >= 4 && p3 <= 7)
        : bt === 6 ? (p3 === 6 || p3 === 7)
        : false;
      if (bankerDraws) { b3 = draw(); bt = (bt + b3) % 10; }
    }
    const res = pt > bt ? 'player' : bt > pt ? 'banker' : 'tie';
    return { detail: { player: pt, banker: bt, playerThird: p3, bankerThird: b3, result: res },
      multiplier: c === res ? (res === 'tie' ? 9 : res === 'banker' ? 1.95 : 2) : 0 }; } },
  andar: { name: 'Andar Bahar', play(c, f) { const joker = card(f); let side = 'andar', ac = 0, bc = 0, winner = '';
    let guard = 0; while (!winner && guard++ < 500) { const v = card(f);
      if (side === 'andar') { ac++; if (v === joker) winner = 'andar'; } else { bc++; if (v === joker) winner = 'bahar'; }
      side = side === 'andar' ? 'bahar' : 'andar'; }
    // Draws with replacement: P(andar)=13/25=0.52, P(bahar)=12/25=0.48.
    // Priced at 0.97 factor: andar x1.87 (EV 0.9724), bahar x2.02 (EV 0.9696).
    return { detail: { joker, andarCards: ac, baharCards: bc, winner }, multiplier: c === winner ? (winner === 'andar' ? 1.87 : 2.02) : 0 }; } },
  limbo: { name: 'Limbo', play(c, f) { const target = Math.min(500, Math.max(1.1, parseFloat(c) || 2)); // H7: cap 500 like crashPoint
    const point = Math.max(1, Math.floor((0.99 / (1 - f())) * 100) / 100);
    return { detail: { point, target }, multiplier: point >= target ? target : 0 }; } },
  skyclimb: { name: 'Sky Climb (auto cash-out)', play(c, f) { const target = Math.min(500, Math.max(1.1, parseFloat(c) || 1.5)); // H7: cap 500
    const point = crashPoint(f); return { detail: { crashPoint: point, target }, multiplier: point >= target ? target : 0 }; } },
  penalty: { name: 'Penalty Kick', play(c, f) { const zones = ['Top Left','Top Centre','Top Right','Bottom Left','Bottom Centre','Bottom Right'];
    const keeper = zones[Math.floor(f() * 6)]; const saved = keeper === c || (keeper.includes('Centre') && c.includes('Centre'));
    // B4: keeper uniform over 6 zones. Corner: saved only on exact match,
    // P(goal)=5/6 -> pay 0.97/(5/6)=1.164 -> 1.16 (EV 0.9667).
    // Centre: saved on either Centre zone, P(goal)=4/6 -> pay 0.97/(2/3)=1.455 -> 1.45 (EV 0.9667).
    const pay = c.includes('Centre') ? 1.45 : 1.16;
    return { detail: { shot: c, keeper }, multiplier: saved ? 0 : pay }; } },
  keno: { name: 'Keno', play(c, f) { const picks = String(c).split(',').map(Number).filter(n => n >= 1 && n <= 40).slice(0, 5);
    const drawn = new Set(); while (drawn.size < 10) drawn.add(1 + Math.floor(f() * 40));
    const hits = picks.filter(n => drawn.has(n)).length; const pay = { 0:0, 1:0, 2:1, 3:3, 4:10, 5:50 };
    return { detail: { picks, drawn: [...drawn].sort((a,b)=>a-b), hits }, multiplier: picks.length === 5 ? pay[hits] : 0 }; } },
  slots: { name: 'Slots / Fruit', play(c, f) { const syms = ['cherry','lemon','bell','star','gem','seven'];
    const pay = { cherry:5, lemon:6, bell:8, star:10, gem:20, seven:50 };
    const r = [0,0,0].map(() => syms[Math.floor(f() * 6)]);
    const mult = r[0] === r[1] && r[1] === r[2] ? pay[r[0]] : (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) ? 1.2 : 0;
    return { detail: { reels: r }, multiplier: mult }; } },
};
const PENALTY_ZONES = ['Top Left', 'Top Centre', 'Top Right', 'Bottom Left', 'Bottom Centre', 'Bottom Right'];
// M10 — per-game choice validators. Returns null when the choice can win,
// or an error string ('bad_choice' / 'unknown_game') when it cannot.
// Call BEFORE any debit: no unwinnable choice may ever reach a debit.
// Allowed sets:
//   dice: 'under' | 'seven' | 'over'
//   sicbo: 'small' | 'big' | 'triple'
//   roulette: 'red' | 'black' | 'green'
//   speedwheel: 'red' | 'black' | 'even' | 'odd' | '0'..'9'
//   flip: 'heads' | 'tails'
//   evenodd: 'even' | 'odd'
//   redblack: 'red' | 'black'
//   dragontiger: 'dragon' | 'tiger' | 'tie'
//   baccarat: 'player' | 'banker' | 'tie'
//   andar: 'andar' | 'bahar'
//   limbo / skyclimb: numeric target, 1.1 <= target <= 500 (H7 cap)
//   penalty: one of the six zones
//   keno: exactly 5 distinct integers, each 1..40, comma-separated
//   slots: choice is ignored by the engine — any choice is valid
function validateChoice(game, choice) {
  if (!GAMES[game]) return 'unknown_game';
  const c = String(choice ?? '');
  const inSet = (arr) => arr.includes(c);
  switch (game) {
    case 'dice': return inSet(['under', 'seven', 'over']) ? null : 'bad_choice';
    case 'sicbo': return inSet(['small', 'big', 'triple']) ? null : 'bad_choice';
    case 'roulette': return inSet(['red', 'black', 'green']) ? null : 'bad_choice';
    case 'speedwheel': return inSet(['red', 'black', 'even', 'odd']) || (/^[0-9]$/.test(c)) ? null : 'bad_choice';
    case 'flip': return inSet(['heads', 'tails']) ? null : 'bad_choice';
    case 'evenodd': return inSet(['even', 'odd']) ? null : 'bad_choice';
    case 'redblack': return inSet(['red', 'black']) ? null : 'bad_choice';
    case 'dragontiger': return inSet(['dragon', 'tiger', 'tie']) ? null : 'bad_choice';
    case 'baccarat': return inSet(['player', 'banker', 'tie']) ? null : 'bad_choice';
    case 'andar': return inSet(['andar', 'bahar']) ? null : 'bad_choice';
    case 'limbo': case 'skyclimb': {
      const t = parseFloat(c);
      return (Number.isFinite(t) && t >= 1.1 && t <= 500) ? null : 'bad_choice';
    }
    case 'penalty': return inSet(PENALTY_ZONES) ? null : 'bad_choice';
    case 'keno': {
      const parts = c.split(',').map(s => s.trim());
      if (parts.length !== 5) return 'bad_choice';
      const nums = parts.map(Number);
      if (nums.some(n => !Number.isInteger(n) || n < 1 || n > 40)) return 'bad_choice';
      if (new Set(nums).size !== 5) return 'bad_choice';
      return null;
    }
    case 'slots': return null; // engine ignores choice
    default: return 'bad_choice';
  }
}
// Maximum multiplier a game can ever pay, for the H7 max-payout gate
// (wallet.assertWithinMaxPayout). Limbo/Sky Climb use the player's capped target.
function gameMaxMultiplier(game, choice) {
  const fixed = { dice: 5.82, sicbo: 30, roulette: 14, speedwheel: 9, flip: 1.96,
    evenodd: 1.96, redblack: 1.96, dragontiger: 9, baccarat: 9, andar: 2.02,
    penalty: 1.45, keno: 50, slots: 50 };
  if (game === 'limbo' || game === 'skyclimb') {
    const t = parseFloat(choice);
    return Number.isFinite(t) ? Math.min(500, Math.max(1.1, t)) : 500;
  }
  return fixed[game] ?? null;
}
module.exports = { GAMES, validateChoice, gameMaxMultiplier, PENALTY_ZONES };
