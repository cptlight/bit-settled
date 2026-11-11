/* Moderation admin console — review open reports, hide or restore posts.
   Admin key lives in sessionStorage only (never localStorage) and is sent as
   x-admin-key. Endpoints:
     GET  /api/moderation/queue?status=open
     POST /api/moderation/posts/:id/hide
     POST /api/moderation/posts/:id/restore
   The page degrades cleanly when moderation is disabled (404) or the key is
   rejected (401/403). */
(function () {
  'use strict';
  var S = window.Settled || {};
  var $ = function (id) { return document.getElementById(id); };
  var base = window.SETTLED_API_BASE || '/api';
  var SESSION_KEY = 'bitsettled_admin_key';
  var key = readStoredKey();
  var hiddenOverrides = {};
  var loading = false;
  var view = 'open';
  var hiddenCount = 0;
  var noticeTimer = null;

  /* ---------- helpers ---------- */
  function esc(v) {
    if (S.esc) return S.esc(v);
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function text(v) { return String(v === null || v === undefined ? '' : v).trim(); }
  function stripSlash(u) { return String(u || '').replace(/\/+$/, ''); }
  function maskKey(value) {
    var k = text(value);
    return k ? '…' + k.slice(-4) : '';
  }
  function ago(iso) {
    if (!iso) return '';
    if (S.timeAgo) {
      var out = S.timeAgo(iso);
      if (out) return out;
    }
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function readStoredKey() {
    try { return text(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return ''; }
  }
  function storeKey(value) {
    try { sessionStorage.setItem(SESSION_KEY, value); } catch (e) {}
  }
  function clearStoredKey() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  function adminFetch(path, options) {
    options = options || {};
    var init = { method: (options.method || 'GET'), headers: { accept: 'application/json' }, credentials: 'same-origin' };
    if (key) init.headers['x-admin-key'] = key;
    if (options.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    return fetch(stripSlash(base) + path, init).then(function (res) {
      return res.text().then(function (raw) {
        var data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) {}
        if (!res.ok) {
          var err = new Error((data && data.error && data.error.message) || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          err.code = (data && data.error && data.error.code) || 'http_error';
          err.data = data;
          var retry = res.headers && res.headers.get ? Number(res.headers.get('retry-after')) : 0;
          if (isFinite(retry) && retry > 0) err.retryAfter = retry;
          throw err;
        }
        return data;
      });
    }, function () {
      var err = new Error('Can’t reach the Settled API. Start the node and reload.');
      err.status = 0;
      err.code = 'network';
      throw err;
    });
  }

  /* ---------- queue normalisation (tolerant of {reports|items|queue}) ---------- */
  function normalizeReport(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var src = raw.report && typeof raw.report === 'object' ? raw.report : raw;
    var post = raw.post && typeof raw.post === 'object' ? raw.post
      : (src.post && typeof src.post === 'object' ? src.post : null);
    var postId = text(src.post_id || src.postId || raw.post_id || (post && post.id));
    if (!postId) return null;
    var reporter = src.reporter !== undefined ? src.reporter : raw.reporter;
    var reporterLabel = '';
    if (typeof reporter === 'string') reporterLabel = text(reporter);
    else if (reporter && typeof reporter === 'object') {
      reporterLabel = text(reporter.display_name || reporter.agent_name || reporter.account_id || reporter.role);
    }
    return {
      reportId: text(src.id || src.report_id || raw.report_id),
      postId: postId,
      reason: text(src.reason || raw.reason) || 'No reason given',
      status: text(src.status || raw.status) || 'open',
      createdAt: src.created_at || raw.created_at || null,
      reporter: reporterLabel,
      post: post ? {
        id: text(post.id) || postId,
        title: text(post.title),
        author: text((post.merchant && post.merchant.name) || post.author || post.merchant_name),
        category: text(post.category || post.board),
        status: text(post.status),
        hidden: post.hidden === true || post.hidden === 1 || post.hidden === 'true' || post.moderated === true
      } : null
    };
  }
  function normalizeHiddenPost(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var post = raw.post && typeof raw.post === 'object' ? raw.post : raw;
    var postId = text(post.id || post.post_id || raw.post_id);
    if (!postId) return null;
    return {
      postId: postId,
      hiddenAt: post.hidden_at || raw.hidden_at || null,
      reason: text(post.reason || raw.reason),
      post: {
        id: postId,
        title: text(post.title),
        author: text((post.merchant && post.merchant.name) || post.author || post.merchant_name),
        category: text(post.category || post.board),
        status: text(post.status),
        hidden: true
      }
    };
  }
  function buildHiddenModel(res) {
    res = res && typeof res === 'object' ? res : {};
    var raw = Array.isArray(res.posts) ? res.posts
      : Array.isArray(res.reports) ? res.reports
        : Array.isArray(res.items) ? res.items : [];
    var groups = raw.map(normalizeHiddenPost).filter(Boolean);
    var seen = {};
    groups = groups.filter(function (group) {
      if (seen[group.postId]) return false;
      seen[group.postId] = true;
      return true;
    });
    return {
      groups: groups,
      count: typeof res.count === 'number' ? res.count : groups.length
    };
  }
  function buildQueueModel(res) {
    res = res && typeof res === 'object' ? res : {};
    var raw = Array.isArray(res.reports) ? res.reports
      : Array.isArray(res.items) ? res.items
        : Array.isArray(res.queue) ? res.queue
          : Array.isArray(res) ? res : [];
    var reports = raw.map(normalizeReport).filter(Boolean);
    var groups = [];
    var byId = {};
    reports.forEach(function (report) {
      var group = byId[report.postId];
      if (!group) {
        group = { postId: report.postId, reports: [], post: report.post };
        byId[report.postId] = group;
        groups.push(group);
      }
      group.reports.push(report);
      if (!group.post && report.post) group.post = report.post;
    });
    return {
      groups: groups,
      reportCount: typeof res.count === 'number' ? res.count : reports.length,
      status: text(res.status) || 'open'
    };
  }
  function isHidden(group) {
    if (Object.prototype.hasOwnProperty.call(hiddenOverrides, group.postId)) return hiddenOverrides[group.postId];
    return Boolean(group.post && group.post.hidden);
  }
  function actionButtons(postId, hidden) {
    if (hidden) {
      return '<button class="btn btn-primary btn-sm mod-act" type="button" data-mod-action="restore" data-post-id="' + esc(postId) + '">Restore post</button>';
    }
    return '<button class="btn btn-ghost btn-sm mod-act" type="button" data-mod-action="hide" data-post-id="' + esc(postId) + '">Hide post</button>';
  }

  /* ---------- render ---------- */
  function setKeyStatus(label, cls) {
    var chip = $('modKeyStatus');
    if (!chip) return;
    chip.textContent = label;
    chip.className = 'mod-chip' + (cls ? ' ' + cls : '');
  }
  function setError(html) {
    var box = $('modError');
    if (!box) return;
    if (!html) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<div>' + html + '</div>';
  }
  function setNote(html) {
    var note = $('modKeyNote');
    if (note) note.innerHTML = html;
  }
  function setNotice(html, ok) {
    var box = $('modNotice');
    if (!box) return;
    box.hidden = !html;
    box.className = 'mod-notice' + (ok === false ? ' bad' : '');
    box.innerHTML = html || '';
    if (noticeTimer) clearTimeout(noticeTimer);
    if (html) noticeTimer = setTimeout(function () { box.hidden = true; box.innerHTML = ''; }, 7000);
  }
  function setTabs() {
    var open = $('modTabOpen');
    var hidden = $('modTabHidden');
    if (open) {
      open.classList.toggle('is-active', view === 'open');
      open.setAttribute('aria-selected', view === 'open' ? 'true' : 'false');
    }
    if (hidden) {
      hidden.classList.toggle('is-active', view === 'hidden');
      hidden.setAttribute('aria-selected', view === 'hidden' ? 'true' : 'false');
      hidden.textContent = 'Hidden posts' + (hiddenCount ? ' · ' + hiddenCount : '');
    }
  }
  function setHiddenCount(value) {
    hiddenCount = isFinite(value) && value >= 0 ? value : 0;
    setTabs();
  }
  function setFormVisible(visible) {
    var form = $('modKeyForm');
    var signOut = $('modSignOut');
    if (form) form.hidden = !visible;
    if (signOut) signOut.hidden = visible;
    var unlock = $('modUnlock');
    if (unlock) unlock.disabled = !visible;
  }
  function renderLocked(message) {
    setKeyStatus('Not unlocked');
    setFormVisible(true);
    setError('');
    var count = $('modCount');
    if (count) count.textContent = 'Locked';
    var host = $('modQueue');
    if (host) {
      host.innerHTML = '<div class="mod-empty">' + (message
        ? esc(message)
        : 'Unlock the queue with the admin key to review reports.') + '</div>';
    }
  }
  function renderAuthError(message) {
    key = '';
    clearStoredKey();
    setKeyStatus('Key rejected', 'bad');
    setFormVisible(true);
    setError('<b>Admin key rejected.</b> ' + esc(message || 'Check ADMIN_API_KEY on the server and try again.'));
    var input = $('modKey');
    if (input) { input.value = ''; input.focus(); }
    var count = $('modCount');
    if (count) count.textContent = 'Locked';
    var host = $('modQueue');
    if (host) host.innerHTML = '<div class="mod-empty">The queue is locked until a valid admin key is entered.</div>';
  }
  function showUnlocked() {
    setKeyStatus('Unlocked · key ' + maskKey(key), 'ok');
    setFormVisible(false);
    setError('');
    setNote('Session only — closing this tab clears the key. It is never written to localStorage or shown in the URL.');
  }
  function renderDisabled() {
    key = '';
    clearStoredKey();
    setKeyStatus('Disabled', 'bad');
    setFormVisible(true);
    setError('');
    setNote('Moderation is disabled on this node. Set <code>ADMIN_API_KEY</code> in the server environment, restart, then refresh this page.');
    var unlock = $('modUnlock');
    if (unlock) unlock.disabled = true;
    var count = $('modCount');
    if (count) count.textContent = 'Disabled';
    var host = $('modQueue');
    if (host) {
      host.innerHTML = '<div class="mod-empty"><b>Moderation is disabled on this node.</b> ' +
        'The queue returned <code>404</code>. Set <code>ADMIN_API_KEY</code> on the server and restart to enable reports and moderation actions.</div>';
    }
  }
  function renderLoading() {
    var count = $('modCount');
    if (count) count.textContent = 'Loading…';
    var host = $('modQueue');
    if (host) {
      host.innerHTML = '<div class="panel mod-skel">Loading the moderation ' +
        (view === 'hidden' ? 'hidden posts' : 'queue') + '…</div>';
    }
  }
  function renderError(err) {
    var count = $('modCount');
    if (count) count.textContent = 'Unavailable';
    var message = (err && err.message) || 'The moderation API did not respond.';
    if (err && err.status === 429) message = 'Rate limited — try again in ' + (err.retryAfter || 60) + 's.';
    setError('<b>Couldn’t load the queue.</b> ' + esc(message) +
      ' <button class="btn btn-ghost btn-sm" id="modRetry" type="button">Retry</button>');
    var retry = $('modRetry');
    if (retry) retry.addEventListener('click', function () { loadQueue(); });
    var host = $('modQueue');
    if (host) host.innerHTML = '<div class="mod-empty">The queue could not be loaded. Use Retry above.</div>';
  }
  function renderEmpty() {
    var count = $('modCount');
    if (count) count.textContent = view === 'hidden' ? 'None hidden' : 'Clear';
    var host = $('modQueue');
    if (!host) return;
    host.innerHTML = view === 'hidden'
      ? '<div class="mod-empty"><b>No hidden posts.</b> Posts you hide from the open queue will appear here with a Restore action. ' +
        '<button class="btn btn-ghost btn-sm" id="modEmptyRefresh" type="button">Refresh</button></div>'
      : '<div class="mod-empty"><b>Queue is clear.</b> No open reports right now. ' +
        '<button class="btn btn-ghost btn-sm" id="modEmptyRefresh" type="button">Refresh</button></div>';
    var refresh = $('modEmptyRefresh');
    if (refresh) refresh.addEventListener('click', function () { loadQueue(); });
  }
  function cardHtml(group) {
    var post = group.post || {};
    var hidden = isHidden(group);
    var title = post.title || '(post details unavailable)';
    var metaParts = [];
    if (post.author) metaParts.push(esc(post.author));
    if (post.category) metaParts.push(esc(post.category));
    if (post.status) metaParts.push('status ' + esc(post.status));
    if (hidden) metaParts.push('hidden from the public board');
    var reasons = group.reports.map(function (report) {
      var facts = [];
      if (report.reporter) facts.push('by ' + esc(report.reporter));
      if (report.reportId) facts.push('report ' + esc(report.reportId));
      if (report.createdAt) facts.push(ago(report.createdAt));
      if (report.status) facts.push('status ' + esc(report.status));
      return '<li class="mod-reason"><b>' + esc(report.reason) + '</b>' +
        (facts.length ? ' <span class="mod-reason-meta">' + facts.join(' · ') + '</span>' : '') + '</li>';
    }).join('');
    return '<article class="panel mod-card' + (hidden ? ' is-hidden' : '') + '" data-post-id="' + esc(group.postId) + '">' +
      '<div class="mod-card-head">' +
        '<div class="mod-card-main">' +
          '<div class="mod-card-kicker">Post <code>' + esc(post.id || group.postId) + '</code>' +
            '<span class="mod-state ' + (hidden ? 'hidden' : 'visible') + '" data-mod-hidden-chip>' + (hidden ? 'Hidden' : 'Visible') + '</span>' +
            '<span>' + group.reports.length + ' report' + (group.reports.length === 1 ? '' : 's') + '</span>' +
          '</div>' +
          '<h3 class="mod-card-title">' + esc(title) + '</h3>' +
          (metaParts.length ? '<div class="mod-card-meta">' + metaParts.join(' · ') + '</div>' : '') +
        '</div>' +
        '<div class="mod-card-actions">' + actionButtons(group.postId, hidden) + '</div>' +
      '</div>' +
      '<ul class="mod-reasons">' + reasons + '</ul>' +
      '<div class="mod-card-status" aria-live="polite"></div>' +
    '</article>';
  }
  function renderList(model) {
    var count = $('modCount');
    if (count) {
      count.textContent = model.reportCount + ' report' + (model.reportCount === 1 ? '' : 's') +
        ' · ' + model.groups.length + ' post' + (model.groups.length === 1 ? '' : 's');
    }
    var host = $('modQueue');
    if (host) host.innerHTML = model.groups.map(cardHtml).join('');
  }
  function hiddenCardHtml(group) {
    var post = group.post || {};
    var title = post.title || '(post details unavailable)';
    var metaParts = [];
    if (post.author) metaParts.push(esc(post.author));
    if (post.category) metaParts.push(esc(post.category));
    if (post.status) metaParts.push('status ' + esc(post.status));
    var when = group.hiddenAt ? ago(group.hiddenAt) : '';
    return '<article class="panel mod-card is-hidden" data-post-id="' + esc(group.postId) + '">' +
      '<div class="mod-card-head">' +
        '<div class="mod-card-main">' +
          '<div class="mod-card-kicker">Post <code>' + esc(post.id || group.postId) + '</code>' +
            '<span class="mod-state hidden" data-mod-hidden-chip>Hidden</span>' +
            (when ? '<span>hidden ' + esc(when) + '</span>' : '') +
          '</div>' +
          '<h3 class="mod-card-title">' + esc(title) + '</h3>' +
          (metaParts.length ? '<div class="mod-card-meta">' + metaParts.join(' · ') + '</div>' : '') +
        '</div>' +
        '<div class="mod-card-actions">' + actionButtons(group.postId, true) + '</div>' +
      '</div>' +
      (group.reason
        ? '<ul class="mod-reasons"><li class="mod-reason"><b>' + esc(group.reason) + '</b>' +
          (when ? ' <span class="mod-reason-meta">' + esc(when) + '</span>' : '') + '</li></ul>'
        : '') +
      '<div class="mod-card-status" aria-live="polite"></div>' +
    '</article>';
  }
  function renderHiddenList(model) {
    var count = $('modCount');
    if (count) count.textContent = model.count + ' hidden post' + (model.count === 1 ? '' : 's');
    setHiddenCount(model.count);
    var host = $('modQueue');
    if (host) host.innerHTML = model.groups.map(hiddenCardHtml).join('');
  }

  /* ---------- data flow ---------- */
  function loadQueue() {
    if (!key) { renderLocked(); return; }
    if (loading) return;
    loading = true;
    setTabs();
    renderLoading();
    adminFetch('/moderation/queue?status=' + (view === 'hidden' ? 'hidden' : 'open')).then(function (res) {
      storeKey(key);
      setHiddenCount(res && typeof res.hidden_count === 'number' ? res.hidden_count : hiddenCount);
      showUnlocked();
      if (view === 'hidden') {
        var hiddenModel = buildHiddenModel(res);
        if (!hiddenModel.groups.length) renderEmpty();
        else renderHiddenList(hiddenModel);
      } else {
        var model = buildQueueModel(res);
        if (!model.groups.length) renderEmpty();
        else renderList(model);
      }
    }).catch(function (err) {
      if (err.status === 401 || err.status === 403) renderAuthError('Check ADMIN_API_KEY on the server and unlock again.');
      else if (err.status === 404 && err.code === 'MODERATION_DISABLED') renderDisabled();
      else if (err.status === 404) renderDisabled();
      else renderError(err);
    }).then(function () { loading = false; });
  }
  function setCardBusy(card, busy) {
    if (!card) return;
    Array.prototype.forEach.call(card.querySelectorAll('[data-mod-action]'), function (btn) { btn.disabled = busy; });
  }
  function refreshCard(card, postId) {
    if (!card) return;
    var hidden = isHidden({ postId: postId, post: null });
    card.classList.toggle('is-hidden', hidden);
    var chip = card.querySelector('[data-mod-hidden-chip]');
    if (chip) {
      chip.textContent = hidden ? 'Hidden' : 'Visible';
      chip.className = 'mod-state ' + (hidden ? 'hidden' : 'visible');
    }
    var actions = card.querySelector('.mod-card-actions');
    if (actions) actions.innerHTML = actionButtons(postId, hidden);
  }
  function runAction(btn) {
    var postId = text(btn.getAttribute('data-post-id'));
    var action = text(btn.getAttribute('data-mod-action'));
    if (!postId || (action !== 'hide' && action !== 'restore')) return;
    if (!key) { renderLocked('Unlock the queue with the admin key before moderating.'); return; }
    var card = btn.closest ? btn.closest('.mod-card') : null;
    var status = card ? card.querySelector('.mod-card-status') : null;
    var original = btn.textContent;
    setCardBusy(card, true);
    btn.textContent = action === 'hide' ? 'Hiding…' : 'Restoring…';
    adminFetch('/moderation/posts/' + encodeURIComponent(postId) + '/' + action, { method: 'POST' }).then(function (res) {
      var nowHidden = res && typeof res.hidden === 'boolean' ? res.hidden : action === 'hide';
      hiddenOverrides[postId] = nowHidden;
      if (view === 'hidden') {
        if (card && card.parentNode) card.parentNode.removeChild(card);
        var host = $('modQueue');
        var remaining = host && host.querySelectorAll ? host.querySelectorAll('.mod-card').length : 0;
        var count = $('modCount');
        if (count) count.textContent = remaining + ' hidden post' + (remaining === 1 ? '' : 's');
        setHiddenCount(remaining);
        setNotice('<b>Post restored.</b> It is visible on the public board again.', true);
        return;
      }
      if (status) {
        status.innerHTML = '<span class="mod-ok">' +
          (nowHidden ? 'Post hidden from the public board. Restore it from the Hidden posts tab.' : 'Post restored to the public board.') + '</span>';
      }
      refreshCard(card, postId);
    }).catch(function (err) {
      var message;
      if (err.status === 401 || err.status === 403) {
        renderAuthError('The admin key was rejected while ' + action + 'ing the post.');
        return;
      } else if (err.status === 404) {
        message = 'Reported post not found — it may have been removed, or moderation is disabled on this node.';
      } else if (err.status === 429) {
        message = 'Rate limited — try again in ' + (err.retryAfter || 60) + 's.';
      } else {
        message = (err && err.message) || 'The action failed.';
      }
      if (status) status.innerHTML = '<span class="mod-err">' + esc(message) + '</span>';
      btn.textContent = original;
      setCardBusy(card, false);
    });
  }

  /* ---------- wiring ---------- */
  var form = $('modKeyForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('modKey');
      var value = input ? text(input.value) : '';
      if (!value) {
        setError('<b>Enter the admin key first.</b> The queue requires <code>x-admin-key</code>.');
        if (input) input.focus();
        return;
      }
      key = value;
      setError('');
      loadQueue();
    });
  }
  var signOut = $('modSignOut');
  if (signOut) {
    signOut.addEventListener('click', function () {
      key = '';
      hiddenOverrides = {};
      view = 'open';
      setTabs();
      clearStoredKey();
      var input = $('modKey');
      if (input) input.value = '';
      setNotice('');
      renderLocked();
    });
  }
  var refresh = $('modRefresh');
  if (refresh) {
    refresh.addEventListener('click', function () {
      if (!key) { renderLocked('Enter the admin key to load the queue.'); return; }
      loadQueue();
    });
  }
  var tabOpen = $('modTabOpen');
  var tabHidden = $('modTabHidden');
  function switchView(next) {
    if (view === next) return;
    view = next;
    setNotice('');
    setError('');
    setTabs();
    if (!key) { renderLocked(next === 'hidden' ? 'Unlock the queue to list hidden posts.' : undefined); return; }
    loadQueue();
  }
  if (tabOpen) tabOpen.addEventListener('click', function () { switchView('open'); });
  if (tabHidden) tabHidden.addEventListener('click', function () { switchView('hidden'); });
  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var btn = target.closest('[data-mod-action]');
    if (!btn) return;
    e.preventDefault();
    runAction(btn);
  });

  setTabs();
  if (key) loadQueue();
  else renderLocked();
})();
