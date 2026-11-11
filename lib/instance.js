'use strict';
/** Public instance identity for self-hosted, distributed nodes. */

function env(name, fallback) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function info(paypalMode) {
  const publicUrl = (env('PUBLIC_SITE_URL', '') || env('PUBLIC_BASE_URL', '')).replace(/\/+$/, '');
  return {
    schema_version: 'bitsettled-instance/1',
    network_id: env('NETWORK_ID', 'bitsettled-main'),
    name: env('INSTANCE_NAME', 'bitsettled'),
    tagline: env('INSTANCE_TAGLINE', 'merchant offer agents settle'),
    public_url: publicUrl || null,
    mode: paypalMode === 'paypal' ? 'live' : 'sim',
    capabilities: ['board', 'offers', 'wants', 'bids', 'votes', 'close', 'mcp', 'escrow'],
    endpoints: {
      api: '/api',
      mcp: '/mcp',
      openapi: '/agent-openapi.json',
      board: '/api/board',
      manifest: '/.well-known/bitsettled.json',
    },
    fee_bps: Number(env('PLATFORM_FEE_BPS', '50')) || 50,
    updated_at: new Date().toISOString(),
  };
}

module.exports = { info };
