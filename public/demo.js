/* =========================================================
   Settled — live demo console behavior
   Plain ES2017, no dependencies. Uses the shared `Settled` client.
   ========================================================= */
(function () {
  'use strict';
  var S = window.Settled;
  if (!S) return;

  var MERCHANT_ID = 'm1';
  var STEP_AXIS = { 1: 'trust', 2: 'authorization', 3: 'negotiation', 4: 'protection', 5: 'recourse' };

  var FALLBACK_AGENTS = [
    {
      id: 'a1', name: 'ProcureBot', status: 'valid',
      operator: { legal_name: 'Acme Procurement Inc', kyb: 'verified', country: 'US' },
      capabilities: ['purchase', 'negotiate', 'claim'],
      limits: { max_amount: 500, categories: ['audio', 'electronics'], merchants: ['m1', 'm2'] },
      reputation: { orders: 24, claims: 1, violations: 0, score: 92 }
    },
    {
      id: 'a2', name: 'GiftGenie', status: 'valid',
      operator: { legal_name: 'Lumen Labs', kyb: 'verified', country: 'US' },
      capabilities: ['purchase'],
      limits: { max_amount: 250, categories: ['home'], merchants: ['m2'] },
      reputation: { orders: 8, claims: 0, violations: 0, score: 78 }
    },
    {
      id: 'a3', name: 'RogueBot', status: 'invalid',
      operator: null, capabilities: ['purchase'],
      limits: { max_amount: 9999 },
      reputation: { orders: 0, claims: 0, violations: 6, score: 12 }
    }
  ];

  var paypalSdkPromise = null;

  var state = {
    config: null,
    liveMode: false,
    paypalClientId: null,
    paypalEnv: 'sandbox',
    aiEnabled: false,
    aiModel: null,
    health: null,
    merchant: null,
    merchantBefore: null,
    ledger: null,
    agents: [],
    agentsSource: 'fallback',
    agentId: 'a1',
    contract: null,
    quote: null,
    order: null,
    orderResponse: null,
    approvalUrl: null,
    claim: null,
    claimResponse: null,
    contractAi: null,
    contractAiRequested: false,
    claimAi: null,
    captureId: '',
    paypalCaptured: false,
    paypalOrderId: null,
    livePaypalActive: false,
    lastQuoteRes: null,
    lastOrderRes: null,
    completed: {},
    logEntries: [],
    logSeq: 0,
    busy: false,
    running: false
  };

  var el = {
    apiError: document.getElementById('apiError'),
    body: document.getElementById('demoBody'),
    modeBadge: document.getElementById('modeBadge'),
    modeNote: document.getElementById('modeNote'),
    aiBadge: document.getElementById('aiBadge'),
    progress: document.getElementById('progressCount'),
    runAll: document.getElementById('runAllBtn'),
    reset: document.getElementById('resetBtn'),
    clearLog: document.getElementById('clearLogBtn'),
    log: document.getElementById('log'),
    logEmpty: document.getElementById('logEmpty'),
    logCount: document.getElementById('logCount'),
    logFoot: document.getElementById('logFoot'),
    finalPanel: document.getElementById('finalPanel'),
    finalContract: document.getElementById('finalContract'),
    finalRefund: document.getElementById('finalRefund'),
    finalOrder: document.getElementById('finalOrder'),
    agentControls: document.getElementById('agentControls')
  };
  el.runAllOriginal = el.runAll.innerHTML;

  S.mountNav('demo');
  wire();

  /* ---------------------------------------------------------- boot -- */
  async function boot() {
    setControlsDisabled(true);
    el.apiError.hidden = true;
    var health;
    try {
      health = await S.api('/health');
    } catch (err) {
      el.modeBadge.textContent = 'OFFLINE';
      el.modeBadge.className = 'badge danger';
      el.modeNote.textContent = 'API unreachable — start node server.js';
      S.showApiError(el.apiError, err, function () { boot(); });
      return;
    }
    state.health = health || {};
    var extras = await Promise.all([
      S.api('/config').catch(function () { return null; }),
      S.api('/agents').catch(function () { return null; })
    ]);
    applyConfig(extras[0]);
    var agentsRes = extras[1];
    if (agentsRes && agentsRes.agents) {
      state.agents = agentsRes.agents;
      state.agentsSource = 'live';
    } else {
      state.agents = FALLBACK_AGENTS.slice();
      state.agentsSource = 'fallback';
    }
    if (!state.agents.length) {
      state.agents = FALLBACK_AGENTS.slice();
      state.agentsSource = 'fallback';
    }
    if (!state.agents.some(function (a) { return a.id === 'a1'; })) {
      state.agents.unshift(FALLBACK_AGENTS[0]);
    }
    state.agentId = 'a1';
    renderAgentControls();
    setControlsDisabled(false);
    updateProgress();
    // Zero-input demo: /demo.html?auto=1 starts the run once the page is ready.
    if (new URLSearchParams(window.location.search || '').get('auto') === '1') {
      setTimeout(function () {
        if (!state.running && !state.busy) runAll();
      }, 650);
    }
  }

  function applyConfig(config) {
    state.config = config || null;
    var mode = (config && config.mode) || (state.health && state.health.mode) || 'sim';
    state.liveMode = String(mode).toLowerCase() === 'live' || String(mode).toLowerCase() === 'paypal';
    state.paypalClientId = (config && config.paypal && config.paypal.client_id) || null;
    state.paypalEnv = (config && config.paypal && config.paypal.env) || 'sandbox';
    state.aiEnabled = !!(config && config.ai && config.ai.enabled);
    state.aiModel = (config && config.ai && config.ai.model) || null;
    setMode(state.liveMode ? 'live' : 'sim');
    updateAiBadge();
    var toggle = document.getElementById('aiEnabled');
    if (toggle) toggle.checked = true; // always start with agent dialogue; fallback renders deterministic messages
    var hint = document.getElementById('aiHint');
    if (hint) {
      hint.textContent = state.aiEnabled
        ? (state.aiModel || 'AI enabled')
        : 'fallback · deterministic agent dialogue';
    }
    syncAiEndpoint(true);
  }

  function syncAiEndpoint(useAi) {
    var endpoint = document.getElementById('step3Endpoint');
    if (endpoint) endpoint.textContent = 'POST /api/contracts + ' + (useAi ? '/ai-auto' : '/auto');
  }

  function updateAiBadge() {
    if (!el.aiBadge) return;
    if (state.aiEnabled) {
      el.aiBadge.textContent = 'AI: ' + (state.aiModel || 'enabled');
      el.aiBadge.className = 'badge blue';
    } else {
      el.aiBadge.textContent = 'AI: fallback';
      el.aiBadge.className = 'badge gold';
    }
  }

  function setMode(mode) {
    var live = String(mode || 'sim').toLowerCase() === 'live' || String(mode || 'sim').toLowerCase() === 'paypal';
    S.setEnv(live ? 'paypal' : 'sim');
    el.modeBadge.textContent = live ? 'PAYPAL SANDBOX' : 'SIM';
    el.modeBadge.className = 'badge ' + (live ? 'blue' : 'gold');
    el.modeNote.textContent = live
      ? (state.paypalClientId ? 'live sandbox · step 4 manual is real' : 'live server · PayPal client not configured')
      : 'deterministic · no funds move';
    el.logFoot.textContent = live ? 'LIVE' : 'SIM';
  }

  /* --------------------------------------------------------- wiring -- */
  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-run]'), function (btn) {
      btn.addEventListener('click', function () { manualRun(Number(btn.getAttribute('data-run'))); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-rogue]'), function (btn) {
      btn.addEventListener('click', tryRogueBot);
    });
    el.runAll.addEventListener('click', runAll);
    var autoBtn = document.getElementById('autoConfigureBtn');
    if (autoBtn) autoBtn.addEventListener('click', autoConfigure);
    el.reset.addEventListener('click', resetDemo);
    el.clearLog.addEventListener('click', clearLog);

    document.addEventListener('click', function (e) {
      var copy = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
      if (!copy) return;
      e.preventDefault();
      S.copyText(copy.getAttribute('data-copy'), copy.getAttribute('data-copy-label') || 'Copied');
    });

    var step2 = document.getElementById('step-2');
    var rogue = document.createElement('div');
    rogue.className = 'step-result hidden';
    rogue.id = 'rogueResult';
    var actions = step2.querySelector('.step-actions');
    step2.querySelector('.step-main').insertBefore(rogue, actions);
    el.rogue = rogue;

    document.addEventListener('click', function (e) {
      var captureBtn = e.target && e.target.closest ? e.target.closest('[data-paypal-capture]') : null;
      if (!captureBtn || !state.order) return;
      e.preventDefault();
      var original = captureBtn.innerHTML;
      captureBtn.disabled = true;
      captureBtn.innerHTML = '<span class="spinner"></span><span class="btn-label">Capturing…</span>';
      call('POST', '/paypal/capture', {
        order_id: state.order.id,
        paypal_order_id: state.paypalOrderId || state.order.payment_id
      }, '4 · PayPal capture (manual)').then(function (res) {
        handlePayPalCapture(res);
      }).catch(function (err) {
        captureBtn.disabled = false;
        captureBtn.innerHTML = original;
        S.toast((err && err.message) || 'PayPal capture failed.', 'err');
      });
    });

    var aiToggle = document.getElementById('aiEnabled');
    if (aiToggle) {
      aiToggle.addEventListener('change', function () {
        var hint = document.getElementById('aiHint');
        if (hint) {
          hint.textContent = aiToggle.checked
            ? ((state.aiModel ? state.aiModel + ' · ' : '') + '/ai-auto')
            : 'deterministic · /auto';
        }
        syncAiEndpoint(aiToggle.checked);
      });
    }
  }

  function renderAgentControls() {
    var options = state.agents.map(function (a) {
      var label = (a.name || a.id) + ' · ' + a.id + (a.status && a.status !== 'valid' ? ' · ' + a.status : '');
      return '<option value="' + S.esc(a.id) + '"' + (a.id === state.agentId ? ' selected' : '') + '>' + S.esc(label) + '</option>';
    }).join('');
    el.agentControls.innerHTML =
      '<div class="field"><label class="field-label" for="agentSelect">Agent passport</label>' +
      '<select class="select" id="agentSelect">' + options + '</select></div>' +
      '<div class="step-hint">' + (state.agentsSource === 'live' ? 'live from /api/agents' : 'agent list API unavailable · seed ids') + '</div>';
    var select = document.getElementById('agentSelect');
    if (select) {
      select.addEventListener('change', function () { state.agentId = select.value; });
    }
  }

  function setControlsDisabled(disabled) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-run],[data-rogue]'), function (b) { b.disabled = disabled; });
    if (el.runAll) el.runAll.disabled = disabled;
    if (el.reset) el.reset.disabled = disabled;
    var agentSelect = document.getElementById('agentSelect');
    if (agentSelect) agentSelect.disabled = disabled;
    var aiToggle = document.getElementById('aiEnabled');
    if (aiToggle) aiToggle.disabled = disabled;
  }

  function setRunActive(active, index) {
    if (!el.runAll) return;
    if (active) {
      el.runAll.disabled = true;
      el.runAll.classList.add('is-busy');
      el.runAll.innerHTML = '<span class="spinner"></span><span class="btn-label">Running ' + index + ' of 5…</span>';
    } else {
      el.runAll.classList.remove('is-busy');
      el.runAll.disabled = false;
      el.runAll.innerHTML = el.runAllOriginal;
    }
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ---------------------------------------------------- step runner -- */
  async function manualRun(n) {
    if (state.busy || state.running) return;
    try {
      await executeStep(n);
      S.toast('Step ' + n + ' complete — axis moved.', 'ok');
    } catch (err) {
      S.toast((err && err.message) || ('Step ' + n + ' failed.'), 'err');
    }
  }

  async function executeStep(n) {
    if (n === 4 && !state.contract) throw new Error('Run step 3 first — no accepted contract yet.');
    if (n === 5 && !state.order) throw new Error('Run step 4 first — no protected order yet.');
    if (state.busy) throw new Error('Another step is already running.');

    state.busy = true;
    setStepState(n, 'running');
    setStepResult(n, '<div class="step-empty">Calling the API…</div>');
    setControlsDisabled(true);
    try {
      if (n === 1) await stepTrust();
      else if (n === 2) await stepPassport(false);
      else if (n === 3) await stepNegotiate();
      else if (n === 4) await stepProtection();
      else if (n === 5) await stepRecourse();

      setStepState(n, 'done');
      if (!state.completed[STEP_AXIS[n]]) {
        state.completed[STEP_AXIS[n]] = true;
        var card = document.querySelector('.axis-card[data-axis="' + STEP_AXIS[n] + '"]');
        if (card) card.classList.add('is-done');
      }
      updateProgress();
      return true;
    } catch (err) {
      setStepState(n, 'error');
      if (!err || !err.rendered) renderStepError(n, err);
      throw err;
    } finally {
      state.busy = false;
      if (!state.running) setControlsDisabled(false);
    }
  }

  function autoConfigure() {
    var btn = document.getElementById('autoConfigureBtn');
    var status = document.getElementById('agentSetupStatus');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'agent configuring catalog…';
    S.api('/merchants/' + MERCHANT_ID + '/agent/autoconfigure', { method: 'POST' })
      .then(function (res) {
        var products = (res && res.products) || [];
        var cats = (res && res.categories) || [];
        var catLabel = cats.length === 1 ? 'category' : 'categories';
        if (status) status.textContent = 'configured · ' + products.length + ' products · ' + cats.length + ' ' + catLabel;
        S.toast('Merchant agent configured ' + products.length + ' products across ' + cats.length + ' ' + (cats.length === 1 ? 'category' : 'categories') + '.', 'ok');
      })
      .catch(function (err) {
        if (status) status.textContent = 'configuration failed';
        S.toast((err && err.message) || 'Agent configuration failed.', 'err');
      })
      .then(function () { if (btn) btn.disabled = false; });
  }

  async function runAll() {
    if (state.running || state.busy) return;
    state.running = true;
    setControlsDisabled(true);
    setRunActive(true, 1);
    var failed = false;
    try {
      for (var i = 1; i <= 5; i++) {
        setRunActive(true, i);
        await executeStep(i);
        if (i < 5) await wait(450);
      }
      S.toast('Full demo complete — all five axes 8+.', 'ok');
    } catch (err) {
      failed = true;
      S.toast('Demo stopped: ' + ((err && err.message) || 'step failed.'), 'err');
    } finally {
      state.running = false;
      setRunActive(false, 0);
      setControlsDisabled(false);
      if (!failed && state.completed.recourse) {
        setTimeout(function () {
          try { el.finalPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
        }, 280);
      }
    }
  }

  async function tryRogueBot() {
    if (state.busy || state.running) return;
    state.busy = true;
    setControlsDisabled(true);
    try {
      await stepPassport(true);
    } catch (err) {
      el.rogue.classList.remove('hidden');
      el.rogue.innerHTML = errorCard(err);
      S.toast((err && err.message) || 'RogueBot check failed.', 'err');
    } finally {
      state.busy = false;
      setControlsDisabled(state.running);
    }
  }

  /* ------------------------------------------------------------ API -- */
  async function call(method, path, body, label) {
    var entry = startLog(method, path, label, body);
    var started = (window.performance && performance.now) ? performance.now() : Date.now();
    var t0 = Date.now();
    // Visible elapsed timer: a slow model looks like progress, not a stall.
    var waitTimer = setInterval(function () {
      var msEl = entry && entry.querySelector ? entry.querySelector('.log-ms') : null;
      if (msEl) msEl.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
    }, 250);
    try {
      var res = await S.api(path, { method: method, body: body });
      clearInterval(waitTimer);
      var ms = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - started);
      finishLog(entry, 'OK', ms, res, false, false);
      return res;
    } catch (err) {
      clearInterval(waitTimer);
      var ms2 = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - started);
      var errBody = (err && err.data) ? err.data : { error: { code: (err && err.code) || 'error', message: (err && err.message) || 'Request failed' } };
      finishLog(entry, err && err.status ? 'HTTP ' + err.status : 'ERR', ms2, errBody, true, false);
      throw err;
    }
  }

  /* ------------------------------------------------------------ log -- */
  function startLog(method, path, label, body) {
    var wrap = document.createElement('div');
    wrap.className = 'log-entry';
    wrap.innerHTML =
      '<div class="log-head">' +
        '<span class="log-method ' + String(method).toLowerCase() + '">' + S.esc(method) + '</span>' +
        '<span class="log-label" title="' + S.esc(label) + '">' + S.esc(label) + '</span>' +
        '<span class="log-path" title="' + S.esc(path) + '">' + S.esc(path) + '</span>' +
        '<span class="log-status">waiting</span>' +
        '<span class="log-ms"></span>' +
      '</div>' +
      '<div class="log-block">' +
        '<div class="log-block-head"><span>request</span></div>' +
        '<div class="log-json">' + (body === undefined || body === null ? '<span class="muted">no body</span>' : S.syntax(body)) + '</div>' +
      '</div>';
    el.log.appendChild(wrap);
    state.logEntries.push({ el: wrap, method: method, path: path, label: label, body: body });
    if (state.logEntries.length > 60) {
      var old = state.logEntries.shift();
      if (old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
    el.logEmpty.hidden = true;
    el.logCount.textContent = String(state.logEntries.length);
    el.log.scrollTop = el.log.scrollHeight;
    return wrap;
  }

  function finishLog(entry, statusText, ms, body, isError, isWarn) {
    var statusEl = entry.querySelector('.log-status');
    if (statusEl) {
      statusEl.textContent = statusText;
      statusEl.className = 'log-status ' + (isError ? 'err' : 'ok');
    }
    var msEl = entry.querySelector('.log-ms');
    if (msEl) msEl.textContent = ms + ' ms';
    if (isError) entry.classList.add('is-error');
    if (isWarn) entry.classList.add('is-warn');

    var block = document.createElement('div');
    block.className = 'log-block';
    block.innerHTML =
      '<div class="log-block-head"><span>response</span><button class="log-copy" type="button">copy</button></div>' +
      '<div class="log-json">' + S.syntax(body) + '</div>';
    var copy = block.querySelector('.log-copy');
    if (copy) {
      copy.addEventListener('click', function () {
        S.copyText(JSON.stringify(body, null, 2), 'Response JSON');
      });
    }
    entry.appendChild(block);
    el.logCount.textContent = String(state.logEntries.length);
    el.log.scrollTop = el.log.scrollHeight;
    if (isWarn) {
      var lastStatus = entry.querySelector('.log-status');
      if (lastStatus) lastStatus.className = 'log-status';
    }
  }

  function markLastLogWarn() {
    var last = state.logEntries[state.logEntries.length - 1];
    if (last && last.el) {
      last.el.classList.add('is-warn');
      var st = last.el.querySelector('.log-status');
      if (st) {
        st.textContent = 'REJECTED';
        st.className = 'log-status';
      }
    }
  }

  function clearLog() {
    Array.prototype.forEach.call(el.log.querySelectorAll('.log-entry'), function (entry) { entry.remove(); });
    state.logEntries = [];
    state.logSeq = 0;
    el.logCount.textContent = '0';
    el.logEmpty.hidden = false;
    if (el.logEmpty.parentNode !== el.log) el.log.appendChild(el.logEmpty);
  }

  /* ------------------------------------------------------ formatting -- */
  function esc(value) { return S.esc(value); }
  function asArray(value) { return Array.isArray(value) ? value : []; }
  function numText(value) {
    return (value === null || value === undefined || value === '') ? '—' : S.num(value);
  }
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/);
    return ((p[0] || '')[0] || '') + ((p[1] || '')[0] || '');
  }
  function metric(label, valueHtml) {
    return '<div class="demo-metric"><div class="demo-metric-label">' + esc(label) + '</div><div class="demo-metric-value">' + valueHtml + '</div></div>';
  }
  function metricVal(key) {
    return S.metric(state.merchant, state.ledger, key);
  }
  function coverageValue() {
    var m = state.merchant || {};
    var cred = (state.ledger && state.ledger.credential) || {};
    var values = [
      m.coverage, m.coverage_pct,
      m.metrics && m.metrics.coverage, m.metrics && m.metrics.coverage_pct,
      cred.coverage, cred.coverage_pct, cred.metrics && cred.metrics.coverage
    ];
    for (var i = 0; i < values.length; i++) {
      var raw = values[i];
      if (raw === null || raw === undefined || raw === '') continue;
      var v = Number(raw);
      if (!isFinite(v)) continue;
      var pct = v <= 1 ? v * 100 : v;
      return Math.round(pct * 10) / 10;
    }
    return null;
  }
  function coverageText() {
    var v = coverageValue();
    if (v === null) return '—';
    return (v % 1 === 0 ? v + '%' : S.pct(v));
  }
  function operatorName(agent) {
    if (!agent) return '';
    var op = agent.operator;
    if (!op) return '';
    if (typeof op === 'string') return op;
    return op.legal_name || op.name || '';
  }
  function kybOf(agent) {
    if (!agent) return '';
    if (agent.kyb) return agent.kyb;
    if (agent.operator && typeof agent.operator === 'object' && agent.operator.kyb) return agent.operator.kyb;
    return '';
  }
  function sigText(sig) {
    if (!sig) return '—';
    if (typeof sig === 'string') return S.shortHash(sig, 30);
    if (sig.sig) return S.shortHash(sig.sig, 30);
    if (sig.signature) return S.shortHash(sig.signature, 30);
    if (sig.hash) return S.shortHash(sig.hash, 30);
    return S.shortHash(JSON.stringify(sig), 30);
  }
  function reasonsText(reasons) {
    var list = asArray(reasons);
    if (!list.length) return 'unknown reason';
    return list.map(function (r) {
      var s = String(r);
      var m = s.match(/^tier_below_minimum:([A-D])<([A-D])$/);
      if (m) return 'tier ' + m[1] + ' is below ' + m[2];
      var v = s.match(/^violations:(\d+)$/);
      if (v) return v[1] + ' reputation violations';
      if (/passport_status_invalid/.test(s)) return 'passport status is invalid';
      if (/mandate_missing/.test(s)) return 'no signed mandate';
      if (/mandate_unsigned/.test(s)) return 'mandate is not signed';
      if (/mandate_expired/.test(s)) return 'mandate has expired';
      if (/operator_kyb_unverified/.test(s)) return 'operator KYB is unverified';
      if (/passport_invalid/.test(s)) return 'passport signature is invalid';
      if (/limit_exceeded/.test(s)) return 'amount exceeds the mandate limit';
      if (/merchant_not_allowed/.test(s)) return 'merchant is not on the allowlist';
      if (/category_not_allowed/.test(s)) return 'category is not allowed';
      return s.replace(/_/g, ' ');
    }).join('; ');
  }
  function termsText(terms) {
    if (!terms || !Object.keys(terms).length) return '—';
    var parts = [];
    if (terms.delivery_days !== undefined) parts.push('delivery ' + terms.delivery_days + 'd');
    if (terms.returns_days !== undefined) parts.push('returns ' + terms.returns_days + 'd');
    if (terms.warranty_months !== undefined) parts.push('warranty ' + terms.warranty_months + 'mo');
    return parts.length ? parts.join(' · ') : '—';
  }

  /* ----------------------------------------------------------- steps -- */
  async function stepTrust() {
    var res = await call('GET', '/merchants/' + MERCHANT_ID, undefined, '1 · Trust credential');
    state.merchant = res.merchant || res;
    state.ledger = res.ledger || null;
    if (!state.merchant || !state.merchant.id) throw new Error('Merchant payload missing from /api/merchants/' + MERCHANT_ID + '.');
    if (!state.ledger || !state.ledger.credential) throw new Error('The merchant response did not include a signed ledger credential.');
    if (!state.merchantBefore) {
      state.merchantBefore = { tier: state.merchant.tier, score: state.merchant.score, reserve: state.merchant.reserve };
    }
    renderTrust();
  }

  function renderTrust() {
    var m = state.merchant;
    var cred = state.ledger.credential;
    var tier = S.tierInfo(m.tier);
    var html =
      '<div class="demo-result">' +
        '<div class="demo-result-head">' +
          '<span class="badge emerald">' + S.icon('shieldCheck') + ' signed credential</span>' +
          '<span class="tiny muted">issuer ' + esc(cred.issuer || 'Settled') + ' · expires ' + esc(S.dateFmt(cred.expires_at)) + '</span>' +
        '</div>' +
        '<div class="demo-agent-line">' +
          '<span class="demo-agent-avatar">' + esc(initials(m.name)) + '</span>' +
          '<div style="min-width:0"><div class="demo-agent-name">' + esc(m.name) + ' <span class="tier ' + tier.cls + '">' + esc(m.tier || '?') + '</span></div>' +
          '<div class="demo-agent-op">' + esc(m.domain || '') + ' · ' + esc(m.category || '') + '</div></div>' +
        '</div>' +
        '<div class="demo-metrics">' +
          metric('Score', esc(numText(m.score))) +
          metric('Coverage', esc(coverageText())) +
          metric('Protection cap', esc(S.money(m.cap))) +
          metric('Reserve', esc(S.money(m.reserve))) +
        '</div>' +
        '<div style="margin-top:9px">' +
          '<div class="demo-kv"><span>settled orders</span><b>' + esc(numText(metricVal('orders'))) + '</b></div>' +
          '<div class="demo-kv"><span>evidence hash</span><b>' + esc(S.shortHash(cred.evidence_hash, 34)) + '</b></div>' +
          '<div class="demo-kv"><span>signature</span><b>' + esc(S.shortHash(state.ledger.signature, 30)) + '</b></div>' +
        '</div>' +
        '<details class="demo-details"><summary>View credential JSON</summary><pre class="json">' + S.syntax(cred) + '</pre></details>' +
        '<div class="step-actions" style="margin-top:9px">' +
          '<button class="btn btn-ghost btn-sm" type="button" id="copyTrustJson">' + S.icon('copy') + 'Copy credential JSON</button>' +
        '</div>' +
      '</div>';
    setStepResult(1, html);
    var copy = document.getElementById('copyTrustJson');
    if (copy) copy.addEventListener('click', function () { S.copyText(JSON.stringify(cred, null, 2), 'Credential JSON'); });
  }

  function verifyContext() {
    var products = (state.merchant && state.merchant.products) || [];
    var product = products.filter(function (p) { return p.id === 'p1'; })[0] || products[0];
    return {
      amount: product && product.price ? product.price : 249,
      category: state.merchant && state.merchant.category ? state.merchant.category : 'Audio gear'
    };
  }

  async function stepPassport(rogue) {
    var agentId = rogue ? 'a3' : (state.agentId || 'a1');
    var ctx = verifyContext();
    var body = { agent_id: agentId, merchant_id: MERCHANT_ID, amount: ctx.amount, category: ctx.category };
    var res = await call('POST', '/agents/verify', body, rogue ? '2 · RogueBot rejected' : '2 · Agent passport');
    if (rogue) {
      renderRogue(res);
      markLastLogWarn();
      S.toast(res.verified ? 'Unexpected: RogueBot passed verification.' : 'RogueBot rejected — no order created.', res.verified ? 'warn' : 'ok');
      return;
    }
    if (!res.verified) {
      var rejected = new Error('Agent not verified: ' + reasonsText(res.reasons));
      rejected.rendered = true;
      setStepResult(2, renderAgentRejected(res));
      throw rejected;
    }
    renderPassport(res);
  }

  function renderPassport(res) {
    var agent = res.agent || {};
    var cred = (res.passport && res.passport.credential) || {};
    var name = agent.name || cred.name || state.agentId;
    var op = operatorName(agent) || operatorName(cred) || '—';
    var kyb = kybOf(agent) || kybOf(cred) || '—';
    var caps = asArray(agent.capabilities || cred.capabilities);
    var limits = agent.limits || cred.limits || {};
    var rep = agent.reputation || cred.reputation || {};
    var mandate = agent.mandate || cred.mandate || {};
    var checks = res.checks || {};
    var html =
      '<div class="demo-result">' +
        '<div class="demo-result-head">' +
          '<span class="badge emerald">' + S.icon('check') + ' verified</span>' +
          '<span class="tiny muted">passport HMAC HS256 · ' + esc(S.shortHash((res.passport && res.passport.signature) || '', 20)) + '</span>' +
        '</div>' +
        '<div class="demo-agent-line">' +
          '<span class="demo-agent-avatar">' + esc(initials(name)) + '</span>' +
          '<div style="min-width:0"><div class="demo-agent-name">' + esc(name) + '</div>' +
          '<div class="demo-agent-op">' + esc(op) + ' · KYB ' + esc(kyb) + '</div></div>' +
        '</div>' +
        '<div class="demo-chips">' + caps.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') + '</div>' +
        '<div class="demo-metrics" style="margin-top:9px">' +
          metric('Max spend', esc(S.money(limits.max_amount))) +
          metric('Reputation', esc(numText(rep.score))) +
          metric('Orders', esc(numText(rep.orders))) +
          metric('Violations', esc(numText(rep.violations))) +
        '</div>' +
        '<div style="margin-top:9px">' +
          '<div class="demo-kv"><span>limits</span><b>' + esc(asArray(limits.categories).join(', ') || '—') + ' · merchants ' + esc(asArray(limits.merchants).join(', ') || '—') + '</b></div>' +
          '<div class="demo-kv"><span>mandate</span><b>' + esc(mandate.id || '—') + ' · exp ' + esc(S.dateFmt(mandate.expires_at)) + ' · signed ' + (mandate.signed ? 'yes' : '—') + '</b></div>' +
          '<div class="demo-kv"><span>claims / violations</span><b>' + esc(numText(rep.claims)) + ' claims · ' + esc(numText(rep.violations)) + ' violations</b></div>' +
        '</div>' +
        checksGrid(checks) +
        '<details class="demo-details"><summary>View passport JSON</summary><pre class="json">' + S.syntax(res.passport || {}) + '</pre></details>' +
        '<div class="step-actions" style="margin-top:9px"><button class="btn btn-ghost btn-sm" type="button" id="copyPassportJson">' + S.icon('copy') + 'Copy passport JSON</button></div>' +
      '</div>';
    setStepResult(2, html);
    var copy = document.getElementById('copyPassportJson');
    if (copy) copy.addEventListener('click', function () { S.copyText(JSON.stringify(res.passport || {}, null, 2), 'Passport JSON'); });
  }

  function renderAgentRejected(res) {
    var agent = res.agent || {};
    var reasons = asArray(res.reasons);
    return '<div class="demo-result is-error">' +
      '<div class="demo-result-head"><span class="badge danger">' + S.icon('x') + ' not verified</span>' +
      '<span class="tiny muted">' + esc(agent.name || state.agentId) + '</span></div>' +
      '<div class="demo-error-msg">' + esc(reasonsText(reasons)) + '</div>' +
      checksGrid(res.checks || {}) +
      '<div class="demo-error-hint">The passport did not pass the authorization policy — no order was created.</div>' +
    '</div>';
  }

  function checksGrid(checks) {
    checks = checks || {};
    var labels = {
      passport: 'Passport signature', mandate: 'Signed mandate', limits: 'Within spend limit',
      merchant: 'Merchant allowlist', category: 'Category allowed', kyb: 'KYB verified'
    };
    var keys = Object.keys(labels);
    Object.keys(checks).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    return '<div class="demo-checks">' + keys.map(function (key) {
      var value = checks[key];
      var cls = value === true ? 'ok' : value === false ? 'bad' : 'skip';
      var text = value === true ? 'PASS' : value === false ? 'FAIL' : '—';
      var icon = value === true ? 'check' : value === false ? 'x' : 'dot';
      return '<div class="check-row ' + cls + '">' + S.icon(icon) + '<span>' + esc(labels[key] || key.replace(/_/g, ' ')) + '</span><span class="val">' + text + '</span></div>';
    }).join('') + '</div>';
  }

  function renderRogue(res) {
    var reasons = asArray(res.reasons);
    var failed = Object.keys(res.checks || {}).filter(function (k) { return res.checks[k] === false; });
    var list = reasons.length ? reasons : failed.map(function (k) { return k.replace(/_/g, ' '); });
    el.rogue.classList.remove('hidden');
    el.rogue.innerHTML =
      '<div class="demo-reject">' +
        '<div class="demo-reject-head">' + S.icon('alert') + 'RogueBot rejected before anything was created</div>' +
        '<div class="demo-reject-sub">No verified operator, no signed mandate, six violations. The passport fails server-side policy — not the LLM’s judgement.</div>' +
        (list.length ? '<ul>' + list.map(function (r) { return '<li>' + esc(reasonsText([r])) + '</li>'; }).join('') + '</ul>' : '') +
        checksGrid(res.checks || {}) +
      '</div>';
  }

  async function stepNegotiate() {
    var products = (state.merchant && state.merchant.products) || [];
    var product = products.filter(function (p) { return p.id === 'p1'; })[0] || products[0];
    var productId = product ? product.id : 'p1';
    var created = await call('POST', '/contracts', {
      merchant_id: MERCHANT_ID,
      product_id: productId,
      buyer_agent_id: state.agentId || 'a1'
    }, '3 · Negotiation round 1');
    var contractId = created.contract && created.contract.id;
    if (!contractId) throw new Error('The contract response did not include a contract id.');

    var aiToggle = document.getElementById('aiEnabled');
    state.contractAiRequested = !!(aiToggle && aiToggle.checked);
    var endpoint = '/contracts/' + encodeURIComponent(contractId) + (state.contractAiRequested ? '/ai-auto' : '/auto');
    var auto = await call('POST', endpoint, undefined, state.contractAiRequested ? '3 · AI agents negotiate' : '3 · Negotiation (auto)');

    var contract = (auto && auto.contract) || (auto && auto.id ? auto : null) || created.contract;
    if (!contract) throw new Error('The auto-negotiation response did not include a contract.');
    state.contractAi = (auto && auto.ai) || contract.ai || null;
    state.contractVerification = (auto && auto.verification) || null;
    if (contract.status !== 'accepted' || contract.agreed_price === null || contract.agreed_price === undefined) {
      throw new Error('Contract did not reach an accepted price (status: ' + contract.status + ').');
    }
    state.contract = contract;
    renderContract(contract, state.contractAi);
  }

  function renderContract(c, ai) {
    var list = Number(c.list_price);
    var agreed = Number(c.agreed_price);
    var discount = isFinite(list) && list > 0 ? (list - agreed) / list * 100 : null;
    var policy = c.policy || {};
    var terms = c.terms || {};
    var sigs = c.signatures || {};
    var dialogue = asArray(ai && ai.dialogue);
    var hasDialogue = dialogue.length > 0;
    var openingPrice = Math.round(list * 0.86);
    var firstBuyer = dialogue.filter(function (d) { return String(d.from || '').indexOf('buyer') >= 0 && d.action !== 'accept'; })[0];
    if (firstBuyer && firstBuyer.price !== undefined && firstBuyer.price !== null) openingPrice = Number(firstBuyer.price);
    var html =
      '<div class="demo-result">' +
        '<div class="demo-result-head">' +
          '<span class="badge emerald">' + S.icon('check') + ' contract signed</span>' +
          (state.contractVerification && state.contractVerification.hash_valid ? '<span class="badge">hash verified</span>' : '') +
          '<span class="tiny muted">both agents signed · ' + esc(S.dateFmt(c.created_at)) + '</span>' +
        '</div>' +
        '<div class="demo-price-hero">' +
          '<div><div class="ph-label">Agreed price</div><div class="ph-value">' + esc(S.money(agreed)) + '</div>' +
          '<div class="ph-sub">list ' + esc(S.money(list)) + (discount !== null ? ' · ' + esc((Math.round(discount * 10) / 10).toFixed(1)) + '% below list' : '') + '</div></div>' +
          '<div class="ph-right"><span class="badge emerald">' + S.icon('check') + ' ' + esc(c.status || 'accepted') + '</span>' +
          '<div class="ph-sub" style="margin-top:6px">' + esc(S.shortHash(c.id, 18)) + '</div></div>' +
        '</div>' +
        (hasDialogue ? renderAgentNegotiation(c, ai, dialogue) : '') +
        renderTranscript(c) +
        renderAiMoves(ai, !hasDialogue) +
        (state.contractAiRequested && !ai ? '<div class="demo-callout"><b>AI fallback:</b> the AI auto endpoint returned no reasoning payload — the deterministic transcript above is the contract of record.</div>' : '') +
        '<div class="demo-metrics" style="margin-top:10px">' +
          metric('Opening offer', esc(S.money(openingPrice))) +
          metric('Auto-accept', policy.auto_accept !== undefined ? esc(S.money(policy.auto_accept)) : 'server-enforced') +
          metric('Max discount', esc(policy.max_discount_pct !== undefined ? policy.max_discount_pct + '%' : '—')) +
          metric('Rounds', esc(numText(c.rounds))) +
        '</div>' +
        '<div style="margin-top:9px">' +
          '<div class="demo-kv"><span>contract hash</span><b>' + esc(S.shortHash(c.hash, 36)) +
            ' <button class="log-copy" type="button" data-copy="' + esc(c.hash || '') + '" data-copy-label="Contract hash">copy</button></b></div>' +
          '<div class="demo-kv"><span>agent signature</span><b>' + esc(sigText(sigs.buyer_agent || sigs.buyer || sigs.agent || sigs.ProcureBot)) + '</b></div>' +
          '<div class="demo-kv"><span>merchant signature</span><b>' + esc(sigText(sigs.merchant || sigs.Merchant)) + '</b></div>' +
          '<div class="demo-kv"><span>terms</span><b>' + esc(termsText(terms)) + '</b></div>' +
        '</div>' +
        '<details class="demo-details"><summary>View contract JSON</summary><pre class="json">' + S.syntax(c) + '</pre></details>' +
      '</div>';
    setStepResult(3, html);
  }

  function renderPolicyBadge(code, side, action) {
    var value = String(code || '').toLowerCase();
    var label, cls;
    if (value.indexOf('within') >= 0 || value.indexOf('mandate') >= 0) {
      label = 'within mandate'; cls = 'within';
    } else if (value.indexOf('auto_accept') >= 0 || value.indexOf('policy_price') >= 0 || value.indexOf('policy') >= 0) {
      label = 'policy price'; cls = 'policy';
    } else if (value.indexOf('signed') >= 0) {
      label = 'signed'; cls = 'signed';
    } else {
      label = value ? value.replace(/_/g, ' ') : (side === 'merchant' ? 'policy price' : 'within mandate');
      cls = side === 'merchant' ? 'policy' : 'within';
    }
    return '<span class="agent-policy-badge ' + cls + '">' + esc(label) + '</span>';
  }

  function renderAgentNegotiation(c, ai, dialogue) {
    var policy = c.policy || {};
    var list = Number(c.list_price) || 0;
    var auto = Number(policy.auto_accept);
    var merchantEntry = dialogue.filter(function (d) { return String(d.from || '').indexOf('merchant') >= 0; })[0];
    if (!isFinite(auto) || auto <= 0) auto = merchantEntry && merchantEntry.price !== undefined ? Number(merchantEntry.price) : Math.round(list * 0.95);
    var opening = null;
    dialogue.forEach(function (d) {
      if (opening === null && String(d.from || '').indexOf('buyer') >= 0 && d.action !== 'accept' && d.price !== undefined) opening = Number(d.price);
    });
    if (opening === null || !isFinite(opening)) opening = Math.round(list * 0.86);
    var middle = Math.round((opening + auto) / 2);
    var allowed = [];
    [opening, middle, auto].forEach(function (v) {
      var n = Math.round(Number(v));
      if (isFinite(n) && allowed.indexOf(n) < 0) allowed.push(n);
    });
    allowed.sort(function (a, b) { return a - b; });

    var buyerAgent = (state.agents || []).filter(function (a) { return a.id === 'a1'; })[0] || FALLBACK_AGENTS[0];
    var buyerOperator = operatorName(buyerAgent) || 'Acme Procurement Inc';
    var buyerLimit = buyerAgent && buyerAgent.limits && buyerAgent.limits.max_amount ? buyerAgent.limits.max_amount : 500;
    var buyerCategories = buyerAgent && buyerAgent.limits ? asArray(buyerAgent.limits.categories) : [];
    var sellerName = (state.merchant && state.merchant.name) || 'Northwind Audio';
    var aiUsed = !!(ai && ai.used);
    var aiBadge = '<span class="ai-badge ' + (aiUsed ? 'ai' : 'fallback') + '">' + (aiUsed ? 'AI' : 'FALLBACK') + '</span>';

    var rows = dialogue.map(function (d) {
      var side = String(d.from || '').toLowerCase().indexOf('merchant') >= 0 ? 'merchant' : 'buyer';
      var action = String(d.action || (side === 'merchant' ? 'counter' : 'offer')).toLowerCase();
      var agentName = d.agent || (side === 'merchant' ? 'Northwind Seller Agent' : 'ProcureBot');
      var price = d.price !== undefined && d.price !== null ? Number(d.price) : null;
      var priceLabel = price !== null && isFinite(price) ? (Math.round(price) === price ? S.money0(price) : S.money(price)) : '';
      var priceChip = priceLabel ? (action === 'accept' ? 'accepted ' + priceLabel : priceLabel) : '';
      var signed = action === 'accept' ? '<span class="agent-policy-badge signed">signed</span>' : '';
      var message = d.message || d.note || '';
      var rationale = d.rationale || '';
      var initialsText = initials(agentName) || (side === 'merchant' ? 'N' : 'P');
      return '<div class="agent-row ' + side + '" data-agent-side="' + side + '">' +
        '<span class="agent-avatar ' + side + '">' + esc(initialsText) + '</span>' +
        '<div class="agent-bubble">' +
          '<div class="agent-bubble-head">' +
            '<span class="agent-name">' + esc(agentName) + '</span>' +
            '<span class="agent-action ' + side + '">' + esc(action) + '</span>' +
            (priceChip ? '<span class="agent-price">' + esc(priceChip) + '</span>' : '') +
            renderPolicyBadge(d.policy, side, action) + signed +
          '</div>' +
          (message ? '<div class="agent-msg">' + esc(message) + '</div>' : '') +
          (rationale ? '<div class="agent-rationale">' + esc(rationale) + '</div>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    var signature = c.signatures || {};
    var signedLine = '<div class="agent-sign-line">' +
      '<span>signed contract <b class="mono">' + esc(S.shortHash(c.hash, 18)) + '</b></span>' +
      '<span>buyer sig <b class="mono">' + esc(sigText(signature.buyer)) + '</b></span>' +
      '<span>seller sig <b class="mono">' + esc(sigText(signature.merchant)) + '</b></span>' +
      '<span class="sign-terms">terms fixed before payment</span>' +
    '</div>';

    var strip = '<div class="agent-policy-strip">' + S.icon('lock') +
      '<span class="policy-lead">Server policy:</span>' +
      '<span>allowed prices <b class="mono">[' + esc(allowed.join(', ')) + ']</b></span>' +
      '<span>buyer mandate <b class="mono">' + esc(S.money0(buyerLimit)) + '</b></span>' +
      '<span>seller auto-accept <b class="mono">' + esc(S.money0(auto)) + '</b></span>' +
      '<span class="policy-model-note">the model can talk but cannot move money outside these.</span>' +
    '</div>';

    return '<div class="agent-panel" id="agentNegotiationPanel">' +
      '<div class="agent-panel-head">' +
        '<div style="min-width:0"><div class="agent-panel-title">Agent-to-agent negotiation</div>' +
        '<div class="agent-panel-sub">Two agents, one contract — the server policy fixes every number.</div></div>' +
        '<div class="agent-panel-badges">' + aiBadge + '<span class="badge">policy-guarded</span></div>' +
      '</div>' +
      '<div class="agent-chips">' +
        '<div class="agent-chip buyer">' +
          '<span class="agent-avatar buyer">' + esc(initials('ProcureBot')) + '</span>' +
          '<div style="min-width:0"><div class="agent-chip-name">Sam’s personal agent — ProcureBot</div>' +
          '<div class="agent-chip-sub">' + esc(buyerOperator) + ' · mandate ' + esc(S.money0(buyerLimit)) + ' · ' + esc(buyerCategories.join('/') || 'audio/electronics') + '</div></div>' +
          '<span class="badge blue">buyer</span>' +
        '</div>' +
        '<div class="agent-chip seller">' +
          '<span class="agent-avatar merchant">' + esc(initials('Northwind Seller Agent')) + '</span>' +
          '<div style="min-width:0"><div class="agent-chip-name">Northwind Seller Agent</div>' +
          '<div class="agent-chip-sub">' + esc(sellerName) + ' · published policy</div></div>' +
          '<span class="badge gold">seller</span>' +
        '</div>' +
      '</div>' +
      '<div class="agent-chat">' + rows + '</div>' +
      strip +
      signedLine +
    '</div>';
  }

  function renderAiMoves(ai, openByDefault) {
    if (!ai) return '';
    openByDefault = !!openByDefault;
    var moves = asArray(ai.moves);
    if (!moves.length) return '';
    var overallUsed = !!ai.used;
    var providerParts = [ai.provider, ai.model].filter(function (v) {
      return v && String(v).toLowerCase() !== 'none';
    });
    var provider = providerParts.join(' · ');
    var html = '<details class="ai-block ai-secondary"' + (openByDefault ? ' open' : '') + '>' +
      '<summary class="ai-summary">' + S.icon('sparkle') +
        '<span class="ai-title">Model reasoning</span>' +
        '<span class="ai-badge ' + (overallUsed ? 'ai' : 'fallback') + '">' + (overallUsed ? 'AI' : 'FALLBACK') + '</span>' +
        '<span class="tiny muted">' + esc(provider || 'deterministic fallback') + (moves.length ? ' · ' + moves.length + ' moves' : '') + '</span>' +
      '</summary>' +
      '<div class="ai-body">';
    moves.forEach(function (move) {
      var used = move.used !== undefined ? !!move.used : overallUsed;
      var action = move.action || (move.price !== undefined ? 'offer' : 'move');
      var message = move.message || move.note || '';
      var rationale = move.rationale || '';
      html += '<div class="ai-move">' +
        '<div class="ai-move-top">' +
          '<span class="ai-round">R' + esc(move.round !== undefined ? move.round : '—') + '</span>' +
          '<span class="ai-badge ' + (used ? 'ai' : 'fallback') + '">' + (used ? 'AI' : 'FALLBACK') + '</span>' +
          '<span class="ai-action">' + esc(action) + '</span>' +
          (move.price !== undefined && move.price !== null ? '<span class="ai-price">' + esc(S.money(move.price)) + '</span>' : '') +
        '</div>' +
        (message ? '<div class="ai-msg">' + esc(message) + '</div>' : '') +
        (rationale ? '<div class="ai-rationale">' + esc(rationale) + '</div>' : '') +
      '</div>';
    });
    return html + '</div></details>';
  }

  function renderTranscript(contract) {
    var transcript = asArray(contract.transcript);
    if (!transcript.length) return '<div class="step-empty" style="margin-top:9px">No transcript entries returned — see contract JSON.</div>';
    return '<div class="demo-transcript">' + transcript.map(function (t, i) {
      var who = String(t.from || t.actor || t.party || 'system').toLowerCase();
      if (who.indexOf('merchant') >= 0) who = 'merchant';
      else if (who.indexOf('buyer') >= 0 || who.indexOf('agent') >= 0) who = 'buyer';
      else who = 'system';
      var price = t.price !== undefined ? t.price : (t.amount !== undefined ? t.amount : (t.offer !== undefined ? t.offer : t.counter));
      var action;
      if (t.decision === 'accepted' || t.accepted === true) action = 'accepted';
      else if (who === 'merchant') action = t.auto ? 'auto-counter' : 'counter';
      else if (who === 'buyer') action = t.decision === 'countered' ? 'offer' : (t.decision || 'offer');
      else action = t.decision || t.status || t.action || '';
      var note = t.note || t.message || '';
      return '<div class="tr-row">' +
        '<span class="tr-round">R' + esc(t.round !== undefined ? t.round : i + 1) + '</span>' +
        '<span class="tr-who ' + who + '">' + esc(who) + '</span>' +
        (action ? '<span class="tr-action">' + esc(action) + '</span>' : '') +
        (price !== undefined && price !== null ? '<span class="tr-price">' + esc(S.money(price)) + '</span>' : '') +
        (note ? '<span class="tr-note" title="' + esc(note) + '">' + esc(note) + '</span>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  async function stepProtection() {
    var contract = state.contract;
    var quoteRes = await call('POST', '/protection/quote', {
      merchant_id: MERCHANT_ID,
      amount: contract.agreed_price
    }, '4 · Protection quote');
    state.quote = quoteRes.quote || quoteRes;
    state.lastQuoteRes = quoteRes;

    /* Manual step + live mode + client id = live PayPal rail.
       Run full demo (and SIM) forces simulate:true so it stays deterministic. */
    var useLive = !state.running && state.liveMode && !!state.paypalClientId;
    var simulate = !useLive;
    var orderBody = {
      product_id: contract.product_id,
      buyer: { name: 'ProcureBot', email: 'procurebot@acme.example' },
      contract_id: contract.id,
      agent_id: state.agentId || 'a1'
    };
    if (simulate) orderBody.simulate = true;

    var orderRes = await call('POST', '/merchants/' + MERCHANT_ID + '/orders', orderBody,
      simulate ? '4 · Protected order (SIM)' : '4 · Protected order');
    var order = orderRes.order;
    if (!order || !order.id) throw new Error('The order response did not include an order.');
    state.order = order;
    state.orderResponse = orderRes;
    state.lastOrderRes = orderRes;
    state.captureId = order.capture_id || '';
    state.paypalCaptured = !!(order.capture_id || (orderRes.payment && orderRes.payment.captured));
    state.approvalUrl = simulate ? null : ((orderRes.payment && orderRes.payment.approval_url) || order.approval_url || null);
    state.livePaypalActive = useLive && order.status !== 'paid' && order.status !== 'delivered';
    renderProtection(quoteRes, orderRes, state.livePaypalActive);
    if (state.livePaypalActive) mountPayPalButtons();
  }

  function renderProtection(quoteRes, orderRes, livePaypal) {
    var quote = quoteRes.quote || quoteRes;
    var order = orderRes.order || {};
    var payment = orderRes.payment || {};
    var receipt = orderRes.receipt || {};
    var acc = orderRes.acc || order.acc || {};
    var approvalUrl = state.approvalUrl;
    var coverage = asArray(quote.coverage);
    var exclusions = asArray(quote.exclusions);
    var captureId = state.captureId || order.capture_id || '';
    var tag = captureId ? 'PAYPAL CAPTURED' : livePaypal ? 'PAYPAL SANDBOX' : approvalUrl ? 'LIVE PAYPAL' : 'SIM PAYMENT';
    var tagClass = (captureId || livePaypal || approvalUrl) ? 'demo-live' : 'demo-sim';
    var html =
      '<div class="demo-result">' +
        '<div class="demo-result-head">' +
          '<span class="badge emerald">' + S.icon('shieldCheck') + ' priced protection</span>' +
          '<span class="' + tagClass + '">' + esc(tag) + '</span>' +
          '<span class="spacer"></span>' +
          '<span class="tiny muted">' + esc(S.modeInfo(quote.mode || (order.protection && order.protection.mode)).label || '') + '</span>' +
        '</div>' +
        '<div class="demo-metrics">' +
          metric('Fee bps', esc(numText(quote.fee_bps))) +
          metric('Fee', esc(S.money(quote.fee))) +
          metric('Cap', esc(S.money(quote.cap))) +
          metric('Agreed amount', esc(S.money(quote.amount))) +
        '</div>' +
        (coverage.length ? '<div class="demo-chips">' + coverage.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') + '</div>' : '') +
        '<div style="margin-top:9px">' +
          '<div class="demo-kv"><span>reserve source</span><b>' + esc(quote.reserve_source || '—') + (quote.reserve_current !== undefined ? ' · current ' + esc(S.money(quote.reserve_current)) : '') + (quote.reserve_target !== undefined ? ' · target ' + esc(S.money(quote.reserve_target)) : '') + '</b></div>' +
          (exclusions.length ? '<div class="demo-kv"><span>exclusions</span><b>' + esc(exclusions.join(' · ')) + '</b></div>' : '') +
          '<div class="demo-kv"><span>order</span><b>' + esc(order.id || '—') + ' · ' + esc(order.status || '—') + '</b></div>' +
          '<div class="demo-kv"><span>amount</span><b class="money">' + esc(S.money(receipt.paid !== undefined ? receipt.paid : order.amount)) + '</b></div>' +
          '<div class="demo-kv"><span>payment id</span><b>' + esc(payment.id || order.payment_id || '—') + '</b></div>' +
          (captureId ? '<div class="demo-kv"><span>paypal capture id</span><b class="ok">' + esc(captureId) + '</b></div>' : '') +
          (payment.captured !== undefined ? '<div class="demo-kv"><span>paypal captured</span><b>' + (payment.captured ? 'yes' : 'awaiting approval') + '</b></div>' : '') +
          '<div class="demo-kv"><span>captured at</span><b>' + esc(S.dateFmt(receipt.captured_at || order.captured_at)) + '</b></div>' +
          '<div class="demo-kv"><span>receipt credential hash</span><b>' + esc(S.shortHash(receipt.credential_hash, 34)) + '</b></div>' +
          (acc.hash || order.contract_hash || order.custom_id ? '<div class="demo-kv"><span>contract hash on order</span><b>' + esc(S.shortHash(acc.hash || order.contract_hash || order.custom_id, 34)) + '</b></div>' : '') +
          (acc.transcript_hash ? '<div class="demo-kv"><span>transcript hash</span><b>' + esc(S.shortHash(acc.transcript_hash, 34)) + '</b></div>' : '') +
          (acc.terms ? '<div class="demo-kv"><span>contract terms</span><b>' + esc(termsText(acc.terms)) + '</b></div>' : '') +
        '</div>' +
        (livePaypal
          ? '<div class="paypal-live-block">' +
              '<div class="paypal-live-head">' + S.icon('wallet') + 'Live PayPal sandbox <span class="badge blue">' + esc(state.paypalEnv || 'sandbox') + '</span></div>' +
              '<div class="paypal-live-sub">Manual step uses the live rail. Complete the PayPal approval to capture the real capture id — Run full demo stays deterministic on SIM.</div>' +
              '<div id="paypalButtonHost" class="paypal-host"><div class="paypal-loading">Loading PayPal Buttons…</div></div>' +
              (approvalUrl ? '<div class="demo-approval" style="margin-top:9px"><a class="btn btn-ghost btn-sm" href="' + esc(approvalUrl) + '" target="_blank" rel="noopener noreferrer">' + S.icon('external') + 'Open approval in a new tab</a><button class="btn btn-gold btn-sm" type="button" data-paypal-capture>I approved — capture</button></div>' : '') +
              '<div class="paypal-status" id="paypalLiveStatus"></div>' +
            '</div>'
          : captureId
            ? '<div class="demo-callout"><b>PayPal captured.</b> Capture id <span class="mono">' + esc(captureId) + '</span> returned from the sandbox; the order is now paid.</div>'
            : approvalUrl
              ? '<div class="demo-approval">' +
                  '<a class="btn btn-gold btn-sm" href="' + esc(approvalUrl) + '" target="_blank" rel="noopener noreferrer">' + S.icon('external') + 'Open PayPal approval</a>' +
                  '<span class="note">Approve in PayPal sandbox, then run step 5. SIM runs skip this.</span>' +
                '</div>'
              : '<div class="demo-callout"><b>SIM payment:</b> the order is captured and the contract hash travels on the order. In live mode this becomes a real PayPal capture.</div>') +
        '<details class="demo-details"><summary>View order JSON</summary><pre class="json">' + S.syntax(orderRes) + '</pre></details>' +
      '</div>';
    setStepResult(4, html);
  }

  async function mountPayPalButtons() {
    var host = document.getElementById('paypalButtonHost');
    if (!host || !state.order || !state.paypalClientId) return;
    host.innerHTML = '<div class="paypal-loading">Loading PayPal sandbox…</div>';
    try {
      var sdk = await loadPayPalSdk(state.paypalClientId);
      if (!sdk || !sdk.Buttons) throw new Error('PayPal SDK did not expose Buttons.');
      var buttons = sdk.Buttons({
        style: { shape: 'pill', color: 'gold', layout: 'vertical', label: 'paypal', height: 46 },
        createOrder: function () {
          return call('POST', '/paypal/create-order', { order_id: state.order.id }, '4 · PayPal create-order')
            .then(function (res) {
              var id = (res && (res.paypal_order_id || res.id)) || (res && res.payment && res.payment.id);
              if (!id) throw new Error('PayPal create-order returned no paypal_order_id.');
              state.paypalOrderId = id;
              return id;
            });
        },
        onApprove: function (data) {
          return call('POST', '/paypal/capture', {
            order_id: state.order.id,
            paypal_order_id: (data && data.orderID) || state.paypalOrderId || state.order.payment_id
          }, '4 · PayPal capture').then(function (res) {
            handlePayPalCapture(res);
            return res;
          }).catch(function (err) {
            showPaypalStatus('PayPal capture failed: ' + (err && err.message ? err.message : err), true);
            S.toast((err && err.message) || 'PayPal capture failed.', 'err');
            throw err;
          });
        },
        onCancel: function () {
          showPaypalStatus('PayPal approval cancelled — no capture.', false);
          S.toast('PayPal approval cancelled.', 'warn');
        },
        onError: function (err) {
          showPaypalStatus('PayPal error: ' + (err && (err.message || err)), true);
          S.toast('PayPal error: ' + (err && (err.message || err)), 'err');
        }
      });
      var rendered = buttons.render('#paypalButtonHost');
      if (rendered && typeof rendered.catch === 'function') {
        rendered.catch(function (err) {
          host.innerHTML = '<div class="paypal-error">PayPal Buttons failed to render: ' + S.esc(err && err.message ? err.message : err) + '</div>';
          showPaypalStatus('Use the approval link above, or keep SIM for the deterministic demo.', true);
        });
      }
    } catch (err) {
      host.innerHTML = '<div class="paypal-error">' + S.icon('alert') + ' PayPal sandbox unavailable: ' + S.esc(err && err.message ? err.message : err) + '</div>';
      showPaypalStatus('Use the approval link above, or keep SIM for the deterministic demo.', true);
    }
  }

  function showPaypalStatus(message, isError) {
    var status = document.getElementById('paypalLiveStatus');
    if (!status) return;
    status.textContent = message || '';
    status.style.color = isError ? 'var(--danger)' : 'var(--muted-2)';
  }

  function handlePayPalCapture(res) {
    if (!state.lastQuoteRes || !state.lastOrderRes) {
      S.toast('PayPal capture completed after a reset — demo state was cleared.', 'warn');
      return;
    }
    var order = (res && res.order) || state.order || {};
    state.order = Object.assign({}, state.order, order);
    state.captureId = captureIdFrom(res) || state.order.capture_id || '';
    state.paypalCaptured = true;
    state.livePaypalActive = false;
    state.approvalUrl = null;
    if (!state.lastOrderRes) state.lastOrderRes = { order: state.order, payment: {} };
    if (state.lastOrderRes) {
      state.lastOrderRes.order = state.order;
      state.lastOrderRes.payment = Object.assign({}, state.lastOrderRes.payment || {}, {
        mode: 'live',
        id: state.order.payment_id,
        captured: true
      });
      state.lastOrderRes.capture = res && res.capture;
    }
    renderProtection(state.lastQuoteRes, state.lastOrderRes, false);
    S.toast('PayPal sandbox capture complete' + (state.captureId ? ' · ' + state.captureId : '') + '.', 'ok');
  }

  function captureIdFrom(res) {
    if (!res) return '';
    if (res.capture_id) return res.capture_id;
    var order = res.order || {};
    if (order.capture_id) return order.capture_id;
    var cap = res.capture;
    if (!cap) return '';
    if (typeof cap === 'string') return cap;
    if (cap.id) return cap.id;
    var pu = asArray(cap.purchase_units)[0];
    var captures = pu && pu.payments && asArray(pu.payments.captures);
    if (captures && captures[0] && captures[0].id) return captures[0].id;
    return '';
  }

  function loadPayPalSdk(clientId) {
    if (window.paypal && window.paypal.Buttons) return Promise.resolve(window.paypal);
    if (paypalSdkPromise) return paypalSdkPromise;
    paypalSdkPromise = new Promise(function (resolve, reject) {
      var old = document.getElementById('paypalSdkScript');
      if (old) old.remove();
      try { delete window.paypal; } catch (e) { window.paypal = undefined; }
      var script = document.createElement('script');
      script.id = 'paypalSdkScript';
      script.async = true;
      script.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) + '&currency=USD&components=buttons&intent=capture';
      var timer = setTimeout(function () { reject(new Error('Timed out loading paypal.com')); }, 12000);
      script.onload = function () {
        clearTimeout(timer);
        if (window.paypal && window.paypal.Buttons) resolve(window.paypal);
        else reject(new Error('PayPal SDK loaded without Buttons.'));
      };
      script.onerror = function () {
        clearTimeout(timer);
        reject(new Error('Could not load the PayPal SDK script.'));
      };
      document.head.appendChild(script);
    }).catch(function (err) {
      paypalSdkPromise = null;
      throw err;
    });
    return paypalSdkPromise;
  }

  async function stepRecourse() {
    if (state.approvalUrl) {
      var liveStatus = state.order.status;
      if (liveStatus !== 'paid' && liveStatus !== 'delivered') {
        var list = await call('GET', '/orders?merchant=' + MERCHANT_ID, undefined, '5 · Check PayPal capture');
        var found = asArray(list.orders).filter(function (o) { return o.id === state.order.id; })[0];
        if (found) state.order = found;
        if (state.order.status !== 'paid' && state.order.status !== 'delivered') {
          var waitErr = new Error('PayPal order is not captured yet — approve the PayPal order, then run step 5 again.');
          waitErr.rendered = true;
          setStepResult(5, '<div class="demo-result is-warn"><div class="demo-error-title">Waiting for PayPal approval</div>' +
            '<div class="demo-error-msg">Open the PayPal approval link in step 4, approve the order in sandbox, then run step 5 again.</div></div>');
          throw waitErr;
        }
      }
    }

    var claimRes = await call('POST', '/orders/' + encodeURIComponent(state.order.id) + '/claim', {
      reason: 'not_delivered',
      evidence: true,
      actor: 'agent:' + (state.agentId || 'a1'),
      use_ai: true
    }, '5 · Instant recourse (AI review)');
    var claim = claimRes.claim;
    if (!claim) throw new Error('The claim response did not include a claim.');
    state.claim = claim;
    state.claimResponse = claimRes;
    state.claimAi = claimRes.ai || claim.ai || null;
    if (claimRes.merchant) {
      state.merchant = Object.assign({}, state.merchant || {}, claimRes.merchant);
    }
    renderRecourse(claimRes);
  }

  function renderClaimAi(ai) {
    if (!ai) {
      return state.aiEnabled ? '<div class="demo-callout"><b>AI review missing:</b> the claim response did not include an <span class="mono">ai</span> object.</div>' : '';
    }
    var rec = String(ai.recommendation || 'review').toLowerCase();
    var tone = rec === 'approve' ? 'approve' : rec === 'deny' ? 'deny' : 'review';
    var used = !!ai.used;
    var conf = Number(ai.confidence);
    var confText = isFinite(conf) ? (Math.round(conf * 1000) / 10).toFixed(1) + '%' : '—';
    var modelParts = [ai.provider, ai.model].filter(function (v) {
      return v && String(v).toLowerCase() !== 'none';
    });
    var model = modelParts.join(' · ');
    var rationale = ai.rationale || ai.reason || '';
    return '<div class="claim-ai ' + tone + '">' +
      '<div class="claim-ai-head">' + S.icon('sparkle') +
        '<span>AI claim review</span>' +
        '<span class="ai-badge ' + (used ? 'ai' : 'fallback') + '">' + (used ? 'AI' : 'FALLBACK') + '</span>' +
        '<span class="claim-ai-rec ' + tone + '">' + esc(rec) + '</span>' +
        '<span class="claim-ai-conf">confidence ' + esc(confText) + '</span>' +
      '</div>' +
      (rationale ? '<div class="claim-ai-rationale">' + esc(rationale) + '</div>' : '') +
      (model ? '<div class="claim-ai-model">' + esc(model) + '</div>' : '') +
    '</div>';
  }

  function renderRecourse(res) {
    var claim = res.claim || {};
    var merchant = res.merchant || {};
    var order = res.order || state.order || {};
    var refund = Number(claim.refund) || 0;
    var slaMs = claim.sla_ms !== undefined ? Number(claim.sla_ms) : 1200;
    var sla = (slaMs / 1000).toFixed(1) + 's';
    var before = state.merchantBefore || {};
    var beforeTier = before.tier || (state.merchant && state.merchant.tier);
    var beforeScore = before.score;
    var afterTier = merchant.tier || beforeTier;
    var afterScore = merchant.score !== undefined ? merchant.score : beforeScore;
    var beforeReserve = claim.reserve_before !== undefined ? claim.reserve_before : before.reserve;
    var afterReserve = claim.reserve_after !== undefined ? claim.reserve_after : merchant.reserve;
    var refundId = claim.paypal_refund_id || claim.refund_id || '—';
    var html =
      '<div class="demo-result">' +
        '<div class="demo-refund-hero">' +
          '<div class="demo-refund-ring">' + S.icon('check') + '</div>' +
          '<div><div class="demo-refund-amount">' + esc(S.money(refund)) + '</div>' +
          '<div class="demo-refund-caption">refunded from seller reserve in ' + esc(sla) + '</div></div>' +
          '<div class="demo-refund-ref" style="margin-left:auto">paypal refund id<b>' + esc(refundId) + '</b></div>' +
        '</div>' +
        '<div class="demo-metrics">' +
          metric('From reserve', esc(S.money(claim.paid_from_reserve))) +
          metric('From network pool', esc(S.money(claim.paid_from_pool))) +
          metric('SLA', esc(sla)) +
          metric('Reserve after', esc(S.money(afterReserve))) +
        '</div>' +
        renderClaimAi(res.ai || claim.ai || state.claimAi) +
        '<div style="margin-top:9px">' +
          '<div class="demo-kv"><span>claim</span><b>' + esc(claim.id || '—') + '</b></div>' +
          '<div class="demo-kv"><span>reason</span><b>' + esc(claim.reason || '—') + '</b></div>' +
          '<div class="demo-kv"><span>actor</span><b>' + esc(claim.actor || ('agent:' + (state.agentId || 'a1'))) + '</b></div>' +
          '<div class="demo-kv"><span>reserve</span><b>' + esc(S.money(beforeReserve)) + ' → ' + esc(S.money(afterReserve)) + '</b></div>' +
          '<div class="demo-kv"><span>merchant tier</span><b>' + esc(beforeTier || '—') + ' → ' + esc(afterTier || '—') + '</b></div>' +
          '<div class="demo-kv"><span>merchant score</span><b>' + esc(beforeScore !== undefined ? beforeScore : '—') + ' → ' + esc(afterScore !== undefined ? afterScore : '—') + '</b></div>' +
          '<div class="demo-kv"><span>order status</span><b class="ok">' + esc(order.status || 'refunded') + '</b></div>' +
          '<div class="demo-kv"><span>events written</span><b>' + esc(numText(asArray(res.events).length || '—')) + '</b></div>' +
        '</div>' +
        '<div class="demo-callout"><b>No chargeback.</b> The refund settled from the merchant reserve with a PayPal refund id, an SLA and a score update — no 30-day wait and no support queue.</div>' +
        '<details class="demo-details"><summary>View claim JSON</summary><pre class="json">' + S.syntax(res) + '</pre></details>' +
      '</div>';
    setStepResult(5, html);
  }

  /* --------------------------------------------------------- ui utils -- */
  function setStepResult(n, html) {
    var target = document.getElementById('result-' + n);
    if (target) target.innerHTML = html;
  }

  function setStepState(n, status) {
    var step = document.getElementById('step-' + n);
    if (!step) return;
    step.classList.remove('is-active', 'is-done', 'is-error', 'is-busy');
    if (status === 'running') step.classList.add('is-active', 'is-busy');
    else if (status === 'done') step.classList.add('is-done');
    else if (status === 'error') step.classList.add('is-error');
    var badge = step.querySelector('.step-status');
    if (badge) {
      var label = status === 'running' ? 'running' : status === 'done' ? 'done' : status === 'error' ? 'error' : 'pending';
      var tone = status === 'done' ? 'emerald' : status === 'error' ? 'danger' : status === 'running' ? 'gold' : '';
      badge.textContent = label;
      badge.className = 'badge step-status' + (tone ? ' ' + tone : '');
    }
    var num = step.querySelector('.step-num');
    if (num) {
      if (status === 'done') num.innerHTML = S.icon('check');
      else num.textContent = String(n);
    }
  }

  function renderStepError(n, err) {
    setStepResult(n, errorCard(err));
  }

  function errorCard(err) {
    var message = (err && err.message) || 'Request failed.';
    var meta = [];
    if (err && err.code) meta.push(err.code);
    if (err && err.status) meta.push('HTTP ' + err.status);
    return '<div class="demo-result is-error">' +
      '<div class="demo-error-title">' + S.icon('alert') + 'Step failed</div>' +
      '<div class="demo-error-msg">' + esc(message) + '</div>' +
      (meta.length ? '<div class="demo-error-hint">' + esc(meta.join(' · ')) + '</div>' : '') +
      '<div class="demo-error-hint">Request and response are in the live JSON log. A 404 here usually means that route is not deployed yet.</div>' +
    '</div>';
  }

  function updateProgress() {
    var count = Object.keys(state.completed).length;
    el.progress.textContent = count + ' / 5';
    if (count === 5) {
      el.finalContract.textContent = state.contract && state.contract.hash ? S.shortHash(state.contract.hash, 18) : '—';
      el.finalRefund.textContent = state.claim ? S.money(state.claim.refund) + ' in ' + ((Number(state.claim.sla_ms) || 1200) / 1000).toFixed(1) + 's' : '—';
      el.finalOrder.textContent = state.order && state.order.id ? S.shortHash(state.order.id, 14) : '—';
      if (el.finalPanel.classList.contains('hidden')) {
        el.finalPanel.classList.remove('hidden');
        if (!state.running) {
          setTimeout(function () {
            try { el.finalPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
          }, 260);
        }
      }
    } else {
      el.finalPanel.classList.add('hidden');
    }
  }

  async function resetDemo() {
    if (state.busy || state.running) return;
    state.busy = true;
    S.setBusy(el.reset, true, 'Resetting…');
    setControlsDisabled(true);
    try {
      await call('POST', '/reset', undefined, 'Reset demo');
      clearAll();
      S.toast('Demo reset to seed state.', 'ok');
    } catch (err) {
      S.toast((err && err.message) || 'Reset failed.', 'err');
    } finally {
      state.busy = false;
      S.setBusy(el.reset, false);
      setControlsDisabled(false);
    }
  }

  function clearAll() {
    state.merchant = null;
    state.merchantBefore = null;
    state.ledger = null;
    state.contract = null;
    state.quote = null;
    state.order = null;
    state.orderResponse = null;
    state.approvalUrl = null;
    state.claim = null;
    state.claimResponse = null;
    state.contractAi = null;
    state.contractAiRequested = false;
    state.claimAi = null;
    state.captureId = '';
    state.paypalCaptured = false;
    state.paypalOrderId = null;
    state.livePaypalActive = false;
    state.lastQuoteRes = null;
    state.lastOrderRes = null;
    state.contractVerification = null;
    state.completed = {};
    var sdkScript = document.getElementById('paypalSdkScript');
    if (sdkScript) sdkScript.remove();
    paypalSdkPromise = null;
    try { delete window.paypal; } catch (e) { window.paypal = undefined; }
    for (var i = 1; i <= 5; i++) {
      setStepState(i, 'pending');
      setStepResult(i, '<div class="step-empty">Not run yet.</div>');
    }
    if (el.rogue) {
      el.rogue.classList.add('hidden');
      el.rogue.innerHTML = '';
    }
    Array.prototype.forEach.call(document.querySelectorAll('.axis-card'), function (card) { card.classList.remove('is-done'); });
    el.finalPanel.classList.add('hidden');
    updateProgress();
    clearLog();
  }

  boot();
})();
