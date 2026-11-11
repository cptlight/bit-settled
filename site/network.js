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

  function request(path) {
    if (S.api) return S.api(path);
    var url = stripSlash(base) + path;
    return fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) {
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

  function load(force) {
    if (loading) return;
    loading = true;
    setBusy(true);
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
      setBusy(false);
    });
  }

  /* ---------- wiring ---------- */
  if (refreshBtn) refreshBtn.addEventListener('click', function () { load(true); });
  document.addEventListener('click', function (e) {
    var target = e.target;
    var btn = target && target.closest ? target.closest('#netCopySeeds, #netEmptyCopy') : null;
    if (!btn) return;
    var code = $('netSeedsCode');
    copy(code ? code.textContent : SEEDS_TEMPLATE);
  });

  load(false);
})();
