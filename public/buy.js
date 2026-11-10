/* Buy an already-accepted contract; no input except PayPal approval/capture. */
(function () {
  'use strict';
  var S = window.Settled;
  var $ = function (id) { return document.getElementById(id); };
  if (!S) return;
  var q = new URLSearchParams(location.search);
  var merchant = q.get('merchant') || 'm1';
  var product = q.get('product') || 'p1';
  var contractId = q.get('contract') || '';
  var state = { order: null, payment: null, receipt: null, busy: false };

  function esc(v) { return S.esc(v); }
  function money(v) { return S.money(v); }
  function busy(btn, on, text) { if (!btn) return; btn.disabled = on; if (!btn.dataset.label) btn.dataset.label = btn.textContent; btn.textContent = on ? text : btn.dataset.label; }

  S.api('/config').then(function (c) { S.setEnv(c && c.mode); }).catch(function () {});
  S.api('/health').then(function (h) { if (h) S.setEnv(h.mode); }).catch(function () {});

  function receiptHtml(o, p, r) {
    return [
      ['order', o && o.id],
      ['product', o && o.product_name],
      ['agreed amount', o && money(o.amount)],
      ['platform fee (0.5%)', o && money(o.platform_fee) + (o.platform_fee_collected ? ' collected' : ' accrued')],
      ['merchant net', o && money(o.merchant_net)],
      ['payment id', p && p.id],
      ['payment rail', p && p.mode],
      ['status', o && o.status],
      ['capture id', o && o.capture_id]
    ].map(function (f) {
      return '<div class="buy-fact"><div class="buy-label">' + esc(f[0]) + '</div><div class="buy-value">' + esc(f[1] === undefined || f[1] === null ? '—' : f[1]) + '</div></div>';
    }).join('');
  }

  function render() {
    var o = state.order;
    if (!o) return;
    $('buyBody').innerHTML = receiptHtml(o, state.payment, state.receipt);
    var actions = $('buyActions');
    var approval = state.payment && state.payment.approval_url;
    if (approval && o.status !== 'paid') {
      actions.innerHTML = '<a class="btn btn-gold" href="' + esc(approval) + '" target="_blank" rel="noopener noreferrer">Open PayPal approval</a>' +
        '<button class="btn btn-primary" id="buyCapture" type="button">I approved — capture</button>';
      var cap = $('buyCapture');
      if (cap) cap.addEventListener('click', capture);
      $('buyNote').textContent = 'Sandbox only. Use a Personal sandbox buyer or the test card (4111 1111 1111 1111, 12/30, CVV 123). The agent cannot approve PayPal on the buyer’s behalf.';
    } else if (o.status === 'paid') {
      actions.innerHTML = '<button class="btn btn-danger" id="buyClaim" type="button">File claim — item never arrived</button>' +
        '<a class="btn btn-ghost" href="board.html">Back to board</a>';
      var claim = $('buyClaim');
      if (claim) claim.addEventListener('click', fileClaim);
      $('buyNote').textContent = 'Paid in the sandbox. The contract hash and protection are attached; filing a claim refunds from the merchant reserve.';
    } else {
      actions.innerHTML = '<a class="btn btn-ghost" href="live.html">Open live room</a>';
    }
  }

  function capture() {
    if (state.busy || !state.order) return;
    state.busy = true;
    var btn = $('buyCapture');
    busy(btn, true, 'Capturing…');
    S.api('/paypal/capture', { method: 'POST', body: { order_id: state.order.id, paypal_order_id: state.payment && state.payment.id } }).then(function (res) {
      state.order = (res && res.order) || state.order;
      state.payment = res && (res.capture || state.payment);
      render();
      S.toast('PayPal sandbox payment captured.', 'ok');
    }).catch(function (err) {
      S.toast((err && err.message) || 'Capture failed.', 'err');
    }).then(function () { state.busy = false; busy(btn, false); });
  }

  function fileClaim() {
    if (state.busy || !state.order) return;
    state.busy = true;
    var btn = $('buyClaim');
    busy(btn, true, 'Filing claim…');
    S.api('/orders/' + encodeURIComponent(state.order.id) + '/claim', { method: 'POST', body: { reason: 'not_delivered', evidence: true, use_ai: true, actor: 'agent:a1' } }).then(function (res) {
      S.toast('Claim paid: ' + money(res && res.claim && res.claim.refund) + ' from the merchant reserve.', 'ok');
      $('buyNote').textContent = 'Claim paid: ' + money(res && res.claim && res.claim.refund) + ' refunded to the buyer from the merchant reserve.';
      $('buyActions').innerHTML = '<a class="btn btn-primary" href="board.html">Back to board</a>';
    }).catch(function (err) {
      S.toast((err && err.message) || 'Claim failed.', 'err');
    }).then(function () { state.busy = false; busy(btn, false); });
  }

  if (!contractId) {
    $('buyBody').innerHTML = '<div class="buy-fact"><div class="buy-label">Status</div><div class="buy-value">No accepted contract in this link. Start from the live room or board.</div></div>';
    $('buyActions').innerHTML = '<a class="btn btn-primary" href="board.html">Open r/bit-settled</a>';
    return;
  }

  S.api('/merchants/' + encodeURIComponent(merchant) + '/orders', {
    method: 'POST',
    body: { product_id: product, contract_id: contractId, agent_id: 'a1', buyer: { name: 'ProcureBot', email: 'procurebot@acme.example' } }
  }).then(function (res) {
    state.order = res && res.order;
    state.payment = res && res.payment;
    state.receipt = res && res.receipt;
    render();
  }).catch(function (err) {
    $('buyBody').innerHTML = '<div class="buy-fact"><div class="buy-label">Status</div><div class="buy-value">' + esc(err && err.message || 'Order failed.') + '</div></div>';
    $('buyActions').innerHTML = '<a class="btn btn-ghost" href="live.html">Open live room</a>';
  });
})();
