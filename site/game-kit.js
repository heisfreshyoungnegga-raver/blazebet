/* BlazeBet Real Games Kit — shared wallet, stakes, messages, history, cards.
   Money is integer pesewas everywhere. Balance persists across all kit games. */
(function () {
  "use strict";
  var KEY = "bb_demo_balance_v2";
  var bal = parseInt(localStorage.getItem(KEY) || "", 10);
  if (!isFinite(bal) || bal < 0) bal = 100000; // GH₵1,000.00

  function fmt(p) {
    return (p / 100).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function render() {
    var el = document.getElementById("gkBal");
    if (el) {
      el.textContent = fmt(bal);
      // F-L1: DEMO tag next to the game header balance (demo disclosure was
      // footer-only; a header screenshot alone read as a real balance).
      var tag = document.getElementById("gkDemoTag");
      if (!tag) {
        tag = document.createElement("span");
        tag.id = "gkDemoTag";
        tag.textContent = "DEMO";
        tag.style.cssText = "display:inline-block;background:#facc15;color:#04122e;font-size:10px;font-weight:800;letter-spacing:.06em;border-radius:6px;padding:2px 6px;margin-left:6px;vertical-align:middle";
        if (el.parentNode) el.parentNode.insertBefore(tag, el.nextSibling);
      }
    }
    var reset = document.getElementById("gkReset");
    if (reset) reset.classList.toggle("show", bal < 100);
  }
  function save() { localStorage.setItem(KEY, String(bal)); render(); }

  function stake() {
    var inp = document.getElementById("gkStake");
    var v = inp ? parseFloat(inp.value) : NaN;
    if (!isFinite(v) || v <= 0) return -1;
    return Math.round(v * 100);
  }
  function msg(text, kind) {
    var el = document.getElementById("gkMsg");
    if (!el) return;
    el.textContent = text;
    el.className = "gk-msg" + (kind ? " " + kind : "");
  }
  function history(label, kind) {
    var box = document.getElementById("gkHistory");
    if (!box) return;
    var s = document.createElement("span");
    s.className = "gk-hist" + (kind ? " " + kind : "");
    s.textContent = label;
    box.prepend(s);
    while (box.children.length > 12) box.removeChild(box.lastChild);
  }
  function burst(stageEl) {
    if (!stageEl) return;
    stageEl.classList.remove("gk-win-flash");
    void stageEl.offsetWidth;
    stageEl.classList.add("gk-win-flash");
    var layer = document.createElement("div");
    layer.className = "gk-burst";
    var colors = ["#2e8cff", "#7db4ff", "#ffffff", "#86efac", "#facc15"];
    for (var i = 0; i < 26; i++) {
      var p = document.createElement("i");
      var ang = Math.random() * Math.PI * 2, dist = 70 + Math.random() * 130;
      p.style.setProperty("--dx", Math.cos(ang) * dist + "px");
      p.style.setProperty("--dy", Math.sin(ang) * dist - 40 + "px");
      p.style.setProperty("--rot", (Math.random() * 540 - 270) + "deg");
      p.style.background = colors[i % colors.length];
      layer.appendChild(p);
    }
    stageEl.appendChild(layer);
    setTimeout(function () { layer.remove(); }, 1000);
  }
  function countUp(el, toP, prefix) {
    if (!el) return;
    var start = null, dur = 600;
    function step(ts) {
      if (!start) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      el.textContent = (prefix || "") + fmt(Math.round(toP * (1 - Math.pow(1 - t, 3))));
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  /* Playing cards: rank in {A,2..10,J,Q,K}, suit in {s,h,d,c} */
  var SUITS = { s: "\u2660", h: "\u2665", d: "\u2666", c: "\u2663" };
  function cardHTML(rank, suit, down) {
    var red = suit === "h" || suit === "d";
    return '<div class="gk-card' + (red ? " red" : "") + (down ? " down" : "") + '">' +
      '<span class="r">' + rank + '</span><span class="s">' + SUITS[suit] + '</span>' +
      '<span class="big-s">' + SUITS[suit] + "</span></div>";
  }
  function newDeck() {
    var ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"], suits = ["s", "h", "d", "c"], d = [];
    suits.forEach(function (s) { ranks.forEach(function (r) { d.push({ r: r, s: s }); }); });
    for (var i = d.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = d[i]; d[i] = d[j]; d[j] = t; }
    return d;
  }
  function cardValue(r) { return r === "A" ? 11 : ("KQJ".indexOf(r) >= 0 ? 10 : parseInt(r, 10)); }

  window.BB = {
    fmt: fmt,
    balance: function () { return bal; },
    stake: stake,
    msg: msg,
    history: history,
    burst: burst,
    countUp: countUp,
    cardHTML: cardHTML,
    newDeck: newDeck,
    cardValue: cardValue,
    rand: function (n) { return Math.floor(Math.random() * n); },
    pick: function (arr) { return arr[Math.floor(Math.random() * arr.length)]; },
    debit: function (p) { if (p > bal) return false; bal -= p; save(); return true; },
    credit: function (p) { bal += p; save(); },
    /* Full round trip: validate stake, debit, return stake pesewas or 0 with message */
    placeBet: function () {
      var s = stake();
      if (s < 0) { msg("Enter a stake first.", "lose"); return 0; }
      if (s > bal) { msg("Not enough demo balance for that stake.", "lose"); return 0; }
      bal -= s; save();
      return s;
    },
    settle: function (stakeP, multiplier, label) {
      var win = Math.round(stakeP * multiplier);
      if (win > 0) { bal += win; save(); }
      return win;
    },
    render: render
  };

  document.addEventListener("DOMContentLoaded", function () {
    render();
    document.querySelectorAll("[data-chip]").forEach(function (b) {
      b.addEventListener("click", function () {
        var inp = document.getElementById("gkStake");
        if (inp) { inp.value = b.getAttribute("data-chip"); inp.dispatchEvent(new Event("input")); }
      });
    });
    var half = document.getElementById("gkHalf"), dbl = document.getElementById("gkDouble");
    if (half) half.addEventListener("click", function () { var i = document.getElementById("gkStake"); if (i) i.value = Math.max(1, Math.floor((parseFloat(i.value) || 0) / 2)); });
    if (dbl) dbl.addEventListener("click", function () { var i = document.getElementById("gkStake"); if (i) i.value = Math.max(1, Math.floor((parseFloat(i.value) || 0) * 2)); });
    var reset = document.getElementById("gkReset");
    if (reset) reset.addEventListener("click", function () { bal = 100000; save(); msg("Demo balance topped back up to GH\u20B51,000.00."); });
  });
})();
