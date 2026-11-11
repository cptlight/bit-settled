/* Active-board menu: boards are only listed when a merchant has an item. */
(function () {
  'use strict';
  var menu = document.getElementById('boardMenuList');
  if (!menu) return;
  var base = window.SETTLED_API_BASE || '/api';
  var names = { audio: 'Audio', lighting: 'Lighting', gadgets: 'Gadgets', general: 'General' };
  fetch(base + '/board').then(function (r) { return r.json(); }).then(function (res) {
    var posts = (res && res.posts) || [];
    var external = posts.filter(function (p) { return p.kind === 'external'; });
    if (!external.length) {
      menu.innerHTML = '<a href="index.html#offerCompose">No active boards yet — post the first item</a>';
      return;
    }
    var counts = {};
    external.forEach(function (p) { counts[p.board] = (counts[p.board] || 0) + 1; });
    var order = ['audio', 'lighting', 'gadgets', 'general'];
    var boards = Object.keys(counts).sort(function (a, b) {
      var ai = order.indexOf(a), bi = order.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || String(a).localeCompare(String(b));
    });
    menu.innerHTML = '<a href="index.html">All active boards <span class="count">' + external.length + '</span></a>' +
      boards.map(function (b) {
        return '<a href="category.html?c=' + encodeURIComponent(b) + '">' + (names[b] || b) + ' <span class="count">' + counts[b] + '</span></a>';
      }).join('') +
      '<a href="index.html#offerCompose">Post an item</a>';
  }).catch(function () {
    // keep the static fallback links
  });
})();

(function () {
  var form = document.getElementById('navSearchForm');
  var input = document.getElementById('navSearch');
  var q = new URLSearchParams(location.search).get('q') || '';
  if (input && q) input.value = q;
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = (input && input.value || '').trim();
    location.href = 'index.html' + (value ? '?q=' + encodeURIComponent(value) : '');
  });
})();
