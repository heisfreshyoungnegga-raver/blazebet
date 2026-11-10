/* BlazeBet adapter — bb-app.js
   Plain JS, no dependencies. Wires the static capture to the BlazeBet API.
   API base: localStorage 'bb_api' > window.BB_API > https://blazebet-api.vercel.app
   Auth token: localStorage 'bb_token'. Money: GH₵ with 2 decimals. No emoji. */
(function () {
  'use strict';
  var API_DEFAULT = 'https://blazebet-api.vercel.app';
  // F-M1: validate a stored override before trusting it — https only, or http
  // only for localhost. An invalid/stale override is ignored (never silently
  // redirects the player site). Player override key is 'bb_api'; portals use
  // the separate 'bb_api_admin' key so a portal test value cannot hijack this site.
  function validApiBase(v) {
    if (!v || typeof v !== 'string') return false;
    try {
      var u = new URL(v.trim());
      if (u.protocol === 'https:') return true;
      if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    } catch (e) { return false; }
    return false;
  }
  var API = (function () {
    try { var o = localStorage.getItem('bb_api'); if (o && validApiBase(o)) return o.replace(/\/$/, ''); } catch (e) {}
    if (window.BB_API && validApiBase(String(window.BB_API))) return String(window.BB_API).replace(/\/$/, '');
    return API_DEFAULT;
  })();
  function apiBaseIsOverride() { return API !== API_DEFAULT; }
  var TOKEN_KEY = 'bb_token';
  function token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function money(n) {
    var v = Number(n); if (!isFinite(v)) v = 0;
    return 'GH₵' + v.toFixed(2);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function qs(name) {
    try { var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search); return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
  }
  var API_TIMEOUT_MS = 18000; // F-H5: ~18s fetch timeout everywhere
  // F-M2: a dead/expired token must not leave a half-logged-in state.
  function clearDeadToken() {
    setToken('');
    var chip = document.getElementById('bb-balance-chip');
    if (chip) chip.remove();
    var mb = document.getElementById('bb-my-bets-btn'); if (mb) mb.remove();
    var lo = document.getElementById('bb-logout-btn'); if (lo) lo.remove();
    renderHeaderChip();
  }
  // Every API call wrapped: never throws, returns {ok, status, data}
  async function api(method, path, body) {
    var ctrl = null, timer = null;
    try {
      if (typeof AbortController !== 'undefined') { ctrl = new AbortController(); timer = setTimeout(function () { ctrl.abort(); }, API_TIMEOUT_MS); }
      var headers = { 'Content-Type': 'application/json' };
      var t = token(); if (t) headers.Authorization = 'Bearer ' + t;
      var opts = { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined };
      if (ctrl) opts.signal = ctrl.signal;
      var res = await fetch(API + path, opts);
      if (timer) clearTimeout(timer);
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      // F-M2: 401 from /api/me or /api/wallet clears the dead token and
      // switches the header chip back to Login (no half-logged-in state).
      if (res.status === 401 && (path === '/api/me' || path === '/api/wallet')) clearDeadToken();
      return { ok: res.ok, status: res.status, data: data || {} };
    } catch (e) {
      if (timer) clearTimeout(timer);
      var timedOut = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
      return { ok: false, status: 0, data: { error: timedOut ? 'request_timeout' : 'network_error', message: timedOut ? 'The request timed out. Check your connection and tap retry.' : 'Could not reach the BlazeBet server. Check your connection and try again.' } };
    }
  }
  function errText(r) {
    if (!r) return 'Something went wrong.';
    if (r.status === 0) return (r.data && r.data.error === 'request_timeout') ? 'The request timed out. Check your connection and try again.' : 'Could not reach the BlazeBet server.';
    var d = r.data || {};
    var map = {
      invalid_credentials: 'Wrong phone number or password.',
      locked_try_later: 'Too many failed attempts. Try again in 15 minutes.',
      account_blocked: 'This account is blocked. Contact support.',
      account_exists: 'An account with this phone number already exists.',
      phone_and_password_required: 'Enter your phone number and password.',
      invalid_promo_code: 'That promo code is not valid.',
      invalid_or_expired_invite: 'That invite link is invalid or expired.',
      registration_closed: 'Registration is closed right now.',
      unauthorized: 'Please log in first.',
      insufficient_funds: 'Insufficient balance for this amount.',
      below_min_stake: 'Stake is below the minimum.',
      above_max_payout: 'Potential payout is above the maximum.',
      match_not_open: 'That match is no longer open for betting.',
      betting_locked: 'Betting is locked on that match.',
      bad_pick: 'That selection is not available.',
      bad_bet: 'Add at least one selection and enter a stake.',
      bet_not_open: 'That bet is no longer open.',
      no_cashout_value: 'No cash-out value is available for this bet.',
      maintenance: 'BlazeBet is under maintenance. Try again shortly.',
      provider_not_configured: 'Payments not connected yet — deposits open once the operator connects the provider.',
      withdrawal_not_eligible: 'Withdrawal not eligible yet.',
      invalid_amount: 'That amount is not valid. Enter an amount above GH₵0.00.',
      invalid_phone: 'That phone number is not valid. Check it and try again.',
      invalid_network: 'That network is not supported for this deposit. Try another number or method.',
      payment_in_progress: 'A payment is already in progress for this number. Wait for it to finish before starting another.',
      number_blocked: 'This number is temporarily blocked by the payment provider. Try a different number or try again later.',
      provider_unreachable: 'The payment provider could not be reached. Try again in a moment.',
      provider_rejected: 'The payment provider rejected this deposit. Check the details and try again.',
      request_timeout: 'The request timed out. Check your connection and try again.',
      network_error: 'Could not reach the BlazeBet server. Check your connection and try again.',
      not_found: 'Not found.'
    };
    if (d.error && map[d.error]) return map[d.error];
    return d.error || d.message || ('Request failed (HTTP ' + r.status + ').');
  }
  function showErr(box, r) {
    if (!box) return;
    box.textContent = errText(r);
    box.style.display = 'block';
  }
  function hideErr(box) { if (box) { box.textContent = ''; box.style.display = 'none'; } }

  /* ---------- styles ---------- */
  var CSS = [
    '#bb-balance-chip{display:inline-flex;align-items:center;gap:6px;background:#0b63e5;color:#fff;border:0;border-radius:999px;padding:7px 12px;font:600 13px/1 "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer;white-space:nowrap;text-decoration:none}',
    '#bb-balance-chip .bb-bonus{opacity:.8;font-weight:400;font-size:11px}',
    '#bb-balance-chip.bb-logged-out{background:#fff;color:#0b63e5;border:1.5px solid #0b63e5}',
    '.bb-btn{background:#0b63e5;color:#fff;border:0;border-radius:10px;padding:10px 14px;font:700 14px "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer}',
    '.bb-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.bb-btn.bb-ghost{background:#fff;color:#0b63e5;border:1.5px solid #0b63e5}',
    '.bb-btn.bb-danger{background:#fff;color:#b42318;border:1.5px solid #b42318}',
    '.bb-btn.bb-sm{padding:7px 10px;font-size:12px;border-radius:8px}',
    '.bb-error{display:none;background:#fdecea;color:#8f1d13;border:1px solid #f5c6c0;border-radius:10px;padding:10px 12px;font-size:13px;margin:10px 0}',
    '.bb-notice{background:#eef4ff;color:#062a5e;border:1px solid #c7dbff;border-radius:10px;padding:10px 12px;font-size:13px;margin:10px 0}',
    '.bb-ok{background:#e7f6ec;color:#14532d;border:1px solid #bfe6c9;border-radius:10px;padding:10px 12px;font-size:13px;margin:10px 0}',
    '.bb-panel{background:#fff;border:1px solid #dbe7fb;border-radius:14px;padding:14px;margin:12px 0;color:#062a5e}',
    '@media(min-width:1024px){#bb-matches{margin-left:88px;margin-right:16px}.bb-slip{left:88px}}',
    '.bb-panel h2{font:800 17px "Plus Jakarta Sans",system-ui,sans-serif;margin:0 0 10px;color:#062a5e}',
    '.bb-panel h3{font:700 14px "Plus Jakarta Sans",system-ui,sans-serif;margin:14px 0 8px;color:#062a5e}',
    '.bb-panel label{display:block;font-size:12px;font-weight:600;color:#33415e;margin:10px 0 4px}',
    '.bb-input,.bb-panel input,.bb-panel select{width:100%;box-sizing:border-box;border:1.5px solid #c7d6f2;border-radius:10px;padding:10px 12px;font-size:14px;background:#fff;color:#062a5e}',
    '.bb-input:focus,.bb-panel input:focus,.bb-panel select:focus{outline:2px solid #0b63e5;outline-offset:1px}',
    '.bb-match{border:1px solid #dbe7fb;border-radius:12px;padding:10px 12px;margin:8px 0;background:#fff}',
    '.bb-match .bb-league{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#0b63e5}',
    '.bb-match .bb-teams{font:700 14px "Plus Jakarta Sans",system-ui,sans-serif;color:#062a5e;margin:4px 0}',
    '.bb-match .bb-meta{font-size:12px;color:#5b6b8c}',
    '.bb-live{display:inline-block;background:#e02424;color:#fff;border-radius:6px;padding:2px 7px;font-size:11px;font-weight:700;margin-left:6px}',
    '.bb-odds{display:flex;gap:8px;margin-top:8px}',
    '.bb-odd{flex:1;border:1.5px solid #0b63e5;background:#fff;color:#0b63e5;border-radius:10px;padding:8px 4px;font:700 13px "Plus Jakarta Sans",system-ui,sans-serif;cursor:pointer;text-align:center}',
    '.bb-odd small{display:block;font-size:10px;font-weight:600;color:#5b6b8c}',
    '.bb-odd.bb-picked{background:#0b63e5;color:#fff}',
    '.bb-odd.bb-picked small{color:#dbeafe}',
    '.bb-slip{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#fff;border-top:2px solid #0b63e5;box-shadow:0 -6px 24px rgba(6,42,94,.18);padding:12px 14px calc(12px + env(safe-area-inset-bottom));color:#062a5e;max-height:62vh;overflow:auto}',
    '.bb-slip h3{margin:0 0 8px;font:800 15px "Plus Jakarta Sans",system-ui,sans-serif}',
    '.bb-slip-leg{display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:6px 0;border-bottom:1px solid #e6eefc}',
    '.bb-slip-row{display:flex;gap:8px;align-items:center;margin-top:10px}',
    '.bb-slip-row input{flex:1}',
    '.bb-overlay{position:fixed;inset:0;z-index:9998;background:rgba(6,42,94,.45);display:flex;justify-content:flex-end}',
    '.bb-drawer{background:#fff;width:min(430px,94vw);height:100%;overflow:auto;padding:16px;color:#062a5e}',
    '.bb-drawer h2{font:800 18px "Plus Jakarta Sans",system-ui,sans-serif;margin:0 0 4px}',
    '.bb-tx{display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:7px 0;border-bottom:1px solid #e6eefc}',
    '.bb-bet{border:1px solid #dbe7fb;border-radius:12px;padding:10px 12px;margin:8px 0;background:#fff}',
    '.bb-bet .bb-code{font-weight:700;color:#0b63e5}',
    '.bb-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}',
    '.bb-tab{border:1.5px solid #c7d6f2;background:#fff;color:#062a5e;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer}',
    '.bb-tab.bb-active{background:#0b63e5;color:#fff;border-color:#0b63e5}',
    '.bb-close{float:right;background:none;border:0;font-size:20px;cursor:pointer;color:#062a5e;line-height:1}',
    '.bb-muted{font-size:12px;color:#5b6b8c}',
    '.bb-row-between{display:flex;justify-content:space-between;align-items:center;gap:8px}',
    '.bb-wallet-line{display:flex;justify-content:space-between;font-size:14px;padding:6px 0;border-bottom:1px solid #e6eefc}'
  ].join('\n');
  function injectCSS() {
    if (document.getElementById('bb-style')) return;
    var st = document.createElement('style');
    st.id = 'bb-style'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ---------- capture quirk: real content hidden behind a "Loading" skeleton ----------
     On login / signup / home the capture froze a Next.js route transition: the real
     <main> sits inside a <div hidden> and the visible main only says "Loading".
     Reveal the real main and hide the skeleton, or no form/board is reachable. */
  var realMain = null;
  function revealHiddenContent() {
    var hiddenMains = Array.prototype.filter.call(document.querySelectorAll('main'), function (m) { return m.closest('[hidden]'); });
    if (!hiddenMains.length) return;
    hiddenMains.forEach(function (m) {
      var a = m.closest('[hidden]');
      if (a) { a.removeAttribute('hidden'); a.removeAttribute('inert'); a.removeAttribute('aria-hidden'); a.style.display = ''; }
      if (!realMain) realMain = m;
    });
    // The frozen route transition leaves a second, skeleton <main> behind
    // (it just says "Loading"): hide every main except the real one, or the
    // page shows the skeleton above/below the real content.
    Array.prototype.forEach.call(document.querySelectorAll('main'), function (m) {
      if (m !== realMain) m.style.display = 'none';
    });
    // The app shell keeps min-height:100dvh even with its skeleton hidden,
    // which pushes the revealed content exactly one screen below the fold
    // (login form and home board both rendered off-screen). Collapse every
    // min-h-dvh ancestor of the skeleton to its real content height (the
    // header/sidebar) — there are two nested ones (player-density shell and
    // app-shell), so closest() alone only fixed the inner one.
    var skel = null;
    Array.prototype.forEach.call(document.querySelectorAll('main'), function (m) { if (m !== realMain && !skel) skel = m; });
    var anc = skel;
    while (anc && anc !== document.body) {
      if (anc.classList && anc.classList.contains('min-h-dvh')) anc.style.minHeight = '0px';
      anc = anc.parentElement;
    }
    // The skeleton <main> sits inside a content wrapper that may itself hold
    // other skeleton blocks (home: a 559px loading area outside the <main>).
    // Hide that wrapper — the skeleton main's ancestor that is a direct
    // child of the app shell — so the shell collapses to the header alone.
    // (Header and sidebar are separate shell children and stay visible.)
    var wrap = skel;
    while (wrap && wrap.parentElement && !(wrap.parentElement.classList && wrap.parentElement.classList.contains('app-shell'))) wrap = wrap.parentElement;
    if (wrap && wrap.parentElement) wrap.style.display = 'none';
  }
  function contentMain() {
    if (realMain) return realMain;
    return document.querySelector('main');
  }
  var walletCache = null;
  async function refreshWallet() {
    if (!token()) { walletCache = null; return null; }
    var r = await api('GET', '/api/wallet');
    if (r.ok) walletCache = r.data;
    return walletCache;
  }
  function headerHost() {
    var inner = document.querySelector('header .desktop-header-inner') ||
      document.querySelector('header div[class*="mx-auto"][class*="flex"]') ||
      document.querySelector('header');
    return inner;
  }
  function renderHeaderChip() {
    var host = headerHost();
    if (!host || document.getElementById('bb-balance-chip')) return;
    var chip = document.createElement('button');
    chip.type = 'button'; chip.id = 'bb-balance-chip';
    chip.setAttribute('aria-label', 'Wallet and account');
    chip.setAttribute('title', 'API base: ' + API + (apiBaseIsOverride() ? ' (override)' : ''));
    chip.dataset.apiBase = API;
    if (!token()) {
      chip.classList.add('bb-logged-out');
      chip.textContent = 'Login';
      chip.addEventListener('click', function () { location.href = '/gh/login/'; });
    } else {
      chip.textContent = 'Loading balance...';
      chip.addEventListener('click', function () { openWalletDrawer(); });
      refreshWallet().then(function (w) {
        if (!w) { chip.textContent = 'Wallet'; return; }
        chip.innerHTML = '<span>' + esc(money(w.main)) + '</span>' +
          (Number(w.bonus) > 0 ? '<span class="bb-bonus">Bonus ' + esc(money(w.bonus)) + '</span>' : '');
      });
      var betsBtn = document.createElement('button');
      betsBtn.type = 'button'; betsBtn.className = 'bb-btn bb-ghost bb-sm'; betsBtn.id = 'bb-my-bets-btn';
      betsBtn.textContent = 'My Bets';
      betsBtn.addEventListener('click', function () { openBetsDrawer(); });
      host.appendChild(betsBtn);
      var outBtn = document.createElement('button');
      outBtn.type = 'button'; outBtn.className = 'bb-btn bb-ghost bb-sm'; outBtn.id = 'bb-logout-btn';
      outBtn.textContent = 'Logout';
      outBtn.addEventListener('click', function () { window.BB.logout(); });
      host.appendChild(outBtn);
    }
    host.appendChild(chip);
  }

  /* ---------- drawers (wallet / bets) ---------- */
  function closeOverlay() { var o = document.getElementById('bb-overlay'); if (o) o.remove(); }
  function makeOverlay(title) {
    closeOverlay();
    var o = document.createElement('div');
    o.className = 'bb-overlay'; o.id = 'bb-overlay';
    o.addEventListener('click', function (e) { if (e.target === o) closeOverlay(); });
    var d = document.createElement('div');
    d.className = 'bb-drawer';
    d.innerHTML = '<button type="button" class="bb-close" aria-label="Close">×</button><h2>' + esc(title) + '</h2><div class="bb-drawer-body"></div>';
    d.querySelector('.bb-close').addEventListener('click', closeOverlay);
    o.appendChild(d);
    document.body.appendChild(o);
    return d.querySelector('.bb-drawer-body');
  }

  function walletHTML() {
    return '' +
      '<div class="bb-error" data-bb="err"></div>' +
      '<div class="bb-wallet-line"><span>Main balance</span><strong data-bb="main">—</strong></div>' +
      '<div class="bb-wallet-line"><span>Bonus balance (stake-only)</span><strong data-bb="bonus">—</strong></div>' +
      '<h3>Deposit</h3>' +
      '<label for="bb-dep-amount">Amount (GH₵)</label>' +
      '<input id="bb-dep-amount" class="bb-input" type="number" min="1" step="0.01" placeholder="100.00">' +
      '<label for="bb-dep-phone">MoMo phone number</label>' +
      '<input id="bb-dep-phone" class="bb-input" type="tel" placeholder="024 000 0000">' +
      '<div class="bb-slip-row">' +
      '<button type="button" class="bb-btn" data-bb="dep-momo" style="flex:1">Deposit with MoMo</button>' +
      '<button type="button" class="bb-btn bb-ghost" data-bb="dep-flw" style="flex:1">Card / Bank</button>' +
      '</div>' +
      '<div class="bb-slip-row"><button type="button" class="bb-btn bb-ghost" data-bb="dep-manual" style="flex:1">Manual MoMo request instead</button></div>' +
      '<div class="bb-notice" data-bb="dep-msg" style="display:none"></div>' +
      '<h3>Withdraw</h3>' +
      '<p class="bb-muted">Withdrawals need GH₵600.00 in completed deposits first. The request goes to an admin for approval.</p>' +
      '<label for="bb-wd-amount">Amount (GH₵)</label>' +
      '<input id="bb-wd-amount" class="bb-input" type="number" min="1" step="0.01" placeholder="50.00">' +
      '<label for="bb-wd-bank">Bank / network</label>' +
      '<input id="bb-wd-bank" class="bb-input" type="text" placeholder="e.g. MTN MoMo, GCB Bank">' +
      '<label for="bb-wd-acc">Account number</label>' +
      '<input id="bb-wd-acc" class="bb-input" type="text" placeholder="Account or MoMo number">' +
      '<label for="bb-wd-name">Account name</label>' +
      '<input id="bb-wd-name" class="bb-input" type="text" placeholder="Full name on the account">' +
      '<div class="bb-slip-row"><button type="button" class="bb-btn" data-bb="withdraw" style="flex:1">Request withdrawal</button></div>' +
      '<div class="bb-notice" data-bb="wd-msg" style="display:none"></div>' +
      '<h3>Referrals</h3><div data-bb="referrals"><p class="bb-muted">Loading referrals...</p></div>' +
      '<h3>Recent transactions</h3><div data-bb="tx"><p class="bb-muted">Loading transactions...</p></div>';
  }
  function fillWalletInto(root) {
    if (!root) return;
    var err = root.querySelector('[data-bb="err"]');
    var mainEl = root.querySelector('[data-bb="main"]');
    var bonusEl = root.querySelector('[data-bb="bonus"]');
    var txEl = root.querySelector('[data-bb="tx"]');
    var refEl = root.querySelector('[data-bb="referrals"]');
    var depMsg = root.querySelector('[data-bb="dep-msg"]');
    var wdMsg = root.querySelector('[data-bb="wd-msg"]');
    function note(el, text, ok) {
      if (!el) return;
      el.textContent = text; el.style.display = 'block';
      el.className = ok ? 'bb-ok' : 'bb-notice';
    }
    refreshWallet().then(function (w) {
      if (!w) { if (err) showErr(err, { status: 401, data: { error: 'unauthorized' } }); return; }
      if (mainEl) mainEl.textContent = money(w.main);
      if (bonusEl) bonusEl.textContent = money(w.bonus);
      if (txEl) {
        var tx = w.transactions || [];
        if (!tx.length) txEl.innerHTML = '<p class="bb-muted">No transactions yet.</p>';
        else txEl.innerHTML = tx.slice(0, 50).map(function (t) {
          var amt = Number(t.amount || 0);
          return '<div class="bb-tx"><span>' + esc(t.kind || 'transaction') +
            '<br><span class="bb-muted">' + esc(t.created_at || '') + '</span></span>' +
            '<strong style="color:' + (amt < 0 ? '#b42318' : '#14532d') + '">' +
            (amt < 0 ? '−' : '+') + esc(money(Math.abs(amt))) + '</strong></div>';
        }).join('');
      }
    });
    // F-L5: referrals must surface an error state (not silent dashes) when
    // /api/referrals fails or returns nulls (money audit M1). Retryable.
    function loadReferrals() {
      if (!refEl) return;
      refEl.innerHTML = '<p class="bb-muted">Loading referrals...</p>';
      api('GET', '/api/referrals').then(function (r) {
      if (!r.ok || !r.data || (r.data.refCode == null && r.data.referred == null && r.data.commissionEarned == null)) {
        refEl.innerHTML = '<p class="bb-muted">Could not load referrals' + (r && !r.ok ? ': ' + esc(errText(r)) : ' — the server returned no referral data') + '.</p>' +
          '<button type="button" class="bb-btn bb-sm" data-bb="ref-retry">Retry</button>';
        var rb = refEl.querySelector('[data-bb="ref-retry"]');
        if (rb) rb.addEventListener('click', loadReferrals);
        return;
      }
      var d = r.data;
      var link = location.origin + '/gh/signup/?ref=' + encodeURIComponent(d.refCode || '');
      refEl.innerHTML =
        '<div class="bb-wallet-line"><span>Your referral code</span><strong>' + esc(d.refCode || '—') + '</strong></div>' +
        '<div class="bb-wallet-line"><span>People referred</span><strong>' + esc(d.referred || 0) + '</strong></div>' +
        '<div class="bb-wallet-line"><span>Commission earned</span><strong>' + esc(money(d.commissionEarned || 0)) + '</strong></div>' +
        '<div class="bb-wallet-line"><span>Commission rate</span><strong>' + esc(d.commissionPct != null ? d.commissionPct + '% of first deposit' : '—') + '</strong></div>' +
        '<label>Your referral link</label>' +
        '<div class="bb-slip-row"><input class="bb-input" type="text" readonly value="' + esc(link) + '" data-bb="ref-link">' +
        '<button type="button" class="bb-btn bb-sm" data-bb="ref-copy">Copy link</button></div>';
      var copyBtn = refEl.querySelector('[data-bb="ref-copy"]');
      if (copyBtn) copyBtn.addEventListener('click', function () {
        var input = refEl.querySelector('[data-bb="ref-link"]');
        var done = function () { copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy link'; }, 2000); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(done, function () { input.select(); document.execCommand('copy'); done(); });
        else { input.select(); document.execCommand('copy'); done(); }
      });
      });
    }
    loadReferrals();
    function amountOf(sel) {
      var el = root.querySelector(sel);
      return el ? parseFloat(el.value) : NaN;
    }
    var momoBtn = root.querySelector('[data-bb="dep-momo"]');
    if (momoBtn) momoBtn.addEventListener('click', async function () {
      hideErr(err);
      var amount = amountOf('#bb-dep-amount');
      var phone = (root.querySelector('#bb-dep-phone') || {}).value || '';
      if (!amount || amount <= 0) { note(depMsg, 'Enter an amount above GH₵0.00.', false); return; }
      if (!phone.trim()) { note(depMsg, 'Enter the MoMo phone number for the prompt.', false); return; }
      // F-M3: disclose the 2.5% MoMo charge BEFORE sending. First tap shows
      // "You will be charged GH₵X (GH₵Y credited)"; second tap sends it.
      var charged = Math.round(amount * 1.025 * 100) / 100;
      if (momoBtn.dataset.armed !== '1' || momoBtn.dataset.chargeFor !== String(amount) + '|' + phone.trim()) {
        momoBtn.dataset.armed = '1'; momoBtn.dataset.chargeFor = String(amount) + '|' + phone.trim();
        note(depMsg, 'You will be charged ' + money(charged) + ' (' + money(amount) + ' credited). Tap "Deposit with MoMo" again to confirm.', false);
        momoBtn.textContent = 'Confirm — charged ' + money(charged);
        return;
      }
      momoBtn.dataset.armed = ''; momoBtn.textContent = 'Deposit with MoMo';
      momoBtn.disabled = true;
      try {
        var r = await api('POST', '/api/wallet/deposit-momo', { phone: phone.trim(), amount: amount });
        // Server may return the exact charged total; prefer it in the message.
        var serverCharged = r.data && r.data.charged_total_ghs != null ? Number(r.data.charged_total_ghs) : charged;
        if (r.status === 503 || r.status === 404 || (r.data && r.data.error === 'provider_not_configured')) {
          note(depMsg, 'Payments not connected yet — deposits open once the operator connects the provider.', false);
        } else if (!r.ok) {
          note(depMsg, errText(r), false);
        } else {
          note(depMsg, 'Deposit prompt sent to ' + phone.trim() + ' — you will be charged ' + money(serverCharged) + ' (' + money(amount) + ' credited). Approve the MoMo prompt on your phone to complete it.', true);
        }
      } finally { momoBtn.disabled = false; }
    });
    var flwBtn = root.querySelector('[data-bb="dep-flw"]');
    if (flwBtn) flwBtn.addEventListener('click', async function () {
      hideErr(err);
      var amount = amountOf('#bb-dep-amount');
      if (!amount || amount <= 0) { note(depMsg, 'Enter an amount above GH₵0.00.', false); return; }
      flwBtn.disabled = true;
      try {
        // F-B1 client note: left as-is — backend currency conversion lands in
        // Phase 2 and both deploy together. No client-side FX conversion.
        var r = await api('POST', '/api/wallet/deposit-flutterwave', { amount: amount });
        if (r.status === 503 || r.status === 404 || (r.data && r.data.error === 'provider_not_configured')) {
          note(depMsg, 'Payments not connected yet — deposits open once the operator connects the provider.', false);
        } else if (!r.ok) {
          note(depMsg, errText(r), false);
        } else if (r.data.checkoutUrl || r.data.url || r.data.link) {
          location.href = r.data.checkoutUrl || r.data.url || r.data.link;
        } else {
          note(depMsg, 'Card / bank deposit started. Follow the checkout link if one was provided.', true);
        }
      } finally { flwBtn.disabled = false; }
    });
    var manualBtn = root.querySelector('[data-bb="dep-manual"]');
    if (manualBtn) manualBtn.addEventListener('click', async function () {
      hideErr(err);
      var amount = amountOf('#bb-dep-amount');
      if (!amount || amount <= 0) { note(depMsg, 'Enter an amount above GH₵0.00.', false); return; }
      manualBtn.disabled = true;
      try {
        var r = await api('POST', '/api/wallet/request', { type: 'deposit', amount: amount, method: 'momo' });
        if (!r.ok) note(depMsg, errText(r), false);
        else note(depMsg, 'Manual deposit request sent (request #' + (r.data.requestId || '') + '). It is pending until an admin confirms it. Send the MoMo payment and keep your reference.', true);
      } finally { manualBtn.disabled = false; }
    });
    var wdBtn = root.querySelector('[data-bb="withdraw"]');
    if (wdBtn) wdBtn.addEventListener('click', async function () {
      hideErr(err);
      var amount = amountOf('#bb-wd-amount');
      var bank = (root.querySelector('#bb-wd-bank') || {}).value || '';
      var acc = (root.querySelector('#bb-wd-acc') || {}).value || '';
      var name = (root.querySelector('#bb-wd-name') || {}).value || '';
      if (!amount || amount <= 0) { note(wdMsg, 'Enter an amount above GH₵0.00.', false); return; }
      if (!bank.trim() || !acc.trim() || !name.trim()) { note(wdMsg, 'Enter your bank, account number and account name.', false); return; }
      wdBtn.disabled = true;
      try {
      var r = await api('POST', '/api/wallet/request', { type: 'withdrawal', amount: amount, method: 'bank', bank: bank.trim(), accountNumber: acc.trim(), accountName: name.trim() });
      if (!r.ok) {
        if (r.data && r.data.error === 'withdrawal_not_eligible') {
          var req = r.data.required != null ? money(r.data.required) : 'GH₵600.00';
          var dep = r.data.deposited != null ? money(r.data.deposited) : r.data.achieved != null ? money(r.data.achieved) : null;
          note(wdMsg, 'Withdrawal not eligible yet. You need ' + req + ' in completed deposits' + (dep ? ' — you have deposited ' + dep + ' so far' : '') + '.', false);
        } else {
          note(wdMsg, errText(r), false);
        }
      } else {
        note(wdMsg, 'Withdrawal request sent (request #' + (r.data.requestId || '') + '). It is pending until a super admin approves it.', true);
        refreshWallet();
      }
      } finally { wdBtn.disabled = false; }
    });
  }
  function openWalletDrawer() {
    if (!token()) { location.href = '/gh/login/'; return; }
    var body = makeOverlay('Wallet');
    body.innerHTML = walletHTML();
    fillWalletInto(body);
  }

  /* ---------- My Bets ---------- */
  // F-L3: no upfront 10-bet leg cap. Legs come with /api/bets when the
  // server returns them; otherwise they are enriched on expand (per bet, on
  // tap) instead of capping the list with "not returned". Booking-code
  // lookups go through api(), which already sends the bearer token — the
  // server will require auth + ownership in Phase 2 and the client is ready.
  async function loadMyBets() {
    var r = await api('GET', '/api/bets');
    if (!r.ok) return { ok: false, error: r };
    return { ok: true, bets: r.data.bets || [] };
  }
  async function loadBetLegs(b) {
    if (!b.code) return null;
    try {
      var cr = await api('GET', '/api/bets/code/' + encodeURIComponent(b.code));
      if (cr.ok && cr.data && cr.data.bet && Array.isArray(cr.data.bet.legs)) return cr.data.bet.legs;
      if (cr.ok && Array.isArray(cr.data.legs)) return cr.data.legs;
      return null;
    } catch (e) { return null; }
  }
  function betLegsHTML(b) {
    if (!Array.isArray(b.legs) || !b.legs.length) return '';
    return b.legs.map(function (l) {
      var name = l.matchName || l.match || ((l.home || '') + (l.away ? ' vs ' + l.away : '')) || ('Match ' + (l.matchId || l.match_id || ''));
      return '<div class="bb-tx"><span>' + esc(name) + '<br><span class="bb-muted">' +
        esc(l.market || '1X2') + ' — pick ' + esc(l.pick) + ' @ ' + esc(l.odds) + ' · ' + esc(l.status || 'pending') +
        '</span></span></div>';
    }).join('');
  }
  function openBetsDrawer() {
    if (!token()) { location.href = '/gh/login/'; return; }
    var body = makeOverlay('My Bets');
    body.innerHTML = '<div class="bb-error" data-bb="err"></div><div data-bb="list"><p class="bb-muted">Loading your bets...</p></div>';
    var list = body.querySelector('[data-bb="list"]');
    var err = body.querySelector('[data-bb="err"]');
    loadMyBets().then(function (res) {
      if (!res.ok) { showErr(err, res.error); list.innerHTML = ''; return; }
      var bets = res.bets;
      if (!bets.length) { list.innerHTML = '<p class="bb-muted">You have no bets yet. Place one from the sports board.</p>'; return; }
      list.innerHTML = bets.map(function (b) {
        return '<div class="bb-bet" data-bet="' + b.id + '">' +
          '<div class="bb-row-between"><span>Booking code <span class="bb-code">' + esc(b.code || '') + '</span></span>' +
          '<span>' + esc(b.status || '') + '</span></div>' +
          betLegsHTML(b) +
          '<div class="bb-wallet-line"><span>Stake</span><strong>' + esc(money(b.stake)) + '</strong></div>' +
          '<div class="bb-wallet-line"><span>Potential return</span><strong>' + esc(money(b.potential)) + '</strong></div>' +
          (b.payout != null ? '<div class="bb-wallet-line"><span>Paid out</span><strong>' + esc(money(b.payout)) + '</strong></div>' : '') +
          (Array.isArray(b.legs) && b.legs.length ? '' : '<div class="bb-slip-row"><button type="button" class="bb-btn bb-ghost bb-sm" data-bb="show-legs" data-code="' + esc(b.code || '') + '">View legs</button>' +
          '<span class="bb-muted" data-bb="legs-msg"></span></div><div data-bb="legs-out"></div>') +
          (b.status === 'open' ? '<div class="bb-slip-row"><button type="button" class="bb-btn bb-sm" data-bb="cashout" data-id="' + b.id + '">Cash Out</button>' +
          '<span class="bb-muted" data-bb="cashout-msg"></span></div>' : '') +
          '</div>';
      }).join('');
      list.querySelectorAll('[data-bb="show-legs"]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var card = btn.closest('.bb-bet');
          var out = card ? card.querySelector('[data-bb="legs-out"]') : null;
          var msg = card ? card.querySelector('[data-bb="legs-msg"]') : null;
          btn.disabled = true;
          if (msg) msg.textContent = 'Loading legs...';
          try {
            var legs = await loadBetLegs({ code: btn.dataset.code });
            if (legs && legs.length) {
              if (out) out.innerHTML = betLegsHTML({ legs: legs });
              if (msg) msg.textContent = '';
              btn.remove();
            } else {
              if (msg) msg.textContent = 'Legs are not available for this bet yet. Tap to retry.';
              btn.disabled = false;
            }
          } finally { if (btn.isConnected) btn.disabled = false; }
        });
      });
      list.querySelectorAll('[data-bb="cashout"]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var msg = btn.parentElement.querySelector('[data-bb="cashout-msg"]');
          if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            btn.textContent = 'Confirm Cash Out';
            if (msg) msg.textContent = 'Tap again to confirm.';
            return;
          }
          btn.disabled = true;
          try {
            var r = await api('POST', '/api/bets/' + btn.dataset.id + '/cashout', {});
            if (!r.ok) {
              if (msg) msg.textContent = errText(r);
              btn.disabled = false; btn.dataset.armed = ''; btn.textContent = 'Cash Out';
            } else {
              // F-L4: reload the bets list after a successful cashout so the
              // card no longer shows status open with the old stake/potential.
              refreshWallet();
              renderHeaderChipRefresh();
              openBetsDrawer();
            }
          } finally { if (btn.isConnected) btn.disabled = false; }
        });
      });
    });
  }
  function renderHeaderChipRefresh() {
    var chip = document.getElementById('bb-balance-chip');
    if (!chip || !token()) return;
    refreshWallet().then(function (w) {
      if (!w) return;
      chip.innerHTML = '<span>' + esc(money(w.main)) + '</span>' +
        (Number(w.bonus) > 0 ? '<span class="bb-bonus">Bonus ' + esc(money(w.bonus)) + '</span>' : '');
    });
  }

  /* ---------- sports board + betslip ---------- */
  var slip = []; // {matchId, home, away, market, pick, odds}
  var placing = false; // F-B3: module-level double-submit guard (see placeBet/renderSlip)
  var slipEl = null;
  function slipTotalOdds() { return slip.reduce(function (a, l) { return a * Number(l.odds || 1); }, 1); }
  function ensureSlip() {
    if (slipEl) return slipEl;
    slipEl = document.createElement('div');
    slipEl.className = 'bb-slip'; slipEl.id = 'bb-slip';
    document.body.appendChild(slipEl);
    renderSlip();
    return slipEl;
  }
  function renderSlip() {
    var el = ensureSlip();
    // F-L2: collapse the betslip bar when empty so it never covers the
    // capture's own bottom nav / betslip FAB. (placeBet re-shows it when it
    // has a confirmation to display after a successful placement.)
    el.style.display = slip.length ? '' : 'none';
    var stakeInput = el.querySelector('#bb-stake');
    var stake = stakeInput ? parseFloat(stakeInput.value) : 10;
    if (!stake || stake <= 0) stake = 10;
    var total = slipTotalOdds();
    var potential = slip.length ? stake * total : 0;
    el.innerHTML =
      '<h3>Betslip' + (slip.length ? ' (' + slip.length + ' leg' + (slip.length > 1 ? 's' : '') + ')' : '') + '</h3>' +
      '<div class="bb-error" data-bb="err"></div>' +
      (slip.length ? slip.map(function (l, i) {
        return '<div class="bb-slip-leg"><span>' + esc(l.home) + ' vs ' + esc(l.away) +
          '<br><span class="bb-muted">' + esc(l.market || '1X2') + ' — pick ' + esc(l.pick) + ' @ ' + esc(l.odds) + '</span></span>' +
          '<button type="button" class="bb-btn bb-ghost bb-sm" data-bb="remove" data-i="' + i + '">Remove</button></div>';
      }).join('') : '<p class="bb-muted">Tap an odds button on a match to add it here.</p>') +
      '<div class="bb-slip-row"><label for="bb-stake" style="font-size:13px;font-weight:700">Stake (GH₵)</label>' +
      '<input id="bb-stake" class="bb-input" type="number" min="1" step="0.01" value="' + stake + '">' +
      '<strong data-bb="potential">Potential ' + esc(money(potential)) + '</strong></div>' +
      '<div class="bb-slip-row"><button type="button" class="bb-btn" data-bb="place" style="flex:1" ' + ((slip.length && !placing) ? '' : 'disabled') + '>' + (placing ? 'Placing...' : 'Place Bet') + '</button>' +
      '<button type="button" class="bb-btn bb-ghost" data-bb="my-bets">My Bets</button></div>' +
      '<div class="bb-ok" data-bb="placed" style="display:none"></div>' +
      '<h3 style="margin-top:14px">Load booking code</h3>' +
      '<div class="bb-slip-row"><input id="bb-load-code" class="bb-input" type="text" placeholder="e.g. BB12AB34" style="text-transform:uppercase">' +
      '<button type="button" class="bb-btn bb-ghost" data-bb="load-code">Load code</button></div>' +
      '<div class="bb-error" data-bb="load-err"></div>';
    var stakeEl = el.querySelector('#bb-stake');
    if (stakeEl) stakeEl.addEventListener('input', function () {
      var s = parseFloat(stakeEl.value) || 0;
      var p = el.querySelector('[data-bb="potential"]');
      if (p) p.textContent = 'Potential ' + money(slip.length ? s * slipTotalOdds() : 0);
    });
    el.querySelectorAll('[data-bb="remove"]').forEach(function (b) {
      b.addEventListener('click', function () { slip.splice(Number(b.dataset.i), 1); renderSlip(); });
    });
    el.querySelector('[data-bb="my-bets"]').addEventListener('click', openBetsDrawer);
    el.querySelector('[data-bb="place"]').addEventListener('click', placeBet);
    el.querySelector('[data-bb="load-code"]').addEventListener('click', loadCode);
  }
  async function placeBet() {
    // F-B3: reject a second Place Bet while one is in flight, even if a
    // re-render rebuilt the button in the meantime (renderSlip also renders
    // the button disabled while placing).
    if (placing) return;
    var el = ensureSlip();
    var err = el.querySelector('[data-bb="err"]');
    var placed = el.querySelector('[data-bb="placed"]');
    hideErr(err); if (placed) placed.style.display = 'none';
    if (!token()) {
      showErr(err, { status: 401, data: { error: 'unauthorized' } });
      var go = document.createElement('button');
      go.type = 'button'; go.className = 'bb-btn bb-sm'; go.textContent = 'Log in first';
      go.style.marginTop = '8px';
      go.addEventListener('click', function () { location.href = '/gh/login/'; });
      err.appendChild(document.createElement('br')); err.appendChild(go);
      return;
    }
    var stake = parseFloat((el.querySelector('#bb-stake') || {}).value) || 0;
    if (!slip.length || stake <= 0) { showErr(err, { status: 400, data: { error: 'bad_bet' } }); return; }
    var btn = el.querySelector('[data-bb="place"]');
    if (btn) btn.disabled = true;
    placing = true;
    // F-B3: client idempotency key per submission (crypto.randomUUID, with a
    // fallback). Server-side enforcement lands in Phase 2; the client
    // already sends `idemKey` in the POST /api/bets body.
    var idemKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('bb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
    var r;
    try {
      r = await api('POST', '/api/bets', {
        stake: stake,
        idemKey: idemKey,
        legs: slip.map(function (l) { return { matchId: l.matchId, market: l.market || '1X2', pick: l.pick }; })
      });
    } finally {
      placing = false;
      // Re-enable the (possibly re-rendered) Place button on failure paths.
      var pb = el.querySelector('[data-bb="place"]');
      if (pb && slip.length) pb.disabled = false;
    }
    if (!r.ok) { showErr(err, r); return; }
    var code = r.data.code || '';
    if (placed) {
      placed.style.display = 'block';
      placed.innerHTML = 'Bet placed. Booking code: <strong>' + esc(code) + '</strong> — potential ' + esc(money(r.data.potential)) + '.';
      var copy = document.createElement('button');
      copy.type = 'button'; copy.className = 'bb-btn bb-sm'; copy.textContent = 'Copy code';
      copy.style.marginLeft = '8px';
      copy.addEventListener('click', function () {
        var done = function () { copy.textContent = 'Copied'; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, done);
        else done();
      });
      placed.appendChild(copy);
    }
    slip = [];
    renderSlip();
    // keep the confirmation visible after re-render (slip is empty now, so
    // renderSlip collapsed it — re-show it for the confirmation).
    var el2 = ensureSlip();
    el2.style.display = '';
    var placed2 = el2.querySelector('[data-bb="placed"]');
    if (placed2) {
      placed2.style.display = 'block';
      placed2.innerHTML = 'Bet placed. Booking code: <strong>' + esc(code) + '</strong> — potential ' + esc(money(r.data.potential)) + '.';
      var copy2 = document.createElement('button');
      copy2.type = 'button'; copy2.className = 'bb-btn bb-sm'; copy2.textContent = 'Copy code';
      copy2.style.marginLeft = '8px';
      copy2.addEventListener('click', function () {
        var done = function () { copy2.textContent = 'Copied'; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, done);
        else done();
      });
      placed2.appendChild(copy2);
    }
    renderHeaderChipRefresh();
  }
  async function loadCode() {
    var el = ensureSlip();
    var codeInput = el.querySelector('#bb-load-code');
    var err = el.querySelector('[data-bb="load-err"]');
    hideErr(err);
    var code = (codeInput.value || '').trim().toUpperCase();
    if (!code) { err.textContent = 'Enter a booking code.'; err.style.display = 'block'; return; }
    var r = await api('GET', '/api/bets/code/' + encodeURIComponent(code));
    if (!r.ok) {
      err.textContent = r.status === 404 ? 'No bet found for that code (or the load-code endpoint is not live on the server yet).' : errText(r);
      err.style.display = 'block';
      return;
    }
    var bet = r.data.bet || r.data;
    var legs = bet.legs || [];
    if (!legs.length) { err.textContent = 'That booking has no legs to load.'; err.style.display = 'block'; return; }
    slip = legs.map(function (l) {
      return {
        matchId: l.matchId || l.match_id,
        home: l.home || (l.matchName || '').split(' vs ')[0] || 'Home',
        away: l.away || (l.matchName || '').split(' vs ')[1] || 'Away',
        market: l.market || '1X2', pick: l.pick, odds: l.odds
      };
    }).filter(function (l) { return l.matchId && l.odds; });
    var stakeEl = el.querySelector('#bb-stake');
    if (stakeEl && bet.stake) stakeEl.value = bet.stake;
    renderSlip();
    var placed = ensureSlip().querySelector('[data-bb="placed"]');
    if (placed) { placed.style.display = 'block'; placed.textContent = 'Booking ' + code + ' loaded into the slip. Adjust the stake and place the bet.'; }
  }
  function fmtKickoff(iso) {
    try { var d = new Date(iso); return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return String(iso || ''); }
  }
  function matchCard(m) {
    var odds = m.odds1x2 || m.odds || null;
    var live = m.status === 'live';
    var score = live && (m.home_score != null || m.away_score != null) ? ' ' + m.home_score + ' - ' + m.away_score : '';
    var card = document.createElement('div');
    card.className = 'bb-match';
    card.dataset.matchId = m.id;
    card.innerHTML =
      '<div class="bb-league">' + esc(m.league || 'Football') + '</div>' +
      '<div class="bb-teams">' + esc(m.home) + ' vs ' + esc(m.away) + (live ? '<span class="bb-live">LIVE' + esc(score) + '</span>' : '') + '</div>' +
      '<div class="bb-meta">' + (live ? 'Live now' : esc(fmtKickoff(m.starts_at))) + (m.betting_locked ? ' · Betting locked' : '') + '</div>' +
      '<div class="bb-markets"></div>';
    var mk = card.querySelector('.bb-markets');
    if (odds && odds.length === 3 && !m.betting_locked) {
      var row = document.createElement('div');
      row.className = 'bb-odds';
      [['1', odds[0], 'Home'], ['X', odds[1], 'Draw'], ['2', odds[2], 'Away']].forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'bb-odd';
        b.innerHTML = '<small>' + esc(o[2]) + '</small>' + esc(Number(o[1]).toFixed(2));
        b.addEventListener('click', function () {
          var idx = slip.findIndex(function (l) { return String(l.matchId) === String(m.id); });
          if (idx >= 0) slip[idx] = { matchId: m.id, home: m.home, away: m.away, market: '1X2', pick: o[0], odds: o[1] };
          else slip.push({ matchId: m.id, home: m.home, away: m.away, market: '1X2', pick: o[0], odds: o[1] });
          card.querySelectorAll('.bb-odd').forEach(function (x) { x.classList.remove('bb-picked'); });
          b.classList.add('bb-picked');
          renderSlip();
        });
        row.appendChild(b);
      });
      mk.appendChild(row);
    } else if (m.betting_locked) {
      mk.innerHTML = '<p class="bb-muted">Betting is locked on this match.</p>';
    } else {
      mk.innerHTML = '<p class="bb-muted">Odds not published for this match yet.</p>';
    }
    // F-M4: explicit "More markets" affordance (was hidden behind a click on
    // the team names, with no label, loading or error state).
    var moreBtn = document.createElement('button');
    moreBtn.type = 'button'; moreBtn.className = 'bb-btn bb-ghost bb-sm';
    moreBtn.textContent = 'More markets';
    moreBtn.style.marginTop = '8px';
    var moreErr = document.createElement('p');
    moreErr.className = 'bb-muted'; moreErr.style.display = 'none';
    mk.appendChild(moreBtn); mk.appendChild(moreErr);
    async function loadMoreMarkets() {
      if (card.dataset.marketsLoaded) return;
      moreBtn.disabled = true; moreBtn.textContent = 'Loading markets...'; moreErr.style.display = 'none';
      var r = await api('GET', '/api/matches/' + encodeURIComponent(m.id));
      if (!r.ok || !r.data || !r.data.markets) {
        moreBtn.disabled = false; moreBtn.textContent = 'More markets — tap to retry';
        moreErr.textContent = r.status === 0 ? 'Could not reach the server. Tap to retry.' : 'More markets are not available for this match right now. Tap to retry.';
        moreErr.style.display = 'block';
        return;
      }
      card.dataset.marketsLoaded = '1';
      moreBtn.remove(); moreErr.remove();
      var markets = r.data.markets;
      Object.keys(markets).forEach(function (mkName) {
        if (mkName === '1X2') return;
        var group = markets[mkName];
        if (!group || typeof group !== 'object') return;
        var row = document.createElement('div');
        row.className = 'bb-odds';
        var label = document.createElement('div');
        label.style.cssText = 'font-size:11px;font-weight:700;color:#0b63e5;margin-top:8px';
        label.textContent = mkName;
        mk.appendChild(label);
        Object.keys(group).forEach(function (pick) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'bb-odd';
          b.innerHTML = '<small>' + esc(pick) + '</small>' + esc(Number(group[pick]).toFixed(2));
          b.addEventListener('click', function () {
            var idx = slip.findIndex(function (l) { return String(l.matchId) === String(m.id) && l.market === mkName; });
            var leg = { matchId: m.id, home: m.home, away: m.away, market: mkName, pick: pick, odds: group[pick] };
            if (idx >= 0) slip[idx] = leg; else slip.push(leg);
            renderSlip();
          });
          row.appendChild(b);
        });
        mk.appendChild(row);
      });
    }
    moreBtn.addEventListener('click', loadMoreMarkets);
    // Keep the old teams-line click as a secondary trigger.
    card.querySelector('.bb-teams').addEventListener('click', loadMoreMarkets);
    return card;
  }
  // mode: 'all' | 'live' | 'upcoming' — the board is the live match list for
  // home, /gh/sports/*, /gh/starting-soon/ and /gh/live/.
  async function renderSportsBoard(mode) {
    mode = mode || 'all';
    var main = contentMain();
    if (!main) return;
    var titles = { all: 'Football — Matches', live: 'Live now', upcoming: 'Starting soon' };
    var emptyText = { all: 'No matches available right now. Check back soon.', live: 'No live matches right now. Check back soon.', upcoming: 'No upcoming matches right now. Check back soon.' };
    var section = document.createElement('section');
    section.id = 'bb-matches';
    section.className = 'bb-panel';
    section.innerHTML = '<h2>' + esc(titles[mode] || titles.all) + '</h2><div class="bb-error" data-bb="err"></div><div data-bb="list"><p class="bb-muted">Loading matches...</p></div>';
    main.insertBefore(section, main.firstChild);
    // The capture's sports pages carry a stale/skeleton match list in
    // .bb-sports-page — hide it so the page shows live API data only.
    // (No-op on home, whose main has no .bb-sports-page.)
    var stale = main.querySelector('.bb-sports-page');
    if (stale) stale.style.display = 'none';
    var list = section.querySelector('[data-bb="list"]');
    var err = section.querySelector('[data-bb="err"]');
    var r = await api('GET', '/api/matches');
    if (!r.ok) {
      showErr(err, r);
      list.innerHTML = '<p class="bb-muted">Matches are unavailable right now. Try reloading the page.</p>';
      return;
    }
    var matches = (r.data.matches || []).filter(function (m) {
      if (mode === 'live') return m.status === 'live';
      if (mode === 'upcoming') return m.status === 'upcoming';
      return true;
    });
    if (!matches.length) { list.innerHTML = '<p class="bb-muted">' + esc(emptyText[mode] || emptyText.all) + '</p>'; return; }
    var leagues = {};
    matches.forEach(function (m) { (leagues[m.league || 'Football'] = leagues[m.league || 'Football'] || []).push(m); });
    list.innerHTML = '';
    Object.keys(leagues).forEach(function (lg) {
      var h = document.createElement('h3');
      h.textContent = lg;
      list.appendChild(h);
      leagues[lg].forEach(function (m) { list.appendChild(matchCard(m)); });
    });
    ensureSlip();
  }
  // Non-football sport pages: the API only carries football fixtures, so
  // show an honest notice instead of football matches on a basketball page.
  function renderSportNotice(sport) {
    var names = { basketball: 'Basketball', tennis: 'Tennis', cricket: 'Cricket', volleyball: 'Volleyball', hockey: 'Hockey', rugby: 'Rugby', tabletennis: 'Table Tennis', boxing: 'Boxing', mma: 'MMA', esports: 'Esports', baseball: 'Baseball' };
    var label = names[sport] || sport;
    var main = contentMain();
    if (!main) return;
    var section = document.createElement('section');
    section.id = 'bb-matches';
    section.className = 'bb-panel';
    section.innerHTML = '<h2>' + esc(label) + ' — coming soon</h2>' +
      '<p class="bb-muted">We only have football fixtures live right now. ' + esc(label) + ' fixtures are not available yet.</p>' +
      '<p style="margin-top:10px"><a class="bb-btn" style="text-decoration:none;display:inline-block" href="/gh/home/">See football matches</a></p>';
    main.insertBefore(section, main.firstChild);
    var stale = main.querySelector('.bb-sports-page');
    if (stale) stale.style.display = 'none';
  }

  /* ---------- auth forms ---------- */
  // F-M7: auth wiring is scoped to the auth pages / element ids — no generic
  // first-form hijack. wireLoginForm only runs on /gh/login/ and only binds
  // the form that actually contains #login-identifier.
  function wireLoginForm() {
    if (!/\/gh\/login\/?/.test(location.pathname)) return;
    var idInput = document.querySelector('#login-identifier');
    var pwInput = document.querySelector('#login-password');
    if (!idInput || !pwInput) return;
    var form = idInput.closest('form');
    if (!form || !form.contains(pwInput)) return;
    if (form.dataset.bbWired) return;
    form.dataset.bbWired = '1';
    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = false; // capture ships it disabled with no JS to enable it
    var err = document.createElement('div');
    err.className = 'bb-error';
    form.appendChild(err);
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      hideErr(err);
      var phone = idInput.value.trim();
      var password = pwInput.value;
      if (!phone || !password) { err.textContent = 'Enter your phone number and password.'; err.style.display = 'block'; return; }
      var btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      var r = await api('POST', '/api/auth/login', { phone: phone, password: password });
      if (btn) btn.disabled = false;
      if (!r.ok) { showErr(err, r); return; }
      setToken(r.data.token);
      location.href = '/gh/home/';
    });
  }
  // F-M7: hide the dead #signup-email and #signup-currency fields (backend
  // is GHS-only; currency is not plumbed). Hidden + not required so they can
  // never block submission.
  function hideDeadSignupFields() {
    ['#signup-email', '#signup-currency'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (!el) return;
      try { el.removeAttribute('required'); el.required = false; } catch (e) {}
      var wrap = el.closest('div');
      if (wrap) wrap.style.display = 'none';
    });
  }
  function wireRegisterForm() {
    hideDeadSignupFields();
    var phoneInput = document.querySelector('#signup-phone');
    var pwInput = document.querySelector('#signup-password');
    if (!phoneInput || !pwInput) return;
    var form = phoneInput.closest('form');
    if (!form || form.dataset.bbWired) return;
    form.dataset.bbWired = '1';
    // Pre-fill referral / invite / promo from the URL.
    var ref = qs('ref'), invite = qs('admin_invite'), promo = qs('promo');
    var userInput = document.querySelector('#signup-username');
    var promoInput = form.querySelector('input[name="promoCode"], input[name="promo"], input[placeholder*="Promo" i]');
    if (promo && promoInput) promoInput.value = promo;
    if (ref || invite || promo) {
      [['ref', ref], ['invite', invite], ['promoCode', promo]].forEach(function (pair) {
        if (!pair[1]) return;
        var h = document.createElement('input');
        h.type = 'hidden'; h.name = pair[0]; h.value = pair[1];
        form.appendChild(h);
      });
    }
    var submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = false;
    var err = document.createElement('div');
    err.className = 'bb-error';
    form.appendChild(err);
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      hideErr(err);
      var phone = phoneInput.value.trim();
      var password = pwInput.value;
      if (!phone || !password) { err.textContent = 'Enter your phone number and password.'; err.style.display = 'block'; return; }
      if (submit) submit.disabled = true;
      var body = {
        phone: phone, password: password,
        name: userInput ? userInput.value.trim() : '',
        promoCode: (promoInput ? promoInput.value.trim() : '') || promo || undefined,
        ref: ref || undefined,
        invite: invite || undefined
      };
      var r = await api('POST', '/api/auth/register', body);
      if (submit) submit.disabled = false;
      if (!r.ok) { showErr(err, r); return; }
      setToken(r.data.token);
      location.href = '/gh/home/';
    });
  }

  /* ---------- deposit page ---------- */
  function wireDepositPage() {
    var main = contentMain();
    if (!main) return;
    var section = document.createElement('section');
    section.id = 'bb-wallet';
    section.className = 'bb-panel';
    section.innerHTML = '<h2>Wallet</h2>' + walletHTML();
    // Deposit page already has its own amount input; keep ours as the working form.
    main.insertBefore(section, main.firstChild);
    fillWalletInto(section);
  }

  /* ---------- boot ---------- */
  function boot() {
    injectCSS();
    revealHiddenContent();
    renderHeaderChip();
    var path = location.pathname;
    var isLogin = /\/gh\/login\/?/.test(path);
    var isSignup = /\/gh\/signup\/?/.test(path);
    var isDeposit = /\/gh\/deposit\/?/.test(path);
    var isHome = /\/gh\/home\/?/.test(path);
    var isStartingSoon = /\/gh\/starting-soon\/?/.test(path);
    var isLive = /\/gh\/live\/?/.test(path);
    var sportPage = /\/gh\/sports\/([a-z]+)\//.exec(path);
    if (isLogin) {
      // F-B2: carry ?admin_invite= / ?ref= / ?promo= through to signup so an
      // invite link that lands on login does not lose its token.
      if (location.search) {
        document.querySelectorAll('a[href="/gh/signup/index.html"]').forEach(function (a) {
          if (a.href.indexOf('?') < 0) a.href = '/gh/signup/index.html' + location.search;
        });
      }
      wireLoginForm();
    }
    if (isSignup) { hideDeadSignupFields(); wireRegisterForm(); }
    if (isHome) renderSportsBoard('all');
    if (isStartingSoon) renderSportsBoard('upcoming');
    if (isLive) renderSportsBoard('live');
    if (sportPage) {
      var sport = sportPage[1];
      if (sport === 'soccer' || sport === 'all') renderSportsBoard('all');
      else renderSportNotice(sport);
    }
    if (isDeposit) wireDepositPage();
    if (token()) refreshWallet().then(renderHeaderChipRefresh);
  }
  window.BB = {
    apiBase: API,
    logout: function () {
      // F-H6: server-side logout (Phase 2 endpoint). Fire-and-forget with
      // keepalive so the redirect does not cancel it; a 404/absence is
      // tolerated — the local token is cleared regardless.
      try {
        fetch(API + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token() ? 'Bearer ' + token() : '' }, body: '{}', keepalive: true }).catch(function () {});
      } catch (e) {}
      setToken(''); location.href = '/gh/login/';
    },
    openWallet: openWalletDrawer,
    openBets: openBetsDrawer,
    refreshBalance: renderHeaderChipRefresh
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
