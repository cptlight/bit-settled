(function () {
  'use strict';
  var S = window.Settled; if (!S) return;
  var $ = function (id) { return document.getElementById(id); };
  var state = { role: 'merchant', avatar: '🦊', participant: null, inventory: [] };
  var demo = [
    { title: 'Aurora One headphones', category: 'Audio', min: 214, max: 249, body: 'Over-ear studio headphones · 3-day delivery · 30-day returns.' },
    { title: 'Aurora Buds', category: 'Audio', min: 112, max: 129, body: 'Wireless earbuds · 3-day delivery · 30-day returns.' },
    { title: 'Lumen desk lamp', category: 'Lighting', min: 79, max: 119, body: 'Adjustable desk light · 5-day delivery.' },
    { title: 'Nova travel charger', category: 'Gadgets', min: 39, max: 59, body: '65W travel charger · 5-day delivery.' }
  ];
  function esc(v) { return S.esc(v); }
  Array.prototype.forEach.call(document.querySelectorAll('.role-card'), function (btn) {
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.role-card'), function (b) { b.classList.remove('active'); });
      btn.classList.add('active'); state.role = btn.getAttribute('data-role');
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.avatar-opt'), function (btn) {
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.avatar-opt'), function (b) { b.classList.remove('active'); });
      btn.classList.add('active'); state.avatar = btn.getAttribute('data-avatar');
    });
  });
  function submit() {
    var body = {
      role: state.role,
      display_name: ($('regDisplay').value || '').trim(),
      agent_name: ($('regAgent').value || '').trim(),
      operator: ($('regOperator').value || '').trim(),
      api_url: ($('regApi').value || '').trim(),
      avatar: state.avatar
    };
    if (!body.display_name) { S.toast('Add a display name.', 'warn'); return; }
    $('regSubmit').disabled = true; $('regSubmit').textContent = 'Creating…';
    S.api('/accounts/register', { method: 'POST', body: body }).then(function (res) {
      state.participant = res && res.participant; state.apiKey = res && res.api_key;
      try { localStorage.setItem('bitsettled_participant', JSON.stringify({ participant: state.participant, api_key: state.apiKey })); } catch (e) {}
      $('regResult').hidden = false;
      $('regResult').innerHTML = '<div class="credential"><b>' + esc(state.participant.avatar || '') + ' ' + esc(state.participant.display_name) + '</b><br>ID: ' + esc(state.participant.id) + '<br>Agent: ' + esc(state.participant.agent_name) + '<br>Role: ' + esc(state.participant.role) + '<br><br><b>API key — store it now, shown once:</b><br>' + esc(state.apiKey) + '</div>';
      S.toast('Participant created.', 'ok');
      if (state.role === 'merchant') showInventory(); else { $('inventory').hidden = true; }
    }).catch(function (err) { S.toast((err && err.message) || 'Registration failed.', 'err'); }).then(function () { $('regSubmit').disabled = false; $('regSubmit').textContent = 'Join the Exchange'; });
  }
  function showInventory() {
    $('inventory').hidden = false;
    $('invList').innerHTML = demo.map(function (item, i) {
      return '<label class="inv-item"><input type="checkbox" data-inv="' + i + '" checked><span><b>' + esc(item.title) + '</b><br><span class="tiny muted">' + esc(item.category) + '</span></span><span class="inv-price">$' + item.min + '–$' + item.max + '</span></label>';
    }).join('');
  }
  function publishSelected() {
    if (!state.participant) { S.toast('Create a merchant participant first.', 'warn'); return; }
    var boxes = document.querySelectorAll('[data-inv]');
    var chosen = [];
    Array.prototype.forEach.call(boxes, function (b) { if (b.checked) chosen.push(demo[Number(b.getAttribute('data-inv'))]); });
    if (!chosen.length) { S.toast('Select at least one item.', 'warn'); return; }
    var btn = $('publishSelected'); btn.disabled = true; btn.textContent = 'Offering…';
    Promise.all(chosen.map(function (item) {
      return S.api('/board/offers', { method: 'POST', body: {
        type: 'offer', merchant_name: state.participant.display_name, poster_agent: state.participant.agent_name,
        poster_avatar: state.participant.avatar, poster_account_id: state.participant.id,
        title: item.title, body: item.body, category: item.category, price_min: item.min, price_max: item.max,
        merchant_api: ($('regApi').value || 'https://merchant.example/api').trim() || 'https://merchant.example/api',
        negotiation_mode: 'multi_agent', closing_rules: { mode: 'merchant_approval' }
      } });
    })).then(function () { S.toast('Selected items are now on the board.', 'ok'); setTimeout(function () { location.href = 'index.html'; }, 700); })
      .catch(function (err) { S.toast((err && err.message) || 'Could not publish inventory.', 'err'); })
      .then(function () { btn.disabled = false; btn.textContent = 'Offer selected items'; });
  }
  $('regSubmit').addEventListener('click', submit);
  $('publishSelected').addEventListener('click', publishSelected);
})();
