/* =========================================================
   Settled — merchant console behavior (catalog + seller policy)
   Plain ES2017, no dependencies. Uses the shared `Settled` client.
   ========================================================= */
(function () {
  'use strict';
  var S = window.Settled;
  if (!S) return;

  var merchantId = S.qs('merchant') || 'm1';
  var catalogPath = '/merchants/' + encodeURIComponent(merchantId) + '/catalog';
  var agentPath = '/merchants/' + encodeURIComponent(merchantId) + '/agent';
  var agentAutoconfigurePath = '/merchants/' + encodeURIComponent(merchantId) + '/agent/autoconfigure';
  var agentCatalogPath = '/merchants/' + encodeURIComponent(merchantId) + '/agent/catalog';
  var importPath = '/merchants/' + encodeURIComponent(merchantId) + '/catalog/import';
  var connectorPath = '/merchants/' + encodeURIComponent(merchantId) + '/connector';
  var syncPath = '/merchants/' + encodeURIComponent(merchantId) + '/catalog/sync';
  var rulesPath = '/merchants/' + encodeURIComponent(merchantId) + '/rules';
  var AGENT_TONES = ['consultative', 'concise', 'warm', 'formal'];
  var ADAPTER_INFO = {
    csv: { label: 'CSV upload', kind: 'csv', hint: 'Paste CSV text or choose a .csv file. Headers: sku/name/price/category/description.', placeholder: 'sku,name,price,category,description\nAURORA-ONE,Aurora One headphones,249,Audio,Reference-grade headphones.' },
    json: { label: 'JSON payload', kind: 'json', hint: 'Paste a JSON object like {"products":[...]} or choose a .json file.', placeholder: '{"products":[{"sku":"AURORA-ONE","name":"Aurora One headphones","price":249,"category":"Audio","description":"..."}]}' },
    shopify: { label: 'Shopify product payload', kind: 'json', hint: 'Payload adapter — paste a Shopify products export; no OAuth connection.', placeholder: '{"products":[{"id":1,"title":"Aurora One headphones","variants":[{"price":"249.00","sku":"AURORA-ONE"}],"product_type":"Audio","body_html":"..."}]}' },
    woocommerce: { label: 'WooCommerce product payload', kind: 'json', hint: 'Payload adapter — paste a WooCommerce products export; no OAuth connection.', placeholder: '{"products":[{"id":1,"name":"Aurora One headphones","price":"249","sku":"AURORA-ONE","categories":[{"name":"Audio"}],"description":"..."}]}' },
    feed: { label: 'Remote JSON feed', kind: 'feed', hint: 'Fetch a remote JSON catalog (array or {"products":[...]}) with a 5s server timeout.', placeholder: '' }
  };
  var IMPORT_SAMPLES = {
    csv: 'sku,name,price,category,description\nAURORA-ONE,Aurora One headphones,249,Audio,Reference-grade over-ear headphones.\nAURORA-BUDS,Aurora Buds,129,Audio,Compact wireless earbuds with 32-hour case life.',
    json: { products: [{ sku: 'AURORA-ONE', name: 'Aurora One headphones', price: 249, category: 'Audio', description: 'Reference-grade over-ear headphones.' }] },
    shopify: { products: [{ id: 1, title: 'Aurora One headphones', variants: [{ price: '249.00', sku: 'AURORA-ONE' }], product_type: 'Audio', body_html: 'Reference-grade over-ear headphones.' }] },
    woocommerce: { products: [{ id: 1, name: 'Aurora One headphones', price: '249', sku: 'AURORA-ONE', categories: [{ name: 'Audio' }], description: 'Reference-grade over-ear headphones.' }] }
  };
  var DEFAULT_GREETING = 'Hi — I’m Northwind’s seller agent. Happy to help with product questions and the published price range.';

  var state = {
    merchant: null,
    products: [],
    catalog: null,
    health: null,
    loading: false,
    agent: null,
    agentChanged: false,
    adapters: null,
    connector: null,
    connectorDue: null,
    connectorLoaded: false,
    connectorError: null,
    rules: null,
    rulesLoaded: false,
    rulesError: null
  };

  var RULE_DEFAULTS = {
    negotiable: true,
    sell_min_pct: 0.82,
    auto_accept_pct: 0.95,
    publish_min_pct: 0.86,
    max_discount_pct: 18,
    window: { from: null, to: null }
  };

  var el = {
    apiError: document.getElementById('apiError'),
    body: document.getElementById('merchantBody'),
    subtitle: document.getElementById('merchantSubtitle'),
    catalogList: document.getElementById('catalogList'),
    catalogCount: document.getElementById('catalogCount'),
    catalogSub: document.getElementById('catalogSub'),
    catalogFoot: document.getElementById('catalogFoot'),
    catalogMerchantId: document.getElementById('catalogMerchantId'),
    refresh: document.getElementById('refreshCatalogBtn'),
    openIndex: document.getElementById('openIndexLink'),
    preview: document.getElementById('previewLink'),
    sideIndex: document.getElementById('sideIndexLink'),
    sidePreview: document.getElementById('sidePreviewLink'),
    agentOperator: document.getElementById('agentOperator'),
    agentSettlement: document.getElementById('agentSettlement'),
    agentSettingsPanel: document.getElementById('agentSettingsPanel'),
    agentCardBadge: document.getElementById('agentCardBadge'),
    agentProfile: document.getElementById('agentProfile'),
    agentProfileAvatar: document.getElementById('agentProfileAvatar'),
    agentProfileName: document.getElementById('agentProfileName'),
    agentProfileOperator: document.getElementById('agentProfileOperator'),
    agentProfileTone: document.getElementById('agentProfileTone'),
    agentForm: document.getElementById('agentForm'),
    agentName: document.getElementById('agentName'),
    agentTone: document.getElementById('agentTone'),
    agentGreeting: document.getElementById('agentGreeting'),
    agentGreetingCount: document.getElementById('agentGreetingCount'),
    agentEnabled: document.getElementById('agentEnabled'),
    agentSaveBtn: document.getElementById('agentSaveBtn'),
    agentSaveStatus: document.getElementById('agentSaveStatus'),
    agentFormError: document.getElementById('agentFormError'),
    importForm: document.getElementById('importForm'),
    importAdapter: document.getElementById('importAdapter'),
    importAdapterBadge: document.getElementById('importAdapterBadge'),
    importHint: document.getElementById('importHint'),
    importDataField: document.getElementById('importDataField'),
    importData: document.getElementById('importData'),
    importDataHint: document.getElementById('importDataHint'),
    importFileWrap: document.getElementById('importFileWrap'),
    importFile: document.getElementById('importFile'),
    importFileName: document.getElementById('importFileName'),
    importUrlField: document.getElementById('importUrlField'),
    importUrl: document.getElementById('importUrl'),
    importSampleBtn: document.getElementById('importSampleBtn'),
    importBtn: document.getElementById('importBtn'),
    importError: document.getElementById('importError'),
    importResult: document.getElementById('importResult'),
    importResultAdapter: document.getElementById('importResultAdapter'),
    importedCount: document.getElementById('importedCount'),
    updatedCount: document.getElementById('updatedCount'),
    skippedCount: document.getElementById('skippedCount'),
    importErrors: document.getElementById('importErrors'),
    importResultFoot: document.getElementById('importResultFoot'),
    adapterList: document.getElementById('adapterList'),
    adapterCount: document.getElementById('adapterCount'),
    agentSetupPanel: document.getElementById('agentSetupPanel'),
    agentSetupStatus: document.getElementById('agentSetupStatus'),
    agentSetupBadge: document.getElementById('agentSetupBadge'),
    agentSetupRefreshBtn: document.getElementById('agentSetupRefreshBtn'),
    autoconfigureBtn: document.getElementById('autoconfigureBtn'),
    agentBrief: document.getElementById('agentBrief'),
    agentBriefChips: document.getElementById('agentBriefChips'),
    agentAddBtn: document.getElementById('agentAddBtn'),
    agentSetupError: document.getElementById('agentSetupError'),
    agentSetupResult: document.getElementById('agentSetupResult'),
    agentSetupFoot: document.getElementById('agentSetupFoot'),
    agentSetupMerchantId: document.getElementById('agentSetupMerchantId'),
    connectorForm: document.getElementById('connectorForm'),
    connectorBadge: document.getElementById('connectorBadge'),
    connectorAdapter: document.getElementById('connectorAdapter'),
    connectorUrl: document.getElementById('connectorUrl'),
    connectorUrlHint: document.getElementById('connectorUrlHint'),
    connectorInterval: document.getElementById('connectorInterval'),
    connectorEnabled: document.getElementById('connectorEnabled'),
    connectorDataField: document.getElementById('connectorDataField'),
    connectorData: document.getElementById('connectorData'),
    connectorDataHint: document.getElementById('connectorDataHint'),
    connectorSaveBtn: document.getElementById('connectorSaveBtn'),
    connectorSyncBtn: document.getElementById('connectorSyncBtn'),
    connectorError: document.getElementById('connectorError'),
    connectorLastSync: document.getElementById('connectorLastSync'),
    connectorLastStatus: document.getElementById('connectorLastStatus'),
    connectorCounts: document.getElementById('connectorCounts'),
    connectorDue: document.getElementById('connectorDue'),
    connectorLastError: document.getElementById('connectorLastError'),
    connectorFoot: document.getElementById('connectorFoot'),
    connectorMerchantId: document.getElementById('connectorMerchantId'),
    rulesPanel: document.getElementById('rulesPanel'),
    rulesBadge: document.getElementById('rulesBadge'),
    rulesBody: document.getElementById('rulesBody'),
    rulesError: document.getElementById('rulesError'),
    rulesRefreshBtn: document.getElementById('rulesRefreshBtn'),
    rulesApplyBtn: document.getElementById('rulesApplyBtn'),
    rulesFoot: document.getElementById('rulesFoot'),
    rulesMerchantId: document.getElementById('rulesMerchantId')
  };

  S.mountNav('merchant');
  wire();
  initAgentDefaults();
  updateImportMode();
  loadAll();

  /* --------------------------------------------------------- utils -- */
  function num(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return isFinite(n) ? n : null;
  }
  function round(n) { return Math.round(Number(n) || 0); }
  function moneyShort(n) {
    if (n === null || n === undefined || n === '') return '—';
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return Math.round(v) === v ? S.money0(v) : S.money(v);
  }
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/);
    return ((p[0] || '')[0] || '') + ((p[1] || '')[0] || '');
  }
  function termsOf(product) {
    var n = (product && product.negotiation) || {};
    return n.terms || { delivery_days: 3, returns_days: 30, warranty_months: 12 };
  }
  function termsText(product) {
    var t = termsOf(product);
    var parts = [];
    if (t.delivery_days !== undefined) parts.push(t.delivery_days + 'd delivery');
    if (t.returns_days !== undefined) parts.push(t.returns_days + 'd returns');
    if (t.warranty_months !== undefined) parts.push(t.warranty_months + 'mo warranty');
    return parts.join(' · ');
  }

  function negotiationOf(product) {
    var price = Number(product && product.price) || 0;
    var n = (product && product.negotiation) || {};
    var floor = n.sell_min !== undefined && n.sell_min !== null ? Number(n.sell_min) : round(price * 0.82);
    var auto = n.auto_accept !== undefined && n.auto_accept !== null ? Number(n.auto_accept) : round(price * 0.95);
    return {
      negotiable: n.negotiable !== false,
      listed: n.listed !== false,
      sell_min: floor,
      sell_max: n.sell_max !== undefined && n.sell_max !== null ? Number(n.sell_max) : round(price),
      publish_min: n.publish_min !== undefined && n.publish_min !== null ? Number(n.publish_min) : round(floor * 1.05),
      publish_max: n.publish_max !== undefined ? (n.publish_max === null ? null : Number(n.publish_max)) : round(price),
      auto_accept: auto,
      max_discount_pct: n.max_discount_pct !== undefined && n.max_discount_pct !== null ? Number(n.max_discount_pct) : 18,
      window: n.window && typeof n.window === 'object' ? { from: n.window.from || null, to: n.window.to || null } : { from: null, to: null },
      terms: n.terms || { delivery_days: 3, returns_days: 30, warranty_months: 12 }
    };
  }

  /* ---------------------------------------------------------- boot -- */
  async function loadAll() {
    state.loading = true;
    setBusy(el.refresh, true);
    el.apiError.hidden = true;
    try {
      var results = await Promise.all([
        S.api(catalogPath).catch(function (err) { return { __error: err }; }),
        S.api('/health').catch(function () { return null; }),
        S.api('/adapters').catch(function () { return null; }),
        S.api(connectorPath).catch(function (err) { return { __error: err }; }),
        S.api(rulesPath).catch(function (err) { return { __error: err }; })
      ]);
      state.health = results[1] || null;
      state.adapters = results[2] || null;
      if (state.health) S.setEnv(state.health.mode);
      renderAdapterList();
      applyConnectorResult(results[3] && results[3].__error ? null : results[3], results[3] && results[3].__error ? results[3].__error : null);
      applyRulesResult(results[4] && results[4].__error ? null : results[4], results[4] && results[4].__error ? results[4].__error : null);
      if (results[0] && results[0].__error) throw results[0].__error;
      var catalog = results[0] && (results[0].catalog || results[0]);
      applyCatalog(catalog, null, false);
      setBusy(el.refresh, false);
    } catch (err) {
      state.loading = false;
      setBusy(el.refresh, false);
      S.showApiError(el.apiError, err, function () { el.apiError.hidden = true; loadAll(); });
      el.catalogList.innerHTML = '<div class="catalog-empty"><strong>Catalog unavailable</strong>' + S.esc((err && err.message) || 'The catalog API did not respond.') + '</div>';
      S.toast((err && err.message) || 'Could not load catalog.', 'err');
    }
  }

  async function refreshCatalog(highlightId) {
    if (state.loading) return;
    state.loading = true;
    setBusy(el.refresh, true);
    try {
      var res = await S.api(catalogPath);
      applyCatalog(res && (res.catalog || res), highlightId, false);
      setBusy(el.refresh, false);
    } catch (err) {
      state.loading = false;
      setBusy(el.refresh, false);
      S.toast((err && err.message) || 'Could not refresh catalog.', 'err');
    }
  }

  function applyCatalog(catalog, highlightId, announce) {
    state.loading = false;
    if (!catalog) return;
    if (catalog.products) {
      state.catalog = catalog;
      state.merchant = catalog.merchant || state.merchant;
      state.products = catalog.products.slice();
    } else if (catalog.product) {
      var idx = state.products.map(function (p) { return p.id; }).indexOf(catalog.product.id);
      if (idx >= 0) state.products[idx] = catalog.product;
      else state.products.push(catalog.product);
    }
    var incomingAgent = catalog.agent || (catalog.merchant && catalog.merchant.agent) || null;
    if (incomingAgent) {
      var normalized = normalizeAgent(incomingAgent);
      if (!state.agent || JSON.stringify(normalized) !== JSON.stringify(state.agent)) {
        state.agent = normalized;
        state.agentChanged = true;
      }
    } else if (!state.agent) {
      state.agent = normalizeAgent(null);
      state.agentChanged = true;
    }
    if (state.merchant && state.agent) state.merchant.agent = state.agent;
    renderAll();
    fillAgentBrief();
    if (highlightId) highlightProduct(highlightId);
    if (announce) S.toast(announce, 'ok');
  }

  function fillAgentBrief() {
    if (!el.agentBrief || (el.agentBrief.value || '').trim()) return;
    var products = state.products || [];
    if (!products.length) return;
    var names = products.slice(0, 3).map(function (p) { return p.name; }).filter(Boolean).join(', ');
    var prices = products.map(function (p) { return Number(p.price); }).filter(function (n) { return isFinite(n) && n > 0; });
    var min = prices.length ? Math.min.apply(null, prices) : 0;
    var max = prices.length ? Math.max.apply(null, prices) : 0;
    el.agentBrief.value = 'Curate a starter catalog around ' + names +
      (min && max ? ' in the $' + Math.round(min) + '–$' + Math.round(max) + ' range.' : '.') +
      ' Add a few adjacent items and apply the same category policy automatically.';
  }

  function renderAll() {
    renderMerchant();
    renderAgentProfile();
    if (state.agentChanged) {
      renderAgentForm();
      state.agentChanged = false;
    }
    renderCatalog();
    updateLinks();
    if (state.merchant) S.setNavMerchant(state.merchant);
  }

  function renderMerchant() {
    var m = state.merchant || {};
    var tier = S.tierInfo(m.tier);
    var mode = S.modeInfo(m.mode);
    var count = state.products.length;
    el.subtitle.textContent = (m.name || 'This merchant') + ' · tier ' + (m.tier || '—') + ' · ' + count + ' product' + (count === 1 ? '' : 's') +
      '. Set the private sell range and the published range buyers see; the seller agent can negotiate only inside them.';
    el.catalogSub.textContent = 'Products, published ranges and seller-agent policy. Private sell ranges stay in this console.';
    el.catalogMerchantId.textContent = m.id || merchantId;
    el.agentOperator.textContent = m.name || 'Northwind Audio';
    el.agentSettlement.textContent = (mode.short || 'Instant') + ' capture · tier ' + (m.tier || '—');
    el.catalogFoot.textContent = 'Saves update the in-memory catalog instantly; the public index reflects published ranges only.';
  }

  /* ------------------------------------------------ seller agent -- */
  function normalizeAgent(raw) {
    var a = raw || {};
    var name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'Northwind Seller Agent';
    var tone = AGENT_TONES.indexOf(String(a.tone || '').toLowerCase()) >= 0 ? String(a.tone).toLowerCase() : 'consultative';
    var greeting = typeof a.greeting === 'string' ? a.greeting : DEFAULT_GREETING;
    return { name: name, tone: tone, greeting: greeting, enabled: a.enabled !== false };
  }

  function extractAgent(res) {
    if (!res) return null;
    var candidates = [
      res.agent,
      res.merchant && res.merchant.agent,
      res.catalog && res.catalog.agent,
      res.catalog && res.catalog.merchant && res.catalog.merchant.agent
    ];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c && typeof c === 'object' && (c.name !== undefined || c.tone !== undefined || c.greeting !== undefined || c.enabled !== undefined)) return c;
    }
    if (res.name !== undefined || res.tone !== undefined || res.greeting !== undefined || res.enabled !== undefined) return res;
    return null;
  }

  function initAgentDefaults() {
    state.agent = normalizeAgent(null);
    state.agentChanged = false;
    renderAgentProfile();
    renderAgentForm();
  }

  function renderAgentProfile() {
    var a = state.agent || normalizeAgent(null);
    var merchantName = (state.merchant && state.merchant.name) || 'Northwind Audio';
    var paused = a.enabled === false;
    if (el.agentProfileAvatar) el.agentProfileAvatar.textContent = initials(a.name) || 'NS';
    if (el.agentProfileName) el.agentProfileName.textContent = a.name;
    if (el.agentProfileOperator) el.agentProfileOperator.textContent = merchantName + ' · seller agent';
    if (el.agentProfileTone) el.agentProfileTone.textContent = a.tone;
    if (el.agentProfile) el.agentProfile.classList.toggle('is-paused', paused);
    if (el.agentCardBadge) {
      el.agentCardBadge.textContent = paused ? 'paused' : 'active';
      el.agentCardBadge.className = 'badge ' + (paused ? 'gold' : 'emerald');
    }
    renderAgentSetup();
  }

  function renderAgentForm() {
    var a = state.agent || normalizeAgent(null);
    el.agentName.value = a.name;
    el.agentTone.value = a.tone;
    el.agentGreeting.value = a.greeting;
    el.agentEnabled.checked = a.enabled !== false;
    el.agentFormError.textContent = '';
    updateAgentGreetingCount();
    setAgentStatus('All changes saved', 'saved');
  }

  function readAgentForm() {
    return {
      name: (el.agentName.value || '').trim(),
      tone: el.agentTone.value,
      greeting: el.agentGreeting.value || '',
      enabled: !!el.agentEnabled.checked
    };
  }

  function updateAgentGreetingCount() {
    if (!el.agentGreetingCount) return;
    var len = (el.agentGreeting.value || '').length;
    el.agentGreetingCount.textContent = len + ' / 200';
    el.agentGreetingCount.classList.toggle('near', len >= 180);
  }

  function setAgentStatus(text, cls) {
    if (!el.agentSaveStatus) return;
    el.agentSaveStatus.textContent = text;
    el.agentSaveStatus.className = 'agent-save-status' + (cls ? ' ' + cls : '');
  }

  function isAgentDirty() {
    var a = state.agent || normalizeAgent(null);
    var f = readAgentForm();
    return f.name !== a.name || f.tone !== a.tone || f.greeting !== a.greeting || f.enabled !== a.enabled;
  }

  function markAgentDirty() {
    el.agentFormError.textContent = '';
    updateAgentGreetingCount();
    if (isAgentDirty()) setAgentStatus('Unsaved changes', 'dirty');
    else setAgentStatus('All changes saved', 'saved');
  }

  function validateAgentForm(f) {
    var errors = [];
    if (!f.name) errors.push('Agent name is required.');
    else if (f.name.length > 60) errors.push('Agent name must be 60 characters or fewer.');
    if (AGENT_TONES.indexOf(f.tone) < 0) errors.push('Tone must be consultative, concise, warm or formal.');
    if (f.greeting.length > 200) errors.push('Greeting must be 200 characters or fewer.');
    return errors;
  }

  async function saveAgent(event) {
    if (event) event.preventDefault();
    if (el.agentSaveBtn.disabled) return;
    var form = readAgentForm();
    var errors = validateAgentForm(form);
    if (errors.length) {
      el.agentFormError.textContent = errors[0];
      setAgentStatus('Not saved', 'err');
      S.toast(errors[0], 'err');
      return;
    }
    var saved = state.agent || normalizeAgent(null);
    var diff = {};
    ['name', 'tone', 'greeting', 'enabled'].forEach(function (key) {
      if (form[key] !== saved[key]) diff[key] = form[key];
    });
    if (!Object.keys(diff).length) {
      el.agentFormError.textContent = '';
      setAgentStatus('No changes to save', 'saved');
      return;
    }
    el.agentFormError.textContent = '';
    el.agentSaveBtn.disabled = true;
    el.agentSaveBtn.classList.add('is-busy');
    setAgentStatus('Saving…', 'saving');
    try {
      var res = await S.api(agentPath, { method: 'PATCH', body: diff });
      var returned = extractAgent(res);
      var merged = normalizeAgent(Object.assign({}, saved, diff, returned || {}));
      state.agent = merged;
      state.agentChanged = false;
      if (state.merchant) state.merchant.agent = merged;
      renderAgentProfile();
      renderAgentForm();
      setAgentStatus('Saved just now', 'saved');
      S.toast('Agent settings saved.', 'ok');
    } catch (err) {
      setAgentStatus('Save failed', 'err');
      el.agentFormError.textContent = (err && err.message) || 'Could not save agent settings.';
      S.toast((err && err.message) || 'Could not save agent settings.', 'err');
    } finally {
      el.agentSaveBtn.disabled = false;
      el.agentSaveBtn.classList.remove('is-busy');
    }
  }

  /* ------------------------------------------------- import catalog -- */
  function renderAdapterList() {
    var data = state.adapters;
    var inventory = data && Array.isArray(data.inventory) ? data.inventory : [];
    if (el.adapterCount) el.adapterCount.textContent = inventory.length ? String(inventory.length) : '—';
    if (!inventory.length) {
      el.adapterList.innerHTML = '<div class="import-loading">Registry unavailable — reload after the adapter API deploys.</div>';
      return;
    }
    el.adapterList.innerHTML = inventory.map(function (a) {
      var status = String(a.status || 'roadmap').toLowerCase();
      var ready = status === 'ready';
      var payload = String(a.mode || '').toLowerCase() === 'payload';
      return '<div class="adapter-row">' +
        '<div class="adapter-row-body">' +
          '<div class="adapter-row-name">' + S.esc(a.name || a.id || 'adapter') + '</div>' +
          '<div class="adapter-row-mode">' + S.esc(a.mode || 'push') + ' · ' + S.esc(a.id || '') + '</div>' +
          (payload ? '<div class="adapter-payload">payload adapter · no OAuth yet</div>' : '') +
        '</div>' +
        '<span class="badge ' + (ready ? 'emerald' : 'gold') + '">' + S.esc(status) + '</span>' +
      '</div>';
    }).join('');
  }

  function currentAdapter() {
    return el.importAdapter.value || 'csv';
  }

  function updateImportMode() {
    var adapter = currentAdapter();
    var info = ADAPTER_INFO[adapter] || ADAPTER_INFO.csv;
    var feed = adapter === 'feed';
    el.importHint.textContent = info.hint;
    el.importDataField.hidden = feed;
    el.importFileWrap.hidden = feed;
    el.importUrlField.hidden = !feed;
    el.importSampleBtn.hidden = feed;
    el.importAdapterBadge.textContent = adapter;
    el.importDataHint.textContent = adapter === 'csv' ? 'CSV text' : 'JSON payload';
    el.importData.placeholder = info.placeholder || '';
    el.importFile.setAttribute('accept', adapter === 'csv' ? '.csv,text/csv' : '.json,application/json');
    el.importError.textContent = '';
  }

  function loadImportFile() {
    var file = el.importFile.files && el.importFile.files[0];
    if (!file) {
      el.importFileName.textContent = 'No file selected';
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      el.importError.textContent = 'File is larger than 2 MB.';
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      el.importData.value = String(reader.result || '');
      el.importFileName.textContent = file.name;
      el.importError.textContent = '';
    };
    reader.onerror = function () {
      el.importError.textContent = 'Could not read that file.';
    };
    reader.readAsText(file);
  }

  function loadImportSample() {
    var adapter = currentAdapter();
    if (adapter === 'feed') return;
    var sample = IMPORT_SAMPLES[adapter];
    if (sample === undefined) return;
    el.importData.value = typeof sample === 'string' ? sample : JSON.stringify(sample, null, 2);
    el.importFileName.textContent = 'Sample payload';
    el.importError.textContent = '';
  }

  function importErrorText(e) {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') {
      var bits = [];
      if (e.row !== undefined) bits.push('row ' + e.row);
      if (e.sku) bits.push('sku ' + e.sku);
      if (e.id !== undefined && e.id !== null) bits.push('id ' + e.id);
      if (e.message) bits.push(e.message);
      else if (e.error) bits.push(e.error);
      else bits.push(JSON.stringify(e));
      return bits.join(': ');
    }
    return String(e);
  }

  function renderImportResult(res, adapter) {
    var data = res || {};
    el.importedCount.textContent = String(Number(data.imported) || 0);
    el.updatedCount.textContent = String(Number(data.updated) || 0);
    el.skippedCount.textContent = String(Number(data.skipped) || 0);
    el.importResultAdapter.textContent = adapter;
    el.importResult.hidden = false;
    var errors = Array.isArray(data.errors) ? data.errors : (data.errors ? [data.errors] : []);
    if (errors.length) {
      el.importErrors.hidden = false;
      el.importErrors.innerHTML = errors.map(function (e) {
        return '<li>' + S.esc(importErrorText(e)) + '</li>';
      }).join('');
    } else {
      el.importErrors.hidden = true;
      el.importErrors.innerHTML = '';
    }
    el.importResultFoot.textContent = 'Catalog refreshing…';
  }

  function importFail(message) {
    el.importError.textContent = message;
    S.toast(message, 'err');
  }

  async function runImport(event) {
    if (event) event.preventDefault();
    if (el.importBtn.disabled) return;
    var adapter = currentAdapter();
    el.importError.textContent = '';
    el.importResult.hidden = true;
    var body;
    if (adapter === 'feed') {
      var url = (el.importUrl.value || '').trim();
      if (!url) return importFail('Enter a feed URL.');
      try {
        var parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('bad protocol');
      } catch (e) {
        return importFail('Feed URL must be a valid http(s) URL.');
      }
      body = { adapter: 'feed', url: url };
    } else {
      var raw = el.importData.value || '';
      if (!raw.trim()) return importFail('Paste a payload or choose a file.');
      if (adapter === 'csv') {
        body = { adapter: 'csv', data: raw };
      } else {
        var parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          return importFail('Payload is not valid JSON: ' + e.message);
        }
        if (!parsed || typeof parsed !== 'object') return importFail('Payload must be a JSON object.');
        body = { adapter: adapter, data: parsed };
      }
    }
    var before = {};
    state.products.forEach(function (p) { if (p && p.id) before[p.id] = JSON.stringify(p); });
    el.importBtn.disabled = true;
    el.importBtn.classList.add('is-busy');
    try {
      var res = await S.api(importPath, { method: 'POST', body: body });
      renderImportResult(res, adapter);
      var products = res && Array.isArray(res.products) ? res.products : [];
      var changed = products.filter(function (p) { return p && p.id && (!before[p.id] || JSON.stringify(p) !== before[p.id]); });
      var highlightId = changed.length ? changed[0].id : null;
      await refreshCatalog(highlightId);
      el.importResultFoot.textContent = highlightId ? 'Catalog refreshed — imported/updated items highlighted below.' : 'Catalog refreshed.';
      var counts = [];
      if (res && res.imported !== undefined) counts.push(res.imported + ' imported');
      if (res && res.updated !== undefined) counts.push(res.updated + ' updated');
      if (res && res.skipped !== undefined) counts.push(res.skipped + ' skipped');
      var hasErrors = res && Array.isArray(res.errors) && res.errors.length > 0;
      S.toast('Import complete' + (counts.length ? ' · ' + counts.join(' · ') : '') + '.', hasErrors ? 'warn' : 'ok');
    } catch (err) {
      el.importError.textContent = (err && err.message) || 'Import failed.';
      S.toast((err && err.message) || 'Import failed.', 'err');
    } finally {
      el.importBtn.disabled = false;
      el.importBtn.classList.remove('is-busy');
    }
  }

  function updateLinks() {
    var m = state.merchant || {};
    var id = m.id || merchantId;
    var productId = (state.products[0] && state.products[0].id) || 'p1';
    var negotiate = 'negotiate.html?merchant=' + encodeURIComponent(id) + '&product=' + encodeURIComponent(productId);
    el.preview.href = negotiate;
    el.sidePreview.href = negotiate;
    el.openIndex.href = 'market.html';
    el.sideIndex.href = 'market.html';
  }

  /* ------------------------------------------------------- catalog -- */
  function renderCatalog() {
    var products = state.products;
    el.catalogCount.textContent = String(products.length);
    if (!products.length) {
      el.catalogList.innerHTML = '<div class="catalog-empty"><strong>No products yet</strong>Add the first product below; its default ranges will be derived from the list price.</div>';
      return;
    }
    el.catalogList.innerHTML = products.map(function (product) {
      return productCard(product);
    }).join('');
    Array.prototype.forEach.call(el.catalogList.querySelectorAll('.product-row'), function (row) {
      updatePreview(row);
    });
  }

  function productCard(product) {
    var n = negotiationOf(product);
    var price = Number(product.price) || 0;
    var category = product.category || 'Uncategorized';
    var thumb = initials(category.replace(/[^A-Za-z ]/g, '')) || initials(product.name) || 'PR';
    var categorySafe = S.esc(category);
    return '<article class="product-row" data-product="' + S.esc(product.id) + '">' +
      '<div class="pr-head">' +
        '<span class="pr-thumb">' + S.esc(thumb) + '</span>' +
        '<div class="pr-id">' +
          '<div class="pr-name" title="' + S.esc(product.name) + '">' + S.esc(product.name) + '</div>' +
          '<div class="pr-meta"><span>#' + S.esc(product.id) + '</span><span class="cat">' + categorySafe + '</span><span>' + S.esc(S.money0(price)) + '</span><span>' + S.esc(termsText(product)) + '</span></div>' +
        '</div>' +
        '<div class="pr-head-right">' +
          '<label class="switch"><input type="checkbox" data-field="negotiable"' + (n.negotiable ? ' checked' : '') + '><span class="switch-track"></span><span>Negotiable</span></label>' +
          '<label class="switch"><input type="checkbox" data-field="listed"' + (n.listed ? ' checked' : '') + '><span class="switch-track"></span><span>Listed</span></label>' +
          '<button class="pr-save" type="button" data-save>Save</button>' +
        '</div>' +
      '</div>' +
      '<div class="pr-fields">' +
        '<div class="pr-group private">' +
          '<div class="pr-group-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>Private range (never public)</div>' +
          '<div class="pr-inputs">' +
            field('sell_min', 'sell_min', n.sell_min, 'Private floor') +
            field('sell_max', 'sell_max', n.sell_max, 'Private ceiling') +
          '</div>' +
        '</div>' +
        '<div class="pr-group public">' +
          '<div class="pr-group-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>Published range (public)</div>' +
          '<div class="pr-inputs">' +
            field('publish_min', 'publish_min', n.publish_min, 'Public “from”') +
            field('publish_max', 'publish_max', n.publish_max, 'Public ceiling (blank = from)') +
          '</div>' +
        '</div>' +
        '<div class="pr-group policy">' +
          '<div class="pr-group-label">Agent policy</div>' +
          '<div class="pr-inputs">' +
            field('auto_accept', 'auto_accept', n.auto_accept, 'Standing accept price') +
            field('max_discount_pct', 'max_discount_pct', n.max_discount_pct, 'Max discount %') +
          '</div>' +
        '</div>' +
        '<div class="pr-group window">' +
          '<div class="pr-group-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/></svg>Negotiation window (blank = inherit category)</div>' +
          '<div class="pr-inputs">' +
            windowInputField('window_from', 'Open from', n.window && n.window.from, 'Blank = inherit the category window') +
            windowInputField('window_to', 'Closes', n.window && n.window.to, 'Blank = inherit the category window') +
          '</div>' +
          '<div class="pr-window-note" data-window-note></div>' +
        '</div>' +
      '</div>' +
      '<div class="pr-foot">' +
        '<div class="pr-preview" data-preview></div>' +
        '<div class="pr-actions"><span class="pr-status" data-status>Saved</span></div>' +
      '</div>' +
    '</article>';
  }

  function field(name, label, value, hint) {
    var v = value === null || value === undefined ? '' : value;
    return '<label class="pr-field" title="' + S.esc(hint) + '"><span class="pf-label">' + S.esc(label) + '</span>' +
      '<input class="m-input" type="number" step="1" min="0" data-field="' + S.esc(name) + '" value="' + S.esc(v) + '" aria-label="' + S.esc(label) + '"></label>';
  }

  function rowFor(productId) {
    return el.catalogList.querySelector('.product-row[data-product="' + cssEscape(productId) + '"]');
  }
  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function readFields(row) {
    function input(name) { return row.querySelector('[data-field="' + name + '"]'); }
    var publishMax = input('publish_max').value.trim();
    return {
      negotiable: input('negotiable').checked,
      listed: input('listed').checked,
      sell_min: num(input('sell_min').value),
      sell_max: num(input('sell_max').value),
      publish_min: num(input('publish_min').value),
      publish_max: publishMax === '' ? null : num(publishMax),
      auto_accept: num(input('auto_accept').value),
      max_discount_pct: num(input('max_discount_pct').value),
      window_from: input('window_from') ? input('window_from').value : '',
      window_to: input('window_to') ? input('window_to').value : ''
    };
  }

  function validateProduct(product, fields) {
    var price = Number(product.price) || 0;
    var errors = [];
    function requirePositive(key) {
      if (fields[key] === null || fields[key] <= 0) errors.push(key + ' must be greater than 0');
    }
    ['sell_min', 'sell_max', 'publish_min', 'auto_accept'].forEach(requirePositive);
    if (fields.sell_min !== null && fields.sell_max !== null && fields.sell_min > fields.sell_max) errors.push('sell_min must be ≤ sell_max');
    if (fields.sell_max !== null && fields.sell_max > price) errors.push('sell_max must be ≤ list price (' + S.money0(price) + ')');
    if (fields.publish_min !== null && fields.sell_min !== null && fields.publish_min < fields.sell_min) errors.push('publish_min must be ≥ sell_min');
    if (fields.publish_max !== null && fields.publish_max !== undefined) {
      if (fields.publish_min !== null && fields.publish_max < fields.publish_min) errors.push('publish_max must be ≥ publish_min');
      if (fields.sell_max !== null && fields.publish_max > fields.sell_max) errors.push('publish_max must be ≤ sell_max');
    }
    if (fields.auto_accept !== null) {
      if (fields.sell_min !== null && fields.auto_accept < fields.sell_min) errors.push('auto_accept must be ≥ sell_min');
      if (fields.sell_max !== null && fields.auto_accept > fields.sell_max) errors.push('auto_accept must be ≤ sell_max');
    }
    if (fields.max_discount_pct === null || fields.max_discount_pct < 0 || fields.max_discount_pct > 50) errors.push('max_discount_pct must be 0–50');
    if (fields.window_from && fields.window_to && new Date(fields.window_from) > new Date(fields.window_to)) errors.push('Window from must be before to');
    return errors;
  }

  function setStatus(row, text, cls) {
    var status = row.querySelector('[data-status]');
    if (!status) return;
    status.textContent = text;
    status.className = 'pr-status' + (cls ? ' ' + cls : '');
  }

  function markDirty(row) {
    row.classList.remove('is-saved');
    row.classList.add('is-dirty');
    setStatus(row, 'Unsaved changes', 'dirty');
    updatePreview(row);
  }

  function updatePreview(row) {
    var productId = row.getAttribute('data-product');
    var product = state.products.filter(function (p) { return p.id === productId; })[0];
    if (!product) return;
    var fields;
    try { fields = readFields(row); } catch (e) { return; }
    var preview = row.querySelector('[data-preview]');
    if (!preview) return;
    var parts = [];
    if (!fields.negotiable) {
      parts.push('<span class="off">Fixed price</span>');
    } else {
      if (fields.publish_max === null || fields.publish_max === undefined) {
        parts.push('Buyers see <b>from ' + S.esc(moneyShort(fields.publish_min)) + '</b> <span class="off">(open ceiling)</span>');
      } else {
        parts.push('Buyers see <b>from ' + S.esc(moneyShort(fields.publish_min)) + '</b> to <b>' + S.esc(moneyShort(fields.publish_max)) + '</b>');
      }
      parts.push('auto-accept <b class="pub">' + S.esc(moneyShort(fields.auto_accept)) + '</b>');
      parts.push('max <b class="off">' + S.esc(fields.max_discount_pct === null ? '—' : fields.max_discount_pct + '%') + '</b> off');
    }
    if (!fields.listed) parts.push('<span class="off">hidden from index</span>');
    preview.innerHTML = parts.join(' · ');

    var fromIso = localInputToIso(fields.window_from);
    var toIso = localInputToIso(fields.window_to);
    var catRule = ruleForCategory(product.category);
    var note = row.querySelector('[data-window-note]');
    if (note) {
      if (fromIso || toIso) {
        note.innerHTML = 'Override · ' + S.esc(windowText(fromIso, toIso));
      } else if (catRule && (catRule.window.from || catRule.window.to)) {
        note.innerHTML = 'Inherits <b>' + S.esc(product.category) + '</b> · ' + S.esc(windowText(catRule.window.from, catRule.window.to));
      } else {
        note.innerHTML = 'Inherits the category rule — no window (negotiation always open).';
      }
    }
  }

  async function saveRow(row) {
    var productId = row.getAttribute('data-product');
    var product = state.products.filter(function (p) { return p.id === productId; })[0];
    if (!product) return;
    var fields = readFields(row);
    var errors = validateProduct(product, fields);
    Array.prototype.forEach.call(row.querySelectorAll('.m-input'), function (input) { input.removeAttribute('aria-invalid'); });
    if (errors.length) {
      setStatus(row, errors[0], 'err');
      S.toast(errors[0], 'err');
      return;
    }
    var btn = row.querySelector('[data-save]');
    if (!btn) return;
    btn.disabled = true;
    btn.classList.add('is-busy');
    setStatus(row, 'Saving…', 'saving');
    try {
      var res = await S.api(catalogPath + '/' + encodeURIComponent(productId), {
        method: 'PATCH',
        body: patchBody(fields)
      });
      var catalog = res && (res.catalog || res);
      applyCatalog(catalog && catalog.products ? catalog : { product: (res && res.product) || product }, productId, false);
      var savedRow = rowFor(productId);
      if (savedRow) {
        savedRow.classList.add('is-saved');
        setStatus(savedRow, 'Saved just now', 'saved');
        updatePreview(savedRow);
      }
      S.toast('Policy saved · ' + (product.name || productId), 'ok');
    } catch (err) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      setStatus(row, (err && err.message) || 'Save failed', 'err');
      S.toast((err && err.message) || 'Save failed.', 'err');
    }
  }

  function patchBody(fields) {
    return {
      negotiation: {
        negotiable: !!fields.negotiable,
        listed: !!fields.listed,
        sell_min: fields.sell_min,
        sell_max: fields.sell_max,
        publish_min: fields.publish_min,
        publish_max: fields.publish_max,
        auto_accept: fields.auto_accept,
        max_discount_pct: fields.max_discount_pct,
        // null clears the item override so the product inherits the category window.
        window: (fields.window_from || fields.window_to)
          ? { from: localInputToIso(fields.window_from), to: localInputToIso(fields.window_to) }
          : null
      }
    };
  }

  function highlightProduct(productId) {
    var row = rowFor(productId);
    if (!row) return;
    row.classList.add('is-new', 'is-saved');
    setStatus(row, 'Saved just now', 'saved');
    try { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
    setTimeout(function () { row.classList.remove('is-new'); }, 2400);
  }

  /* ---------------------------------------------------- agent setup -- */
  function agentProductCategoryCount() {
    if (state.rulesLoaded && state.rules && Array.isArray(state.rules.categories)) return state.rules.categories.length;
    var seen = {};
    var count = 0;
    state.products.forEach(function (p) {
      var name = p && p.category ? String(p.category) : 'Uncategorised';
      if (!seen[name]) {
        seen[name] = true;
        count += 1;
      }
    });
    return count;
  }

  function agentPolicyConfigured() {
    return !!(state.rulesLoaded && state.rules && state.rules.categories && state.rules.categories.length > 0);
  }

  function renderAgentSetup() {
    if (!el.agentSetupStatus) return;
    var agent = state.agent || normalizeAgent(null);
    var products = state.products.length;
    var categories = agentProductCategoryCount();
    var configured = agentPolicyConfigured();
    el.agentSetupStatus.textContent = agent.name + ' · ' + products + ' product' + (products === 1 ? '' : 's') +
      ' · ' + categories + ' categor' + (categories === 1 ? 'y' : 'ies') + ' · ' + (configured ? 'policy configured' : 'policy pending');
    el.agentSetupBadge.textContent = configured ? 'ready' : 'setup';
    el.agentSetupBadge.className = 'badge ' + (configured ? 'emerald' : 'gold');
    el.agentSetupMerchantId.textContent = (state.merchant && state.merchant.id) || merchantId;
    el.agentSetupFoot.textContent = configured
      ? 'Auto-configure is deterministic and offline; Add with agent uses the AI drafting helper with a deterministic fallback.'
      : 'Run Auto-configure to derive category rules for every product category.';
  }

  function showAgentResult(kind, res) {
    if (!el.agentSetupResult) return;
    res = res || {};
    var ai = res.ai && typeof res.ai === 'object' ? res.ai : {};
    var used = ai.used === true;
    var warn = false;
    var head;
    var sub;
    var list = '';
    if (kind === 'autoconfigure') {
      var categories = Array.isArray(res.categories) ? res.categories : [];
      var updated = Number(res.updated) || 0;
      var skipped = Number(res.skipped) || 0;
      head = 'Agent configured ' + updated + ' product' + (updated === 1 ? '' : 's') + ' across ' + categories.length + ' categor' + (categories.length === 1 ? 'y' : 'ies');
      sub = 'Updated ' + updated + ' · skipped ' + skipped + ' · ' + categories.length + ' rule' + (categories.length === 1 ? '' : 's') +
        ' applied · ' + (used ? 'AI-assisted' : 'deterministic, no model call');
      if (categories.length) {
        list = '<ul class="agent-created">' + categories.slice(0, 8).map(function (c) {
          return '<li><span class="ac-name">' + S.esc(c) + '</span><span class="ac-meta">category rule</span></li>';
        }).join('') + '</ul>';
      }
      warn = skipped > 0;
    } else {
      var products = Array.isArray(res.products) ? res.products : [];
      var created = res.created !== undefined ? Number(res.created) || 0 : products.length;
      head = 'Agent drafted ' + created + ' item' + (created === 1 ? '' : 's');
      sub = 'Created ' + created + ' · ' + (used ? 'AI-assisted' : 'deterministic fallback') +
        ' · category rules inherited' + (ai.error ? ' · ' + ai.error : '');
      if (products.length) {
        list = '<ul class="agent-created">' + products.slice(0, 8).map(function (p) {
          return '<li><span class="ac-name">' + S.esc(p.name || p.id || 'item') + '</span>' +
            '<span class="ac-meta">' + S.esc(p.category || '—') + '</span>' +
            '<span class="ac-price">' + S.esc(S.money0(p.price)) + '</span></li>';
        }).join('') + '</ul>';
      }
      warn = !!ai.error;
    }
    el.agentSetupResult.hidden = false;
    el.agentSetupResult.className = 'agent-setup-result' + (warn ? ' is-warn' : '');
    el.agentSetupResult.innerHTML = '<div class="agent-result-head"><span>' + S.esc(head) + '</span>' +
      '<span class="badge ' + (warn ? 'gold' : 'emerald') + '">' + S.esc(used ? 'ai' : 'deterministic') + '</span></div>' +
      '<div class="agent-result-sub">' + S.esc(sub) + '</div>' + list;
  }

  async function autoConfigureCatalog() {
    if (el.autoconfigureBtn.disabled) return;
    el.agentSetupError.textContent = '';
    setBusy(el.autoconfigureBtn, true, 'Configuring…');
    try {
      var res = await S.api(agentAutoconfigurePath, { method: 'POST', body: {} });
      showAgentResult('autoconfigure', res);
      await Promise.all([refreshCatalog(), loadRules()]);
      S.toast('Agent configured the catalog.', 'ok');
    } catch (err) {
      el.agentSetupError.textContent = (err && err.message) || 'Could not auto-configure the catalog.';
      S.toast((err && err.message) || 'Could not auto-configure the catalog.', 'err');
    } finally {
      setBusy(el.autoconfigureBtn, false);
    }
  }

  async function addWithAgent() {
    if (el.agentAddBtn.disabled) return;
    var brief = (el.agentBrief.value || '').trim();
    if (!brief) {
      el.agentSetupError.textContent = 'Describe what you sell first — or pick an example below.';
      S.toast('Describe what you sell first.', 'err');
      return;
    }
    el.agentSetupError.textContent = '';
    setBusy(el.agentAddBtn, true, 'Drafting…');
    try {
      var res = await S.api(agentCatalogPath, { method: 'POST', body: { brief: brief, count: 3 } });
      showAgentResult('catalog', res);
      var created = res && Array.isArray(res.products) ? res.products : [];
      await refreshCatalog(created.length && created[0].id ? created[0].id : null);
      if (state.rulesLoaded) await loadRules();
      var count = res && res.created !== undefined ? Number(res.created) || 0 : created.length;
      S.toast('Agent drafted ' + count + ' item' + (count === 1 ? '' : 's') + '.', res && res.ai && res.ai.error ? 'warn' : 'ok');
    } catch (err) {
      el.agentSetupError.textContent = (err && err.message) || 'Could not draft products.';
      S.toast((err && err.message) || 'Could not draft products.', 'err');
    } finally {
      setBusy(el.agentAddBtn, false);
    }
  }

  async function refreshAgentSetup() {
    setBusy(el.agentSetupRefreshBtn, true, 'Refreshing…');
    try {
      await Promise.all([refreshCatalog(), loadRules()]);
      renderAgentSetup();
    } finally {
      setBusy(el.agentSetupRefreshBtn, false);
    }
  }

  /* --------------------------------------------------- window helpers -- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoToLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function localInputToIso(value) {
    if (!value) return null;
    var d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  function windowInputField(name, label, iso, hint) {
    return '<label class="pr-field" title="' + S.esc(hint) + '"><span class="pf-label">' + S.esc(label) + '</span>' +
      '<input class="m-input" type="datetime-local" data-field="' + S.esc(name) + '" value="' + S.esc(isoToLocalInput(iso)) + '" aria-label="' + S.esc(label) + '"></label>';
  }
  function ruleForCategory(category) {
    var map = state.rules && state.rules.rules;
    return map && category && map[category] ? map[category] : null;
  }
  function windowText(fromIso, toIso) {
    var from = fromIso ? S.dateFmt(fromIso) : 'always';
    var to = toIso ? S.dateFmt(toIso) : 'no close';
    return from + ' → ' + to;
  }

  /* --------------------------------------------- inventory source -- */
  var CONNECTOR_MANUAL = { json: true, csv: true };

  function connectorOf(res) {
    if (!res || typeof res !== 'object') return null;
    if (res.connector && typeof res.connector === 'object') return res.connector;
    if (res.adapter !== undefined || res.last_status !== undefined || res.last_sync_at !== undefined) return res;
    return null;
  }

  function applyConnectorResult(res, err) {
    if (err) {
      state.connectorLoaded = false;
      state.connectorError = err;
      renderConnectorUnavailable(err);
      return;
    }
    var c = connectorOf(res);
    if (c) {
      state.connector = c;
      state.connectorLoaded = true;
      state.connectorError = null;
      if (res && res.due_at !== undefined) state.connectorDue = res.due_at;
    } else {
      state.connectorLoaded = false;
    }
    renderConnector();
  }

  function connectorCountsText(counts) {
    if (!counts || typeof counts !== 'object') return '—';
    var bits = [];
    if (counts.imported !== undefined && counts.imported !== null) bits.push(counts.imported + ' in');
    if (counts.updated !== undefined && counts.updated !== null) bits.push(counts.updated + ' upd');
    if (counts.skipped !== undefined && counts.skipped !== null) bits.push(counts.skipped + ' skip');
    return bits.length ? bits.join(' · ') : '—';
  }

  function renderConnector() {
    var c = state.connector;
    if (!c) return renderConnectorUnavailable(state.connectorError);
    var known = ['feed', 'json', 'csv'];
    var adapter = known.indexOf(c.adapter) >= 0 ? c.adapter : 'feed';
    el.connectorAdapter.value = adapter;
    el.connectorUrl.value = c.url || '';
    el.connectorInterval.value = c.interval_seconds !== undefined && c.interval_seconds !== null ? c.interval_seconds : 300;
    el.connectorEnabled.checked = c.enabled !== false;
    el.connectorBadge.textContent = adapter;
    el.connectorBadge.className = 'badge ' + (c.enabled === false ? 'gold' : 'emerald');
    el.connectorLastSync.textContent = c.last_sync_at ? S.dateFmt(c.last_sync_at) : 'never';
    var status = String(c.last_status || 'never');
    el.connectorLastStatus.textContent = status;
    el.connectorLastStatus.className = status === 'ok' ? 'is-ok' : (status === 'error' ? 'is-err' : 'is-muted');
    el.connectorCounts.textContent = connectorCountsText(c.last_counts);
    el.connectorDue.textContent = state.connectorDue ? S.dateFmt(state.connectorDue) : (c.enabled === false ? 'paused' : '—');
    if (c.last_error) {
      el.connectorLastError.hidden = false;
      el.connectorLastError.innerHTML = '<b>Last error</b> · ' + S.esc(c.last_error);
    } else {
      el.connectorLastError.hidden = true;
      el.connectorLastError.innerHTML = '';
    }
    var manual = !!CONNECTOR_MANUAL[adapter];
    el.connectorFoot.textContent = c.enabled === false
      ? 'Scheduler paused — Pull now still works. ' + (manual ? 'JSON/CSV sources sync a manual payload; use Import catalog for large pushes.' : 'The feed is pulled with a 5s server timeout.')
      : 'Scheduler pulls every ' + (c.interval_seconds || 300) + 's · ' + (manual ? 'manual payload sync only' : '5s fetch timeout · failures recorded, never fatal') + '.';
    el.connectorMerchantId.textContent = merchantId;
    updateConnectorMode(false);
  }

  function renderConnectorUnavailable(err) {
    if (!el.connectorBadge) return;
    el.connectorBadge.textContent = 'offline';
    el.connectorBadge.className = 'badge gold';
    el.connectorLastSync.textContent = '—';
    el.connectorLastStatus.textContent = 'unavailable';
    el.connectorLastStatus.className = 'is-err';
    el.connectorCounts.textContent = '—';
    el.connectorDue.textContent = '—';
    el.connectorLastError.hidden = false;
    el.connectorLastError.innerHTML = '<b>Connector API unavailable</b> · ' + S.esc((err && err.message) || 'GET /connector did not respond.');
    el.connectorFoot.textContent = 'GET/PUT ' + connectorPath + ' is not deployed yet — retry after the backend lands.';
    el.connectorMerchantId.textContent = merchantId;
  }

  function updateConnectorMode(clearData) {
    if (!el.connectorAdapter) return;
    var adapter = el.connectorAdapter.value || 'feed';
    var manual = !!CONNECTOR_MANUAL[adapter];
    el.connectorDataField.hidden = !manual;
    el.connectorUrlHint.textContent = manual ? 'optional for json/csv' : 'feed pulls this URL';
    el.connectorDataHint.textContent = 'only used by Pull now · ' + adapter;
    if (clearData) el.connectorData.value = '';
    el.connectorError.textContent = '';
  }

  function readConnectorForm() {
    return {
      adapter: el.connectorAdapter.value || 'feed',
      url: (el.connectorUrl.value || '').trim(),
      interval_seconds: num(el.connectorInterval.value),
      enabled: !!el.connectorEnabled.checked
    };
  }

  function validateConnector(form) {
    var errors = [];
    if (['feed', 'json', 'csv'].indexOf(form.adapter) < 0) {
      errors.push('Shopify and WooCommerce OAuth connectors are roadmap — use the payload import below.');
    }
    if (form.interval_seconds === null || form.interval_seconds < 60 || form.interval_seconds > 86400) {
      errors.push('Interval must be 60–86400 seconds.');
    }
    if (form.adapter === 'feed' && !form.url) {
      errors.push('A feed URL is required for the feed adapter.');
    }
    if (form.url) {
      var okUrl = false;
      try {
        var parsed = new URL(form.url);
        okUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch (e) { okUrl = false; }
      if (!okUrl) errors.push('Source URL must be a valid http(s) URL.');
    }
    return errors;
  }

  async function saveConnector(event) {
    if (event) event.preventDefault();
    if (el.connectorSaveBtn.disabled) return;
    var form = readConnectorForm();
    var errors = validateConnector(form);
    if (errors.length) {
      el.connectorError.textContent = errors[0];
      S.toast(errors[0], 'err');
      return;
    }
    el.connectorError.textContent = '';
    el.connectorSaveBtn.disabled = true;
    try {
      var res = await S.api(connectorPath, { method: 'PUT', body: form });
      applyConnectorResult(res);
      await loadConnector();
      S.toast('Inventory source saved.', 'ok');
    } catch (err) {
      el.connectorError.textContent = (err && err.message) || 'Could not save the inventory source.';
      S.toast((err && err.message) || 'Could not save the inventory source.', 'err');
    } finally {
      el.connectorSaveBtn.disabled = false;
    }
  }

  async function loadConnector() {
    try {
      var res = await S.api(connectorPath);
      applyConnectorResult(res);
    } catch (err) {
      applyConnectorResult(null, err);
    }
  }

  async function syncConnector() {
    if (el.connectorSyncBtn.disabled) return;
    var form = readConnectorForm();
    var formErrors = validateConnector(form);
    if (formErrors.length) {
      el.connectorError.textContent = formErrors[0];
      S.toast(formErrors[0], 'err');
      return;
    }
    var adapter = form.adapter;
    var data;
    if (CONNECTOR_MANUAL[adapter]) {
      var raw = (el.connectorData.value || '').trim();
      if (!raw) {
        el.connectorError.textContent = 'Paste a ' + (adapter === 'csv' ? 'CSV' : 'JSON') + ' payload below, or use the Import catalog panel.';
        S.toast('JSON/CSV sources need a manual payload to sync.', 'err');
        return;
      }
      if (adapter === 'json') {
        try {
          data = JSON.parse(raw);
        } catch (e) {
          el.connectorError.textContent = 'Manual payload is not valid JSON: ' + e.message;
          S.toast('Manual payload is not valid JSON.', 'err');
          return;
        }
      } else {
        data = raw;
      }
    }
    el.connectorError.textContent = '';
    setBusy(el.connectorSyncBtn, true, 'Pulling…');
    try {
      // Pull now runs against the form as shown: save the source config first,
      // then sync (empty body for feed; {data} for manual json/csv payloads).
      var putRes = await S.api(connectorPath, { method: 'PUT', body: form });
      applyConnectorResult(putRes);
      var body = CONNECTOR_MANUAL[adapter] ? { data: data } : {};
      var res = await S.api(syncPath, { method: 'POST', body: body });
      var connector = connectorOf(res);
      if (connector) state.connector = connector;
      var sync = res && res.sync ? res.sync : (res || {});
      var errors = Array.isArray(sync.errors) ? sync.errors : [];
      if (errors.length) {
        el.connectorError.textContent = 'Warnings: ' + errors.slice(0, 3).map(importErrorText).join('; ');
      }
      var counts = (connector && connector.last_counts) || {
        imported: sync.imported,
        updated: sync.updated,
        skipped: sync.skipped
      };
      var countsTxt = connectorCountsText(counts);
      S.toast('Pull complete' + (countsTxt !== '—' ? ' · ' + countsTxt : '') + '.', errors.length ? 'warn' : 'ok');
      await loadConnector();
      await refreshCatalog();
      // A sync can introduce new categories; refresh the rule rows (and their inherit notes).
      if (state.rulesLoaded) await loadRules();
    } catch (err) {
      el.connectorError.textContent = (err && err.message) || 'Pull failed.';
      S.toast((err && err.message) || 'Pull failed.', 'err');
      await loadConnector();
    } finally {
      setBusy(el.connectorSyncBtn, false);
    }
  }

  /* ---------------------------------------------- category rules -- */
  function ruleFraction(value, fallback) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return fallback;
    return n > 1 ? n / 100 : n;
  }
  function rulePercent(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return n > 0 && n < 1 ? n * 100 : n;
  }
  function normalizeRule(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var w = r.window && typeof r.window === 'object' ? r.window : {};
    return {
      negotiable: r.negotiable !== false,
      sell_min_pct: ruleFraction(r.sell_min_pct, RULE_DEFAULTS.sell_min_pct),
      auto_accept_pct: ruleFraction(r.auto_accept_pct, RULE_DEFAULTS.auto_accept_pct),
      publish_min_pct: ruleFraction(r.publish_min_pct, RULE_DEFAULTS.publish_min_pct),
      max_discount_pct: rulePercent(r.max_discount_pct, RULE_DEFAULTS.max_discount_pct),
      window: { from: w.from || null, to: w.to || null }
    };
  }
  function normalizeRuleCategories(categories, rules) {
    var out = [];
    var seen = {};
    function add(name) {
      name = String(name === null || name === undefined ? '' : name).trim();
      if (!name || seen[name]) return;
      seen[name] = true;
      out.push(name);
    }
    if (Array.isArray(categories)) {
      categories.forEach(function (c) {
        if (c && typeof c === 'object') add(c.name || c.category || c.id);
        else add(c);
      });
    }
    Object.keys(rules || {}).forEach(add);
    out.sort(function (a, b) { return a.localeCompare(b); });
    return out;
  }

  function applyRulesResult(res, err) {
    if (err) {
      state.rulesLoaded = false;
      state.rulesError = err;
      renderRulesUnavailable(err);
      return;
    }
    var data = res && typeof res === 'object' ? res : {};
    if (data.rules && typeof data.rules === 'object') {
      var map = {};
      Object.keys(data.rules).forEach(function (key) { map[key] = normalizeRule(data.rules[key]); });
      state.rules = { rules: map, categories: normalizeRuleCategories(data.categories, map) };
      state.rulesLoaded = true;
      state.rulesError = null;
    } else {
      state.rulesLoaded = false;
      state.rulesError = null;
    }
    renderRules();
  }

  function renderRulesUnavailable(err) {
    if (!el.rulesBody) return;
    el.rulesBadge.textContent = 'offline';
    el.rulesBadge.className = 'badge gold';
    el.rulesBody.innerHTML = '<tr><td colspan="8" class="rules-empty"><strong>Category rules API unavailable</strong>' +
      S.esc((err && err.message) || 'GET /rules did not respond yet — retry after the backend deploys.') + '</td></tr>';
    el.rulesError.textContent = '';
    el.rulesFoot.textContent = 'GET/PUT ' + rulesPath + ' is not deployed yet.';
    el.rulesMerchantId.textContent = merchantId;
    renderAgentSetup();
  }

  function percentCell(field, value, min, max) {
    return '<input class="m-input rules-pct" type="number" data-rule="' + S.esc(field) + '" min="' + min + '" max="' + max + '" step="1" value="' + S.esc(Math.round(Number(value) || 0)) + '">';
  }
  function ruleWindowCell(field, iso) {
    return '<input class="m-input rules-window" type="datetime-local" data-rule="' + S.esc(field) + '" value="' + S.esc(isoToLocalInput(iso)) + '">';
  }
  function ruleRow(category) {
    var r = (state.rules && state.rules.rules && state.rules.rules[category]) || normalizeRule(null);
    return '<tr data-category="' + S.esc(category) + '">' +
      '<td><div class="rules-cat" title="' + S.esc(category) + '">' + S.esc(category) + '</div></td>' +
      '<td><label class="switch" title="Negotiable in this category"><input type="checkbox" data-rule="negotiable"' + (r.negotiable ? ' checked' : '') + '><span class="switch-track"></span></label></td>' +
      '<td>' + percentCell('sell_min_pct', r.sell_min_pct * 100, 50, 99) + '</td>' +
      '<td>' + percentCell('auto_accept_pct', r.auto_accept_pct * 100, 51, 100) + '</td>' +
      '<td>' + percentCell('max_discount_pct', r.max_discount_pct, 0, 50) + '</td>' +
      '<td>' + ruleWindowCell('window_from', r.window.from) + '</td>' +
      '<td>' + ruleWindowCell('window_to', r.window.to) + '</td>' +
      '<td class="rules-cell-status"><button class="rules-save" type="button" data-rule-save>Save</button><span class="rules-row-status" data-rule-status>Saved</span></td>' +
    '</tr>';
  }

  function renderRules() {
    if (!state.rulesLoaded) { renderRulesUnavailable(state.rulesError); return; }
    var cats = (state.rules && state.rules.categories) || [];
    el.rulesBadge.textContent = String(cats.length);
    el.rulesBadge.className = 'badge ' + (cats.length ? 'blue' : 'gold');
    el.rulesMerchantId.textContent = merchantId;
    if (!cats.length) {
      el.rulesBody.innerHTML = '<tr><td colspan="8" class="rules-empty"><strong>No categories yet</strong>Save a category rule or add catalog items to see categories here.</td></tr>';
      el.rulesFoot.textContent = 'No category rules returned. Run Auto-configure in Agent setup, or set a category rule manually.';
      updateAllPreviews();
      renderAgentSetup();
      return;
    }
    el.rulesBody.innerHTML = cats.map(ruleRow).join('');
    el.rulesFoot.textContent = 'Percentages are off list price. Saves apply to new and imported items; use Apply to re-derive existing items.';
    updateAllPreviews();
    renderAgentSetup();
  }

  function ruleInput(tr, field) {
    return tr.querySelector('[data-rule="' + field + '"]');
  }
  function readRuleRow(tr) {
    var category = tr.getAttribute('data-category');
    var base = (state.rules && state.rules.rules && state.rules.rules[category]) || normalizeRule(null);
    function valueOf(field) {
      var input = ruleInput(tr, field);
      return input ? String(input.value) : '';
    }
    function numberOr(field, fallback) {
      var n = num(valueOf(field));
      return n === null ? fallback : n;
    }
    var sellMin = numberOr('sell_min_pct', base.sell_min_pct * 100) / 100;
    var auto = numberOr('auto_accept_pct', base.auto_accept_pct * 100) / 100;
    var maxDiscount = numberOr('max_discount_pct', base.max_discount_pct);
    var negotiable = ruleInput(tr, 'negotiable');
    return {
      negotiable: !negotiable || !!negotiable.checked,
      sell_min_pct: sellMin,
      auto_accept_pct: auto,
      publish_min_pct: Math.min(Math.max(base.publish_min_pct, sellMin), auto),
      max_discount_pct: maxDiscount,
      window: { from: localInputToIso(valueOf('window_from')), to: localInputToIso(valueOf('window_to')) }
    };
  }

  function validateRule(rule) {
    var errors = [];
    if (!(rule.sell_min_pct >= 0.5 && rule.sell_min_pct < rule.auto_accept_pct && rule.auto_accept_pct <= 1)) {
      errors.push('Sell min must be 50–99% and below auto-accept (max 100%).');
    }
    if (rule.publish_min_pct < rule.sell_min_pct) errors.push('Publish min must be ≥ sell min.');
    if (!(rule.max_discount_pct >= 0 && rule.max_discount_pct <= 50)) errors.push('Max discount must be 0–50%.');
    if (rule.window.from && rule.window.to && new Date(rule.window.from) > new Date(rule.window.to)) {
      errors.push('Window “from” must be before “to”.');
    }
    return errors;
  }

  function setRuleStatus(tr, text, cls) {
    var status = tr.querySelector('[data-rule-status]');
    if (!status) return;
    status.textContent = text;
    status.className = 'rules-row-status' + (cls ? ' ' + cls : '');
  }

  function markRuleDirty(tr) {
    el.rulesError.textContent = '';
    setRuleStatus(tr, 'Unsaved changes', 'dirty');
  }

  async function saveRule(tr) {
    var category = tr.getAttribute('data-category');
    if (!category) return;
    var btn = tr.querySelector('[data-rule-save]');
    if (btn && btn.disabled) return;
    var rule = readRuleRow(tr);
    var errors = validateRule(rule);
    if (errors.length) {
      setRuleStatus(tr, errors[0], 'err');
      S.toast(errors[0], 'err');
      return;
    }
    if (btn) btn.disabled = true;
    setRuleStatus(tr, 'Saving…', '');
    try {
      var res = await S.api(rulesPath + '/' + encodeURIComponent(category), { method: 'PUT', body: rule });
      var map = {};
      if (res && res.rules && typeof res.rules === 'object') {
        Object.keys(res.rules).forEach(function (key) { map[key] = normalizeRule(res.rules[key]); });
      } else {
        map = Object.assign({}, state.rules.rules);
      }
      map[category] = normalizeRule((res && res.rule) || rule);
      state.rules.rules = map;
      if (state.rules.categories.indexOf(category) < 0) {
        state.rules.categories.push(category);
        state.rules.categories.sort(function (a, b) { return a.localeCompare(b); });
      }
      renderRules();
      S.toast('Category rule saved · ' + category, 'ok');
    } catch (err) {
      if (btn) btn.disabled = false;
      setRuleStatus(tr, (err && err.message) || 'Save failed', 'err');
      S.toast((err && err.message) || 'Could not save the category rule.', 'err');
    }
  }

  async function loadRules() {
    setBusy(el.rulesRefreshBtn, true, 'Loading…');
    try {
      var res = await S.api(rulesPath);
      applyRulesResult(res);
    } catch (err) {
      applyRulesResult(null, err);
      S.toast((err && err.message) || 'Could not load category rules.', 'err');
    } finally {
      setBusy(el.rulesRefreshBtn, false);
    }
  }

  async function applyRules() {
    if (el.rulesApplyBtn.disabled) return;
    if (!state.rulesLoaded) {
      S.toast('Category rules API unavailable.', 'err');
      return;
    }
    el.rulesError.textContent = '';
    setBusy(el.rulesApplyBtn, true, 'Applying…');
    try {
      var res = await S.api(rulesPath + '/apply', { method: 'POST', body: {} });
      var updated = null;
      if (res && res.updated !== undefined) updated = res.updated;
      else if (res && res.applied !== undefined) updated = res.applied;
      else if (res && Array.isArray(res.products)) updated = res.products.length;
      var msg = 'Applied category rules to existing items' + (updated !== null ? ' · ' + updated + ' updated' : '') + '.';
      if (res && res.rules && typeof res.rules === 'object') {
        var map = {};
        Object.keys(res.rules).forEach(function (key) { map[key] = normalizeRule(res.rules[key]); });
        state.rules.rules = map;
        state.rules.categories = normalizeRuleCategories(res.categories, map);
        renderRules();
      }
      el.rulesFoot.textContent = msg;
      S.toast(msg, 'ok');
      await refreshCatalog();
    } catch (err) {
      el.rulesError.textContent = (err && err.message) || 'Could not apply category rules.';
      S.toast((err && err.message) || 'Could not apply category rules.', 'err');
    } finally {
      setBusy(el.rulesApplyBtn, false);
    }
  }

  function updateAllPreviews() {
    if (!el.catalogList) return;
    Array.prototype.forEach.call(el.catalogList.querySelectorAll('.product-row'), function (row) {
      updatePreview(row);
    });
  }

  /* --------------------------------------------------------- events -- */
  function wire() {
    el.refresh.addEventListener('click', function () { refreshCatalog(null); });
    var advancedBtn = document.getElementById('advancedInventoryBtn');
    if (advancedBtn) {
      advancedBtn.addEventListener('click', function () {
        var panels = [document.getElementById('inventoryPanel'), document.getElementById('importPanel')].filter(Boolean);
        var open = panels.some(function (p) { return !p.hidden; });
        panels.forEach(function (p) { p.hidden = open; });
        advancedBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
        advancedBtn.textContent = open ? 'Advanced inventory' : 'Hide advanced inventory';
        if (!open) panels[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    if (el.autoconfigureBtn) el.autoconfigureBtn.addEventListener('click', autoConfigureCatalog);
    if (el.agentAddBtn) el.agentAddBtn.addEventListener('click', addWithAgent);
    if (el.agentSetupRefreshBtn) el.agentSetupRefreshBtn.addEventListener('click', refreshAgentSetup);
    if (el.agentBriefChips) {
      el.agentBriefChips.addEventListener('click', function (e) {
        var chip = e.target && e.target.closest ? e.target.closest('[data-brief]') : null;
        if (!chip) return;
        el.agentBrief.value = chip.getAttribute('data-brief') || '';
        el.agentBrief.focus();
        el.agentSetupError.textContent = '';
      });
    }
    if (el.agentForm) el.agentForm.addEventListener('submit', saveAgent);
    [el.agentName, el.agentTone, el.agentEnabled].forEach(function (node) {
      if (!node) return;
      node.addEventListener('input', markAgentDirty);
      node.addEventListener('change', markAgentDirty);
    });
    if (el.agentGreeting) {
      el.agentGreeting.addEventListener('input', markAgentDirty);
      el.agentGreeting.addEventListener('change', markAgentDirty);
    }
    if (el.importAdapter) {
      el.importAdapter.addEventListener('change', function () {
        el.importFile.value = '';
        el.importFileName.textContent = 'No file selected';
        el.importResult.hidden = true;
        updateImportMode();
      });
    }
    if (el.importFile) el.importFile.addEventListener('change', loadImportFile);
    if (el.importSampleBtn) el.importSampleBtn.addEventListener('click', loadImportSample);
    if (el.importForm) el.importForm.addEventListener('submit', runImport);

    el.catalogList.addEventListener('input', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.product-row') : null;
      if (!row || !e.target.hasAttribute('data-field')) return;
      if (e.target.getAttribute('data-field') === 'negotiable' || e.target.getAttribute('data-field') === 'listed') return;
      markDirty(row);
    });
    el.catalogList.addEventListener('change', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.product-row') : null;
      if (!row || !e.target.hasAttribute('data-field')) return;
      markDirty(row);
    });
    el.catalogList.addEventListener('click', function (e) {
      var save = e.target && e.target.closest ? e.target.closest('[data-save]') : null;
      if (!save) return;
      var row = save.closest('.product-row');
      if (row) saveRow(row);
    });

    if (el.connectorForm) el.connectorForm.addEventListener('submit', saveConnector);
    if (el.connectorSyncBtn) el.connectorSyncBtn.addEventListener('click', syncConnector);
    if (el.connectorAdapter) {
      el.connectorAdapter.addEventListener('change', function () {
        updateConnectorMode(true);
        el.connectorLastError.hidden = true;
      });
    }

    if (el.rulesRefreshBtn) el.rulesRefreshBtn.addEventListener('click', loadRules);
    if (el.rulesApplyBtn) el.rulesApplyBtn.addEventListener('click', applyRules);
    if (el.rulesBody) {
      el.rulesBody.addEventListener('input', function (e) {
        var row = e.target && e.target.closest ? e.target.closest('tr[data-category]') : null;
        if (!row || !e.target.hasAttribute('data-rule')) return;
        markRuleDirty(row);
      });
      el.rulesBody.addEventListener('change', function (e) {
        var row = e.target && e.target.closest ? e.target.closest('tr[data-category]') : null;
        if (!row || !e.target.hasAttribute('data-rule')) return;
        markRuleDirty(row);
      });
      el.rulesBody.addEventListener('click', function (e) {
        var save = e.target && e.target.closest ? e.target.closest('[data-rule-save]') : null;
        if (!save) return;
        var row = save.closest('tr[data-category]');
        if (row) saveRule(row);
      });
    }
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      if (btn.dataset.original === undefined) btn.dataset.original = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.innerHTML = '<span class="spinner"></span><span class="btn-label">' + S.esc(label || 'Refreshing…') + '</span>';
    } else {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      if (btn.dataset.original !== undefined) {
        btn.innerHTML = btn.dataset.original;
        delete btn.dataset.original;
      }
    }
  }
})();
