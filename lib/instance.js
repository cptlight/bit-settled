'use strict';
/** Public instance identity for self-hosted, distributed nodes. */

const reputation = require('./reputation');
const handoff = require('./handoff');

function env(name, fallback) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function info(paypalMode) {
  const publicUrl = (env('PUBLIC_SITE_URL', '') || env('PUBLIC_BASE_URL', '')).replace(/\/+$/, '');
  const capabilities = ['board', 'offers', 'wants', 'bids', 'votes', 'close', 'mcp', 'escrow'];
  if (reputation.enabled()) capabilities.push('reputation');
  if (handoff.enabled()) capabilities.push('handoff');
  return {
    schema_version: 'bitsettled-instance/1',
    network_id: env('NETWORK_ID', 'bitsettled-main'),
    name: env('INSTANCE_NAME', 'bitsettled'),
    tagline: env('INSTANCE_TAGLINE', 'merchant offer agents settle'),
    public_url: publicUrl || null,
    mode: paypalMode === 'paypal' ? 'live' : 'sim',
    capabilities,
    endpoints: {
      api: '/api',
      mcp: '/mcp',
      openapi: '/agent-openapi.json',
      board: '/api/board',
      manifest: '/.well-known/bitsettled.json',
      ...(reputation.enabled() ? { reputation: '/api/network/reputation' } : {}),
      ...(handoff.enabled() ? { handoff: '/api/network/handoff' } : {}),
    },
    // Public half of the node's Ed25519 receipt/handoff key (private half is
    // persisted only inside data.state). Null when the experimental APIs are off.
    reputation_public_key: reputation.enabled() ? reputation.publicKeyPem() : null,
    fee_bps: Number(env('PLATFORM_FEE_BPS', '50')) || 50,
    updated_at: new Date().toISOString(),
  };
}

module.exports = { info };
