/* BlazeBet casino-plus: ticker, filters, card badges/RTP, wins feed, leaderboard,
   promos, playable dice showcase, how-it-works, responsible play. Demo data is
   labelled demo; the WELCOME promo is the real backend code. */
(function () {
  "use strict";
  var GAMES = {
    "aviator": { cat: "crash", badge: "HOT", rtp: "97.0%" },
    "gold-rush-slots": { cat: "slots", badge: "HOT", rtp: "96.5%" },
    "safari-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "ocean-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "space-slots": { cat: "slots", badge: "NEW", rtp: "96.5%" },
    "candy-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "pirate-slots": { cat: "slots", badge: "NEW", rtp: "96.5%" },
    "egypt-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "neon-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "dragon-slots": { cat: "slots", badge: "HOT", rtp: "96.5%" },
    "zeus-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "vegas-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "emerald-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "ruby-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "farm-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "beach-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "royal-slots": { cat: "slots", badge: "HOT", rtp: "96.5%" },
    "mega-slots": { cat: "slots", badge: "HOT", rtp: "96.5%" },
    "turbo-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "wild-west-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "jungle-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "ice-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "fire-slots": { cat: "slots", badge: "NEW", rtp: "96.5%" },
    "lucky-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "diamond-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "fruit-party-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "golden-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "star-slots": { cat: "slots", badge: null, rtp: "96.5%" },
    "accra-slots": { cat: "slots", badge: "NEW", rtp: "96.5%" },
    "fruit-fiesta-deluxe": { cat: "slots", badge: "NEW", rtp: "96.5%" },
    "berry-blast": { cat: "slots", badge: null, rtp: "96.5%" },
    "citrus-splash": { cat: "slots", badge: null, rtp: "96.5%" },
    "grape-escape": { cat: "slots", badge: null, rtp: "96.5%" },
    "cherry-chase": { cat: "slots", badge: null, rtp: "96.5%" },
    "tropical-grid": { cat: "slots", badge: null, rtp: "96.5%" },
    "melon-grid": { cat: "slots", badge: null, rtp: "96.5%" },
    "orchard-grid": { cat: "slots", badge: null, rtp: "96.5%" },
    "sweet-grid": { cat: "slots", badge: null, rtp: "96.5%" },
    "golden-grid": { cat: "slots", badge: null, rtp: "96.5%" },
    "lucky-grid": { cat: "slots", badge: null, rtp: "96.5%" },
    "neon-grid": { cat: "slots", badge: "NEW", rtp: "96.5%" },
    "royal-grid": { cat: "slots", badge: null, rtp: "96.5%" },
    "fiesta-grid": { cat: "slots", badge: null, rtp: "96.5%" },
    "golden-wheel": { cat: "arcade", badge: "HOT", rtp: "95.0%" },
    "mega-wheel": { cat: "arcade", badge: "HOT", rtp: "95.0%" },
    "turbo-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "royal-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "risk-wheel": { cat: "arcade", badge: "NEW", rtp: "95.0%" },
    "safari-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "ocean-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "neon-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "dragon-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "zeus-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "egypt-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "candy-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "pirate-wheel": { cat: "arcade", badge: "NEW", rtp: "95.0%" },
    "diamond-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "fire-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "ice-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "grand-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "lucky-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "accra-wheel": { cat: "arcade", badge: "NEW", rtp: "95.0%" },
    "cosmic-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "coral-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "imperial-wheel": { cat: "arcade", badge: null, rtp: "95.0%" },
    "rocket-rush": { cat: "crash", badge: "HOT", rtp: "97.0%" },
    "jet-stream": { cat: "crash", badge: "NEW", rtp: "97.0%" },
    "submarine-dive": { cat: "crash", badge: null, rtp: "97.0%" },
    "express-train": { cat: "crash", badge: null, rtp: "97.0%" },
    "eagle-flight": { cat: "crash", badge: null, rtp: "97.0%" },
    "comet-rider": { cat: "crash", badge: "NEW", rtp: "97.0%" },
    "speedboat-surge": { cat: "crash", badge: null, rtp: "97.0%" },
    "dragon-flight": { cat: "crash", badge: "HOT", rtp: "97.0%" },
    "gt-racer": { cat: "crash", badge: null, rtp: "97.0%" },
    "ufo-abduction": { cat: "crash", badge: null, rtp: "97.0%" },
    "balloon-pop-pro": { cat: "crash", badge: null, rtp: "97.0%" },
    "night-train": { cat: "crash", badge: null, rtp: "97.0%" },
    "falcon-dive": { cat: "crash", badge: null, rtp: "97.0%" },
    "zeus-thunder": { cat: "crash", badge: "NEW", rtp: "97.0%" },
    "plinko-gold": { cat: "arcade", badge: "HOT", rtp: "97.0%" },
    "plinko-mini": { cat: "arcade", badge: null, rtp: "97.0%" },
    "plinko-mega": { cat: "arcade", badge: "HOT", rtp: "97.0%" },
    "plinko-neon": { cat: "arcade", badge: "NEW", rtp: "97.0%" },
    "plinko-royal": { cat: "arcade", badge: null, rtp: "97.0%" },
    "plinko-turbo": { cat: "arcade", badge: null, rtp: "97.0%" },
    "plinko-safari": { cat: "arcade", badge: null, rtp: "97.0%" },
    "plinko-ocean": { cat: "arcade", badge: null, rtp: "97.0%" },
    "plinko-dragon": { cat: "arcade", badge: null, rtp: "97.0%" },
    "plinko-candy": { cat: "arcade", badge: null, rtp: "97.0%" },
    "plinko-egypt": { cat: "arcade", badge: null, rtp: "97.0%" },
    "plinko-cosmic": { cat: "arcade", badge: "NEW", rtp: "97.0%" },
    "mines-gold": { cat: "arcade", badge: "HOT", rtp: "97.0%" },
    "mines-mini": { cat: "arcade", badge: null, rtp: "97.0%" },
    "mines-extreme": { cat: "arcade", badge: "NEW", rtp: "97.0%" },
    "diamond-mines": { cat: "arcade", badge: null, rtp: "97.0%" },
    "safari-mines": { cat: "arcade", badge: null, rtp: "97.0%" },
    "ocean-mines": { cat: "arcade", badge: null, rtp: "97.0%" },
    "pirate-mines": { cat: "arcade", badge: null, rtp: "97.0%" },
    "mega-mines": { cat: "arcade", badge: null, rtp: "97.0%" },
    "royal-mines": { cat: "arcade", badge: null, rtp: "97.0%" },
    "volcano-mines": { cat: "arcade", badge: "NEW", rtp: "97.0%" },
    "turbo-mines": { cat: "arcade", badge: null, rtp: "97.0%" },
    "grand-mines": { cat: "arcade", badge: null, rtp: "97.0%" },
    "keno-gold": { cat: "table", badge: "HOT", rtp: "96.0%" },
    "keno-royale": { cat: "table", badge: null, rtp: "96.0%" },
    "keno-mega": { cat: "table", badge: "NEW", rtp: "96.0%" },
    "keno-express": { cat: "table", badge: null, rtp: "96.0%" },
    "keno-deluxe": { cat: "table", badge: null, rtp: "96.0%" },
    "keno-supreme": { cat: "table", badge: null, rtp: "96.0%" },
    "keno-ultra": { cat: "table", badge: null, rtp: "96.0%" },
    "keno-mini": { cat: "table", badge: null, rtp: "96.0%" },
    "keno-max": { cat: "table", badge: "HOT", rtp: "96.0%" },
    "keno-neon": { cat: "table", badge: "NEW", rtp: "96.0%" },
    "keno-safari": { cat: "table", badge: null, rtp: "96.0%" },
    "keno-egypt": { cat: "table", badge: null, rtp: "96.0%" },
    "scratch-gold": { cat: "arcade", badge: "HOT", rtp: "96.0%" },
    "scratch-jackpot": { cat: "arcade", badge: "NEW", rtp: "96.0%" },
    "scratch-daily": { cat: "arcade", badge: null, rtp: "96.0%" },
    "scratch-royal": { cat: "arcade", badge: null, rtp: "96.0%" },
    "scratch-safari": { cat: "arcade", badge: null, rtp: "96.0%" },
    "scratch-neon": { cat: "arcade", badge: "NEW", rtp: "96.0%" },
    "scratch-egypt": { cat: "arcade", badge: null, rtp: "96.0%" },
    "scratch-candy": { cat: "arcade", badge: null, rtp: "96.0%" },
    "scratch-dragon": { cat: "arcade", badge: null, rtp: "96.0%" },
    "scratch-ocean": { cat: "arcade", badge: null, rtp: "96.0%" },
    "scratch-mega": { cat: "arcade", badge: "HOT", rtp: "96.0%" },
    "scratch-lucky": { cat: "arcade", badge: null, rtp: "96.0%" },
    "dice-deluxe": { cat: "table", badge: "HOT", rtp: "97.0%" },
    "dice-royale": { cat: "table", badge: null, rtp: "97.0%" },
    "dice-neon": { cat: "table", badge: "NEW", rtp: "97.0%" },
    "dice-gold": { cat: "table", badge: null, rtp: "97.0%" },
    "dice-turbo": { cat: "table", badge: null, rtp: "97.0%" },
    "dice-zones": { cat: "table", badge: null, rtp: "97.0%" },
    "dice-safari": { cat: "table", badge: null, rtp: "97.0%" },
    "dice-dragon": { cat: "table", badge: null, rtp: "97.0%" },
    "dice-ocean": { cat: "table", badge: null, rtp: "97.0%" },
    "dice-accra": { cat: "table", badge: "NEW", rtp: "97.0%" },
    "over-under-classic": { cat: "arcade", badge: null, rtp: "97.0%" },
    "over-under-high": { cat: "arcade", badge: null, rtp: "97.0%" },
    "over-under-low": { cat: "arcade", badge: null, rtp: "97.0%" },
    "over-under-top": { cat: "arcade", badge: null, rtp: "97.0%" },
    "over-under-neon": { cat: "arcade", badge: null, rtp: "97.0%" },
    "over-under-gold": { cat: "arcade", badge: null, rtp: "97.0%" },
    "over-under-turbo": { cat: "arcade", badge: null, rtp: "97.0%" },
    "over-under-royal": { cat: "arcade", badge: null, rtp: "97.0%" },
    "limbo-sprint": { cat: "arcade", badge: null, rtp: "97.0%" },
    "limbo-classic": { cat: "arcade", badge: "HOT", rtp: "97.0%" },
    "limbo-pro": { cat: "arcade", badge: null, rtp: "97.0%" },
    "limbo-challenge": { cat: "arcade", badge: null, rtp: "97.0%" },
    "limbo-extreme": { cat: "arcade", badge: "NEW", rtp: "97.0%" },
    "limbo-mega": { cat: "arcade", badge: null, rtp: "97.0%" },
    "limbo-gold": { cat: "arcade", badge: null, rtp: "97.0%" },
    "limbo-neon": { cat: "arcade", badge: null, rtp: "97.0%" },
    "flip-cedi": { cat: "arcade", badge: null, rtp: "96.0%" },
    "flip-gold": { cat: "arcade", badge: null, rtp: "96.0%" },
    "flip-royal": { cat: "arcade", badge: null, rtp: "96.0%" },
    "flip-star": { cat: "arcade", badge: null, rtp: "96.0%" },
    "flip-fire": { cat: "arcade", badge: null, rtp: "96.0%" },
    "flip-alpha": { cat: "arcade", badge: null, rtp: "96.0%" },
    "flip-day": { cat: "arcade", badge: null, rtp: "96.0%" },
    "flip-turbo": { cat: "arcade", badge: null, rtp: "96.0%" },
    "mini-roulette": { cat: "table", badge: "HOT", rtp: "97.0%" },
    "roulette-royale-mini": { cat: "table", badge: null, rtp: "97.0%" },
    "turbo-roulette": { cat: "table", badge: null, rtp: "97.0%" },
    "grand-roulette-mini": { cat: "table", badge: "NEW", rtp: "97.0%" },
    "neon-roulette": { cat: "table", badge: null, rtp: "97.0%" },
    "golden-roulette-mini": { cat: "table", badge: null, rtp: "97.0%" },
    "dragon-roulette": { cat: "table", badge: null, rtp: "97.0%" },
    "ocean-roulette": { cat: "table", badge: null, rtp: "97.0%" },
    "hi-lo-numbers": { cat: "arcade", badge: "HOT", rtp: "97.0%" },
    "higher-lower-gold": { cat: "arcade", badge: null, rtp: "97.0%" },
    "number-climb": { cat: "arcade", badge: null, rtp: "97.0%" },
    "hi-lo-royale": { cat: "arcade", badge: null, rtp: "97.0%" },
    "hi-lo-neon": { cat: "arcade", badge: "NEW", rtp: "97.0%" },
    "hi-lo-turbo": { cat: "arcade", badge: null, rtp: "97.0%" },
    "hi-lo-dragon": { cat: "arcade", badge: null, rtp: "97.0%" },
    "hi-lo-safari": { cat: "arcade", badge: null, rtp: "97.0%" },
    "tower-climb": { cat: "arcade", badge: "HOT", rtp: "97.0%" },
    "sky-ladder": { cat: "arcade", badge: null, rtp: "97.0%" },
    "golden-ladder": { cat: "arcade", badge: null, rtp: "97.0%" },
    "dragon-ladder": { cat: "arcade", badge: "NEW", rtp: "97.0%" },
    "mini-ladder": { cat: "arcade", badge: null, rtp: "97.0%" },
    "royal-ladder": { cat: "arcade", badge: null, rtp: "97.0%" },
    "mega-ladder": { cat: "arcade", badge: null, rtp: "97.0%" },
    "safari-ladder": { cat: "arcade", badge: null, rtp: "97.0%" },
    "sic-bo-deluxe": { cat: "table", badge: "HOT", rtp: "97.2%" },
    "sic-bo-royale": { cat: "table", badge: null, rtp: "97.2%" },
    "sic-bo-gold": { cat: "table", badge: null, rtp: "97.2%" },
    "sic-bo-neon": { cat: "table", badge: "NEW", rtp: "97.2%" },
    "sic-bo-dragon": { cat: "table", badge: null, rtp: "97.2%" },
    "sic-bo-turbo": { cat: "table", badge: null, rtp: "97.2%" },
    "red-black-pro": { cat: "table", badge: "HOT", rtp: "97.0%" },
    "rouge-noir": { cat: "table", badge: null, rtp: "97.0%" },
    "crimson-onyx": { cat: "table", badge: null, rtp: "97.0%" },
    "ruby-obsidian": { cat: "table", badge: "NEW", rtp: "97.0%" },
    "scarlet-shadow": { cat: "table", badge: null, rtp: "97.0%" },
    "hearts-spades": { cat: "table", badge: null, rtp: "97.0%" },
    "bingo-blitz": { cat: "table", badge: "HOT", rtp: "96.0%" },
    "bingo-royale-mini": { cat: "table", badge: null, rtp: "96.0%" },
    "bingo-express": { cat: "table", badge: null, rtp: "96.0%" },
    "bingo-jackpot": { cat: "table", badge: "NEW", rtp: "96.0%" },
    crash:      { cat: "crash",  badge: "HOT", rtp: "97.0%" },
    skyclimb:   { cat: "crash",  badge: "HOT", rtp: "97.0%" },
    slots:      { cat: "slots",  badge: "HOT", rtp: "96.5%" },
    fruit:      { cat: "slots",  badge: null,  rtp: "96.5%" },
    roulette:   { cat: "table",  badge: null,  rtp: "97.3%" },
    baccarat:   { cat: "table",  badge: null,  rtp: "98.9%" },
    blackjack:  { cat: "table",  badge: null,  rtp: "99.4%" },
    sicbo:      { cat: "table",  badge: null,  rtp: "97.2%" },
    dragontiger:{ cat: "table",  badge: null,  rtp: "96.7%" },
    poker:      { cat: "table",  badge: null,  rtp: "99.5%" },
    andar:      { cat: "table",  badge: null,  rtp: "97.0%" },
    redblack:   { cat: "table",  badge: null,  rtp: "97.0%" },
    hilo:       { cat: "table",  badge: null,  rtp: "97.0%" },
    mines:      { cat: "arcade", badge: "HOT", rtp: "97.0%" },
    plinko:     { cat: "arcade", badge: "HOT", rtp: "97.0%" },
    dice:       { cat: "arcade", badge: null,  rtp: "97.0%" },
    limbo:      { cat: "arcade", badge: null,  rtp: "97.0%" },
    balloon:    { cat: "arcade", badge: "NEW", rtp: "97.0%" },
    flip:       { cat: "arcade", badge: null,  rtp: "97.0%" },
    wheel:      { cat: "arcade", badge: null,  rtp: "97.0%" },
    speedwheel: { cat: "arcade", badge: null,  rtp: "97.0%" },
    keno:       { cat: "arcade", badge: null,  rtp: "96.0%" },
    bingo:      { cat: "arcade", badge: null,  rtp: "96.0%" },
    bottle:     { cat: "arcade", badge: "NEW", rtp: "97.0%" },
    penalty:    { cat: "arcade", badge: null,  rtp: "97.0%" },
    goalladder: { cat: "arcade", badge: "NEW", rtp: "97.0%" },
    towers:     { cat: "arcade", badge: null,  rtp: "97.0%" },
    turbocars:  { cat: "arcade", badge: "NEW", rtp: "97.0%" },
    "even-odd": { cat: "arcade", badge: null,  rtp: "97.0%" },
    scratch:    { cat: "arcade", badge: null,  rtp: "96.0%" }
  };
  var CATS = [["all", "All games"], ["crash", "Crash"], ["slots", "Slots"], ["table", "Table"], ["arcade", "Arcade"]];
  var WINS = [
    ["Maame", "1,400", "Sky Climb"], ["Esi", "950", "Roulette"], ["Kwame", "320", "Crash"],
    ["Dzifa", "210", "Blackjack"], ["Yaw", "1,150", "Plinko Drop"], ["Selasie", "120", "Baccarat"],
    ["Kojo", "85", "Mines"], ["Fiifi", "640", "Slots 777"], ["Akosua", "475", "Dice Roll"],
    ["Elikem", "230", "Towers"]
  ];
  var BOARD = [
    ["Kwame M.", "Accra", "Sky Climb", "18,450"], ["Ama S.", "Kumasi", "Slots 777", "12,980"],
    ["Yaw O.", "Takoradi", "Crash", "9,340"], ["Akosua D.", "Tema", "Blackjack", "7,615"],
    ["Elikem A.", "Ho", "Mines", "5,980"]
  ];

  var totalCards = 0; // total games before any filter is applied (cached on first run)
  function syncCount() {
    var cards = document.querySelectorAll("a[data-bb-cat]");
    if (!cards.length) return;
    var vis = 0;
    cards.forEach(function (a) { if (a.style.display !== "none" && a.offsetParent !== null) vis++; });
    if (!totalCards) totalCards = vis;
    document.querySelectorAll(".casino-browser-result-count").forEach(function (s) {
      if (s.textContent !== String(vis)) s.textContent = String(vis);
    });
    // The sidebar "All" filter shows the total, not the filtered count.
    document.querySelectorAll(".casino-browser-filter-count").forEach(function (s) {
      if (s.textContent !== String(totalCards)) s.textContent = String(totalCards);
    });
  }
  setInterval(syncCount, 600);

  function slugOf(a) {
    var m = (a.getAttribute("href") || "").match(/casino\/([a-z-]+)\/index\.html/);
    return m ? m[1] : null;
  }
  function el(html) { var d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; }

  function init() {
    var cards = Array.prototype.filter.call(
      document.querySelectorAll('a[href*="/gh/casino/"]'),
      function (a) { var s = slugOf(a); return s && GAMES[s] && !a.dataset.bbDone; }
    );
    if (!cards.length) return false;

    /* --- ticker --- */
    var header = document.querySelector("header");
    if (header && !document.querySelector(".bb-ticker")) {
      var items = "MEGA JACKPOT GH₵ 412,756.88 <i>•</i> DEMO COUNTER <i>•</i> WELCOME BONUS — GH₵10 FREE WITH CODE <b>WELCOME</b> <i>•</i> 231 CASINO GAMES — FREE DEMOS <i>•</i> FRIDAY CASH RACE — COMING SOON";
      var ticker = el('<div class="bb-ticker"><div class="bb-ticker-track"><span>' + items + '</span><span>' + items + "</span></div></div>");
      header.parentNode.insertBefore(ticker, header.nextSibling);
    }

    /* --- filters + card decoration --- */
    var grid = cards[0].parentElement;
    cards.forEach(function (a) {
      a.dataset.bbDone = "1";
      var g = GAMES[slugOf(a)];
      a.dataset.bbCat = g.cat;
      var cover = a.querySelector("div");
      if (cover) {
        if (g.badge) cover.appendChild(el('<span class="bb-badge' + (g.badge === "NEW" ? " new" : "") + '">' + g.badge + "</span>"));
        cover.appendChild(el('<span class="bb-rtp">RTP ' + g.rtp + "</span>"));
      }
    });
    if (grid && !document.querySelector(".bb-filters")) {
      var bar = el('<div class="bb-filters" role="group" aria-label="Filter games"></div>');
      CATS.forEach(function (c, i) {
        var b = el('<button class="bb-pill" aria-pressed="' + (i === 0) + '">' + c[1] + "</button>");
        b.addEventListener("click", function () {
          bar.querySelectorAll(".bb-pill").forEach(function (p) { p.setAttribute("aria-pressed", "false"); });
          b.setAttribute("aria-pressed", "true");
          document.querySelectorAll("a[data-bb-cat]").forEach(function (a) {
            a.style.display = (c[0] === "all" || a.dataset.bbCat === c[0]) ? "" : "none";
          });
          syncCount();
        });
        bar.appendChild(b);
      });
      grid.parentNode.insertBefore(bar, grid);
    }

    /* --- sections after the grid --- */
    var anchor = grid ? grid.parentElement : null;
    if (anchor && !document.querySelector(".bb-marquee")) {
      var winsHtml = WINS.map(function (w) { return "<span>" + w[0] + " won <b>GH₵ " + w[1] + "</b> on " + w[2] + "</span>"; }).join("");
      var feed = el('<div class="bb-section"><div class="bb-kicker">Latest wins</div><div class="bb-h">Fresh off the floor</div>' +
        '<div class="bb-marquee"><div class="bb-marquee-track"><span class="bb-tag">DEMO FEED</span>' + winsHtml + winsHtml + "</div></div></div>");
      anchor.parentNode.insertBefore(feed, anchor.nextSibling);

      var rest = document.createElement("div");
      rest.innerHTML =
        /* showcase */
        '<div class="bb-section"><div class="bb-kicker">Playable showcase</div><div class="bb-h">Try it right here — Dice Roll</div>' +
        '<div class="bb-show"><div class="bb-sub">Demo balance: <span class="bb-bal" id="bbBal">GH₵ 1,000.00</span> · free play, same engine as the full game</div>' +
        '<div class="bb-diceface" id="bbFace"></div><div class="bb-msg" id="bbMsg">Pick a target, set your stake, roll.</div>' +
        '<div class="bb-sub">ROLL OVER <b id="bbTargetLbl" style="color:#ffd75e">50</b> · win chance <b id="bbChance" style="color:#ffd75e">49%</b> · pays <b id="bbMult" style="color:#ffd75e">×1.98</b></div>' +
        '<input class="bb-slider" id="bbTarget" type="range" min="5" max="90" value="50">' +
        '<div class="bb-ctl" id="bbStakes"></div>' +
        '<button class="bb-roll" id="bbRoll">ROLL</button>' +
        '<div class="bb-sub" style="margin-top:8px">Win pays stake × multiplier · 97% RTP design · <a href="/gh/casino/dice/index.html" style="color:#ffd75e">Open the full Dice Roll game</a></div></div></div>' +
        /* leaderboard */
        '<div class="bb-section"><div class="bb-kicker">Leaderboard · demo data</div><div class="bb-h">This week\'s top players</div><div class="bb-board">' +
        BOARD.map(function (r, i) {
          return '<div class="bb-row' + (i === 0 ? " first" : "") + '"><span><span class="rk">' + (i + 1) + "</span>" + r[0] + ' <span style="color:#999">· ' + r[1] + " · " + r[2] + '</span></span><span class="amt">GH₵ ' + r[3] + "</span></div>";
        }).join("") + "</div></div>" +
        /* promos */
        '<div class="bb-section"><div class="bb-kicker">Promotions</div><div class="bb-h">More play for your money</div><div class="bb-cards">' +
        '<div class="bb-card"><h3>Welcome Bonus — GH₵10 free</h3><p>Register with the code below and GH₵10 lands in your bonus wallet instantly. Stake-only, no deposit needed.</p><span class="bb-code">WELCOME</span></div>' +
        '<div class="bb-card"><h3>Friday Cash Race — GH₵25,000</h3><p>Every Friday spin earns race points. Top 100 players split the pot, paid as cash with no wagering.</p><span class="bb-soon">COMING SOON</span></div>' +
        '<div class="bb-card"><h3>Monday Cashback — 10% back</h3><p>Rough weekend? Get 10% of net losses back every Monday, up to GH₵500, credited automatically.</p><span class="bb-soon">COMING SOON</span></div>' +
        "</div></div>" +
        /* steps */
        '<div class="bb-section"><div class="bb-kicker">Start to cash-out</div><div class="bb-h">Three moves, that\'s it</div><div class="bb-steps">' +
        '<div class="bb-step"><span class="ghost">DEPOSIT</span><div class="n">STEP 01</div><h3>Deposit</h3><p>Top up with MTN MoMo, Telecel Cash, AirtelTigo, bank or card. Money lands instantly, no deposit fees.</p></div>' +
        '<div class="bb-step"><span class="ghost">PLAY</span><div class="n">STEP 02</div><h3>Play</h3><p>Stakes from GH₵1 across crash, slots, tables and arcade. Every game shows its RTP right on the tile.</p></div>' +
        '<div class="bb-step"><span class="ghost">CASH OUT</span><div class="n">STEP 03</div><h3>Cash out</h3><p>Withdraw winnings back to the same MoMo number you deposited from, straight to your phone.</p></div>' +
        "</div></div>" +
        /* responsible play */
        '<div class="bb-section"><div class="bb-rg"><b>18+ · Play responsibly.</b> Casino games are entertainment, not a way to make money. Set a deposit limit before you start, never chase losses, and take breaks. Under-18s are strictly prohibited. Demo figures on this page are for illustration only.</div></div>';
      var footer = document.querySelector("footer");
      if (footer) footer.parentNode.insertBefore(rest, footer); else document.body.appendChild(rest);
      setupDice();
    }
    return true;
  }

  /* --- playable dice showcase --- */
  var PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function drawFace(face, n) {
    face.innerHTML = "";
    for (var i = 0; i < 9; i++) {
      var d = document.createElement("i");
      if (PIPS[n].indexOf(i) >= 0) d.className = "on";
      face.appendChild(d);
    }
  }
  function setupDice() {
    var face = document.getElementById("bbFace"); if (!face) return;
    var bal = 1000, stake = 10, target = 50;
    var balEl = document.getElementById("bbBal"), msg = document.getElementById("bbMsg");
    var slider = document.getElementById("bbTarget"), rollBtn = document.getElementById("bbRoll");
    drawFace(face, 5);
    [5, 10, 25, 50, 100].forEach(function (s, i) {
      var b = el('<button class="bb-chip" aria-pressed="' + (s === 10) + '">GH₵ ' + s + "</button>");
      b.addEventListener("click", function () {
        stake = s;
        document.querySelectorAll("#bbStakes .bb-chip").forEach(function (c) { c.setAttribute("aria-pressed", "false"); });
        b.setAttribute("aria-pressed", "true");
      });
      document.getElementById("bbStakes").appendChild(b);
    });
    function upd() {
      var chance = 99 - target, mult = Math.floor((0.97 / (chance / 100)) * 100) / 100;
      document.getElementById("bbTargetLbl").textContent = target;
      document.getElementById("bbChance").textContent = chance + "%";
      document.getElementById("bbMult").textContent = "×" + mult.toFixed(2);
      return mult;
    }
    slider.addEventListener("input", function () { target = +slider.value; upd(); });
    upd();
    rollBtn.addEventListener("click", function () {
      if (bal < stake) { msg.textContent = "Demo balance too low — refreshing to GH₵ 1,000."; bal = 1000; balEl.textContent = "GH₵ 1,000.00"; return; }
      rollBtn.disabled = true; msg.className = "bb-msg"; msg.textContent = "Rolling…";
      face.classList.add("rolling");
      var ticks = 0;
      var iv = setInterval(function () { drawFace(face, 1 + Math.floor(Math.random() * 6)); if (++ticks > 9) clearInterval(iv); }, 70);
      setTimeout(function () {
        face.classList.remove("rolling");
        var roll = Math.floor(Math.random() * 100) + 1; // 1..100
        var faceN = Math.min(6, Math.max(1, Math.ceil(roll / 100 * 6)));
        drawFace(face, faceN);
        var mult = upd(), win = roll > target;
        if (win) { var pay = Math.floor(stake * mult * 100) / 100; bal += pay - stake; msg.className = "bb-msg win"; msg.textContent = "Rolled " + roll + " — you win GH₵ " + pay.toFixed(2) + "!"; }
        else { bal -= stake; msg.className = "bb-msg"; msg.textContent = "Rolled " + roll + " — no luck this time."; }
        balEl.textContent = "GH₵ " + bal.toFixed(2);
        rollBtn.disabled = false;
      }, 800);
    });
  }

  if (!init()) { document.addEventListener("DOMContentLoaded", init); setTimeout(init, 900); }
})();
