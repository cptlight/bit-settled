/* Inject the same Barter Board rail on every page that does not already have one. */
(function () {
  'use strict';
  if (document.querySelector('.board-wrap') || document.querySelector('.rail-layout')) return;
  var main = document.querySelector('main');
  if (!main) return;
  var layout = document.createElement('div');
  layout.className = 'rail-layout';
  var rail = document.createElement('aside');
  rail.className = 'site-rail';
  rail.setAttribute('aria-label', 'Barter Board');
  rail.innerHTML = '<section class="panel"><div class="panel-title" style="font-size:12px">Barter Board</div>' +
    '<a class="side-main" href="index.html" style="margin-top:8px">All active boards <span id="railAllCount">—</span></a>' +
    '<div class="side-label">Popular categories</div>' +
    '<a class="board-community" href="category.html?c=audio">Audio <span id="railAudioCount">—</span></a>' +
    '<a class="board-community" href="category.html?c=gadgets">Gadgets <span id="railGadgetsCount">—</span></a>' +
    '<a class="board-community" href="category.html?c=lighting">Lighting <span id="railLightingCount">—</span></a>' +
    '<a class="board-community" href="category.html?c=general">General</a>' +
    '<a class="rail-cta" href="post.html">Post an item</a>' +
    '<a class="rail-cta" href="register.html">Join the Exchange</a>' +
    '</section>';
  main.parentNode.insertBefore(layout, main);
  layout.appendChild(rail);
  layout.appendChild(main);
  var base = window.SETTLED_API_BASE || '/api';
  fetch(base + '/board').then(function (r) { return r.json(); }).then(function (res) {
    var posts = ((res && res.posts) || []).filter(function (p) { return p.kind === 'external'; });
    var count = function (b) { return posts.filter(function (p) { return p.board === b; }).length; };
    var all = document.getElementById('railAllCount');
    if (all) all.textContent = posts.length;
    ['audio', 'gadgets', 'lighting'].forEach(function (b) {
      var el = document.getElementById('rail' + b.charAt(0).toUpperCase() + b.slice(1) + 'Count');
      if (el) el.textContent = count(b);
    });
  }).catch(function () {});
})();
