/* Runtime API target for both the hosted board and self-hosted installs. */
(function () {
  'use strict';
  var host = (location.hostname || '').toLowerCase();
  var hosted = host === 'bitsettled.com' || host === 'bitsettled.pages.dev' || /\.bitsettled\.com$/.test(host) || /\.bitsettled\.pages\.dev$/.test(host);
  var meta = document.querySelector('meta[name="settled-api-base"]');
  var override = meta && meta.getAttribute('content');
  window.SETTLED_API_BASE = override || (hosted ? 'https://cptlight-bit-settled.hf.space/api' : '/api');
  window.SETTLED_PUBLIC_ORIGIN = hosted ? 'https://cptlight-bit-settled.hf.space' : '';
  window.SETTLED_STANDALONE = true;
})();
