/* ============================================================
   Settled — /negotiate.html
   Generic consumer-agent checkout: negotiate → sign → pay → claim.
   Plain ES2017, no dependencies. Uses the shared `Settled` client
   (app.js) for API calls, formatting and toasts.
   ============================================================ */
(function () {
  'use strict';

  var S = window.Settled;
  var $ = function (id) { return document.getElementById(id); };

  if (!S) {
    var host = $('apiError');
    if (host) {
      host.hidden = false;
      host.textContent = 'Settled client failed to load (app.js). Open this page from the running server: node server.js';
    }
    return;
  }

  var params = new URLSearchParams(window.location.search || '');
  var MERCHANT = String(params.get('merchant') || 'm1').trim() || 'm1';
  var PRODUCT = String(params.get('product') || '').trim();
  var AGENT_ID = 'a1';

  var state = {
    config: null,
    agents: [],
    agent: null,
    merchant: null,
    products: [],
    product: null,
    item: null,
    quote: null,
    ledger: null,
    mandate: 500,
    contract: null,
    ai: null,
    order: null,
    payment: null,
    acc: null,
    claim: null,
    claimAi: null,
    live: false,
    busy: false,
    callCount: 0
  };

  /* ---------- small helpers ---------- */
  function esc(v) { return S.esc(v); }
  function enc(v) { return encodeURIComponent(String(v)); }
  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return Math.round(v) === v ? S.money0(v) : S.money(v);
  }
  function coveragePct(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    var pct = n > 0 && n <= 1 ? n * 100 : n;
    return (Math.round(pct * 10) / 10) + '%';
  }
  function initials(name) {
    var parts = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/);
    if (!parts[0]) return '—';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }
  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }
  function show(id, on) {
    var el = $(id);
    if (!el) return;
    if (on) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  }
  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      if (!btn.getAttribute('data-label')) btn.setAttribute('data-label', btn.textContent);
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      if (label) btn.textContent = label;
    } else {
      btn.removeAttribute('aria-busy');
      if (btn.getAttribute('data-label')) btn.textContent = btn.getAttribute('data-label');
      btn.disabled = false;
    }
  }
  function fatal(message) {
    var box = $('apiError');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = S.icon('alert') + '<div><b>Can’t load this negotiation.</b><div class="small" style="margin-top:4px">' +
      esc(message) + '</div><div class="small" style="margin-top:8px"><a href="' + esc(window.location.href) + '">Retry</a></div></div>';
  }
  function toast(message, kind) {
    try { S.toast(message, kind); } catch (e) { /* toast is cosmetic */ }
  }

  /* ---------- API call log ---------- */
  S.api.onCall = function (info) {
    state.callCount += 1;
    setText('callCount', String(state.callCount));
    var log = $('callLog');
    if (!log) return;
    var empty = log.querySelector('.empty');
    if (empty) log.removeChild(empty);
    var row = document.createElement('div');
    row.className = 'call';
    row.innerHTML = '<span class="m">' + esc(info.method || 'GET') + '</span>' +
      '<span class="p" title="' + esc(info.path || '') + '">' + esc(info.path || '') + '</span>' +
      '<span class="s' + (info.ok ? '' : ' err') + '">' + esc(String(info.status || 0)) + '</span>' +
      '<span class="ms">' + (info.ms ? esc(String(info.ms)) + 'ms' : '—') + '</span>';
    log.appendChild(row);
    while (log.children.length > 60) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  };

  /* ---------- data loading ---------- */
  function loadConfig() {
    return S.api('/config').then(function (cfg) {
      state.config = cfg;
      var live = String(cfg && cfg.mode).toLowerCase();
      state.live = (live === 'live' || live === 'paypal') && !!(cfg && cfg.paypal && cfg.paypal.configured);
      S.setEnv(live === 'live' || live === 'paypal' ? 'paypal' : 'sim');
    }).catch(function () { /* health/config is optional */ });
  }

  function loadAgents() {
    return S.api('/agents').then(function (res) {
      state.agents = (res && res.agents) || [];
      state.agent = state.agents.filter(function (a) { return a.id === AGENT_ID; })[0] || null;
      renderAgent();
    }).catch(function () { renderAgent(); });
  }

  function loadProduct() {
    show('apiError', false);
    return S.api('/merchants/' + enc(MERCHANT)).then(function (res) {
      state.merchant = (res && res.merchant) || null;
      state.ledger = (res && res.ledger) || null;
      var products = (state.merchant && state.merchant.products) || [];
      if (!products.length) throw new Error('merchant ' + MERCHANT + ' has no products');
      state.products = products;

      var wanted = PRODUCT;
      var product = null;
      products.forEach(function (p) { if (!product && p.id === wanted) product = p; });
      var requestedMissing = !!wanted && !product;
      products.forEach(function (p) { if (!product && p.negotiable !== false) product = p; });
      if (!product) product = products[0];
      state.product = product;

      state.requestedMissing = requestedMissing;
      state.requestedId = requestedMissing ? wanted : null;
      if (requestedMissing) {
        history.replaceState(null, '', '?merchant=' + enc(MERCHANT) + '&product=' + enc(product.id));
      }

      renderProduct();
      renderMerchant();
      renderAgent();
      refreshMandateUi();
      loadProtectionQuote();
      loadIndexItem(product.id);
      verifyCredential();
      if (product.negotiable === false) {
        setText('negBadge', 'fixed price');
        setText('startBadge', 'not negotiable');
      }
      syncStartState();
    }).catch(function (err) {
      fatal(err && err.message ? err.message : 'merchant not found');
      setText('productSub', 'Not loaded');
      $('productBody').innerHTML = '<div class="empty">Product unavailable.</div>';
      return null;
    });
  }

  /** Optional enrichment when the public market index exists (backend lands in parallel). */
  function loadIndexItem(productId) {
    return S.api('/index?merchant=' + enc(MERCHANT) + '&limit=50').then(function (res) {
      var items = (res && res.items) || [];
      var match = null;
      items.forEach(function (it) {
        if (!match && it && it.product && it.product.id === productId) match = it;
      });
      if (match) {
        state.item = match;
        if (match.protection) state.protection = match.protection;
        renderProduct();
      }
    }).catch(function () { /* index endpoint is optional in this build */ });
  }

  function loadProtectionQuote() {
    if (!state.product) return;
    return S.api('/protection/quote', {
      method: 'POST',
      body: { merchant_id: MERCHANT, amount: Number(state.product.price) }
    }).then(function (res) {
      state.quote = (res && res.quote) || null;
      renderProduct();
    }).catch(function () { /* derive from merchant fields instead */ });
  }

  function verifyCredential() {
    return S.api('/merchants/' + enc(MERCHANT) + '/verify', { method: 'POST', body: {} }).then(function (res) {
      var valid = !!(res && (res.valid === true || (res.checks && res.checks.signature && res.checks.issuer)));
      var badge = $('verifyBadge');
      if (badge) {
        badge.textContent = valid ? 'signature valid' : 'verify failed';
        badge.className = 'badge ' + (valid ? 'emerald' : 'gold');
      }
    }).catch(function () {
      var badge = $('verifyBadge');
      if (badge) { badge.textContent = 'unverified'; }
    });
  }

  /* ---------- derived values ---------- */
  function publishedRange() {
    var item = state.item;
    if (item && item.published_range) return item.published_range;
    if (state.product && state.product.published_range) return state.product.published_range;
    return null;
  }
  function terms() {
    if (state.item && state.item.terms) return state.item.terms;
    if (state.product && state.product.terms) return state.product.terms;
    return null;
  }
  function isNegotiable() {
    if (state.product && state.product.negotiable === false) return false;
    if (state.item && state.item.product && state.item.product.negotiable === false) return false;
    return true;
  }
  function protection() {
    if (state.item && state.item.protection) return state.item.protection;
    if (state.quote) return { fee_bps: state.quote.fee_bps, cap: state.quote.cap, mode: state.quote.mode };
    if (state.merchant) return { fee_bps: state.merchant.fee_bps, cap: state.merchant.cap, mode: state.merchant.mode };
    return null;
  }
  function modeLabel(mode) {
    var info = S.modeInfo ? S.modeInfo(mode) : null;
    return info && info.label ? info.label : String(mode || '—');
  }

  /* ---------- render: product ---------- */
  function renderProduct() {
    var p = state.product;
    if (!p) return;
    var range = publishedRange();
    var neg = isNegotiable();
    var prot = protection();
    var t = terms();
    var list = Number(p.price);
    var from = range && Number(range.min);
    var showFrom = neg && isFinite(from) && from > 0 && from < list;

    var priceHtml = '<div class="price-row">' +
      '<span class="price-now">' + (showFrom ? 'from ' : '') + esc(money(showFrom ? from : list)) + '</span>' +
      (showFrom ? '<span class="price-list">' + esc(money(list)) + ' list</span>' : '') +
      (range && isFinite(Number(range.max)) && Number(range.max) !== Number(range.min)
        ? '<span class="price-range">negotiable ' + esc(money(range.min)) + '–' + esc(money(range.max)) + '</span>'
        : '<span class="price-range">' + (neg ? 'negotiable' : 'fixed price') + '</span>') +
      '</div>';

    var termHtml = '';
    if (t) {
      if (t.delivery_days) termHtml += '<span class="term">' + S.icon('truck') + esc(t.delivery_days) + '-day delivery</span>';
      if (t.returns_days) termHtml += '<span class="term">' + S.icon('package') + esc(t.returns_days) + '-day returns</span>';
      if (t.warranty_months) termHtml += '<span class="term">' + S.icon('shieldCheck') + esc(t.warranty_months) + '-month warranty</span>';
    }

    var protHtml = '';
    if (prot) {
      var fee = state.quote && state.quote.fee !== undefined
        ? Number(state.quote.fee)
        : (isFinite(list) ? Math.round((list * Number(prot.fee_bps)) / 10000 * 100) / 100 : 0);
      protHtml = '<div class="price-range prot-line" style="margin-top:10px;color:var(--muted)">' + S.icon('shieldCheck') +
        ' protection ' + esc(String(prot.fee_bps)) + ' bps · ~' + esc(money(fee)) + ' at list · ' +
        esc(money(prot.cap)) + ' cap · ' + esc(modeLabel(prot.mode)) + '</div>';
    }

    $('productSub').textContent = (p.category ? p.category + ' · ' : '') + (state.merchant ? state.merchant.name : MERCHANT) +
      ' · prices in USD' + (state.requestedMissing ? ' · requested ' + state.requestedId + ' not found' : '');
    setText('negBadge', neg ? 'negotiable' : 'fixed price');
    $('negBadge').className = 'badge ' + (neg ? 'emerald' : 'muted');

    $('productBody').innerHTML =
      '<div class="prod">' +
        '<div class="prod-art" aria-hidden="true">' + esc(initials(p.category || p.name)) + '</div>' +
        '<div style="min-width:0">' +
          '<div class="prod-meta">' +
            (p.category ? '<span class="chip chip-tone-blue">' + esc(p.category) + '</span>' : '') +
            (neg ? '<span class="chip chip-tone-emerald">negotiable</span>' : '<span class="chip chip-tone-muted">fixed price</span>') +
            '<span class="chip chip-tone-muted">' + esc(p.id) + '</span>' +
          '</div>' +
          '<div class="prod-name" style="margin-top:7px">' + esc(p.name) + '</div>' +
          (p.description ? '<div class="prod-desc">' + esc(p.description) + '</div>' : '') +
          priceHtml +
          (termHtml ? '<div class="terms">' + termHtml + '</div>' : '') +
          protHtml +
        '</div>' +
      '</div>' +
      '<div class="neg-note">Published by the merchant for any agent. The private floor and auto-accept price stay server-side — this page only sees the public range and terms.</div>';
  }

  /* ---------- render: merchant trust ---------- */
  function renderMerchant() {
    var m = state.merchant;
    if (!m) return;
    var tier = S.tierInfo ? S.tierInfo(m.tier) : { label: 'Tier ' + m.tier, cls: 'tier-c' };
    var sig = state.ledger && state.ledger.signature ? S.shortHash(state.ledger.signature, 20) : null;
    var facts = [
      ['trust tier', '<span class="tier ' + esc(tier.cls) + '" style="vertical-align:middle">' + esc(m.tier || '?') + '</span> <span class="small muted">score ' + esc(String(m.score)) + ' · ' + esc(coveragePct(m.coverage)) + ' coverage</span>'],
      ['protection price', esc(String(m.fee_bps)) + ' bps · ' + esc(money(m.cap)) + ' cap'],
      ['settlement mode', esc(modeLabel(m.mode))],
      ['reserve', esc(money(m.reserve)) + ' <span class="small muted">merchant-funded</span>'],
      ['credential', sig ? '<span class="mono" title="' + esc(state.ledger.signature || '') + '">' + esc(sig) + '</span>' : 'HMAC-SHA256 signed'],
      ['merchant id', esc(m.id)]
    ];
    $('merchantBody').innerHTML = '<div class="facts">' + facts.map(function (f) {
      return '<div class="fact"><div class="fact-label">' + esc(f[0]) + '</div><div class="fact-value">' + f[1] + '</div></div>';
    }).join('') + '</div>' +
      '<div class="note-inline">The credential is earned from settled payments, delivery and dispute outcomes — not bought. Nothing here is a review score.</div>';
  }

  /* ---------- render: agent passport ---------- */
  function renderAgent() {
    var a = state.agent || {};
    var name = a.name || 'ProcureBot';
    var operator = a.operator || 'Acme Procurement Inc';
    var kyb = a.kyb || 'verified';
    var caps = (a.capabilities || ['purchase', 'negotiate', 'claim']).join(' · ');
    var limit = a.limits && a.limits.max_amount ? a.limits.max_amount : 500;
    var rep = a.reputation && a.reputation.score !== undefined ? a.reputation.score : 92;
    var mandateId = a.mandate && a.mandate.id ? a.mandate.id : 'ap2_9f2c';
    var cats = a.limits && a.limits.categories ? a.limits.categories.join('/') : 'audio/electronics';

    setText('agentBadge', a.id || AGENT_ID);
    $('agentBody').innerHTML =
      '<div class="passport">' +
        '<div class="p-avatar" aria-hidden="true">' + esc(initials(name)) + '</div>' +
        '<div style="min-width:0">' +
          '<div class="p-name">' + esc(name) + '</div>' +
          '<div class="p-sub">' + esc(operator) + ' · KYB ' + esc(kyb) + ' · signed mandate ' + esc(mandateId) + '</div>' +
          '<div class="p-badges">' +
            '<span class="badge blue">agent passport</span>' +
            '<span class="badge">' + esc(caps) + '</span>' +
            '<span class="badge">reputation ' + esc(String(rep)) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="facts">' +
        '<div class="fact"><div class="fact-label">operator</div><div class="fact-value">' + esc(operator) + '</div></div>' +
        '<div class="fact"><div class="fact-label">KYB</div><div class="fact-value">' + esc(kyb) + '</div></div>' +
        '<div class="fact"><div class="fact-label">agent spend limit</div><div class="fact-value">' + esc(money(limit)) + '</div></div>' +
        '<div class="fact"><div class="fact-label">categories</div><div class="fact-value">' + esc(cats) + '</div></div>' +
      '</div>' +
      '<div class="note-inline">The passport is checked server-side before the order exists. The mandate below is the ceiling this page passes into the contract.</div>';

  }

  /* ---------- mandate ---------- */
  function mandateValue() {
    var input = $('mandateMax');
    var n = Number(input && input.value);
    return isFinite(n) && n > 0 ? Math.round(n) : 0;
  }
  function refreshMandateUi() {
    var range = publishedRange();
    var min = range && Number(range.min) ? Number(range.min) : 0;
    setText('mandatePublish', min ? 'published from ' + money(min) : '');
    var hint = $('mandateHint');
    var max = mandateValue();
    if (!hint) return;
    hint.className = 'neg-hint';
    if (!max) {
      hint.textContent = 'Enter a ceiling above the published from-price.';
      hint.className = 'neg-hint warn';
    } else if (min && max < min) {
      hint.textContent = 'Below the published from-price (' + money(min) + '). The seller should counter above your mandate — no deal at this ceiling.';
      hint.className = 'neg-hint warn';
    } else {
      hint.textContent = 'The agent can never offer, accept or pay above ' + money(max) + '.';
    }
    syncStartState();
  }
  function syncStartState() {
    var btn = $('startBtn');
    if (!btn) return;
    if (state.busy) { btn.disabled = true; return; }
    var ok = !!state.product && isNegotiable() && mandateValue() > 0;
    btn.disabled = !ok;
  }

  /* ---------- negotiation ---------- */
  function startNegotiation() {
    if (state.busy || !state.product) return;
    var max = mandateValue();
    if (!max) { toast('Set a mandate ceiling first.', 'warn'); return; }
    var range = publishedRange();
    if (range && Number(range.min) && max < Number(range.min)) {
      toast('Your mandate is below the published from-price — raise it to at least ' + money(range.min) + '.', 'warn');
      return;
    }

    state.busy = true;
    var btn = $('startBtn');
    setBusy(btn, true, 'Negotiating…');

    S.api('/contracts', {
      method: 'POST',
      body: { merchant_id: MERCHANT, product_id: state.product.id, buyer_agent_id: AGENT_ID, mandate: { max: max } }
    }).then(function (res) {
      var contract = (res && res.contract) || res;
      if (!contract || !contract.id) throw new Error('contract create returned no id');
      state.contract = contract;
      return S.api('/contracts/' + enc(contract.id) + '/ai-auto', { method: 'POST', body: {} }).then(function (aiRes) {
        state.contract = (aiRes && aiRes.contract) || contract;
        state.ai = (aiRes && aiRes.ai) || null;
      }).catch(function () {
        // Older backend without the AI endpoint: fall back to the deterministic auto path.
        return S.api('/contracts/' + enc(contract.id) + '/auto', { method: 'POST', body: {} }).then(function (autoRes) {
          state.contract = (autoRes && autoRes.contract) || contract;
          state.ai = null;
        });
      });
    }).then(function () {
      setText('startBadge', 'max 2 moves');
      renderChat();
      show('chatPanel', true);
      if ($('chatPanel') && $('chatPanel').scrollIntoView) {
        try { $('chatPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
      }
      var c = state.contract;
      if (c && c.status === 'accepted') {
        toast('Deal agreed at ' + money(c.agreed_price) + ' — contract signed.', 'ok');
      } else {
        toast('No agreement inside that mandate. Raise the ceiling and start again.', 'warn');
      }
    }).catch(function (err) {
      toast(err && err.message ? err.message : 'negotiation failed', 'err');
    }).then(function () {
      state.busy = false;
      setBusy(btn, false);
      syncStartState();
    });
  }

  function dialogueEntries() {
    var ai = state.ai || {};
    var list = Array.isArray(ai.dialogue) ? ai.dialogue : (Array.isArray(ai.moves) ? ai.moves : []);
    if (list.length) {
      return list.map(function (d) {
        return {
          from: d.from || 'buyer_agent',
          agent: d.agent || null,
          action: d.action || 'offer',
          price: d.price,
          message: d.message || d.note || '',
          rationale: d.rationale || '',
          policy: d.policy || ''
        };
      });
    }
    // Deterministic fallback: render the contract transcript.
    var transcript = (state.contract && Array.isArray(state.contract.transcript)) ? state.contract.transcript : [];
    return transcript.map(function (e) {
      var from = String(e.from || e.actor || 'buyer').toLowerCase().indexOf('merchant') >= 0 ? 'merchant_agent' : 'buyer_agent';
      return {
        from: from,
        agent: null,
        action: e.action || e.type || 'offer',
        price: e.price,
        message: e.note || e.message || '',
        rationale: '',
        policy: ''
      };
    });
  }

  function policyLabel(policy) {
    var p = String(policy || '').toLowerCase();
    if (p.indexOf('mandate') >= 0) return 'within mandate';
    if (p.indexOf('auto') >= 0) return 'seller policy';
    if (p.indexOf('signed') >= 0) return 'signed';
    return '';
  }

  function renderChat() {
    var c = state.contract;
    if (!c) return;
    var ai = state.ai || {};
    var merchantName = (state.merchant && state.merchant.name) || 'Merchant';
    var entries = dialogueEntries();

    var rows = entries.map(function (d) {
      var side = String(d.from || '').toLowerCase().indexOf('merchant') >= 0 ? 'merchant' : 'buyer';
      var action = String(d.action || 'offer').toLowerCase();
      var agentName = d.agent || (side === 'merchant' ? merchantName + ' Seller Agent' : 'ProcureBot');
      var hasPrice = d.price !== undefined && d.price !== null && isFinite(Number(d.price));
      var priceChip = hasPrice ? '<span class="b-price">' + (action === 'accept' ? 'agreed ' : '') + esc(money(d.price)) + '</span>' : '';
      var policy = policyLabel(d.policy);
      return '<div class="b-row ' + side + '">' +
        '<div class="b-av" aria-hidden="true">' + esc(initials(agentName)) + '</div>' +
        '<div class="bubble">' +
          '<div class="b-head">' +
            '<span class="b-name">' + esc(agentName) + '</span>' +
            '<span class="b-action ' + esc(action) + '">' + esc(action) + '</span>' +
            priceChip +
            (policy ? '<span class="b-policy">' + esc(policy) + '</span>' : '') +
          '</div>' +
          (d.message ? '<div class="b-msg">' + esc(d.message) + '</div>' : '') +
          (d.rationale ? '<div class="b-why">' + esc(d.rationale) + '</div>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    $('chatBody').innerHTML = rows || '<div class="empty">No transcript returned.</div>';

    var aiUsed = !!(ai && ai.used);
    var badge = $('aiBadge');
    badge.textContent = aiUsed ? 'AI · ' + String(ai.model || 'model') : (ai ? 'fallback policy' : 'policy only');
    badge.className = 'badge ' + (aiUsed ? 'blue' : 'muted');

    var accepted = c.status === 'accepted' && c.agreed_price !== null && c.agreed_price !== undefined;
    var deal = $('dealBadge');
    deal.textContent = accepted ? 'accepted ' + money(c.agreed_price) : 'open — no deal';
    deal.className = 'badge ' + (accepted ? 'emerald' : 'gold');

    var hash = $('hashLine');
    if (hash) {
      var sig = c.signatures || {};
      function sigText(v) {
        if (!v) return '';
        if (typeof v === 'string') return v;
        return v.sig || v.signature || v.hash || '';
      }
      hash.hidden = false;
      hash.innerHTML =
        '<span>signed contract <b class="mono">' + esc(S.shortHash(c.hash, 22)) + '</b></span>' +
        '<span class="sep">·</span>' +
        '<span>buyer sig <b class="mono">' + esc(S.shortHash(sigText(sig.buyer), 16)) + '</b></span>' +
        '<span class="sep">·</span>' +
        '<span>seller sig <b class="mono">' + esc(S.shortHash(sigText(sig.merchant), 16)) + '</b></span>' +
        '<span class="sep">·</span>' +
        '<span>mandate <b class="mono">' + esc(money(c.mandate && c.mandate.max)) + '</b></span>' +
        '<span class="sep">·</span>' +
        '<span>terms fixed before payment</span>';
    }

    setText('chatSub', aiUsed ? 'Agent-to-agent · model-generated, policy-guarded' : 'Agent-to-agent · deterministic policy fallback');

    var actions = $('chatActions');
    if (accepted) {
      actions.hidden = false;
      var payBtn = $('payBtn');
      payBtn.disabled = false;
      payBtn.textContent = 'Pay ' + money(c.agreed_price) + (state.live ? ' · PayPal sandbox' : ' (SIM)');
      setText('startBadge', 'contract signed');
    } else {
      actions.hidden = true;
    }
  }

  /* ---------- pay ---------- */
  function pay() {
    if (state.busy || !state.contract) return;
    var c = state.contract;
    if (c.status !== 'accepted') { toast('There is no agreed price yet.', 'warn'); return; }
    state.busy = true;
    var btn = $('payBtn');
    setBusy(btn, true, 'Placing order…');

    S.api('/merchants/' + enc(MERCHANT) + '/orders', {
      method: 'POST',
      body: {
        product_id: state.product.id,
        buyer: {
          name: (state.agent && state.agent.name) || 'ProcureBot',
          email: ((state.agent && state.agent.id) || 'agent') + '@acme.example'
        },
        contract_id: c.id,
        agent_id: AGENT_ID,
        simulate: !state.live
      }
    }).then(function (res) {
      state.order = (res && res.order) || null;
      state.payment = (res && res.payment) || null;
      state.acc = (res && res.acc) || (state.order && state.order.acc) || null;
      renderOrder();
      show('orderPanel', true);
      show('chatActions', false);
      if ($('orderPanel') && $('orderPanel').scrollIntoView) {
        try { $('orderPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
      }
      toast(state.live ? 'PayPal sandbox order created — approve in PayPal, then capture.' : 'Order placed at ' + money(state.order && state.order.amount) + ' — SIM payment.', 'ok');
    }).catch(function (err) {
      toast(err && err.message ? err.message : 'order failed', 'err');
    }).then(function () {
      state.busy = false;
      setBusy(btn, false);
    });
  }

  function renderOrder() {
    var o = state.order || {};
    var p = state.payment || {};
    var facts = [
      ['order id', '<span class="mono">' + esc(o.id || '—') + '</span>'],
      ['agreed amount', esc(money(o.amount))],
      ['payment id', '<span class="mono">' + esc(p.id || o.payment_id || '—') + '</span>'],
      ['platform fee · 0.5%', esc(money(o.platform_fee || 0)) + ' <span class="tiny muted">' + (o.platform_fee_collected ? 'collected' : 'accrued') + '</span>'],
      ['merchant net', esc(money(o.merchant_net || 0))],
      ['rail', esc(p.mode || 'sim') + (o.simulated ? ' · SIM forced' : '')],
      ['status', esc(o.status || '—')],
      ['contract hash', state.acc && state.acc.hash ? '<span class="mono">' + esc(S.shortHash(state.acc.hash, 22)) + '</span>' : '—']
    ];
    $('orderBody').innerHTML =
      '<div class="facts">' + facts.map(function (f) {
        return '<div class="fact"><div class="fact-label">' + esc(f[0]) + '</div><div class="fact-value">' + f[1] + '</div></div>';
      }).join('') + '</div>' +
      '<div class="note-inline">' + (o.simulated
        ? 'The order carries the Agent Commerce Contract hash. This is the deterministic SIM rail; the hosted live sandbox uses the real PayPal approval rail.'
        : 'Live PayPal sandbox order. Approve it in PayPal, then capture to lock the real capture id before filing a claim.') + '</div>';
    setText('orderSub', 'Order ' + (o.id || '') + ' · ' + money(o.amount));
    setText('orderBadge', o.status === 'paid' ? (o.simulated ? 'paid (SIM)' : 'paid · sandbox') : String(o.status || '—'));
    var actions = $('orderActions');
    if (actions) {
      var approval = p.approval_url || o.approval_url;
      if (!o.simulated && approval) {
        actions.innerHTML = '<a class="btn btn-gold" href="' + esc(approval) + '" target="_blank" rel="noopener noreferrer">Open PayPal approval</a>' +
          '<button class="btn btn-primary" id="captureLiveBtn" type="button">I approved — capture</button>';
        var captureBtn = $('captureLiveBtn');
        if (captureBtn) captureBtn.addEventListener('click', function () { captureLive(captureBtn); });
      } else {
        actions.innerHTML = '<button class="btn btn-danger" id="claimBtn" type="button">File claim — item never arrived</button>';
        var cb = $('claimBtn');
        if (cb) cb.addEventListener('click', fileClaim);
      }
      actions.hidden = false;
    }
  }

  /* ---------- live PayPal capture ---------- */
  function captureLive(btn) {
    if (state.busy || !state.order) return;
    state.busy = true;
    setBusy(btn, true, 'Capturing…');
    S.api('/paypal/capture', {
      method: 'POST',
      body: { order_id: state.order.id, paypal_order_id: (state.payment && state.payment.id) || undefined }
    }).then(function (res) {
      state.order = (res && res.order) || state.order;
      state.payment = (res && res.capture) || state.payment;
      renderOrder();
      toast('PayPal sandbox payment captured.', 'ok');
    }).catch(function (err) {
      toast((err && err.message) || 'capture failed', 'err');
    }).then(function () {
      state.busy = false;
      setBusy(btn, false);
    });
  }

  /* ---------- claim ---------- */
  function fileClaim() {
    if (state.busy || !state.order) return;
    state.busy = true;
    var btn = $('claimBtn');
    setBusy(btn, true, 'Filing claim…');

    S.api('/orders/' + enc(state.order.id) + '/claim', {
      method: 'POST',
      body: { reason: 'not_delivered', evidence: true, use_ai: true, actor: 'agent:' + AGENT_ID }
    }).then(function (res) {
      state.claim = (res && res.claim) || null;
      state.claimAi = (res && res.ai) || (state.claim && state.claim.ai) || null;
      renderClaim(res || {});
      show('claimPanel', true);
      show('orderActions', false);
      if ($('claimPanel') && $('claimPanel').scrollIntoView) {
        try { $('claimPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
      }
      toast('Claim paid: ' + money(state.claim && state.claim.refund) + ' from the merchant reserve.', 'ok');
    }).catch(function (err) {
      toast(err && err.message ? err.message : 'claim failed', 'err');
    }).then(function () {
      state.busy = false;
      setBusy(btn, false);
    });
  }

  function renderClaim(res) {
    var claim = state.claim || {};
    var ai = state.claimAi || (res && res.ai) || null;
    var refund = claim.refund !== undefined ? claim.refund : (res && res.refund);
    var refundId = claim.paypal_refund_id || (res && res.paypal_refund_id) || '—';
    var reserveBefore = claim.reserve_before !== undefined ? claim.reserve_before : null;
    var reserveAfter = claim.reserve_after !== undefined ? claim.reserve_after : null;
    var sla = claim.sla_ms || (res && res.sla_ms) || 1200;

    var aiHtml = '';
    if (ai && ai.recommendation) {
      var conf = typeof ai.confidence === 'number' ? Math.round(ai.confidence * 100) + '% confidence' : '';
      aiHtml = '<div class="note-inline" style="padding-top:12px;border-top:1px solid rgba(29,44,68,.8)">' +
        '<b class="muted tiny" style="display:block;margin-bottom:5px">AI claim explainer · ' + esc(ai.recommendation) + (conf ? ' · ' + esc(conf) : '') + '</b>' +
        esc(ai.rationale || '') + '</div>';
    }

    $('claimBody').innerHTML =
      '<div class="done-line">' +
        '<div><div class="fact-label">refunded from the merchant reserve</div>' +
        '<div class="big-amount" style="margin-top:6px">' + esc(money(refund)) + '</div></div>' +
        '<div class="muted">' + esc(String(sla)) + 'ms · ' + esc(claim.status || 'approved') + '</div>' +
      '</div>' +
      '<div class="facts">' +
        '<div class="fact"><div class="fact-label">refund id (Payments v2)</div><div class="fact-value mono">' + esc(refundId) + '</div></div>' +
        '<div class="fact"><div class="fact-label">paid from reserve</div><div class="fact-value">' + esc(money(claim.paid_from_reserve !== undefined ? claim.paid_from_reserve : refund)) + '</div></div>' +
        '<div class="fact"><div class="fact-label">reserve before</div><div class="fact-value">' + esc(reserveBefore === null ? '—' : money(reserveBefore)) + '</div></div>' +
        '<div class="fact"><div class="fact-label">reserve after</div><div class="fact-value">' + esc(reserveAfter === null ? '—' : money(reserveAfter)) + '</div></div>' +
        '<div class="fact"><div class="fact-label">reason</div><div class="fact-value">' + esc(claim.reason || 'not_delivered') + '</div></div>' +
        '<div class="fact"><div class="fact-label">filed by</div><div class="fact-value">' + esc(claim.actor || 'agent:' + AGENT_ID) + '</div></div>' +
      '</div>' + aiHtml +
      '<div class="note-inline">The claim is paid from the merchant’s own reserve, not a chargeback. The merchant’s score and tier recompute after the dispute — that is the loop.</div>';
    setText('claimSub', 'Order ' + (claim.order_id || (state.order && state.order.id) || '') + ' · no chargeback, no support queue');
    setText('slaBadge', String(sla) + 'ms');
  }

  /* ---------- wiring ---------- */
  function bindEvents() {
    var startBtn = $('startBtn');
    if (startBtn) startBtn.addEventListener('click', startNegotiation);
    var resetBtn = $('resetBtn');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      window.location.href = window.location.pathname + (MERCHANT ? '?merchant=' + enc(MERCHANT) + (PRODUCT ? '&product=' + enc(PRODUCT) : '') : '');
    });
    var mandateInput = $('mandateMax');
    if (mandateInput) {
      mandateInput.addEventListener('input', refreshMandateUi);
      mandateInput.addEventListener('change', refreshMandateUi);
    }
    var payBtn = $('payBtn');
    if (payBtn) payBtn.addEventListener('click', pay);
    var claimBtn = $('claimBtn');
    if (claimBtn) claimBtn.addEventListener('click', fileClaim);
  }

  function boot() {
    bindEvents();
    setText('agentBadge', 'a1');
    setText('mandatePublish', '');
    if (!PRODUCT) {
      // Default to the first negotiable product once the catalog is known.
      setText('productSub', 'Loading catalog…');
    }
    var input = $('mandateMax');
    if (input) input.value = String(state.mandate);
    Promise.all([loadConfig(), loadAgents()]).then(function () {
      // Auto-fill the mandate from the agent's signed passport — no typing.
      var agentMax = state.agent && state.agent.limits && Number(state.agent.limits.max_amount);
      if (input && isFinite(agentMax) && agentMax > 0) input.value = String(agentMax);
      refreshMandateUi();
      return loadProduct();
    }).catch(function (err) {
      if (err && err.message) fatal(err.message);
    }).then(function () {
      state.busy = false;
      syncStartState();
    });
  }

  boot();
})();
