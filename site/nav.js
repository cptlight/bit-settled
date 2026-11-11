/* Active-board menu: boards are only listed when a merchant has an item. */
(function () {
  'use strict';
  var board = document.getElementById('navBoard');
  var summary = board && board.querySelector('summary');
  var menu = document.getElementById('boardMenuList');
  if (!menu || !board || !summary) return;

  // Move the menu out of the header so no ancestor can clip or flatten it.
  document.body.appendChild(menu);
  menu.setAttribute('role', 'menu');
  summary.setAttribute('aria-expanded', 'false');

  function placeMenu() {
    var r = summary.getBoundingClientRect();
    var width = Math.min(260, Math.max(220, window.innerWidth - 24));
    var left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    var top = Math.min(r.bottom + 6, window.innerHeight - 80);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.width = width + 'px';
    menu.style.minWidth = width + 'px';
  }
  function closeMenu() {
    menu.classList.remove('portal-open');
    summary.setAttribute('aria-expanded', 'false');
  }
  function openMenu() {
    placeMenu();
    menu.classList.add('portal-open');
    summary.setAttribute('aria-expanded', 'true');
  }
  summary.addEventListener('click', function (e) {
    e.preventDefault();
    if (menu.classList.contains('portal-open')) closeMenu(); else openMenu();
  });
  menu.addEventListener('click', function (e) {
    if (e.target.closest('a')) setTimeout(closeMenu, 80);
  });
  document.addEventListener('click', function (e) {
    if (!menu.contains(e.target) && !summary.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', function () { if (menu.classList.contains('portal-open')) placeMenu(); });
  window.addEventListener('scroll', closeMenu, { passive: true });

  var base = window.SETTLED_API_BASE || '/api';
  var names = { audio: 'Audio', lighting: 'Lighting', gadgets: 'Gadgets', general: 'General' };
  fetch(base + '/board').then(function (r) { return r.json(); }).then(function (res) {
    var posts = (res && res.posts) || [];
    var external = posts.filter(function (p) { return p.kind === 'external'; });
    if (!external.length) {
      menu.innerHTML = '<a href="post.html">No active boards yet — post the first item</a>';
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
      '<a href="post.html">Post an item</a>';
  }).catch(function () {
    // keep the static fallback links
  });
})();
