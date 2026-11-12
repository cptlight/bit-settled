/* Network discovery — this node + the independent boards it can reach.
   Data: GET /api/network/nodes (self is always nodes[0]; peers follow).
   The API is implemented by lib/network.js; this page degrades cleanly when
   a node does not expose discovery yet. */
(function () {
  'use strict';
  var S = window.Settled || {};
  var $ = function (id) { return document.getElementById(id); };
  var base = window.SETTLED_API_BASE || '/api';
  var loading = false;
  var boardsLoading = false;
  var pendingBusy = 0;
  var refreshBtn = $('netRefresh');

  var SEEDS_TEMPLATE = 'NETWORK_ID=my-agent-market\n' +
    'INSTANCE_NAME="My Agent Market"\n' +
    'INSTANCE_TAGLINE="agents negotiate. merchants settle."\n' +
    'PUBLIC_SITE_URL=https://market.example\n' +
    'NETWORK_SEEDS=https://peer-one.example,https://peer-two.example';

  /* ---------- small helpers ---------- */
  function esc(v) {
    if (S.esc) return S.esc(v);
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function text(v) { return String(v === null || v === undefined ? '' : v).trim(); }
  function stripSlash(u) { return String(u || '').replace(/\/+$/, ''); }
  function safeUrl(v) {
    var s = text(v);
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.indexOf('//') === 0) return 'https:' + s;
    return '';
  }
  function ago(iso) {
    if (S.timeAgo) return S.timeAgo(iso) || 'just now';
    if (!iso) return '';
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function modeInfo(mode) {
    var m = text(mode).toLowerCase();
    if (m === 'live') return { cls: 'live', label: 'Live' };
    if (m === 'sim') return { cls: 'sim', label: 'Sandbox' };
    return { cls: '', label: m ? m : 'Unknown mode' };
  }
  function copy(value) {
    if (S.copyText) { S.copyText(value, 'Setup'); return; }
    var done = function () { if (S.toast) S.toast('Copied to clipboard.', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(function () {});
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    ta.remove();
  }

  /* ---------- normalisation ---------- */
  function normalizeNode(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var endpoints = raw.endpoints && typeof raw.endpoints === 'object' ? raw.endpoints : {};
    return {
      self: raw.self === true,
      name: text(raw.name) || 'Unnamed node',
      tagline: text(raw.tagline),
      networkId: text(raw.network_id),
      publicUrl: safeUrl(raw.public_url),
      mode: text(raw.mode),
      endpoints: {
        api: text(endpoints.api),
        board: text(endpoints.board),
        mcp: text(endpoints.mcp),
        manifest: text(endpoints.manifest),
        openapi: text(endpoints.openapi)
      },
      lastSeen: raw.last_seen || raw.updated_at || null,
      reachable: raw.reachable !== false,
      manifestUrl: safeUrl(raw.manifest_url),
      error: text(raw.error)
    };
  }

  function buildModel(res) {
    res = res && typeof res === 'object' ? res : {};
    var rawNodes = Array.isArray(res.nodes) ? res.nodes : [];
    var nodes = rawNodes.map(normalizeNode).filter(Boolean);
    var self = null;
    var peers = [];
    nodes.forEach(function (n) {
      if (!self && n.self) self = n;
      else peers.push(n);
    });
    // Tolerate older { self, peers } aliases without depending on them.
    if (!self && res.self) self = normalizeNode(res.self);
    if (!peers.length && Array.isArray(res.peers)) peers = res.peers.map(normalizeNode).filter(Boolean);
    if (!self && peers.length) {
      self = peers.shift();
      self.self = true;
    }
    return {
      self: self,
      peers: peers,
      networkId: text(res.network_id) || (self && self.networkId) || '',
      seeds: Array.isArray(res.seeds) ? res.seeds.map(text).filter(Boolean) : [],
      count: typeof res.count === 'number' ? res.count : nodes.length,
      cached: res.cached === true,
      generatedAt: res.generated_at || null
    };
  }

  /* ---------- endpoint URLs ---------- */
  function originOf(node) {
    if (node.publicUrl) return stripSlash(node.publicUrl);
    var b = String(base || '');
    if (/^https?:\/\//i.test(b)) {
      var m = b.match(/^(https?:\/\/[^/]+)/i);
      if (m) return m[1];
    }
    return (window.location && window.location.origin) || '';
  }
  function endpointUrl(node, key) {
    var ep = text(node.endpoints[key]);
    if (!ep) return '';
    var abs = safeUrl(ep);
    if (abs) return abs;
    if (ep.charAt(0) !== '/') ep = '/' + ep;
    var origin = originOf(node);
    return origin ? origin + ep : ep;
  }

  /* ---------- render ---------- */
  function metaItem(label, valueHtml) {
    return '<div class="net-meta-item"><div class="net-meta-label">' + esc(label) +
      '</div><div class="net-meta-value">' + valueHtml + '</div></div>';
  }
  function badge(cls, label) {
    return '<span class="net-badge ' + (cls ? cls + ' ' : '') + '"><span class="dot"></span>' + esc(label) + '</span>';
  }

  function renderSummary(model, opts) {
    var host = $('netSummary');
    if (!host) return;
    var total = (model.self ? 1 : 0) + model.peers.length;
    var reachable = (model.self && model.self.reachable ? 1 : 0) +
      model.peers.filter(function (p) { return p.reachable; }).length;
    var html = '<span class="net-stat"><span class="pulse" aria-hidden="true"></span><b>' + total + '</b> node' + (total === 1 ? '' : 's') + ' in network</span>';
    html += '<span class="net-stat"><b>' + reachable + '</b> reachable</span>';
    html += '<span class="net-stat"><b>' + model.seeds.length + '</b> seed' + (model.seeds.length === 1 ? '' : 's') + ' configured</span>';
    if (opts && opts.degraded) html += '<span class="net-stat"><b>Discovery</b> unavailable</span>';
    else if (model.generatedAt) html += '<span class="net-stat">Updated <b>' + esc(ago(model.generatedAt)) + '</b>' + (model.cached ? ' · cached' : '') + '</span>';
    host.innerHTML = html;
  }

  function renderSelf(model) {
    var host = $('netSelf');
    if (!host) return;
    var node = model.self;
    if (!node) {
      host.innerHTML = '<div class="net-empty"><div class="net-empty-title">Current node not available</div>' +
        '<p>The server did not return its own identity. The board still works — reload or check <code>GET /api/instance</code>.</p></div>';
      return;
    }
    var m = modeInfo(node.mode);
    var networkId = node.networkId || model.networkId || '';
    var boardUrl = endpointUrl(node, 'board') || 'index.html';
    var apiUrl = endpointUrl(node, 'api');
    var mcpUrl = endpointUrl(node, 'mcp');
    var manifestUrl = node.manifestUrl || endpointUrl(node, 'manifest');
    var seen = node.lastSeen ? 'Updated ' + ago(node.lastSeen) : 'Live from this server';
    var html = '<div class="net-self-top">' +
      '<div class="net-self-copy">' +
        '<div class="net-kicker">Current node · you are here</div>' +
        '<h2 class="net-self-name">' + esc(node.name) + '</h2>' +
        (node.tagline ? '<div class="net-self-tag">' + esc(node.tagline) + '</div>' : '') +
      '</div>' +
      '<div class="net-badges">' + badge(m.cls, m.label) + badge('', 'Self') +
        (node.reachable ? '' : badge('offline', 'Unreachable')) +
      '</div>' +
    '</div>';
    html += '<div class="net-meta">' +
      metaItem('Network ID', networkId ? '<span class="net-mono">' + esc(networkId) + '</span>' : '<span class="net-muted">not set</span>') +
      metaItem('Public URL', node.publicUrl
        ? '<a href="' + esc(node.publicUrl) + '" target="_blank" rel="noopener">' + esc(stripSlash(node.publicUrl)) + '</a>'
        : '<span class="net-muted">not configured · local node</span>') +
      metaItem('Mode', esc(m.label)) +
      metaItem('Last seen', esc(seen)) +
    '</div>';
    html += '<div class="net-self-actions">' +
      '<a class="btn btn-primary btn-sm" href="' + esc(boardUrl) + '">Open board</a>' +
      (apiUrl ? '<a class="btn btn-ghost btn-sm" href="' + esc(apiUrl) + '">API</a>' : '') +
      (mcpUrl ? '<a class="btn btn-ghost btn-sm" href="' + esc(mcpUrl) + '">MCP</a>' : '') +
      '<a class="btn btn-ghost btn-sm" href="post.html">Create an item</a>' +
      (manifestUrl ? '<a class="btn btn-ghost btn-sm" href="' + esc(manifestUrl) + '" target="_blank" rel="noopener">Manifest ↗</a>' : '') +
    '</div>';
    host.innerHTML = html;
  }

  function peerCard(node) {
    var m = modeInfo(node.mode);
    var hostOf = function (u) {
      try { return new URL(u).host; } catch (e) { return stripSlash(u).replace(/^https?:\/\//i, ''); }
    };
    var publicLink = node.publicUrl
      ? '<a href="' + esc(node.publicUrl) + '" target="_blank" rel="noopener">' + esc(hostOf(node.publicUrl)) + '</a>'
      : '<span class="net-muted">public URL not configured</span>';
    var seen = node.reachable
      ? (node.lastSeen ? 'Seen ' + ago(node.lastSeen) : 'Reachable')
      : (node.lastSeen ? 'Last seen ' + ago(node.lastSeen) : 'Not reachable');
    var boardUrl = node.reachable ? (node.publicUrl || endpointUrl(node, 'board')) : '';
    var html = '<article class="panel net-card" data-node="' + esc(node.networkId || node.name) + '">' +
      '<div class="net-card-head">' + badge(node.reachable ? m.cls : 'offline', node.reachable ? m.label : 'Unreachable') +
        badge('', node.reachable ? 'Peer' : 'Cached') +
      '</div>' +
      '<h3 class="net-card-name">' + esc(node.name) + '</h3>' +
      (node.tagline
        ? '<p class="net-card-tag">' + esc(node.tagline) + '</p>'
        : '<p class="net-card-tag net-muted">No tagline published.</p>') +
      '<div class="net-card-meta">' +
        '<span>Network <b>' + (node.networkId ? esc(node.networkId) : '—') + '</b></span>' +
        '<span>' + publicLink + '</span>' +
        '<span>' + esc(seen) + '</span>' +
        (node.error ? '<span class="net-card-err">' + esc(node.error) + '</span>' : '') +
      '</div>' +
      '<div class="net-card-foot">' +
        (boardUrl ? '<a class="btn btn-primary btn-sm" href="' + esc(boardUrl) + '"' + (node.publicUrl ? ' target="_blank" rel="noopener"' : '') + '>Open board</a>' : '') +
        (node.publicUrl && !node.reachable ? '<a class="btn btn-ghost btn-sm" href="' + esc(node.publicUrl) + '" target="_blank" rel="noopener">Try site ↗</a>' : '') +
        (node.manifestUrl ? '<a class="btn btn-ghost btn-sm" href="' + esc(node.manifestUrl) + '" target="_blank" rel="noopener">Manifest ↗</a>' : '') +
      '</div>' +
    '</article>';
    return html;
  }

  function renderPeers(model, opts) {
    var host = $('netPeers');
    var count = $('netPeerCount');
    if (!host) return;
    if (count) {
      count.textContent = opts && opts.degraded
        ? 'Discovery unavailable'
        : (model.peers.length ? model.peers.length + (model.peers.length === 1 ? ' independent board' : ' independent boards') : 'None configured');
    }
    if (model.peers.length) {
      host.innerHTML = model.peers.map(peerCard).join('');
      return;
    }
    var degraded = opts && opts.degraded;
    host.innerHTML = '<div class="panel net-empty">' +
      '<div class="net-empty-title">' + (degraded ? 'Peer discovery is not available on this node' : 'No independent boards yet') + '</div>' +
      '<p>' + (degraded
        ? 'This server does not answer <code>GET /api/network/nodes</code> yet, so only this node is listed. The board itself still works.'
        : 'This node has no <code>NETWORK_SEEDS</code> configured. Any operator can host an independent board and join the network — point this node at their manifest URL to list them here.') +
      '</p>' +
      '<div class="net-card-foot">' +
        '<button class="btn btn-ghost btn-sm" id="netEmptyCopy" type="button">Copy NETWORK_SEEDS setup</button>' +
        '<a class="btn btn-ghost btn-sm" href="post.html">Post an item</a>' +
        '<a class="btn btn-ghost btn-sm" href="index.html">Open the board</a>' +
      '</div>' +
    '</div>';
  }

  function renderSeeds(model, opts) {
    var host = $('netSeedStatus');
    if (!host) return;
    if (opts && opts.degraded) {
      host.innerHTML = 'Seed list unavailable from this server. Every node publishes its discovery document at <code>/.well-known/bitsettled.json</code>.';
      return;
    }
    if (!model.seeds.length) {
      host.innerHTML = '<b>NETWORK_SEEDS is empty.</b> This node is running as a single independent board. Add comma-separated peer origins or manifest URLs to the node environment to list them above.';
      return;
    }
    host.innerHTML = '<b>' + model.seeds.length + ' seed' + (model.seeds.length === 1 ? '' : 's') + ' configured:</b> ' +
      model.seeds.map(function (s) { return '<code>' + esc(s) + '</code>'; }).join(' ');
  }

  function render(model, opts) {
    renderSummary(model, opts);
    renderSelf(model);
    renderPeers(model, opts);
    renderSeeds(model, opts);
  }

  /* ---------- loading + states ---------- */
  function setError(html) {
    var box = $('netError');
    if (!box) return;
    if (!html) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<div class="net-error-copy">' + html + '</div>' +
      '<button class="btn btn-ghost btn-sm" id="netRetry" type="button">Retry</button>';
    var retry = $('netRetry');
    if (retry) retry.addEventListener('click', function () { load(true); });
  }
  function friendlyError(err) {
    var status = err && err.status;
    if (status === 404) return 'This server does not expose network discovery yet (<code>GET /api/network/nodes</code>).';
    if (status === 0) return 'Can’t reach the Settled API. Start the node and reload.';
    return esc((err && err.message) || 'The network API did not respond.');
  }

  function participantKey() {
    try {
      var saved = JSON.parse(localStorage.getItem('bitsettled_participant') || 'null');
      if (saved && typeof saved.api_key === 'string' && saved.api_key) return saved.api_key;
    } catch (e) {}
    return '';
  }

  function request(path, options) {
    options = options || {};
    if (S.api) return S.api(path, options);
    var url = stripSlash(base) + path;
    var init = {
      method: (options.method || 'GET').toUpperCase(),
      headers: { accept: 'application/json' },
      credentials: 'same-origin'
    };
    var key = participantKey();
    if (key) init.headers['x-agent-key'] = key;
    if (options.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) {
          var err = new Error((data && data.error && data.error.message) || ('Request failed (' + r.status + ')'));
          err.status = r.status;
          err.code = (data && data.error && data.error.code) || 'http_error';
          throw err;
        }
        return data;
      });
    }, function () {
      var err = new Error('Can’t reach the Settled API.');
      err.status = 0; err.code = 'network';
      throw err;
    });
  }
  function selfFallback() {
    var url = stripSlash(base) + '/instance';
    return fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function setBusy(busy) {
    if (!refreshBtn) return;
    refreshBtn.disabled = busy;
    refreshBtn.textContent = busy ? 'Refreshing…' : 'Refresh network';
    refreshBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  function busyStart() { pendingBusy += 1; setBusy(true); }
  function busyEnd() {
    pendingBusy = Math.max(0, pendingBusy - 1);
    if (!pendingBusy) setBusy(false);
  }

  function load(force) {
    if (loading) return;
    loading = true;
    busyStart();
    var path = '/network/nodes' + (force ? '?refresh=1' : '');
    request(path).then(function (res) {
      setError('');
      render(buildModel(res), { degraded: false });
    }).catch(function (err) {
      var instance = null;
      selfFallback().then(function (data) {
        instance = data;
        var model = buildModel(instance ? { nodes: [instance], network_id: instance.network_id } : { nodes: [] });
        if (instance && model.self) model.self.lastSeen = instance.updated_at || null;
        render(model, { degraded: true });
        setError('<b>Network discovery unavailable.</b> ' + friendlyError(err) +
          '<br><span class="net-muted">Only this node is shown. Add <code>NETWORK_SEEDS</code> on the server and reload — see “Run your own node” below.</span>');
      });
    }).then(function () {
      loading = false;
      busyEnd();
    });
  }

  /* ---------- cross-node offers: GET /api/network/boards ---------- */
  function normalizeRange(range) {
    if (!range) return null;
    if (Array.isArray(range) && range.length >= 2) return { min: Number(range[0]), max: Number(range[1]) };
    if (typeof range !== 'object') return null;
    var lo = Number(range.min);
    var hi = Number(range.max);
    if (!isFinite(lo) && !isFinite(hi)) return null;
    if (!isFinite(lo)) lo = hi;
    if (!isFinite(hi)) hi = lo;
    return { min: lo, max: hi };
  }
  function normalizeOffer(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var id = text(raw.id);
    if (!id) return null;
    var status = text(raw.status).toLowerCase().replace(/[^a-z_]/g, '');
    var labels = {
      open: 'Open', negotiating: 'Negotiating', deal: 'Deal', accepted: 'Accepted',
      closed: 'Closed', no_deal: 'No deal', rejected: 'Rejected', error: 'Error'
    };
    return {
      id: id,
      title: text(raw.title) || 'Untitled offer',
      category: text(raw.category),
      range: normalizeRange(raw.published_range),
      statusKey: status || 'open',
      statusLabel: labels[status] || (status ? status.replace(/_/g, ' ') : 'Open'),
      itemUrl: text(raw.item_url)
    };
  }
  function normalizeBoardEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var src = raw.node && typeof raw.node === 'object' ? raw.node : raw;
    var postsRaw = Array.isArray(raw.posts) ? raw.posts : (Array.isArray(src.posts) ? src.posts : []);
    return {
      node: {
        self: src.self === true,
        name: text(src.name) || 'Unnamed node',
        networkId: text(src.network_id),
        publicUrl: safeUrl(src.public_url)
      },
      posts: postsRaw.map(normalizeOffer).filter(Boolean).slice(0, 10)
    };
  }
  function buildBoardsModel(res) {
    res = res && typeof res === 'object' ? res : {};
    var raw = Array.isArray(res.nodes) ? res.nodes : (Array.isArray(res.boards) ? res.boards : []);
    var entries = raw.map(normalizeBoardEntry).filter(function (e) { return e && e.posts.length; });
    var offers = entries.reduce(function (n, e) { return n + e.posts.length; }, 0);
    var unreachable = raw.filter(function (e) {
      return e && (e.reachable === false || (e.node && e.node.reachable === false));
    }).length;
    var peersScanned = typeof res.count === 'number' && res.count >= 0 ? res.count : raw.length;
    return {
      entries: entries,
      offers: offers,
      nodes: entries.length,
      peersScanned: peersScanned,
      unreachable: unreachable,
      totalPosts: typeof res.total_posts === 'number' ? res.total_posts : offers,
      cached: res.cached === true
    };
  }
  function money(n) {
    if (S.money0) return S.money0(n);
    var v = Number(n);
    return isFinite(v) ? '$' + Math.round(v) : '—';
  }
  function rangeLabel(range) {
    if (!range) return '';
    if (!isFinite(range.min) || !isFinite(range.max)) return '';
    return range.min === range.max ? money(range.min) : money(range.min) + '–' + money(range.max);
  }
  function resolveOfferUrl(node, offer) {
    var absolute = safeUrl(offer.itemUrl);
    if (absolute) return absolute;
    var raw = text(offer.itemUrl);
    var origin = node.publicUrl ? stripSlash(node.publicUrl) : (node.self ? originOf(node) : '');
    if (raw && raw.charAt(0) === '/' && origin) return origin + raw;
    if (origin) return origin + '/item.html?post=' + encodeURIComponent(offer.id);
    return 'item.html?post=' + encodeURIComponent(offer.id);
  }
  function isRemoteUrl(url) {
    if (!/^https?:\/\//i.test(url)) return false;
    return !window.location || url.indexOf(window.location.origin) !== 0;
  }
  function offerRow(node, offer) {
    var href = resolveOfferUrl(node, offer);
    var meta = [];
    if (offer.category) meta.push('<span class="net-offer-cat">' + esc(offer.category) + '</span>');
    var range = rangeLabel(offer.range);
    if (range) meta.push('<span class="net-offer-price">' + esc(range) + '</span>');
    meta.push('<span class="net-offer-status ' + esc(offer.statusKey) + '">' + esc(offer.statusLabel) + '</span>');
    var main = '<span class="net-offer-main"><span class="net-offer-title">' + esc(offer.title) + '</span>' +
      '<span class="net-offer-meta">' + meta.join('') + '</span></span>';
    var link;
    if (!href) {
      link = '<div class="net-offer">' + main + '</div>';
    } else {
      var remote = isRemoteUrl(href);
      link = '<a class="net-offer" href="' + esc(href) + '"' + (remote ? ' target="_blank" rel="noopener"' : '') + '>' +
        main + '<span class="net-offer-arrow" aria-hidden="true">↗</span></a>';
    }
    var handoff = '';
    if (!node.self && node.publicUrl) {
      handoff = '<button class="net-offer-handoff" type="button" data-handoff-post="' + esc(offer.id) +
        '" data-handoff-target="' + esc(node.publicUrl) + '" data-handoff-node="' + esc(node.name) +
        (href ? '" data-handoff-item="' + esc(href) : '') +
        '" aria-label="Hand off ' + esc(offer.title) + ' to ' + esc(node.name) + '">Hand off ↗</button>';
    }
    return '<div class="net-offer-row">' + link + handoff + '</div>';
  }
  function boardEntryHtml(entry) {
    var node = entry.node;
    var meta = 'Network <b>' + (node.networkId ? esc(node.networkId) : '—') + '</b>';
    if (node.publicUrl) {
      meta += ' · <a href="' + esc(node.publicUrl) + '" target="_blank" rel="noopener">' +
        esc(stripSlash(node.publicUrl).replace(/^https?:\/\//i, '')) + '</a>';
    }
    var badgeLabel = node.self ? 'This node' : entry.posts.length + ' offer' + (entry.posts.length === 1 ? '' : 's');
    return '<section class="panel net-offer-node">' +
      '<div class="net-offer-node-head">' +
        '<div class="net-offer-node-id">' +
          '<h3 class="net-offer-node-name">' + esc(node.name) + '</h3>' +
          '<div class="net-offer-node-meta">' + meta + '</div>' +
        '</div>' +
        '<span class="net-badge">' + esc(badgeLabel) + '</span>' +
      '</div>' +
      '<div class="net-offer-list">' + entry.posts.map(function (o) { return offerRow(node, o); }).join('') + '</div>' +
    '</section>';
  }
  function wireOffersRetry() {
    var retry = $('netOffersRetry');
    if (retry) retry.addEventListener('click', function () { loadBoards(true); });
  }
  function renderBoards(state) {
    var host = $('netOffers');
    var count = $('netOffersCount');
    if (!host) return;
    if (state.status === 'error') {
      if (count) count.textContent = 'Unavailable';
      host.innerHTML = '<div class="net-offers-error"><div><b>Couldn’t load cross-node offers.</b> ' +
        (state.notFound
          ? 'This node does not expose <code>GET /api/network/boards</code> yet.'
          : esc(state.message || 'The network API did not respond.')) +
        '<br><span class="net-muted">The rest of the network page still works.</span></div>' +
        '<button class="btn btn-ghost btn-sm" id="netOffersRetry" type="button">Retry</button></div>';
      wireOffersRetry();
      return;
    }
    var model = state.model;
    if (!model.entries.length) {
      if (count) count.textContent = 'None yet';
      var peerNote;
      if (model.unreachable) {
        peerNote = model.unreachable + ' peer board' + (model.unreachable === 1 ? '' : 's') +
          ' could not be reached. Post an item here, or refresh later.';
      } else if (model.peersScanned) {
        peerNote = 'Reached ' + model.peersScanned + ' peer board' + (model.peersScanned === 1 ? '' : 's') +
          ' — none had live offers. Post an item here, or refresh later.';
      } else {
        peerNote = 'No reachable peer boards are configured on this node. Post an item here, or add <code>NETWORK_SEEDS</code> so this node can follow other boards.';
      }
      host.innerHTML = '<div class="panel net-empty" style="grid-column:1/-1">' +
        '<div class="net-empty-title">No active offers across the network yet</div>' +
        '<p>' + peerNote + '</p>' +
        '<div class="net-card-foot">' +
          '<a class="btn btn-ghost btn-sm" href="post.html">Post an item</a>' +
          '<a class="btn btn-ghost btn-sm" href="index.html">Open the board</a>' +
          '<button class="btn btn-ghost btn-sm" id="netOffersRetry" type="button">Refresh offers</button>' +
        '</div></div>';
      wireOffersRetry();
      return;
    }
    if (count) {
      count.textContent = model.offers + ' offer' + (model.offers === 1 ? '' : 's') +
        ' · ' + model.peersScanned + ' peer' + (model.peersScanned === 1 ? '' : 's') +
        (model.unreachable ? ' · ' + model.unreachable + ' unreachable' : '');
    }
    host.innerHTML = model.entries.map(boardEntryHtml).join('');
  }
  function loadBoards(force) {
    if (boardsLoading) return;
    boardsLoading = true;
    busyStart();
    var path = '/network/boards' + (force ? '?refresh=1' : '');
    request(path).then(function (res) {
      renderBoards({ status: 'ok', model: buildBoardsModel(res) });
    }).catch(function (err) {
      renderBoards({
        status: 'error',
        notFound: err && err.status === 404,
        message: (err && err.message) || 'The network API did not respond.'
      });
    }).then(function () {
      boardsLoading = false;
      busyEnd();
    });
  }

  /* ---------- portable reputation: GET /api/network/reputation?agent=NAME ---------- */
  var repSeq = 0;
  var REP_ROLES = { merchant: 'Merchant', buyer_agent: 'Buyer agent' };

  function repDate(iso) {
    if (S.dateFmt) {
      var out = S.dateFmt(iso);
      if (out && out !== '—') return out;
    }
    return text(iso);
  }
  function hasOwn(obj, name) { return Object.prototype.hasOwnProperty.call(obj, name); }
  function flagOn(value) {
    if (value === true) return true;
    if (typeof value === 'number') return value > 0;
    if (typeof value === 'string') {
      var s = value.trim().toLowerCase();
      return Boolean(s) && s !== 'false' && s !== '0' && s !== 'null';
    }
    if (value && typeof value === 'object') return true;
    return false;
  }
  function flagInfo(value) {
    var info = { at: null, reason: null };
    if (!value) return info;
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}/.test(value.trim())) info.at = value.trim();
      else info.reason = value.trim();
      return info;
    }
    if (typeof value === 'object') {
      info.at = value.at || value.revoked_at || value.expired_at || value.timestamp || null;
      info.reason = text(value.reason || value.revoke_reason || value.revocation_reason || value.revoked_reason || value.why) || null;
    }
    return info;
  }
  /* Receipt lifecycle: backend marks revoked/expired (boolean or metadata object);
     counts from the API already exclude them, but local fallbacks must too. */
  function receiptLifecycle(receipt) {
    receipt = receipt && typeof receipt === 'object' ? receipt : {};
    var revoked = false;
    if (hasOwn(receipt, 'revoked')) revoked = flagOn(receipt.revoked);
    else if (receipt.revoked_at) revoked = true;
    var expired = false;
    if (hasOwn(receipt, 'expired')) expired = flagOn(receipt.expired);
    else if (receipt.expires_at) {
      var expiresAt = Date.parse(receipt.expires_at);
      if (isFinite(expiresAt) && expiresAt <= Date.now()) expired = true;
    }
    if (revoked) expired = false;
    var info = revoked ? flagInfo(receipt.revoked) : (expired ? flagInfo(receipt.expired) : { at: null, reason: null });
    return {
      revoked: revoked,
      expired: expired,
      state: revoked ? 'revoked' : expired ? 'expired' : 'valid',
      at: info.at || (revoked ? (receipt.revoked_at || null) : (expired ? (receipt.expired_at || receipt.effective_expires_at || receipt.expires_at || null) : null)),
      reason: info.reason || text(receipt.revocation_reason || receipt.revoke_reason || receipt.revoked_reason) || null
    };
  }
  function isActiveReceipt(receipt) {
    if (receipt && typeof receipt === 'object' && typeof receipt.valid === 'boolean') return receipt.valid === true;
    var life = receiptLifecycle(receipt);
    return !life.revoked && !life.expired;
  }
  function lifecycleCounts(receipts) {
    var out = { revoked: 0, expired: 0, active: 0 };
    (Array.isArray(receipts) ? receipts : []).forEach(function (receipt) {
      var life = receiptLifecycle(receipt);
      if (life.revoked) out.revoked += 1;
      else if (life.expired) out.expired += 1;
      else out.active += 1;
    });
    return out;
  }
  function buildReputationModel(res) {
    res = res && typeof res === 'object' ? res : {};
    var nodes = Array.isArray(res.nodes) ? res.nodes : [];
    var receipts = [];
    nodes.forEach(function (entry) {
      if (entry && Array.isArray(entry.receipts)) receipts = receipts.concat(entry.receipts);
    });
    var total = typeof res.count === 'number' ? res.count : receipts.length;
    var verified = typeof res.verified_count === 'number' ? res.verified_count : receipts.filter(function (r) {
      return r && r.verified === true && isActiveReceipt(r);
    }).length;
    var unverified = typeof res.unverified_count === 'number' ? res.unverified_count : receipts.filter(function (r) {
      return r && r.verified !== true && isActiveReceipt(r);
    }).length;
    var lifecycle = lifecycleCounts(receipts);
    var revokedCount = typeof res.revoked_count === 'number' ? res.revoked_count : lifecycle.revoked;
    var expiredCount = typeof res.expired_count === 'number' ? res.expired_count : lifecycle.expired;
    return {
      agent: text(res.agent),
      nodes: nodes,
      count: total,
      verifiedCount: verified,
      unverifiedCount: unverified,
      revokedCount: revokedCount,
      expiredCount: expiredCount
    };
  }
  function repReceipt(receipt) {
    var life = receiptLifecycle(receipt);
    var verified = receipt.verified === true;
    // Lifecycle wins the primary badge (Revoked > Expired); crypto status is
    // shown as a separate meta fact so a revoked-but-signed receipt stays clear.
    var badge;
    if (life.revoked) badge = '<span class="net-rep-badge revoked">Revoked</span>';
    else if (life.expired) badge = '<span class="net-rep-badge expired">Expired</span>';
    else if (verified) badge = '<span class="net-rep-badge ok">Verified</span>';
    else badge = '<span class="net-rep-badge bad">Unverified</span>';
    var role = REP_ROLES[text(receipt.role)] || text(receipt.role) || 'Receipt';
    var meta = [];
    if (receipt.issuer_network_id) meta.push('Issuer <b>' + esc(receipt.issuer_network_id) + '</b>');
    if (receipt.post_id) meta.push('Post <code>' + esc(receipt.post_id) + '</code>');
    if (receipt.issued_at) meta.push(esc(repDate(receipt.issued_at)));
    var plainReason = text(receipt.reason).toLowerCase();
    if (life.revoked) {
      var revokedText = life.at ? 'revoked ' + esc(repDate(life.at)) : 'revoked';
      var revokedBits = [revokedText];
      if (life.reason) revokedBits.push(esc(life.reason));
      meta.push('<span class="net-rep-lifecycle">' + revokedBits.join(' · ') + '</span>');
    } else if (life.expired) {
      meta.push('<span class="net-rep-lifecycle expired">expired' + (life.at ? ' ' + esc(repDate(life.at)) : '') + '</span>');
    }
    if (life.revoked || life.expired) {
      if (verified) {
        meta.push('signature verified');
      } else {
        meta.push('<span class="net-rep-reason">signature invalid' + (receipt.reason && plainReason !== 'revoked' && plainReason !== 'expired' ? ': ' + esc(receipt.reason) : '') + '</span>');
      }
    } else if (!verified && receipt.reason && plainReason !== 'revoked' && plainReason !== 'expired') {
      meta.push('<span class="net-rep-reason">' + esc(receipt.reason) + '</span>');
    }
    var cls = 'net-rep-receipt' + (life.revoked ? ' is-revoked' : life.expired ? ' is-expired' : '');
    return '<div class="' + cls + '">' +
      '<div class="net-rep-receipt-top">' + badge +
        '<span class="net-rep-subject">' + esc(text(receipt.subject_agent) || '(unnamed agent)') + '</span>' +
        '<span class="net-rep-role">' + esc(role) + '</span>' +
        '<span class="net-rep-outcome">' + esc(text(receipt.outcome) || 'settled') + '</span>' +
      '</div>' +
      '<div class="net-rep-receipt-meta">' + meta.join(' · ') + '</div>' +
    '</div>';
  }
  function repNodeEntry(entry) {
    entry = entry && typeof entry === 'object' ? entry : {};
    var node = entry.node && typeof entry.node === 'object' ? entry.node : {};
    var receipts = Array.isArray(entry.receipts) ? entry.receipts : [];
    var count = typeof entry.count === 'number' ? entry.count : receipts.length;
    var verified = typeof entry.verified_count === 'number' ? entry.verified_count : receipts.filter(function (r) { return r && r.verified === true && isActiveReceipt(r); }).length;
    var unverified = typeof entry.unverified_count === 'number' ? entry.unverified_count : receipts.filter(function (r) { return r && r.verified !== true && isActiveReceipt(r); }).length;
    var life = lifecycleCounts(receipts);
    var revokedCount = typeof entry.revoked_count === 'number' ? entry.revoked_count : life.revoked;
    var expiredCount = typeof entry.expired_count === 'number' ? entry.expired_count : life.expired;
    var name = text(node.name) || text(node.network_id) || 'Unnamed node';
    var meta = node.network_id ? 'Network <b>' + esc(node.network_id) + '</b>' : 'Network ID unknown';
    if (node.public_url) {
      meta += ' · <a href="' + esc(node.public_url) + '" target="_blank" rel="noopener">' +
        esc(stripSlash(node.public_url).replace(/^https?:\/\//i, '')) + '</a>';
    }
    var head = '<div class="net-rep-node-head">' +
      '<div class="net-rep-node-id">' +
        '<h3 class="net-rep-node-name">' + esc(name) + (node.self === true ? ' <span class="net-badge">This node</span>' : '') + '</h3>' +
        '<div class="net-rep-node-meta">' + meta + '</div>' +
      '</div>' +
      '<div class="net-rep-counts">' +
        '<span class="net-rep-count">' + count + ' receipt' + (count === 1 ? '' : 's') + '</span>' +
        '<span class="net-rep-count ok">' + verified + ' verified</span>' +
        (unverified ? '<span class="net-rep-count bad">' + unverified + ' unverified</span>' : '') +
        (revokedCount ? '<span class="net-rep-count warn">' + revokedCount + ' revoked</span>' : '') +
        (expiredCount ? '<span class="net-rep-count warn">' + expiredCount + ' expired</span>' : '') +
        (entry.reachable === false ? '<span class="net-rep-count bad">Unreachable</span>' : '') +
      '</div>' +
    '</div>';
    var body;
    if (entry.reachable === false) {
      body = '<div class="net-rep-no-receipts">Peer could not be reached' + (entry.error ? ': ' + esc(entry.error) : '.') + '</div>';
    } else if (!receipts.length) {
      body = '<div class="net-rep-no-receipts">No receipts for this agent on this node.</div>';
    } else {
      body = '<div class="net-rep-receipts">' + receipts.map(repReceipt).join('') + '</div>';
    }
    return '<div class="net-rep-node">' + head + body + '</div>';
  }
  function renderReputation(state) {
    var host = $('netRepResults');
    var count = $('netRepCount');
    if (!host) return;
    if (state.status === 'idle') {
      host.innerHTML = '<div class="net-rep-empty">Enter an agent name to see portable receipts.</div>';
      if (count) count.textContent = 'Look up an agent';
      return;
    }
    if (state.status === 'loading') {
      host.innerHTML = '<div class="net-rep-empty">Looking up receipts for ' + esc(state.agent) + '…</div>';
      if (count) count.textContent = 'Searching…';
      return;
    }
    if (state.status === 'disabled' || state.status === 'error') {
      if (count) count.textContent = 'Unavailable';
      var body = state.status === 'disabled'
        ? '<b>Feature disabled.</b> Portable reputation is turned off on this node (experimental federation feature).'
        : '<b>Couldn’t load receipts.</b> ' + esc(state.message || 'The reputation API did not respond.');
      host.innerHTML = '<div class="net-rep-error"><div>' + body + '</div>' +
        '<button class="btn btn-ghost btn-sm" id="netRepRetry" type="button">Retry</button></div>';
      var retry = $('netRepRetry');
      if (retry) retry.addEventListener('click', function () { loadReputation(state.agent, true); });
      return;
    }
    var model = state.model;
    if (!model.nodes.length) {
      if (count) count.textContent = 'No nodes answered';
      host.innerHTML = '<div class="net-rep-empty">No nodes answered the lookup for ' + esc(state.agent) + '.</div>';
      return;
    }
    if (count) {
      count.textContent = model.count + ' receipt' + (model.count === 1 ? '' : 's') +
        ' · ' + model.verifiedCount + ' verified' +
        (model.revokedCount ? ' · ' + model.revokedCount + ' revoked' : '') +
        (model.expiredCount ? ' · ' + model.expiredCount + ' expired' : '');
    }
    var summary = '<div class="net-rep-summary">' +
      '<span class="net-rep-count">' + model.count + ' receipt' + (model.count === 1 ? '' : 's') + '</span>' +
      '<span class="net-rep-count ok">' + model.verifiedCount + ' verified</span>' +
      (model.unverifiedCount ? '<span class="net-rep-count bad">' + model.unverifiedCount + ' unverified</span>' : '') +
      (model.revokedCount ? '<span class="net-rep-count warn">' + model.revokedCount + ' revoked</span>' : '') +
      (model.expiredCount ? '<span class="net-rep-count warn">' + model.expiredCount + ' expired</span>' : '') +
      '<span>across ' + model.nodes.length + ' node' + (model.nodes.length === 1 ? '' : 's') + ' for ' + esc(model.agent || state.agent) + '</span>' +
    '</div>';
    host.innerHTML = summary + model.nodes.map(repNodeEntry).join('');
  }
  function loadReputation(agentValue, force) {
    var agent = text(agentValue);
    if (!agent) {
      renderReputation({ status: 'idle' });
      var input = $('netRepAgent');
      if (input) input.focus();
      return;
    }
    var seq = ++repSeq;
    renderReputation({ status: 'loading', agent: agent });
    var path = '/network/reputation?agent=' + encodeURIComponent(agent) + (force ? '&refresh=1' : '');
    request(path).then(function (res) {
      if (seq !== repSeq) return;
      renderReputation({ status: 'ok', agent: agent, model: buildReputationModel(res) });
    }).catch(function (err) {
      if (seq !== repSeq) return;
      if (err && err.status === 404) renderReputation({ status: 'disabled', agent: agent });
      else renderReputation({ status: 'error', agent: agent, message: (err && err.message) || 'The reputation API did not respond.' });
    });
  }

  /* ---------- signed cross-node handoff: POST /api/network/handoff ---------- */
  var handoffTimer = null;
  function showHandoffNote(html, ok) {
    var note = $('netHandoffNote');
    if (!note) return;
    note.hidden = false;
    note.className = 'net-handoff-note' + (ok ? ' ok' : '');
    note.innerHTML = html;
    if (handoffTimer) clearTimeout(handoffTimer);
    handoffTimer = setTimeout(function () { note.hidden = true; note.innerHTML = ''; }, ok ? 4500 : 10000);
  }
  function doHandoff(btn) {
    var postId = btn.getAttribute('data-handoff-post') || '';
    var target = btn.getAttribute('data-handoff-target') || '';
    var nodeName = btn.getAttribute('data-handoff-node') || 'that node';
    var itemHref = safeUrl(btn.getAttribute('data-handoff-item') || '');
    if (!postId || !target) return;
    if (!participantKey()) {
      showHandoffNote('<b>Join the Exchange to hand off a post.</b> A signed handoff needs a participant API key — <a href="register.html">register a participant</a> first.', false);
      return;
    }
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Signing…';
    request('/network/handoff', { method: 'POST', body: { post_id: postId, target_url: target } }).then(function (res) {
      var envelope = res && res.handoff ? res.handoff : null;
      var itemUrl = safeUrl((envelope && envelope.item_url) || (res && res.item_url));
      if (itemUrl) {
        showHandoffNote('<b>Handoff signed.</b> Opening the item on ' + esc(nodeName) + '…', true);
        window.open(itemUrl, '_blank', 'noopener');
      } else {
        showHandoffNote('<b>Handoff signed.</b> ' +
          (envelope && envelope.handoff_id ? 'Envelope <code>' + esc(envelope.handoff_id) + '</code> created.' : 'Signed envelope created.'), true);
      }
      btn.textContent = 'Handed off ✓';
      setTimeout(function () { btn.disabled = false; btn.textContent = original; }, 1800);
    }).catch(function (err) {
      var code = err && err.code;
      var message;
      if (code === 'REGISTRATION_REQUIRED' || (err && err.status === 401)) {
        message = '<b>Join the Exchange to hand off a post.</b> <a href="register.html">Register a participant</a> and try again.';
      } else if (code === 'POST_NOT_FOUND') {
        message = '<b>This post isn’t hosted on this node.</b> Handoffs can only be signed by the node that hosts the post (<code>' + esc(postId) + '</code>).' +
          (itemHref ? ' <a href="' + esc(itemHref) + '" target="_blank" rel="noopener">Open the remote offer ↗</a>' : '');
      } else if (err && err.status === 404) {
        message = '<b>Handoffs are disabled on this node.</b> The experimental federation feature is turned off here.';
      } else {
        message = '<b>Handoff failed.</b> ' + esc((err && err.message) || 'The node did not respond.');
      }
      showHandoffNote(message, false);
      btn.disabled = false;
      btn.textContent = original;
    });
  }

  /* ---------- wiring ---------- */
  if (refreshBtn) refreshBtn.addEventListener('click', function () { load(true); loadBoards(true); });
  var repForm = $('netRepForm');
  if (repForm) {
    repForm.addEventListener('submit', function (e) {
      e.preventDefault();
      loadReputation($('netRepAgent') ? $('netRepAgent').value : '', false);
    });
  }
  try {
    var agentParam = new URLSearchParams(window.location.search).get('agent');
    if (agentParam && $('netRepAgent')) {
      $('netRepAgent').value = agentParam;
      loadReputation(agentParam, false);
    }
  } catch (e) {}
  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var handoffBtn = target.closest('[data-handoff-post]');
    if (handoffBtn) { e.preventDefault(); doHandoff(handoffBtn); return; }
    var btn = target.closest('#netCopySeeds, #netEmptyCopy');
    if (!btn) return;
    var code = $('netSeedsCode');
    copy(code ? code.textContent : SEEDS_TEMPLATE);
  });

  load(false);
  loadBoards(false);
})();
