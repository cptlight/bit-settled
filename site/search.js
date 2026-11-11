/* Apple-style live search. Suggestions are built from the public board API. */
(function () {
  'use strict';
  var form = document.getElementById('navSearchForm');
  var input = document.getElementById('navSearch');
  if (!form || !input) return;
  var base = window.SETTLED_API_BASE || '/api';
  var posts = [];
  var loaded = false;
  var loading = false;
  var active = -1;
  var items = [];
  var timer = null;

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  function money(v) { return '$' + Number(v || 0).toFixed(2).replace(/\.00$/, ''); }

  // Wrap the form so the suggestion panel can float beneath it.
  var shell = document.createElement('div');
  shell.className = 'nav-search-shell';
  form.parentNode.insertBefore(shell, form);
  shell.appendChild(form);

  var icon = document.createElement('span');
  icon.className = 'nav-search-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4.2 4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  form.insertBefore(icon, form.firstChild);

  var clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'nav-search-clear';
  clear.setAttribute('aria-label', 'Clear search');
  clear.innerHTML = '×';
  form.appendChild(clear);

  var panel = document.createElement('div');
  panel.className = 'nav-suggest';
  panel.id = 'navSuggest';
  panel.setAttribute('role', 'listbox');
  shell.appendChild(panel);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'navSuggest');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');

  function categoryLabel(b) {
    var map = { audio: 'Audio', lighting: 'Lighting', gadgets: 'Gadgets', general: 'General' };
    return map[b] || String(b || 'General').replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function load() {
    if (loaded || loading) return Promise.resolve(posts);
    loading = true;
    return fetch(base + '/board').then(function (r) { return r.json(); }).then(function (res) {
      posts = ((res && res.posts) || []).filter(function (p) { return p.kind === 'external'; });
      loaded = true; loading = false; return posts;
    }).catch(function () { loading = false; return posts; });
  }
  function recent() {
    try { return JSON.parse(localStorage.getItem('bitsettled_recent') || '[]').slice(0, 4); } catch (e) { return []; }
  }
  function saveRecent(q) {
    if (!q) return;
    try {
      var r = recent().filter(function (x) { return x.toLowerCase() !== q.toLowerCase(); });
      r.unshift(q); localStorage.setItem('bitsettled_recent', JSON.stringify(r.slice(0, 5)));
    } catch (e) {}
  }
  function itemRow(emoji, title, sub, href, price) {
    return '<a href="' + esc(href) + '" data-search-item role="option"><span class="s-emoji">' + esc(emoji || '◇') + '</span><span class="s-main"><span class="s-title">' + esc(title) + '</span><span class="s-sub">' + esc(sub) + '</span></span>' + (price ? '<span class="s-price">' + esc(price) + '</span>' : '') + '</a>';
  }
  function render() {
    var q = (input.value || '').trim().toLowerCase();
    var html = '';
    items = [];
    if (!q) {
      var rec = recent();
      if (rec.length) {
        html += '<div class="nav-suggest-label">Recent searches</div>';
        rec.forEach(function (r) { html += '<a href="#" data-search-item data-query="' + esc(r) + '" role="option"><span class="s-emoji">↺</span><span class="s-main"><span class="s-title">' + esc(r) + '</span></span></a>'; });
      }
      html += '<div class="nav-suggest-label">Popular categories</div>';
      var boards = {};
      posts.forEach(function (p) { boards[p.board] = (boards[p.board] || 0) + 1; });
      Object.keys(boards).slice(0, 5).forEach(function (b) {
        html += itemRow('▦', categoryLabel(b), boards[b] + ' active items', 'category.html?c=' + encodeURIComponent(b));
      });
      if (!Object.keys(boards).length) html += '<div class="s-empty">Search offers, wants, merchants and categories.</div>';
    } else {
      var matched = posts.filter(function (p) {
        return [p.title, p.body, p.author, p.category, p.merchant && p.merchant.name].join(' ').toLowerCase().indexOf(q) !== -1;
      });
      if (matched.length) {
        html += '<div class="nav-suggest-label">Items</div>';
        matched.slice(0, 6).forEach(function (p) {
          var range = p.published_range ? money(p.published_range.min) + '–' + money(p.published_range.max) : '';
          html += itemRow(p.poster_avatar || '◇', p.title, (p.merchant && p.merchant.name || p.author || 'Merchant') + ' · ' + categoryLabel(p.category), 'item.html?post=' + encodeURIComponent(p.id), range);
        });
        var cats = [];
        matched.forEach(function (p) { if (cats.indexOf(p.category) === -1) cats.push(p.category); });
        if (cats.length) {
          html += '<div class="nav-suggest-label">Categories</div>';
          cats.slice(0, 4).forEach(function (c) { html += itemRow('▦', c, 'Browse category', 'category.html?c=' + encodeURIComponent((c || 'general').toLowerCase())); });
        }
      } else {
        html = '<div class="s-empty">No matches for “' + esc(input.value.trim()) + '”. Press Enter to search all boards.</div>';
      }
    }
    panel.innerHTML = html;
    items = Array.prototype.slice.call(panel.querySelectorAll('[data-search-item]'));
    active = -1;
    panel.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
  }
  function close() { panel.classList.remove('open'); input.setAttribute('aria-expanded', 'false'); active = -1; }
  function highlight(n) {
    if (!items.length) return;
    active = (n + items.length) % items.length;
    items.forEach(function (a, i) { a.classList.toggle('active', i === active); });
    items[active].scrollIntoView({ block: 'nearest' });
  }
  function choose(el) {
    if (!el) return;
    var query = el.getAttribute('data-query');
    if (query) { input.value = query; saveRecent(query); close(); location.href = 'index.html?q=' + encodeURIComponent(query); return; }
    saveRecent(input.value.trim());
    close();
    location.href = el.getAttribute('href');
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (active >= 0 && items[active]) return choose(items[active]);
    var q = (input.value || '').trim();
    if (!q) return;
    saveRecent(q);
    close();
    location.href = 'index.html?q=' + encodeURIComponent(q);
  });
  input.addEventListener('focus', function () { load().then(render); });
  input.addEventListener('input', function () {
    clear.classList.toggle('show', Boolean(input.value));
    if (timer) clearTimeout(timer);
    timer = setTimeout(render, 90);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!panel.classList.contains('open')) render(); else highlight(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  clear.addEventListener('click', function () { input.value = ''; clear.classList.remove('show'); input.focus(); render(); });
  panel.addEventListener('mousedown', function (e) {
    var a = e.target.closest('[data-search-item]');
    if (!a) return;
    e.preventDefault(); choose(a);
  });
  document.addEventListener('click', function (e) { if (!shell.contains(e.target)) close(); });
  input.addEventListener('blur', function () { setTimeout(function () { if (!shell.contains(document.activeElement)) close(); }, 120); });
})();
