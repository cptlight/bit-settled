/* =========================================================
   Settled — shared client
   Plain ES2017, no dependencies. All data comes from /api.
   ========================================================= */
(function (global) {
  'use strict';

  var API_BASE = window.SETTLED_API_BASE || '/api';

  /* ---------- errors + api ---------- */
  function ApiError(message, code, status, data) {
    this.name = 'ApiError';
    this.message = message;
    this.code = code || 'api_error';
    this.status = status || 0;
    this.data = data || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function api(path, options) {
    options = options || {};
    var method = (options.method || 'GET').toUpperCase();
    var init = { method: method, headers: { accept: 'application/json' }, credentials: 'same-origin' };
    try {
      var saved = JSON.parse(localStorage.getItem('bitsettled_participant') || 'null');
      if (saved && saved.api_key) init.headers['x-agent-key'] = saved.api_key;
    } catch (e) {}
    if (options.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    var started = (global.performance && performance.now) ? performance.now() : Date.now();
    return fetch(API_BASE + path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        var elapsed = Math.round(((global.performance && performance.now) ? performance.now() : Date.now()) - started);
        if (typeof api.onCall === 'function') {
          try { api.onCall({ method: method, path: path, status: res.status, ok: res.ok, ms: elapsed }); } catch (e) {}
        }
        if (!res.ok) {
          var err = (data && data.error) || {};
          throw new ApiError(err.message || ('Request failed (' + res.status + ')'), err.code || 'http_error', res.status, data);
        }
        return data;
      });
    }, function () {
      if (typeof api.onCall === 'function') {
        try { api.onCall({ method: method, path: path, status: 0, ok: false, ms: 0 }); } catch (e) {}
      }
      throw new ApiError('Can’t reach the Settled API. Start the server with `node server.js` and open http://127.0.0.1:4173.', 'network', 0, null);
    });
  }

  /* ---------- formatting ---------- */
  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  var intFmt = new Intl.NumberFormat('en-US');

  function money(n) {
    if (n === null || n === undefined || n === '') return '—';
    var v = Number(n);
    return isFinite(v) ? usd.format(v) : '—';
  }
  function money0(n) {
    var v = Number(n);
    return isFinite(v) ? usd0.format(v) : '—';
  }
  function num(n) {
    var v = Number(n);
    return isFinite(v) ? intFmt.format(v) : '—';
  }
  function pct(n) {
    if (n === null || n === undefined || n === '') return '—';
    var v = Number(n);
    return isFinite(v) ? v.toFixed(1) + '%' : '—';
  }
  function bps(n) {
    if (n === null || n === undefined) return '—';
    return Number(n) + ' bps';
  }
  function dateFmt(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
    } catch (e) { return d.toLocaleString(); }
  }
  function timeAgo(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function shortHash(h, len) {
    if (!h) return '—';
    var s = String(h);
    len = len || 12;
    return s.length <= len ? s : s.slice(0, len) + '…';
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- json highlight ---------- */
  function syntax(obj) {
    var text;
    try {
      text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    } catch (e) { text = String(obj); }
    return esc(text).replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
      function (m, str, colon) {
        if (str) {
          var cls = colon ? 'j-k' : (/^"https?:/.test(str) ? 'j-u' : 'j-s');
          return '<span class="' + cls + '">' + str + '</span>' + (colon ? esc(colon) : '');
        }
        if (m === 'true' || m === 'false' || m === 'null') return '<span class="j-b">' + m + '</span>';
        return '<span class="j-n">' + m + '</span>';
      }
    );
  }

  /* ---------- icons (inline SVG, no assets) ---------- */
  var ICONS = {
    check: '<polyline points="20 6 9 17 4 12"/>',
    shieldCheck: '<path d="M12 3 5 6v6c0 4.6 3 7.6 7 9 4-1.4 7-4.4 7-9V6l-7-3Z"/><polyline points="9 12 11.2 14.2 15.4 10"/>',
    shield: '<path d="M12 3 5 6v6c0 4.6 3 7.6 7 9 4-1.4 7-4.4 7-9V6l-7-3Z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5M12 17.5h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v6h-6"/>',
    arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    external: '<path d="M14 4h6v6M20 4 10 14"/><path d="M20 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    store: '<path d="M4 9 5 4h14l1 5v2H4V9Z"/><path d="M6 11v9h12v-9"/><path d="M10 20v-5h4v5"/>',
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    agent: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/><circle cx="12" cy="12" r="2.5"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2V5Z"/><path d="M8 7h7M8 11h7"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M17 4l3 3M14 7l3 3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    wallet: '<path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2"/><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M16 13h2"/>',
    package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
    truck: '<path d="M3 16V6h11v10H3ZM14 9h4l3 3v4h-7V9Z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/>',
    flag: '<path d="M5 21V4M5 5h11l-1.6 3.4L16 12H5"/>',
    link: '<path d="M10 14 14 10M7.5 12.5 5 15a3.5 3.5 0 0 0 5 5l2.5-2.5M16.5 11.5 19 9a3.5 3.5 0 0 0-5-5l-2.5 2.5"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
    dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>'
  };
  function icon(name, extraClass) {
    var body = ICONS[name] || ICONS.dot;
    return '<svg' + (extraClass ? ' class="' + extraClass + '"' : '') + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  /* ---------- domain metadata ---------- */
  var TIERS = {
    A: { cls: 'tier-a', rank: 4, label: 'Tier A', desc: 'Excellent' },
    B: { cls: 'tier-b', rank: 3, label: 'Tier B', desc: 'Solid' },
    C: { cls: 'tier-c', rank: 2, label: 'Tier C', desc: 'Watch' },
    D: { cls: 'tier-d', rank: 1, label: 'Tier D', desc: 'Blocked' }
  };
  var MODES = {
    instant: { cls: 'mode-instant', label: 'Instant settlement', short: 'Instant' },
    reserve: { cls: 'mode-reserve', label: 'Reserve-backed', short: 'Reserve' },
    escrow: { cls: 'mode-escrow', label: 'Escrowed payout', short: 'Escrow' },
    blocked: { cls: 'mode-blocked', label: 'Blocked', short: 'Blocked' }
  };
  var STATUSES = { paid: 'paid', delivered: 'delivered', claimed: 'claimed', refunded: 'refunded', blocked: 'blocked' };
  var REASONS = [
    { value: 'not_delivered', label: 'Item never delivered' },
    { value: 'not_as_described', label: 'Not as described' },
    { value: 'damaged', label: 'Damaged on arrival' }
  ];
  function tierInfo(tier) { return TIERS[tier] || { cls: 'tier-c', rank: 0, label: 'Tier ' + (tier || '?'), desc: 'Unknown' }; }
  function modeInfo(mode) { return MODES[mode] || { cls: 'mode-escrow', label: mode || 'Unknown', short: mode || '—' }; }
  function statusInfo(status) {
    var cls = STATUSES[status] ? ('status-' + status) : 'status-paid';
    return { cls: cls, label: status || 'unknown' };
  }

  /* ---------- small ui primitives ---------- */
  function toast(message, kind) {
    var host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      host.id = 'toastHost';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    var k = kind || 'ok';
    var icons = { ok: 'check', warn: 'alert', err: 'alert', info: 'info' };
    var el = document.createElement('div');
    el.className = 'toast ' + k;
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="t-icon">' + icon(icons[k] || 'info') + '</span><span>' + esc(message) + '</span>';
    host.appendChild(el);
    while (host.children.length > 3) host.removeChild(host.firstChild);
    setTimeout(function () { el.classList.add('out'); }, 3200);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 3600);
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      if (btn.dataset.origHtml === undefined) btn.dataset.origHtml = btn.innerHTML;
      btn.classList.add('is-busy');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span><span class="btn-label">' + esc(label || 'Working…') + '</span>';
    } else {
      btn.classList.remove('is-busy');
      btn.disabled = false;
      if (btn.dataset.origHtml !== undefined) {
        btn.innerHTML = btn.dataset.origHtml;
        delete btn.dataset.origHtml;
      }
    }
  }

  function copyText(text, label) {
    var value = String(text === null || text === undefined ? '' : text);
    function done() { toast((label || 'Copied') + ' to clipboard.', 'ok'); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy blocked by the browser.', 'warn'); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function qs(name) {
    try { return new URLSearchParams(global.location.search).get(name); } catch (e) { return null; }
  }
  function setQuery(name, value) {
    try {
      var url = new URL(global.location.href);
      if (value === null || value === undefined || value === '') url.searchParams.delete(name);
      else url.searchParams.set(name, value);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) {}
  }

  function emptyState(title, sub) {
    return '<div class="empty"><strong>' + esc(title) + '</strong>' + esc(sub || '') + '</div>';
  }

  function showApiError(container, err, retry) {
    if (!container) return;
    container.hidden = false;
    container.innerHTML =
      '<div class="eyebrow gold">Connection</div>' +
      '<h2>Couldn’t load data</h2>' +
      '<p>' + esc((err && err.message) || 'The Settled API did not respond.') + '</p>' +
      '<p class="tiny muted">Run <code>node server.js</code> in the <code>settled</code> folder, then open <code>http://127.0.0.1:4173</code>.</p>' +
      '<button class="btn btn-primary btn-sm" type="button" id="apiRetry">' + icon('refresh') + 'Retry</button>';
    var btn = container.querySelector('#apiRetry');
    if (btn) btn.addEventListener('click', function () { container.hidden = true; if (retry) retry(); });
  }

  /* ---------- nav ---------- */
  function mountNav(page) {
    document.body.dataset.page = page;
    var links = document.querySelectorAll('.nav a[data-nav]');
    Array.prototype.forEach.call(links, function (a) {
      a.classList.toggle('is-active', a.getAttribute('data-nav') === page);
    });
    var id = qs('merchant');
    if (id) setMerchantLinks(id);
  }
  function setMerchantLinks(id) {
    var pages = { dashboard: 'index.html', store: 'store.html', agent: 'agent.html' };
    var links = document.querySelectorAll('a[data-nav]');
    Array.prototype.forEach.call(links, function (a) {
      var page = a.getAttribute('data-nav');
      if (pages[page]) a.href = pages[page] + (id ? '?merchant=' + encodeURIComponent(id) : '');
    });
    var sideLinks = document.querySelectorAll('a[data-link]');
    Array.prototype.forEach.call(sideLinks, function (a) {
      var base = a.getAttribute('data-link');
      if (base) a.href = base + (id ? '?merchant=' + encodeURIComponent(id) : '');
    });
  }
  function setNavMerchant(merchant) {
    var host = document.getElementById('navMerchant');
    if (!host) return;
    if (!merchant) { host.hidden = true; return; }
    host.hidden = false;
    var name = document.getElementById('navMerchantName');
    var tier = document.getElementById('navMerchantTier');
    if (name) name.textContent = merchant.name;
    if (tier) {
      var t = tierInfo(merchant.tier);
      tier.textContent = merchant.tier || '?';
      tier.className = 'tier ' + t.cls;
    }
  }
  function setEnv(mode) {
    var pill = document.getElementById('envPill');
    var label = document.getElementById('envLabel');
    if (!pill || !label) return;
    var live = String(mode).toLowerCase() === 'paypal';
    pill.classList.toggle('paypal', live);
    label.textContent = live ? 'PAYPAL' : 'SIM';
    pill.title = live ? 'Live PayPal adapter enabled' : 'Simulated payments';
  }

  /* ---------- score dial ---------- */
  function ring(score, tier, size) {
    var s = Math.max(0, Math.min(100, Number(score) || 0));
    var t = tierInfo(tier);
    var color = t.rank === 4 ? 'var(--emerald)' : t.rank === 3 ? 'var(--blue)' : t.rank === 2 ? 'var(--gold)' : 'var(--danger)';
    var r = 54;
    var c = 2 * Math.PI * r;
    var offset = c * (1 - s / 100);
    var px = size || 124;
    return '<div class="dial" style="width:' + px + 'px;height:' + px + 'px">' +
      '<svg viewBox="0 0 124 124" width="' + px + '" height="' + px + '" aria-hidden="true">' +
      '<circle cx="62" cy="62" r="' + r + '" fill="none" stroke-width="7" class="dial-track"/>' +
      '<circle cx="62" cy="62" r="' + r + '" fill="none" stroke-width="7" class="dial-fill" stroke="' + color + '" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '"/>' +
      '</svg>' +
      '<div class="dial-center"><span class="dial-score">' + (isFinite(Number(score)) ? Math.round(Number(score)) : '—') + '</span><span class="dial-label">score</span></div>' +
      '</div>';
  }

  /* ---------- modal ---------- */
  function modal(opts) {
    opts = opts || {};
    // Only one dialog at a time: replace any open modal (e.g. receipt -> claim).
    Array.prototype.forEach.call(document.querySelectorAll('.modal-backdrop'), function (n) { n.remove(); });
    document.body.style.overflow = '';
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML =
      '<div class="modal' + (opts.wide ? ' wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="settledModalTitle">' +
        '<div class="modal-head">' +
          '<div style="min-width:0"><div class="modal-title" id="settledModalTitle"></div><div class="modal-sub"></div></div>' +
          '<button class="icon-btn modal-close" type="button" aria-label="Close">' + icon('x') + '</button>' +
        '</div>' +
        '<div class="modal-body"></div>' +
        '<div class="modal-foot"></div>' +
      '</div>';
    document.body.appendChild(backdrop);
    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    var panel = backdrop.querySelector('.modal');
    var titleEl = backdrop.querySelector('.modal-title');
    var subEl = backdrop.querySelector('.modal-sub');
    var bodyEl = backdrop.querySelector('.modal-body');
    var footEl = backdrop.querySelector('.modal-foot');
    var closeBtn = backdrop.querySelector('.modal-close');
    var closed = false;
    var handle = {
      root: backdrop,
      panel: panel,
      body: bodyEl,
      foot: footEl,
      setTitle: function (t) { titleEl.textContent = t || ''; },
      setSub: function (t) { subEl.textContent = t || ''; subEl.hidden = !t; },
      setBody: function (content) {
        bodyEl.innerHTML = '';
        if (typeof content === 'string') bodyEl.innerHTML = content;
        else if (content) bodyEl.appendChild(content);
      },
      setFoot: function (content) {
        footEl.innerHTML = '';
        if (typeof content === 'string') footEl.innerHTML = content;
        else if (content) footEl.appendChild(content);
      },
      close: function () {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey);
        document.body.style.overflow = prevOverflow;
        backdrop.remove();
        if (typeof opts.onClose === 'function') opts.onClose();
      }
    };
    function onKey(e) {
      if (e.key === 'Escape') handle.close();
    }
    handle.setTitle(opts.title || '');
    handle.setSub(opts.sub || '');
    if (opts.body) handle.setBody(opts.body);
    if (opts.foot) handle.setFoot(opts.foot);
    document.addEventListener('keydown', onKey);
    closeBtn.addEventListener('click', handle.close);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) handle.close(); });
    var first = panel.querySelector('input,select,textarea,button:not(.modal-close)');
    if (first) setTimeout(function () { try { first.focus(); } catch (e) {} }, 40);
    return handle;
  }

  /* ---------- order helpers ---------- */
  function fulfill(order) {
    return api('/orders/' + encodeURIComponent(order.id) + '/fulfill', { method: 'POST' });
  }

  var REDUCED = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function countUp(el, to, duration, format) {
    var target = Number(to) || 0;
    if (!el) return;
    if (REDUCED) { el.textContent = (format || money)(target); return; }
    var start = null;
    var dur = duration || 1200;
    function frame(ts) {
      if (start === null) start = ts;
      var k = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - k, 3);
      el.textContent = (format || money)(target * eased);
      if (k < 1) global.requestAnimationFrame(frame);
    }
    global.requestAnimationFrame(frame);
    // Under headless/background tabs rAF can stall; guarantee the final figure.
    global.setTimeout(function () {
      el.textContent = (format || money)(target);
    }, dur + 120);
  }

  /* ---------- claim dialog ---------- */
  function claimDialog(opts) {
    opts = opts || {};
    var order = opts.order || {};
    var merchant = opts.merchant || {};
    var m = modal({
      title: 'Report a problem',
      sub: (order.product_name || 'Order') + ' · ' + money(order.amount) + ' · ' + (order.id || '')
    });
    var completed = false;

    function renderForm() {
      var options = REASONS.map(function (r) {
        return '<option value="' + r.value + '">' + esc(r.label) + '</option>';
      }).join('');
      m.setBody(
        '<div class="protect-note">' + icon('shieldCheck') +
          '<div><div class="pn-title">Buyer protection · instant settlement</div>' +
          '<div class="pn-sub">A valid claim is refunded instantly from the merchant’s reserve. Their score and tier are recomputed in the same request.</div></div>' +
        '</div>' +
        '<div class="field" style="margin-top:15px">' +
          '<label class="field-label" for="claimReason">What went wrong</label>' +
          '<select id="claimReason" class="select">' + options + '</select>' +
        '</div>' +
        '<label class="check" style="margin-top:14px">' +
          '<input type="checkbox" id="claimEvidence">' +
          '<span>I’ve attached photo evidence for this claim <span class="muted">— required by the protection contract</span></span>' +
        '</label>' +
        '<div id="claimError" class="field-error" style="margin-top:9px" hidden></div>'
      );
      m.setFoot(
        '<button class="btn btn-ghost" type="button" data-close>Cancel</button>' +
        '<button class="btn btn-primary" type="button" id="claimSubmit">' + icon('shieldCheck') + '<span class="btn-label">Approve instant refund</span></button>'
      );
      m.foot.querySelector('[data-close]').addEventListener('click', m.close);
      var submit = m.foot.querySelector('#claimSubmit');
      var reasonEl = m.body.querySelector('#claimReason');
      var evidenceEl = m.body.querySelector('#claimEvidence');
      var errEl = m.body.querySelector('#claimError');
      submit.addEventListener('click', function () {
        if (!evidenceEl.checked) {
          errEl.hidden = false;
          errEl.textContent = 'Evidence is required. Check the box to proceed.';
          return;
        }
        errEl.hidden = true;
        setBusy(submit, true, 'Settling refund…');
        api('/orders/' + encodeURIComponent(order.id) + '/claim', {
          method: 'POST',
          body: { reason: reasonEl.value, evidence: true }
        }).then(function (res) {
          completed = true;
          renderResult(res);
        }).catch(function (err) {
          setBusy(submit, false);
          errEl.hidden = false;
          errEl.textContent = (err && err.message) || 'The claim could not be processed.';
          toast((err && err.message) || 'Claim failed.', 'err');
        });
      });
    }

    function renderResult(res) {
      var claim = res.claim || {};
      var updated = res.merchant || {};
      var updatedOrder = res.order || order;
      var refund = Number(claim.refund !== undefined ? claim.refund : order.amount) || 0;
      var fromReserve = Number(claim.paid_from_reserve !== undefined ? claim.paid_from_reserve : Math.min(refund, Number(updated.reserve) || 0)) || 0;
      var fromPool = Number(claim.paid_from_pool || 0);
      var reserveAfter = Number(claim.reserve_after !== undefined ? claim.reserve_after : updated.reserve);
      var tier = updated.tier || merchant.tier;
      var t = tierInfo(tier);
      var refundReason = (REASONS.filter(function (r) { return r.value === claim.reason; })[0] || {}).label || claim.reason || '—';
      var shortage = fromPool > 0
        ? '<div class="shortfall">' + icon('alert') + ' Reserve shortfall: <b>' + money(fromPool) + '</b> was drawn from the <b>$25,000 network pool</b> to cover this refund. The next settlement keeps refilling the reserve.</div>'
        : '';
      m.setTitle('Refund approved');
      m.setSub('Instant settlement · ' + (order.product_name || 'Order'));
      m.setBody(
        '<div class="success-hero">' +
          '<div class="success-ring">' + icon('check') + '</div>' +
          '<div class="success-title">Refund approved instantly</div>' +
          '<div class="refund-amount" id="refundAmt">' + money(refund) + '</div>' +
          '<div class="refund-caption" id="refundCap">Settling from seller reserve…</div>' +
          '<div class="refund-bar"><div class="refund-fill" id="refundFill"></div></div>' +
        '</div>' +
        '<div class="receipt-grid" style="margin-top:16px">' +
          '<div class="receipt-cell"><div class="receipt-label">Reason</div><div class="receipt-value">' + esc(refundReason) + '</div></div>' +
          '<div class="receipt-cell"><div class="receipt-label">Claim</div><div class="receipt-value">' + esc(claim.id || '—') + '</div></div>' +
          '<div class="receipt-cell"><div class="receipt-label">From reserve</div><div class="receipt-value money">' + money(fromReserve) + '</div></div>' +
          '<div class="receipt-cell"><div class="receipt-label">From network pool</div><div class="receipt-value money">' + money(fromPool) + '</div></div>' +
          '<div class="receipt-cell"><div class="receipt-label">Reserve after</div><div class="receipt-value money">' + money(reserveAfter) + '</div></div>' +
          '<div class="receipt-cell"><div class="receipt-label">Merchant tier after</div><div class="receipt-value"><span class="tier ' + t.cls + '">' + esc(tier || '?') + '</span> &nbsp;score ' + esc(updated.score !== undefined ? updated.score : '—') + '</div></div>' +
        '</div>' +
        shortage
      );
      m.setFoot(
        '<span class="note">Order ' + esc(updatedOrder.id || order.id || '') + ' marked <b>' + esc(updatedOrder.status || 'refunded') + '</b>.</span>' +
        '<button class="btn btn-primary" type="button" data-done>Done</button>'
      );
      m.foot.querySelector('[data-done]').addEventListener('click', function () {
        m.close();
      });
      // Amount is rendered final immediately; the bar animates. (Headless-safe.)
      var fill = m.body.querySelector('#refundFill');
      if (fill) {
        if (REDUCED) fill.style.width = '100%';
        else setTimeout(function () { fill.style.width = '100%'; }, 30);
      }
      var cap = m.body.querySelector('#refundCap');
      setTimeout(function () {
        if (!cap) return;
        var text = 'Refunded ' + money(refund) + ' from seller reserve in 1.2s';
        if (fromPool > 0) text = 'Refunded ' + money(refund) + ' in 1.2s · ' + money(fromReserve) + ' reserve + ' + money(fromPool) + ' pool';
        cap.textContent = text;
      }, REDUCED ? 0 : 1250);
      if (typeof opts.onComplete === 'function') {
        // Let the page refresh underneath while the animation plays.
        setTimeout(function () { try { opts.onComplete(res); } catch (e) {} }, REDUCED ? 0 : 1250);
      }
    }

    renderForm();
    return m;
  }

  /* ---------- product art (inline SVG) ---------- */
  var ART_HEADPHONES =
    '<svg viewBox="0 0 320 260" fill="none" aria-hidden="true">' +
    '<defs>' +
      '<linearGradient id="hpBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#37506F"/><stop offset="1" stop-color="#152538"/></linearGradient>' +
      '<linearGradient id="hpCup" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#20344D"/><stop offset="1" stop-color="#0E1B2B"/></linearGradient>' +
      '<radialGradient id="hpGlow" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#2BD9A0" stop-opacity=".18"/><stop offset="1" stop-color="#2BD9A0" stop-opacity="0"/></radialGradient>' +
    '</defs>' +
    '<ellipse cx="160" cy="150" rx="122" ry="92" fill="url(#hpGlow)"/>' +
    '<path d="M78 168V128c0-46 37-78 82-78s82 32 82 78v40" stroke="#C9D8EC" stroke-opacity=".4" stroke-width="8" stroke-linecap="round"/>' +
    '<path d="M78 150V126c0-42 37-70 82-70s82 28 82 70v24" stroke="url(#hpBand)" stroke-width="15" stroke-linecap="round"/>' +
    '<path d="M92 118c18-22 42-34 68-34s50 12 68 34" stroke="#2BD9A0" stroke-opacity=".5" stroke-width="2"/>' +
    '<rect x="47" y="130" width="60" height="90" rx="28" fill="url(#hpCup)" stroke="#33506F"/>' +
    '<rect x="213" y="130" width="60" height="90" rx="28" fill="url(#hpCup)" stroke="#33506F"/>' +
    '<rect x="63" y="151" width="28" height="48" rx="13" fill="#0A1420" stroke="#33506F"/>' +
    '<rect x="229" y="151" width="28" height="48" rx="13" fill="#0A1420" stroke="#33506F"/>' +
    '<circle cx="77" cy="187" r="3.6" fill="#2BD9A0"/>' +
    '<circle cx="243" cy="187" r="3.6" fill="#2BD9A0"/>' +
    '<path d="M77 138c15-6 27-9 43-11" stroke="#F5C451" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M243 138c-15-6-27-9-43-11" stroke="#F5C451" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';

  var ART_BUDS =
    '<svg viewBox="0 0 320 260" fill="none" aria-hidden="true">' +
    '<defs>' +
      '<linearGradient id="budBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2A405C"/><stop offset="1" stop-color="#122234"/></linearGradient>' +
      '<linearGradient id="budCase" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1C3049"/><stop offset="1" stop-color="#0E1B2B"/></linearGradient>' +
      '<radialGradient id="budGlow" cx="50%" cy="42%" r="60%"><stop offset="0" stop-color="#F5C451" stop-opacity=".14"/><stop offset="1" stop-color="#F5C451" stop-opacity="0"/></radialGradient>' +
    '</defs>' +
    '<ellipse cx="160" cy="150" rx="118" ry="88" fill="url(#budGlow)"/>' +
    '<g transform="rotate(-18 118 84)">' +
      '<ellipse cx="118" cy="80" rx="30" ry="26" fill="url(#budBody)" stroke="#3A5878" stroke-width="1.5"/>' +
      '<rect x="112" y="96" width="13" height="52" rx="6.5" fill="#16283F" stroke="#3A5878" stroke-width="1.5"/>' +
      '<circle cx="118" cy="80" r="10" fill="#0A1420" stroke="#2BD9A0" stroke-opacity=".5"/>' +
    '</g>' +
    '<g transform="rotate(20 210 76)">' +
      '<ellipse cx="210" cy="76" rx="27" ry="24" fill="url(#budBody)" stroke="#3A5878" stroke-width="1.5"/>' +
      '<rect x="204" y="91" width="12" height="46" rx="6" fill="#16283F" stroke="#3A5878" stroke-width="1.5"/>' +
      '<circle cx="210" cy="76" r="9" fill="#0A1420" stroke="#F5C451" stroke-opacity=".55"/>' +
    '</g>' +
    '<rect x="96" y="160" width="128" height="64" rx="26" fill="url(#budCase)" stroke="#33506F"/>' +
    '<path d="M116 160c8 10 20 15 44 15s36-5 44-15" stroke="#33506F" stroke-width="1.5"/>' +
    '<circle cx="160" cy="192" r="4" fill="#2BD9A0"/>' +
    '<path d="M128 178h64" stroke="#C9D8EC" stroke-opacity=".18" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';

  var ART_FLOOR_LAMP =
    '<svg viewBox="0 0 320 260" fill="none" aria-hidden="true">' +
    '<defs>' +
      '<linearGradient id="flShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4E4C0"/><stop offset="1" stop-color="#D8BE8B"/></linearGradient>' +
      '<linearGradient id="flPole" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8FA6BF"/><stop offset="1" stop-color="#4E6682"/></linearGradient>' +
      '<radialGradient id="flGlow" cx="50%" cy="35%" r="60%"><stop offset="0" stop-color="#F5C451" stop-opacity=".3"/><stop offset="1" stop-color="#F5C451" stop-opacity="0"/></radialGradient>' +
    '</defs>' +
    '<ellipse cx="160" cy="120" rx="128" ry="94" fill="url(#flGlow)"/>' +
    '<path d="M116 116 100 58h120l-16 58H116Z" fill="url(#flShade)"/>' +
    '<path d="M116 116h88" stroke="#B99C67" stroke-width="2"/>' +
    '<rect x="153" y="116" width="14" height="104" fill="url(#flPole)"/>' +
    '<path d="M160 128c12 0 22 9 22 20s-10 20-22 20" stroke="#F5C451" stroke-opacity=".18" stroke-width="2"/>' +
    '<ellipse cx="160" cy="228" rx="54" ry="10" fill="#0C1727" stroke="#3A5878"/>' +
    '<ellipse cx="160" cy="224" rx="54" ry="9" fill="#182B44"/>' +
    '<ellipse cx="160" cy="228" rx="34" ry="5" fill="#2BD9A0" fill-opacity=".14"/>' +
    '</svg>';

  var ART_DESK_LAMP =
    '<svg viewBox="0 0 320 260" fill="none" aria-hidden="true">' +
    '<defs>' +
      '<linearGradient id="dlHead" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2C4563"/><stop offset="1" stop-color="#152538"/></linearGradient>' +
      '<radialGradient id="dlGlow" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#F5C451" stop-opacity=".22"/><stop offset="1" stop-color="#F5C451" stop-opacity="0"/></radialGradient>' +
    '</defs>' +
    '<ellipse cx="170" cy="140" rx="122" ry="92" fill="url(#dlGlow)"/>' +
    '<path d="M160 134l-8-56 28-24" stroke="#7E95B0" stroke-width="9" stroke-linecap="round" fill="none"/>' +
    '<path d="M180 54l44 26" stroke="#7E95B0" stroke-width="8" stroke-linecap="round"/>' +
    '<path d="M212 48l48 34-36 17-12-51Z" fill="url(#dlHead)" stroke="#3A5878"/>' +
    '<path d="M224 99 190 210h116L248 99" fill="#F5C451" fill-opacity=".1"/>' +
    '<ellipse cx="218" cy="88" rx="8" ry="8" fill="#F5C451" fill-opacity=".85"/>' +
    '<ellipse cx="160" cy="222" rx="52" ry="10" fill="#0D1828" stroke="#3A5878"/>' +
    '<ellipse cx="160" cy="218" rx="52" ry="9" fill="#182B44"/>' +
    '<rect x="150" y="194" width="20" height="24" rx="4" fill="#233B58"/>' +
    '</svg>';

  var ART_PROJECTOR =
    '<svg viewBox="0 0 320 260" fill="none" aria-hidden="true">' +
    '<defs>' +
      '<linearGradient id="pjBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B425F"/><stop offset="1" stop-color="#122132"/></linearGradient>' +
      '<radialGradient id="pjGlow" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#2BD9A0" stop-opacity=".16"/><stop offset="1" stop-color="#2BD9A0" stop-opacity="0"/></radialGradient>' +
      '<linearGradient id="pjBeam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#F5C451" stop-opacity=".28"/><stop offset="1" stop-color="#F5C451" stop-opacity="0"/></linearGradient>' +
    '</defs>' +
    '<ellipse cx="160" cy="146" rx="124" ry="90" fill="url(#pjGlow)"/>' +
    '<path d="M196 150 300 112v96L196 172Z" fill="url(#pjBeam)"/>' +
    '<rect x="58" y="112" width="138" height="80" rx="18" fill="url(#pjBody)" stroke="#3A5878"/>' +
    '<circle cx="178" cy="152" r="24" fill="#0A1420" stroke="#3A5878" stroke-width="2"/>' +
    '<circle cx="178" cy="152" r="14" fill="#162C44" stroke="#2BD9A0" stroke-opacity=".5"/>' +
    '<circle cx="178" cy="152" r="6" fill="#F5C451" fill-opacity=".8"/>' +
    '<circle cx="178" cy="152" r="27" fill="none" stroke="#2BD9A0" stroke-opacity=".18"/>' +
    '<path d="M78 130h42M78 142h28" stroke="#8FA6BF" stroke-opacity=".5" stroke-width="3" stroke-linecap="round"/>' +
    '<circle cx="90" cy="172" r="5" fill="#2BD9A0"/>' +
    '<path d="M70 192h114" stroke="#0A1420" stroke-width="2"/>' +
    '</svg>';

  var ART_GENERIC =
    '<svg viewBox="0 0 320 260" fill="none" aria-hidden="true">' +
    '<defs><linearGradient id="ggBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B425F"/><stop offset="1" stop-color="#122132"/></linearGradient></defs>' +
    '<rect x="70" y="86" width="180" height="112" rx="20" fill="url(#ggBody)" stroke="#3A5878"/>' +
    '<rect x="92" y="108" width="92" height="10" rx="5" fill="#8FA6BF" fill-opacity=".6"/>' +
    '<rect x="92" y="128" width="60" height="8" rx="4" fill="#2BD9A0" fill-opacity=".6"/>' +
    '<circle cx="214" cy="148" r="18" fill="#0A1420" stroke="#F5C451" stroke-opacity=".55"/>' +
    '</svg>';

  function productArt(product, category) {
    var name = String((product && product.name) || '').toLowerCase();
    var cat = String(category || '').toLowerCase();
    if (/bud|earbud/.test(name)) return ART_BUDS;
    if (/headphone|aurora one|over-ear|studio/.test(name)) return ART_HEADPHONES;
    if (/floor lamp|floor-light/.test(name)) return ART_FLOOR_LAMP;
    if (/desk lamp|desk-light/.test(name)) return ART_DESK_LAMP;
    if (/projector|beam/.test(name)) return ART_PROJECTOR;
    if (/audio|sound/.test(cat)) return ART_HEADPHONES;
    if (/home|light|lamp/.test(cat)) return ART_FLOOR_LAMP;
    if (/gadget|tech/.test(cat)) return ART_PROJECTOR;
    return ART_GENERIC;
  }

  var FALLBACK_DESC = {
    p1: 'Reference-grade over-ear headphones with adaptive noise control, 40-hour battery and a machined aluminium frame.',
    p2: 'Compact wireless earbuds with transparency mode, IPX4 sweat resistance and a pocket charging case.',
    p3: 'Warm, dimmable floor lamp with a linen shade, solid oak stem and a soft evening glow.',
    p4: 'Articulated desk lamp with three colour temperatures, USB-C passthrough and a matte powder coat.',
    p5: 'Palm-sized 1080p projector with auto keystone, built-in streaming and a 120-inch picture.'
  };
  function productDescription(product, category) {
    if (product && product.description) return product.description;
    if (product && product.id && FALLBACK_DESC[product.id]) return FALLBACK_DESC[product.id];
    return 'Ships from ' + (category || 'the merchant') + ' with Settled buyer protection attached to the payment.';
  }

  /* ---------- page helpers ---------- */
  function metric(merchant, ledger, key) {
    var m = merchant || {};
    var cred = (ledger && ledger.credential) || {};
    var sources = [m.metrics, cred.metrics, m];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (s && s[key] !== undefined && s[key] !== null) return s[key];
    }
    return null;
  }
  function productsOf(merchant) {
    var p = (merchant && merchant.products) || [];
    return Array.isArray(p) ? p : [];
  }
  function eventsOf(detail) {
    var ev = (detail && detail.events) || [];
    if (!Array.isArray(ev)) ev = [];
    return ev.slice().sort(function (a, b) {
      return (Number(b.seq) || 0) - (Number(a.seq) || 0);
    });
  }
  function eventType(e) {
    return String((e && (e.type || e.kind || e.event)) || 'event').toLowerCase();
  }
  function eventTone(type) {
    var t = String(type);
    if (/order|payment|paid/.test(t)) return 'gold';
    if (/deliver|fulfil/.test(t)) return 'emerald';
    if (/claim|dispute/.test(t)) return 'danger';
    if (/refund/.test(t)) return 'emerald';
    if (/reserve/.test(t)) return 'gold';
    if (/tier/.test(t)) return 'blue';
    return 'muted';
  }
  function eventIcon(type) {
    var t = String(type);
    if (/order|payment|paid/.test(t)) return 'wallet';
    if (/deliver|fulfil/.test(t)) return 'truck';
    if (/claim|dispute/.test(t)) return 'flag';
    if (/refund/.test(t)) return 'shieldCheck';
    if (/reserve/.test(t)) return 'wallet';
    if (/tier/.test(t)) return 'sparkle';
    return 'dot';
  }
  function eventSummary(e, merchant) {
    if (!e) return '—';
    var d = e.data || e.payload || e.detail || e.meta || {};
    if (e.summary) return String(e.summary);
    if (e.description) return String(e.description);
    var type = eventType(e);
    var parts = [];
    function take() {
      for (var i = 0; i < arguments.length; i++) {
        var k = arguments[i];
        if (d && d[k] !== undefined && d[k] !== null && d[k] !== '') return d[k];
        if (e[k] !== undefined && e[k] !== null && e[k] !== '') return e[k];
      }
      return null;
    }
    function productLabel() {
      var name = take('product_name', 'product');
      if (name) return String(name);
      var pid = take('product_id');
      var list = (merchant && merchant.products) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === pid) return list[i].name;
      }
      return null;
    }
    if (/order/.test(type)) {
      var amount = take('amount');
      var product = productLabel();
      parts.push(product ? esc(product) : 'New order');
      if (amount !== null) parts.push('for <b>' + money(amount) + '</b>');
    } else if (/deliver|fulfil/.test(type)) {
      parts.push('Delivery confirmed');
      var pid = productLabel();
      if (pid) parts.push('for ' + esc(pid));
    } else if (/claim/.test(type)) {
      var reason = take('reason');
      parts.push('Claim filed' + (reason ? ' · ' + esc(String(reason).replace(/_/g, ' ')) : ''));
      var refund = take('refund');
      if (refund !== null) parts.push('· refund <b>' + money(refund) + '</b>');
    } else if (/refund/.test(type)) {
      var r = take('refund', 'amount');
      parts.push('Refund settled' + (r !== null ? ' · <b>' + money(r) + '</b>' : ''));
    } else if (/reserve/.test(type)) {
      var after = take('reserve_after', 'after', 'value');
      parts.push('Reserve updated' + (after !== null ? ' · now <b>' + money(after) + '</b>' : ''));
    } else if (/tier/.test(type)) {
      var from = take('from', 'tier_from', 'old_tier');
      var to = take('to', 'tier_to', 'new_tier');
      parts.push('Tier ' + (from ? esc(from) : '?') + ' → ' + (to ? '<b>' + esc(to) + '</b>' : '?'));
    } else {
      parts.push(type.replace(/_/g, ' '));
    }
    return parts.join(' ');
  }

  /* ---------- score ring for dashboard header ---------- */
  function trustPill(merchant) {
    var t = tierInfo(merchant.tier);
    return '<span class="tier ' + t.cls + '">' + esc(merchant.tier || '?') + '</span>';
  }

  global.Settled = {
    api: api,
    ApiError: ApiError,
    money: money,
    money0: money0,
    num: num,
    pct: pct,
    bps: bps,
    dateFmt: dateFmt,
    timeAgo: timeAgo,
    shortHash: shortHash,
    esc: esc,
    syntax: syntax,
    icon: icon,
    tierInfo: tierInfo,
    modeInfo: modeInfo,
    statusInfo: statusInfo,
    statuses: STATUSES,
    reasons: REASONS,
    toast: toast,
    setBusy: setBusy,
    copyText: copyText,
    copy: copyText,
    qs: qs,
    setQuery: setQuery,
    emptyState: emptyState,
    showApiError: showApiError,
    mountNav: mountNav,
    setMerchantLinks: setMerchantLinks,
    setNavMerchant: setNavMerchant,
    setEnv: setEnv,
    ring: ring,
    modal: modal,
    claimDialog: claimDialog,
    fulfill: fulfill,
    productArt: productArt,
    productDescription: productDescription,
    metric: metric,
    productsOf: productsOf,
    eventsOf: eventsOf,
    eventType: eventType,
    eventTone: eventTone,
    eventIcon: eventIcon,
    eventSummary: eventSummary,
    trustPill: trustPill
  };
})(window);
