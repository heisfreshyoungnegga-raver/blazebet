// Server-authoritative instant game engines. Each: play(choice, f) -> {detail, multiplier}
// f() returns provably-fair floats in [0,1). Paytables define RTP (~95-97%).
const { crashPoint } = require('./crypto');
const die = (f) => 1 + Math.floor(f() * 6);
const card = (f) => 1 + Math.floor(f() * 13); // rank 1..13 (Ace..King), 10+ counts 10 in baccarat
const REDS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
const GAMES = {
  dice: { name: 'Dice Roll', play(c, f) { const a = die(f), b = die(f), t = a + b;
    const win = (c === 'under' && t < 7) || (c === 'seven' && t === 7) || (c === 'over' && t > 7);
    return { detail: { dice: [a, b], total: t }, multiplier: win ? (c === 'seven' ? 5 : 2) : 0 }; } },
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
  baccarat: { name: 'Baccarat', play(c, f) { const hand = () => { let t = Math.min(card(f), 10); if (f() < 0.45) t += Math.min(card(f), 10); return t % 10; };
    const p = hand(), b = hand(), res = p > b ? 'player' : b > p ? 'banker' : 'tie';
    return { detail: { player: p, banker: b, result: res }, multiplier: c === res ? (res === 'tie' ? 9 : res === 'banker' ? 1.95 : 2) : 0 }; } },
  andar: { name: 'Andar Bahar', play(c, f) { const joker = card(f); let side = 'andar', ac = 0, bc = 0, winner = '';
    let guard = 0; while (!winner && guard++ < 500) { const v = card(f);
      if (side === 'andar') { ac++; if (v === joker) winner = 'andar'; } else { bc++; if (v === joker) winner = 'bahar'; }
      side = side === 'andar' ? 'bahar' : 'andar'; }
    return { detail: { joker, andarCards: ac, baharCards: bc, winner }, multiplier: c === winner ? 1.9 : 0 }; } },
  limbo: { name: 'Limbo', play(c, f) { const target = Math.max(1.1, parseFloat(c) || 2);
    const point = Math.max(1, Math.floor((0.99 / (1 - f())) * 100) / 100);
    return { detail: { point, target }, multiplier: point >= target ? target : 0 }; } },
  skyclimb: { name: 'Sky Climb (auto cash-out)', play(c, f) { const target = Math.max(1.1, parseFloat(c) || 1.5);
    const point = crashPoint(f); return { detail: { crashPoint: point, target }, multiplier: point >= target ? target : 0 }; } },
  penalty: { name: 'Penalty Kick', play(c, f) { const zones = ['Top Left','Top Centre','Top Right','Bottom Left','Bottom Centre','Bottom Right'];
    const keeper = zones[Math.floor(f() * 6)]; const saved = keeper === c || (keeper.includes('Centre') && c.includes('Centre'));
    const pay = c.includes('Top') && c !== 'Top Centre' ? 2.6 : c.includes('Centre') ? 1.6 : 2;
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
module.exports = { GAMES };
