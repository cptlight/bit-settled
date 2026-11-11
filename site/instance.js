/* Apply the public instance identity to a self-hosted node. */
(function () {
  'use strict';
  var base = window.SETTLED_API_BASE || '/api';
  var endpoint = base.replace(/\/+$/, '') + '/instance';
  fetch(endpoint, { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (node) {
    if (!node) return;
    if (node.name) {
      document.querySelectorAll('.brand-copy b').forEach(function (el) { el.textContent = node.name; });
    }
    if (node.tagline) {
      document.querySelectorAll('.brand-copy small').forEach(function (el) { el.textContent = node.tagline; });
    }
    document.documentElement.setAttribute('data-network', node.network_id || '');
  }).catch(function () {});
})();
