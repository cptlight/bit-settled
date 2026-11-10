/* Live negotiation rooms — instruct a personal agent, watch it negotiate. */
(function () {
  'use strict';
  var S = window.Settled;
  var $ = function (id) { return document.getElementById(id); };
  if (!S) return;

  var state = { sessions: [], selected: null, timer: null, busy: false };
  var selectedFromUrl = new URLSearchParams(window.location.search || '').get('session');

  S.mountNav('live');
  if (S.setEnvFromHealth) S.setEnvFromHealth();
  S.api('/health').then(function (h) { if (h) S.setEnv(h.mode); }).catch(function () {});

  function esc(v) { return S.esc(v); }
  function when(v) { try { return S.dateFmt(v); } catch (e) { return '—'; } }
  function initials(name) {
    var parts = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/);
    return parts[0] ? (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase() : 'AI';
  }
  function statusClass(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'accepted' || s === 'done' || s === 'paid') return 'accepted';
    if (s === 'negotiating' || s === 'running') return 'negotiating';
    if (s === 'no_deal' || s === 'rejected' || s === 'error') return 'error';
    return s;
  }
  function setBusy(btn, busy, label) {
    if (!btn) return;
    btn.disabled = busy;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = busy ? label : btn.dataset.label;
  }

  function roomLabel(session) {
    return (session.merchant && session.merchant.name ? session.merchant.name : 'Merchant') +
      ' · ' + (session.product && session.product.name ? session.product.name : 'Item');
  }

  function renderRooms() {
    var host = $('liveRoomList');
    if (!host) return;
    $('liveRoomCount').textContent = String(state.sessions.length);
    if (!state.sessions.length) {
      host.innerHTML = '<div class="live-empty">No rooms yet. Send the first instruction.</div>';
      return;
    }
    host.innerHTML = state.sessions.map(function (s) {
      var active = state.selected && state.selected.id === s.id ? ' is-active' : '';
      var price = s.agreed_price ? '<span class="live-room-price">' + esc(S.money(s.agreed_price)) + '</span>' : '';
      return '<button class="live-room' + active + '" type="button" data-session="' + esc(s.id) + '">' +
        '<div class="live-room-top"><span class="live-room-prompt">' + esc(s.instruction || '—') + '</span><span class="live-status ' + esc(statusClass(s.status)) + '">' + esc(s.status || '—') + '</span></div>' +
        '<div class="live-room-meta"><span>' + esc(roomLabel(s)) + '</span><span>' + esc(when(s.updated_at || s.created_at)) + '</span>' + price + '</div>' +
      '</button>';
    }).join('');
    Array.prototype.forEach.call(host.querySelectorAll('[data-session]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-session');
        state.selected = state.sessions.filter(function (s) { return s.id === id; })[0] || null;
        renderRooms();
        loadSession(id);
      });
    });
  }

  function renderSession(session) {
    state.selected = session;
    var panel = $('liveWatch');
    panel.hidden = false;
    $('liveWatchTitle').textContent = session.instruction || 'Live negotiation';
    $('liveWatchSub').textContent = roomLabel(session) + ' · budget ' + S.money(session.budget) + ' · ' + when(session.created_at);
    $('liveStatus').textContent = session.status || '—';
    $('liveStatus').className = 'live-status ' + statusClass(session.status);
    var rows = session.transcript || [];
    if (!rows.length) {
      $('liveTranscript').innerHTML = '<div class="live-empty">Waiting for the agents…</div>';
    } else {
      $('liveTranscript').innerHTML = rows.map(function (r) {
        var role = r.role || 'system';
        var label = role === 'you' ? 'You' : role === 'buyer_agent' ? (r.name || 'Your agent') : role === 'merchant_agent' ? (r.name || 'Merchant agent') : 'System';
        var price = r.price !== undefined && r.price !== null ? '<span class="live-price">' + esc(S.money(r.price)) + '</span>' : '';
        return '<div class="live-msg ' + esc(role) + '">' +
          '<div class="live-msg-head"><span class="live-who">' + esc(label) + '</span>' + price + '</div>' +
          '<div class="live-text">' + esc(r.text || (r.kind === 'accepted' ? 'Deal agreed.' : '')) + '</div>' +
          (r.rationale ? '<div class="live-why">' + esc(r.rationale) + '</div>' : '') +
        '</div>';
      }).join('');
    }
    var buyHost = $('liveBuyActions');
    if (buyHost) {
      if (session.status === 'accepted' && session.contract_id) {
        buyHost.innerHTML = '<a class="btn btn-primary btn-sm" href="buy.html?merchant=' + encodeURIComponent((session.merchant && session.merchant.id) || 'm1') + '&product=' + encodeURIComponent((session.product && session.product.id) || 'p1') + '&contract=' + encodeURIComponent(session.contract_id) + '">Buy this deal</a>' +
          '<a class="btn btn-ghost btn-sm" href="negotiate.html?merchant=' + encodeURIComponent((session.merchant && session.merchant.id) || 'm1') + '&product=' + encodeURIComponent((session.product && session.product.id) || 'p1') + '">Open negotiation</a>';
      } else {
        buyHost.innerHTML = '';
      }
    }
    $('liveFoot').textContent = session.status === 'no_deal' ? 'No deal inside the stated budget. Try a higher budget.' : session.status === 'accepted'
      ? 'Negotiation complete · signed contract ' + (session.contract_id || '') + ' · agreed ' + S.money(session.agreed_price)
      : 'Anyone with this link can watch. The merchant’s private floor is not in this transcript.';
    if (session.id) {
      try { window.history.replaceState(null, '', '?session=' + encodeURIComponent(session.id)); } catch (e) {}
    }
  }

  function loadSession(id) {
    if (!id) return;
    return S.api('/live/sessions/' + encodeURIComponent(id)).then(function (res) {
      if (res && res.session) renderSession(res.session);
    }).catch(function (err) {
      if (err && err.status === 404) S.toast('That room is no longer available.', 'warn');
    });
  }

  function loadRooms() {
    return S.api('/live/sessions').then(function (res) {
      state.sessions = (res && res.sessions) || [];
      if (!state.selected && state.sessions.length) {
        var wanted = selectedFromUrl && state.sessions.filter(function (s) { return s.id === selectedFromUrl; })[0];
        state.selected = wanted || state.sessions[0];
      }
      renderRooms();
      if (state.selected) return loadSession(state.selected.id);
    }).catch(function () { /* keep the last view */ });
  }

  function startSession() {
    if (state.busy) return;
    var input = $('liveInstruction');
    var instruction = (input.value || '').trim();
    if (instruction.length < 3) {
      S.toast('Write a short instruction first.', 'warn'); input.focus(); return;
    }
    state.busy = true;
    var btn = $('liveStart');
    setBusy(btn, true, 'Sending to your agent…');
    S.api('/live/sessions', { method: 'POST', body: { instruction: instruction } }).then(function (res) {
      var session = res && res.session;
      if (!session) throw new Error('The room was not created.');
      state.selected = session;
      renderSession(session);
      S.toast('Your agent is negotiating. Watch the room.', 'ok');
      loadRooms();
    }).catch(function (err) {
      S.toast((err && err.message) || 'Could not start the agent.', 'err');
    }).then(function () {
      state.busy = false;
      setBusy(btn, false);
    });
  }

  if ($('liveStart')) $('liveStart').addEventListener('click', startSession);
  if ($('liveInstruction')) {
    $('liveInstruction').addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') startSession();
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-instruction]'), function (chip) {
    chip.addEventListener('click', function () {
      $('liveInstruction').value = chip.getAttribute('data-instruction') || '';
      $('liveInstruction').focus();
    });
  });

  loadRooms();
  state.timer = setInterval(loadRooms, 1500);
  window.addEventListener('beforeunload', function () { clearInterval(state.timer); });
})();
