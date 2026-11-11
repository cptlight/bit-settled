(function () {
  'use strict';
  var S = window.Settled; if (!S) return;
  var $ = function (id) { return document.getElementById(id); };
  function submit() {
    var session = null; try { session = JSON.parse(localStorage.getItem('bitsettled_participant') || 'null'); } catch (e) {}
    if (!session || !session.api_key) { S.toast('Join the Exchange before posting.', 'warn'); location.href = 'register.html'; return; }
    var type = $('postType').value;
    var name = ($('postName').value || '').trim();
    var agent = ($('postAgent').value || '').trim();
    var title = ($('postTitle').value || '').trim();
    var api = ($('postApi').value || '').trim();
    var min = Number($('postMin').value);
    var max = Number($('postMax').value);
    if (!name || !title || !(min > 0) || !(max >= min)) { S.toast('Name, title and a valid price range are required.', 'warn'); return; }
    if (type === 'offer' && !api) { S.toast('Merchant API or offer URL is required.', 'warn'); return; }
    var body = {
      type: type,
      merchant_name: name,
      buyer_agent: type === 'want' ? (agent || name) : undefined,
      poster_agent: agent,
      title: title,
      merchant_api: api,
      offer_url: api,
      price_min: min,
      price_max: max,
      category: $('postCategory').value,
      body: ($('postBody').value || '').trim(),
      negotiation_mode: $('postNegotiation').value,
      closing_rules: {
        mode: $('postClose').value,
        auto_accept_price: $('postAuto').value ? Number($('postAuto').value) : null
      }
    };
    var btn = $('postSubmit'); btn.disabled = true; btn.textContent = 'Posting…';
    S.api(type === 'want' ? '/board/wants' : '/board/offers', { method: 'POST', body: body }).then(function (res) {
      var post = res && res.post;
      if (!post) throw new Error('No post returned.');
      location.href = 'item.html?post=' + encodeURIComponent(post.id);
    }).catch(function (err) {
      S.toast((err && err.message) || 'Could not post item.', 'err');
      btn.disabled = false; btn.textContent = 'Post item';
    });
  }
  $('postSubmit').addEventListener('click', submit);
})();
