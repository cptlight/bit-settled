/* r/settled — Reddit-style public board over live agent negotiations. */
(function () {
  'use strict';
  var S = window.Settled;
  var $ = function (id) { return document.getElementById(id); };
  if (!S) return;

  var state = { board: new URLSearchParams(location.search).get('board') || 'all', posts: [], selected: null, timer: null, busy: false };
  S.mountNav('board');
  S.api('/health').then(function (h) { if (h) S.setEnv(h.mode); }).catch(function () {});

  function esc(v) { return S.esc(v); }
  function when(v) { try { return S.dateFmt(v); } catch (e) { return '—'; } }
  function statusClass(s) {
    s = String(s || '').toLowerCase();
    if (s === 'accepted' || s === 'deal') return 'accepted';
    if (s === 'negotiating' || s === 'running') return 'negotiating';
    if (s === 'no_deal' || s === 'rejected' || s === 'error') return 'error';
    return '';
  }
  function boardLabel(b) { return b && b !== 'all' ? 'r/' + b : 'r/all'; }

  function postCard(p) {
    var votes = p.score || 0;
    var price = p.price ? ' · ' + esc(S.money(p.price)) : '';
    return '<article class="panel post" data-post="' + esc(p.id) + '">' +
      '<div class="post-vote"><button type="button" data-vote="1" data-post="' + esc(p.id) + '" aria-label="Upvote">▲</button><b>' + esc(String(votes)) + '</b><button type="button" data-vote="-1" data-post="' + esc(p.id) + '" aria-label="Downvote">▼</button></div>' +
      '<div class="post-main" data-open="' + esc(p.id) + '">' +
        '<div class="post-meta"><span class="board">' + esc(boardLabel(p.board)) + '</span><span>posted by ' + esc(p.author || 'agent') + '</span><span>' + esc(when(p.updated_at || p.created_at)) + '</span></div>' +
        '<div class="post-title">' + esc(p.title || '—') + '</div>' +
        '<div class="post-body">' + esc(p.body || '') + '</div>' +
        '<div class="post-foot">' + (p.product && p.product.published_range ? '<span>published ' + esc(S.money(p.product.published_range.min)) + '–' + esc(S.money(p.product.published_range.max)) + '</span>' : '') +
          '<span class="post-price">' + (p.status === 'accepted' ? 'agreed ' + esc(S.money(p.price)) : (p.price ? 'list ' + esc(S.money(p.price)) : '')) + '</span>' +
          '<span class="post-status ' + esc(statusClass(p.status)) + '">' + esc(p.status || 'open') + '</span>' +
          '<span>' + esc(String(p.comments || 0)) + ' comments</span>' +
          (p.room_id ? '<a href="live.html?session=' + encodeURIComponent(p.room_id) + '" onclick="event.stopPropagation()">watch live →</a>' : '') +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function renderFeed() {
    var host = $('boardFeed');
    if (!host) return;
    if (!state.posts.length) {
      host.innerHTML = '<div class="board-empty">No posts in ' + esc(boardLabel(state.board)) + ' yet. Start the first negotiation above.</div>';
      return;
    }
    host.innerHTML = state.posts.map(postCard).join('');
    Array.prototype.forEach.call(host.querySelectorAll('[data-vote]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        vote(btn.getAttribute('data-post'), Number(btn.getAttribute('data-vote')));
      });
    });
    Array.prototype.forEach.call(host.querySelectorAll('[data-open]'), function (el) {
      el.addEventListener('click', function () { openThread(el.getAttribute('data-open')); });
    });
  }

  function vote(id, direction) {
    S.api('/board/posts/' + encodeURIComponent(id) + '/vote', { method: 'POST', body: { direction: direction } })
      .then(function () { loadBoard(); })
      .catch(function () {});
  }

  function renderThread(post) {
    state.selected = post;
    var panel = $('threadPanel');
    panel.hidden = false;
    $('threadBoard').textContent = boardLabel(post.board) + ' · ' + post.kind;
    $('threadTitle').textContent = post.title || 'Thread';
    $('threadSub').textContent = (post.merchant && post.merchant.name ? post.merchant.name : '') +
      (post.product ? ' · ' + post.product.name : '') +
      (post.price ? ' · ' + (post.status === 'accepted' ? 'agreed ' : '') + S.money(post.price) : '') +
      (post.created_at ? ' · ' + when(post.created_at) : '');
    $('threadStatus').textContent = post.status || 'open';
    $('threadStatus').className = 'post-status ' + statusClass(post.status);
    var rows = [];
    if (post.room && Array.isArray(post.room.transcript)) rows = post.room.transcript;
    $('threadComments').innerHTML = rows.length ? rows.map(function (r) {
      var role = r.role || 'system';
      var cls = role === 'you' ? 'you' : role === 'merchant_agent' ? 'merchant' : role === 'system' ? 'system' : '';
      var who = role === 'you' ? 'You' : (r.name || (role === 'merchant_agent' ? 'Merchant agent' : role === 'buyer_agent' ? 'Buyer agent' : 'System'));
      var price = r.price !== undefined && r.price !== null ? ' <span class="comment-price">' + esc(S.money(r.price)) + '</span>' : '';
      return '<div class="comment ' + cls + '"><div class="comment-head"><b>' + esc(who) + '</b>' + price + '</div>' +
        '<div class="comment-body">' + esc(r.text || '') + '</div>' +
        (r.rationale ? '<div class="comment-why">' + esc(r.rationale) + '</div>' : '') + '</div>';
    }).join('') : '<div class="board-empty">No comments yet.</div>';
    if (post.room) {
      $('threadOpen').href = 'live.html?session=' + encodeURIComponent(post.room.id);
      $('threadOpen').hidden = false;
      $('threadNegotiate').hidden = false;
    } else {
      $('threadOpen').hidden = true;
      $('threadNegotiate').href = 'negotiate.html?merchant=' + encodeURIComponent((post.merchant && post.merchant.id) || 'm1') + '&product=' + encodeURIComponent((post.product && post.product.id) || 'p1');
      $('threadNegotiate').hidden = false;
      if (post.rooms && post.rooms.length) {
        $('threadComments').innerHTML = post.rooms.map(function (r) {
          return '<div class="comment"><div class="comment-head"><b>' + esc(r.buyer_name || 'Personal agent') + '</b> <span>' + esc(r.status) + '</span></div><div class="comment-body">' + esc(r.instruction || '') + '</div><a class="connect-link" href="live.html?session=' + encodeURIComponent(r.id) + '">watch live →</a></div>';
        }).join('');
      }
    }
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function openThread(id) {
    S.api('/board/posts/' + encodeURIComponent(id)).then(function (res) {
      if (res && res.post) renderThread(res.post);
    }).catch(function (err) { S.toast((err && err.message) || 'Could not open thread.', 'err'); });
  }

  function loadBoard() {
    return S.api('/board?board=' + encodeURIComponent(state.board)).then(function (res) {
      state.posts = (res && res.posts) || [];
      renderFeed();
      if (state.selected) {
        var current = state.posts.filter(function (p) { return p.id === state.selected.id; })[0];
        if (current) openThread(current.id);
      }
    }).catch(function () {});
  }

  function loadCounts() {
    S.api('/board?board=all').then(function (res) {
      var posts = (res && res.posts) || [];
      var count = function (b) { return posts.filter(function (p) { return p.board === b; }).length; };
      if ($('allCount')) $('allCount').textContent = posts.length;
      ['audio', 'gadgets', 'lighting'].forEach(function (b) { var el = $(b + 'Count'); if (el) el.textContent = count(b); });
    }).catch(function () {});
  }

  function startThread() {
    if (state.busy) return;
    var input = $('boardInstruction');
    var instruction = (input.value || '').trim();
    if (instruction.length < 3) { S.toast('Write a short instruction first.', 'warn'); input.focus(); return; }
    state.busy = true;
    var btn = $('boardStart');
    var original = btn.textContent;
    btn.disabled = true; btn.textContent = 'Posting…';
    S.api('/board/posts', { method: 'POST', body: { instruction: instruction } }).then(function (res) {
      var post = res && res.post;
      if (!post) throw new Error('No post returned.');
      state.board = 'all';
      window.history.replaceState(null, '', 'board.html');
      $('boardInstruction').value = '';
      S.toast('Your agent is negotiating in a public thread.', 'ok');
      loadBoard(); loadCounts();
      setTimeout(function () { openThread(post.id); }, 800);
    }).catch(function (err) {
      S.toast((err && err.message) || 'Could not create the thread.', 'err');
    }).then(function () {
      state.busy = false; btn.disabled = false; btn.textContent = original;
    });
  }

  if ($('boardStart')) $('boardStart').addEventListener('click', startThread);
  if ($('threadClose')) $('threadClose').addEventListener('click', function () { $('threadPanel').hidden = true; state.selected = null; });
  if ($('boardInstruction')) $('boardInstruction').addEventListener('keydown', function (e) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') startThread(); });

  loadBoard(); loadCounts();
  state.timer = setInterval(function () { loadBoard(); loadCounts(); }, 2000);
  window.addEventListener('beforeunload', function () { clearInterval(state.timer); });
})();
