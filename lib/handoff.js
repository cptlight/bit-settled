'use strict';
/**
 * lib/handoff.js — EXPERIMENTAL signed cross-node handoff envelopes.
 *
 * A handoff is a signed deep link: "this post on my node should continue on
 * that node". It is NOT cross-node settlement — no funds, orders, contracts or
 * escrow move between nodes. The envelope carries the source node identity,
 * the validated target node, the item URL and an Ed25519 signature so the
 * target (or anyone) can verify who created it.
 *
 * Feature flag: HANDOFF_ENABLED=0 disables creation/read.
 */

const data = require('./data');
const network = require('./network');
const reputation = require('./reputation');

const SCHEMA = 'bitsettled-handoff/1';
const PEER_TIMEOUT_MS = 2500;
const MAX_STORED = 500;

function enabled() {
  return process.env.EXPERIMENTAL_FEDERATION !== '0' && process.env.HANDOFF_ENABLED !== '0';
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bad(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function selfNetworkId(self) {
  return text(self.network_id) || (process.env.NETWORK_ID || '').trim() || 'bitsettled-main';
}

function normalizeBase(value) {
  const s = text(value);
  return s ? s.replace(/\/+$/, '') : null;
}

function handoffStore() {
  if (!Array.isArray(data.state.network_handoffs)) data.state.network_handoffs = [];
  return data.state.network_handoffs;
}

/** Stable signing projection — field order is the serialization contract. */
function canonical(envelope) {
  return JSON.stringify({
    schema: envelope.schema,
    handoff_id: envelope.handoff_id,
    source_network_id: envelope.source_network_id,
    source_public_url: envelope.source_public_url,
    source_public_key: envelope.source_public_key,
    target: {
      network_id: envelope.target.network_id,
      name: envelope.target.name,
      public_url: envelope.target.public_url,
    },
    post_id: envelope.post_id,
    item_url: envelope.item_url,
    created_at: envelope.created_at,
  });
}

function verifyEnvelope(envelope) {
  if (!plainObject(envelope) || !plainObject(envelope.target)) return false;
  if (envelope.schema !== SCHEMA) return false;
  for (const field of ['handoff_id', 'source_network_id', 'source_public_key', 'post_id', 'item_url', 'created_at', 'signature']) {
    if (!text(envelope[field])) return false;
  }
  for (const field of ['network_id', 'name', 'public_url']) {
    if (!text(envelope.target[field])) return false;
  }
  return reputation.verifyMaterial(canonical(envelope), envelope.signature, envelope.source_public_key);
}

function sameNode(target, self) {
  const selfUrl = normalizeBase(self.public_url);
  if (selfUrl && target.public_url && selfUrl === normalizeBase(target.public_url)) return true;
  const selfId = text(self.network_id);
  return Boolean(selfId && selfId === target.network_id && !selfUrl && !target.public_url);
}

function targetFromManifest(manifestUrl, manifest) {
  const body = plainObject(manifest) || {};
  let origin = null;
  try {
    origin = new URL(manifestUrl).origin;
  } catch {
    origin = null;
  }
  return {
    network_id: text(body.network_id) || origin || manifestUrl,
    name: text(body.name) || 'Unnamed node',
    public_url: normalizeBase(body.public_url) || origin,
  };
}

async function resolveTarget(self, targetUrl) {
  const raw = text(targetUrl);
  if (raw) {
    const manifestUrl = network.manifestUrl(raw);
    if (!manifestUrl) throw bad(400, 'INVALID_TARGET', 'target_url must be an http(s) origin or manifest URL');
    const res = await network.fetchJson(manifestUrl, PEER_TIMEOUT_MS);
    if (!res.ok) throw bad(400, 'TARGET_UNREACHABLE', 'could not reach target manifest: ' + res.error);
    const target = targetFromManifest(manifestUrl, res.json);
    if (sameNode(target, plainObject(self) || {})) {
      throw bad(400, 'SAME_NODE', 'target must be a different node than the source');
    }
    return target;
  }
  let peers = [];
  try {
    const discovered = await network.nodes({ self });
    peers = discovered.nodes || [];
  } catch {
    peers = [];
  }
  const peer = peers.find((node) =>
    plainObject(node) && node.self !== true && !node.via && node.reachable === true && text(node.public_url)
  );
  if (!peer) {
    throw bad(400, 'TARGET_REQUIRED', 'target_url is required when no reachable peer is configured');
  }
  return {
    network_id: text(peer.network_id) || peer.public_url,
    name: text(peer.name) || 'Unnamed node',
    public_url: normalizeBase(peer.public_url),
  };
}

/**
 * Create, sign and persist a handoff envelope for a local post.
 * @param {{ self: object, post: object, target_url?: string }} options
 */
async function create(options) {
  const opts = plainObject(options) || {};
  const self = plainObject(opts.self) || {};
  const post = plainObject(opts.post);
  if (!post || !text(post.id)) throw bad(400, 'POST_REQUIRED', 'post_id is required');
  const target = await resolveTarget(self, opts.target_url);
  const sourcePublicUrl = normalizeBase(self.public_url);
  const envelope = {
    schema: SCHEMA,
    handoff_id: 'hoff_' + data.randHex(12),
    source_network_id: selfNetworkId(self),
    source_public_url: sourcePublicUrl,
    source_public_key: reputation.publicKeyPem(),
    target,
    post_id: String(post.id),
    item_url: (normalizeBase(target.public_url) || '') + '/item.html?post=' + encodeURIComponent(String(post.id)),
    created_at: data.nowIso(),
  };
  envelope.signature = reputation.signMaterial(canonical(envelope));
  const store = handoffStore();
  store.unshift(envelope);
  if (store.length > MAX_STORED) store.splice(MAX_STORED);
  return { handoff: envelope, verified: true, note: 'deep-link handoff; no cross-node settlement' };
}

/** Read a stored handoff envelope by id. */
function get(handoffId) {
  const id = text(handoffId);
  if (!id) return null;
  const envelope = handoffStore().find((entry) => plainObject(entry) && entry.handoff_id === id);
  if (!envelope) return null;
  return { handoff: envelope, verified: verifyEnvelope(envelope), note: 'deep-link handoff; no cross-node settlement' };
}

function reset() {
  data.state.network_handoffs = [];
}

module.exports = {
  SCHEMA,
  enabled,
  canonical,
  verifyEnvelope,
  create,
  get,
  reset,
};
