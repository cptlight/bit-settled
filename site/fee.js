/* Pay the 0.5% platform fee with the official PayPal JS SDK. */
(function () {
  'use strict';
  var S = window.Settled;
  var $ = function (id) { return document.getElementById(id); };
  if (!S) return;
  var postId = new URLSearchParams(location.search).get('post') || '';
  var state = { post: null, feeOrderId: null, approvalUrl: null, clientId: null, busy: false, sdk: null };

  function esc(v) { return S.esc(v); }
  function money(v) { return S.money(v); }
  function fact(label, value) {
    return '<div class="fee-fact"><div class="fee-label">' + esc(label) + '</div><div class="fee-value">' + esc(value == null ? '—' : value) + '</div></div>';
  }
  function render() {
    var p = state.post || {};
    $('feeFacts').innerHTML = fact('deal', p.title) + fact('agreed price', money(p.agreed_price)) +
      fact('platform fee · 0.5%', money(p.platform_fee)) + fact('fee status', p.fee_collected ? 'paid' : 'due') +
      fact('contract', p.contract_ref || '—') + fact('merchant', p.merchant && p.merchant.name);
    if (p.fee_collected) {
      $('paypalFeeHost').innerHTML = '';
      $('feeActions').innerHTML = '<a class="btn btn-primary" href="index.html">Back to board</a>';
      $('feeNote').textContent = 'Paid via PayPal. Capture id: ' + (p.fee_capture_id || '—') + '.';
      return;
    }
    $('feeActions').innerHTML = state.approvalUrl ? '<a class="btn btn-ghost" href="' + esc(state.approvalUrl) + '" target="_blank" rel="noopener noreferrer">Open PayPal approval</a>' : '';
    mountPayPal();
  }

  function mountPayPal() {
    if (!state.clientId || !state.feeOrderId) return;
    var host = $('paypalFeeHost');
    if (window.paypal && window.paypal.Buttons) {
      renderButtons(window.paypal);
      return;
    }
    host.innerHTML = '<div class="tiny muted">Loading PayPal Buttons…</div>';
    var old = document.getElementById('paypalFeeSdk');
    if (old) old.remove();
    var s = document.createElement('script');
    s.id = 'paypalFeeSdk';
    s.async = true;
    s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(state.clientId) + '&currency=USD&components=buttons&intent=capture';
    s.onload = function () { if (window.paypal && window.paypal.Buttons) renderButtons(window.paypal); else host.innerHTML = '<div class="tiny">PayPal SDK failed to load.</div>'; };
    s.onerror = function () { host.innerHTML = '<div class="tiny">Could not load paypal.com. Use the approval link.</div>'; };
    document.head.appendChild(s);
  }

  function renderButtons(paypal) {
    var host = $('paypalFeeHost');
    host.innerHTML = '';
    var buttons = paypal.Buttons({
      style: { shape: 'pill', color: 'gold', layout: 'vertical', label: 'paypal', height: 46 },
      createOrder: function () { return state.feeOrderId; },
      onApprove: function (data) { return capture((data && data.orderID) || state.feeOrderId); },
      onCancel: function () { S.toast('Fee payment cancelled.', 'warn'); },
      onError: function (err) { S.toast('PayPal error: ' + (err && (err.message || err)), 'err'); }
    });
    buttons.render('#paypalFeeHost');
  }

  function capture(paypalOrderId) {
    if (state.busy) return;
    state.busy = true;
    return S.api('/board/posts/' + encodeURIComponent(postId) + '/fee-capture', {
      method: 'POST', body: { paypal_order_id: paypalOrderId, order_id: state.feeOrderId }
    }).then(function (res) {
      state.post = res && res.post ? res.post : state.post;
      render();
      S.toast('Platform fee captured via PayPal.', 'ok');
    }).catch(function (err) {
      S.toast((err && err.message) || 'Fee capture failed.', 'err');
    }).then(function () { state.busy = false; });
  }

  if (!postId) {
    $('feeFacts').innerHTML = fact('status', 'No deal id in this link.');
    return;
  }
  S.api('/board/posts/' + encodeURIComponent(postId)).then(function (res) {
    state.post = res && res.post;
    if (!state.post || state.post.kind !== 'external' || state.post.status !== 'deal') throw new Error('This deal is not closed yet.');
    if (state.post.fee_collected) { render(); return; }
    return S.api('/config').then(function (cfg) {
      state.clientId = cfg && cfg.paypal && cfg.paypal.client_id;
      return S.api('/board/posts/' + encodeURIComponent(postId) + '/fee-order', { method: 'POST', body: {} });
    }).then(function (res) {
      state.feeOrderId = res && res.fee_order_id;
      state.approvalUrl = res && res.approval_url;
      render();
    });
  }).catch(function (err) {
    $('feeFacts').innerHTML = fact('status', (err && err.message) || 'Unavailable');
    $('feeNote').textContent = 'A closed deal with a recorded 0.5% fee is required.';
  });
})();
