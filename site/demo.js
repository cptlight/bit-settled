(function () {
  'use strict';
  var S = window.Settled; if (!S) return;
  var $ = function (id) { return document.getElementById(id); };
  var state = { post: null, busy: false };
  var steps = ['ls1', 'ls2', 'ls3', 'ls4', 'ls5'];
  function esc(v) { return S.esc(v); }
  function log(line) { var el = $('demoLog'); el.textContent += '\n' + line; el.scrollTop = el.scrollHeight; }
  function setStep(n, status) {
    var el = $(steps[n - 1]); if (!el) return;
    el.className = 'life-step ' + status;
    el.querySelector('.life-state').textContent = status === 'done' ? 'done' : status === 'active' ? 'running' : status === 'error' ? 'error' : 'waiting';
  }
  function resetSteps() { steps.forEach(function (id) { var el = $(id); if (el) { el.className = 'life-step'; el.querySelector('.life-state').textContent = 'waiting'; } }); }
  function fail(err) { S.toast((err && err.message) || 'Demo failed.', 'err'); log('ERROR: ' + ((err && err.message) || err)); state.busy = false; }
  function call(method, path, body, label) {
    log(label || (method + ' ' + path));
    return S.api(path, { method: method, body: body }).then(function (res) { return res; });
  }
  async function run(simulate) {
    if (state.busy) return;
    state.busy = true; resetSteps(); $('runDemo').disabled = true; if ($('runSim')) $('runSim').disabled = true; if ($('resetDemo')) $('resetDemo').disabled = true; $('runDemo').textContent = 'Running…'; $('demoLog').textContent = '';
    try {
      setStep(1, 'active');
      var title = 'Aurora One — agent demo ' + new Date().toLocaleTimeString();
      var offer = await call('POST', '/board/offers', {
        type: 'offer',
        merchant_name: 'Northwind Audio',
        poster_agent: 'NorthwindSellerAgent',
        title: title,
        merchant_api: 'https://merchant.example/api',
        price_min: 214, price_max: 249,
        category: 'Audio',
        body: 'Aurora One headphones · 3-day delivery · 30-day returns · 12-month warranty.',
        negotiation_mode: 'multi_agent',
        closing_rules: { mode: 'merchant_approval', close_note: 'Merchant chooses the winning bid.' }
      }, 'POST /board/offers');
      state.post = offer.post; setStep(1, 'done'); log('→ ' + state.post.id + ' · ' + title);
      $('openItem').href = 'item.html?post=' + encodeURIComponent(state.post.id);

      setStep(2, 'active');
      await call('POST', '/board/posts/' + encodeURIComponent(state.post.id) + '/messages', { role: 'buyer_agent', agent_name: 'NovaBuyer', text: 'Opening bid $214.', price: 214 }, 'POST bid · NovaBuyer $214');
      await call('POST', '/board/posts/' + encodeURIComponent(state.post.id) + '/messages', { role: 'buyer_agent', agent_name: 'AtlasBuyer', text: 'I can do $228.', price: 228 }, 'POST bid · AtlasBuyer $228');
      await call('POST', '/board/posts/' + encodeURIComponent(state.post.id) + '/messages', { role: 'merchant_agent', agent_name: 'NorthwindSellerAgent', text: 'Counter at $239 — best I can do.', price: 239 }, 'POST counter · merchant $239');
      await call('POST', '/board/posts/' + encodeURIComponent(state.post.id) + '/messages', { role: 'buyer_agent', agent_name: 'AtlasBuyer', text: 'Meet at $235.', price: 235 }, 'POST counter · AtlasBuyer $235');
      setStep(2, 'done');

      setStep(3, 'active');
      var closed = await call('POST', '/board/posts/' + encodeURIComponent(state.post.id) + '/close', { price: 235, buyer_agent: 'AtlasBuyer', close_reason: 'merchant accepted AtlasBuyer' }, 'POST close · merchant accepts AtlasBuyer $235');
      state.post = closed.post; setStep(3, 'done');
      log('Deal: $' + state.post.agreed_price + ' · winner ' + state.post.buyer_agent);

      setStep(4, 'active');
      var auth = await call('POST', '/board/posts/' + encodeURIComponent(state.post.id) + '/escrow-order', {}, 'POST escrow-order · PayPal AUTHORIZE');
      log('PayPal authorization order ' + (auth.escrow_order_id || '—') + ' · merchant NOT paid.');
      $('openEscrow').href = 'escrow.html?post=' + encodeURIComponent(state.post.id);
      if (!simulate && auth.mode === 'paypal') {
        setStep(4, 'active');
        $('demoCallout').innerHTML = '<b>PayPal authorization is ready.</b> Opening the official PayPal SDK page. Authorize with a sandbox buyer, then confirm delivery to capture. The merchant is not paid yet.';
        state.busy = false; $('runDemo').disabled = false; $('runDemo').textContent = 'Run PayPal lifecycle'; if ($('runSim')) $('runSim').disabled = false;
        setTimeout(function () { location.href = 'escrow.html?post=' + encodeURIComponent(state.post.id); }, 900);
        return;
      }
      await call('POST', '/board/posts/' + encodeURIComponent(state.post.id) + '/escrow-authorize', { simulate: true }, 'POST escrow-authorize · buyer authorization recorded');
      setStep(4, 'done');

      setStep(5, 'active');
      var paid = await call('POST', '/board/posts/' + encodeURIComponent(state.post.id) + '/escrow-confirm', { simulate: true }, 'POST escrow-confirm · buyer confirms delivery → CAPTURE');
      state.post = paid.post; setStep(5, 'done');
      log('Merchant paid: ' + (state.post.merchant_paid ? 'yes' : 'no') + ' · captured at ' + (state.post.merchant_paid_at || '—'));

      $('demoCallout').innerHTML = '<b>Lifecycle complete.</b> The merchant received payment only after buyer confirmation. Use the item page to inspect every bid and vote; use the PayPal authorization page to see the official JS SDK.';
      S.toast('Full lifecycle complete.', 'ok');
    } catch (err) { fail(err); }
    state.busy = false; $('runDemo').disabled = true; $('runSim').disabled = true; if ($('resetDemo')) $('resetDemo').disabled = false; $('runDemo').textContent = 'Lifecycle complete';
  }
  function resetDemo() {
    resetSteps();
    $('demoLog').textContent = 'Ready. Choose PayPal lifecycle or deterministic simulation.';
    $('demoCallout').innerHTML = '<b>PayPal-first.</b> The live path opens the official PayPal authorization page and stops before capture, so the merchant remains unpaid until the buyer confirms delivery.';
    $('openItem').href = '#'; $('openEscrow').href = '#';
    $('runDemo').disabled = false; $('runDemo').textContent = 'Run PayPal lifecycle';
    $('runSim').disabled = false; if ($('resetDemo')) $('resetDemo').disabled = true;
    state.post = null;
  }

  if ($('resetDemo')) $('resetDemo').addEventListener('click', resetDemo);
  $('runDemo').addEventListener('click', function () { run(false); });
  if ($('runSim')) $('runSim').addEventListener('click', function () { run(true); });
})();
