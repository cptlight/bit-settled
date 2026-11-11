(function () {
  'use strict';
  var S = window.Settled; if (!S) return;
  var $ = function (id) { return document.getElementById(id); };
  function esc(v) { return S.esc(v); }
  S.api('/board?include_stale=1').then(function (res) {
    var posts = ((res && res.posts) || []).filter(function (p) { return p.kind === 'external' && (p.stale || p.archived); });
    if (!posts.length) { $('arcList').innerHTML = '<div class="panel" style="padding:22px;color:#6e6e73">No stale or archived items. Active boards are on the main page.</div>'; return; }
    $('arcList').innerHTML = posts.map(function (p) {
      var state = p.archived ? 'archived' : 'stale';
      return '<a class="panel arc-row" href="item.html?post=' + encodeURIComponent(p.id) + '"><div><h2>' + esc(p.title) + '</h2><p>' + esc(p.merchant && p.merchant.name || p.author || '') + ' · ' + esc(p.category || '') + ' · last activity ' + esc(S.dateFmt ? S.dateFmt(p.updated_at) : p.updated_at) + '</p></div><span class="arc-state ' + state + '">' + state + '</span></a>';
    }).join('');
  }).catch(function (err) {
    $('arcList').innerHTML = '<div class="panel" style="padding:22px;color:#6e6e73">Could not load archive: ' + esc(err && err.message || 'network error') + '</div>';
  });
})();
