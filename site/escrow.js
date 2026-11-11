(function () {
  'use strict';
  var S = window.Settled; if (!S) return;
  var $ = function (id) { return document.getElementById(id); };
  var postId = new URLSearchParams(location.search).get('post') || '';
  var state = { post: null, orderId: null, approvalUrl: null, clientId: null, mode: null, busy: false };
  function esc(v) { return S.esc(v); }
  function money(v) { return S.money(v); }
  function step(title, status, cls) { return '<div class="esc-step"><b>' + esc(title) + '</b><span class="esc-state ' + (cls || 'pending') + '">' + esc(status) + '</span></div>'; }
  function render() {
    var p = state.post || {}; if (!p.id) return;
    var paid = p.merchant_paid || p.payment_status === 'captured';
    var authorized = p.payment_status === 'authorized';
    $('escSteps').innerHTML = step('Winning bid: ' + money(p.agreed_price), 'closed', 'good') +
      step('Buyer authorizes payment', authorized || paid ? 'authorized' : 'not yet', authorized || paid ? 'good' : 'pending') +
      step('Buyer confirms delivery', paid ? 'confirmed' : authorized ? 'waiting' : 'not yet', paid ? 'good' : 'pending') +
      step('Merchant receives payment', paid ? 'paid' : 'not paid', paid ? 'good' : 'pending');
    if (paid) {
      $('escPaypal').innerHTML = '';
      $('escActions').innerHTML = '<a class="btn btn-primary" href="index.html">Back to board</a>';
      $('escNote').textContent = 'Merchant paid at ' + (p.merchant_paid_at || '—') + '. Platform fee is recorded separately.';
      return;
    }
    if (authorized) {
      $('escPaypal').innerHTML = '<div class="esc-step"><b>Payment authorized — merchant not paid yet.</b><span class="esc-state good">held</span></div>';
      $('escActions').innerHTML = '<button class="btn btn-primary" id="escConfirm" type="button">Buyer confirms delivery → release payment</button>';
      $('escConfirm').addEventListener('click', confirmDelivery);
      $('escNote').textContent = 'The authorization is held until buyer confirmation. The merchant receives money only after capture.';
      return;
    }
    // unpaid: create authorization order, then render PayPal SDK
    if (!state.orderId) {
      $('escPaypal').innerHTML = '<div class="tiny muted">Creating PayPal authorization…</div>';
      S.api('/board/posts/' + encodeURIComponent(postId) + '/escrow-order', { method: 'POST', body: {} }).then(function (res) {
        state.orderId = res && res.escrow_order_id;
        state.approvalUrl = res && res.approval_url;
        state.mode = res && res.mode;
        state.post = res && res.post || state.post;
        render();
      }).catch(function (err) { $('escPaypal').innerHTML = '<div class="tiny">' + esc(err && err.message || 'Could not create authorization') + '</div>'; });
      return;
    }
    if (state.mode === 'paypal' && state.clientId) mountPayPal(); else {
      $('escActions').innerHTML = '<button class="btn btn-primary" id="escSimAuth" type="button">Simulate buyer authorization</button>';
      $('escSimAuth').addEventListener('click', authorizeSim);
      $('escNote').textContent = 'SIM mode: no real PayPal authorization is created. In live mode this becomes a real PayPal authorization.';
    }
  }
  function mountPayPal() {
    if (window.paypal && window.paypal.Buttons) return renderButtons(window.paypal);
    var host = $('escPaypal'); host.innerHTML = '<div class="tiny muted">Loading PayPal Buttons…</div>';
    var old = document.getElementById('escrowSdk'); if (old) old.remove();
    var s = document.createElement('script'); s.id = 'escrowSdk'; s.async = true;
    s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(state.clientId) + '&currency=USD&components=buttons&intent=authorize';
    s.onload = function () { if (window.paypal && window.paypal.Buttons) renderButtons(window.paypal); else host.innerHTML = '<div class="tiny">PayPal SDK failed to load.</div>'; };
    s.onerror = function () { host.innerHTML = '<div class="tiny">Could not load PayPal. Use the authorization link if present.</div>'; };
    document.head.appendChild(s);
  }
  function renderButtons(paypal) {
    var host = $('escPaypal'); host.innerHTML = '';
    paypal.Buttons({
      style: { shape: 'pill', color: 'gold', layout: 'vertical', label: 'paypal', height: 46 },
      createOrder: function () { return state.orderId; },
      onApprove: function (data) { return authorize((data && data.orderID) || state.orderId); },
      onCancel: function () { S.toast('Authorization cancelled.', 'warn'); },
      onError: function (err) { S.toast('PayPal error: ' + (err && (err.message || err)), 'err'); }
    }).render('#escPaypal');
  }
  function authorize(paypalOrderId) {
    return S.api('/board/posts/' + encodeURIComponent(postId) + '/escrow-authorize', { method: 'POST', body: { paypal_order_id: paypalOrderId } }).then(function (res) { state.post = res.post; render(); S.toast('Payment authorized. Merchant not paid yet.', 'ok'); });
  }
  function authorizeSim() {
    S.api('/board/posts/' + encodeURIComponent(postId) + '/escrow-authorize', { method: 'POST', body: { paypal_order_id: state.orderId } }).then(function (res) { state.post = res.post; render(); }).catch(function (err) { S.toast(err && err.message || 'Authorization failed', 'err'); });
  }
  function confirmDelivery() {
    if (state.busy) return; state.busy = true;
    S.api('/board/posts/' + encodeURIComponent(postId) + '/escrow-confirm', { method: 'POST', body: { authorization_id: state.post && state.post.authorization_id } }).then(function (res) { state.post = res.post; render(); S.toast('Delivery confirmed. Merchant paid.', 'ok'); }).catch(function (err) { S.toast(err && err.message || 'Capture failed', 'err'); }).then(function () { state.busy = false; });
  }
  if (!postId) { $('escSteps').innerHTML = '<div class="esc-step"><b>No deal in this link.</b></div>'; return; }
  S.api('/config').then(function (cfg) { state.clientId = cfg && cfg.paypal && cfg.paypal.client_id; state.mode = cfg && cfg.paypal && cfg.paypal.mode; return S.api('/board/posts/' + encodeURIComponent(postId)); }).then(function (res) {
    state.post = res && res.post; if (!state.post || state.post.status !== 'deal') throw new Error('Deal must be closed first.'); render();
  }).catch(function (err) { $('escSteps').innerHTML = '<div class="esc-step"><b>' + esc(err && err.message || 'Unavailable') + '</b></div>'; });
})();
