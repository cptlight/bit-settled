'use strict';
/**
 * lib/handoff.js — EXPERIMENTAL signed cross-node handoff envelopes.
 *
 * A handoff is a signed deep link: "this post on my node should continue on
 * that node". It is NOT cross-node settlement — no funds, orders, contracts or
 * escrow move between nodes. The envelope carries the source node identity, the
 * validated target node, the item URL, an optional signed `context` and an
 * Ed25519 signature so the target (or anyone) can verify who created it.
 *
 * A target node can accept a handoff (POST /api/network/handoff/accept); the
 * acceptance is a local record only. Feature flags:
 *   HANDOFF_ENABLED=0         disables the whole handoff surface
 *   HANDOFF_ACCEPT_ENABLED=0  disables acceptance/list endpoints only
 */

const data = require('./data');
const network = require('./network');
const reputation = require('./reputation');

const SCHEMA = 'bitsettled-handoff/1';
const ACCEPTANCE_SCHEMA = 'bitsettled-handoff-acceptance/1';
const LIST_SCHEMA = 'bitsettled-handoffs/1';
const PEER_TIMEOUT_MS = 2500;
const MAX_STORED = 500;
const MAX_ACCEPTED = 1000;
const CONTEXT_FIELDS = ['post_id', 'price', 'buyer_agent', 'seller_agent', 'source_deal_id'];

function enabled() {
  return process.env.EXPERIMENTAL_FEDERATION !== '0' && process.env.HANDOFF_ENABLED !== '0';
}

/** Experimental acceptance surface (accept/list/read acceptance). */
function acceptEnabled() {
  return enabled() && process.env.HANDOFF_ACCEPT_ENABLED !== '0';
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

function acceptanceStore() {
  if (!Array.isArray(data.state.handoff_acceptances)) data.state.handoff_acceptances = [];
  return data.state.handoff_acceptances;
}

/** Stable signing projection for the optional context object. */
function contextProjection(context) {
  const src = plainObject(context);
  if (!src) return null;
  const out = {};
  for (const field of CONTEXT_FIELDS) {
    if (src[field] !== undefined) out[field] = src[field];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Validate/normalize an operator-supplied context. Throws 400 on bad types.
 * `expectedPostId` ties context.post_id to the envelope post id.
 */
function normalizeContext(context, expectedPostId) {
  if (context === undefined || context === null) return null;
  const src = plainObject(context);
  if (!src) throw bad(400, 'INVALID_CONTEXT', 'context must be an object');
  const out = {};
  if (src.post_id !== undefined && src.post_id !== null) {
    const postId = text(src.post_id);
    if (!postId) throw bad(400, 'INVALID_CONTEXT', 'context.post_id must be a non-empty string');
    if (expectedPostId && postId !== String(expectedPostId)) {
      throw bad(400, 'INVALID_CONTEXT', 'context.post_id must match the handoff post_id');
    }
    out.post_id = postId.slice(0, 200);
  }
  if (src.price !== undefined && src.price !== null) {
    const price = Number(src.price);
    if (!Number.isFinite(price) || price < 0) {
      throw bad(400, 'INVALID_CONTEXT', 'context.price must be a non-negative number');
    }
    out.price = price;
  }
  for (const field of ['buyer_agent', 'seller_agent', 'source_deal_id']) {
    if (src[field] === undefined || src[field] === null) continue;
    const value = text(src[field]);
    if (!value) throw bad(400, 'INVALID_CONTEXT', `context.${field} must be a non-empty string`);
    out[field] = value.slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

/** Stable signing projection — field order is the serialization contract.
 *  `context` is included only when present, so legacy envelopes keep their
 *  original canonical form and signatures. */
function canonical(envelope) {
  const payload = {
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
  };
  const context = contextProjection(envelope.context);
  if (context) payload.context = context;
  return JSON.stringify(payload);
}

function validContext(context, envelopePostId) {
  if (context === undefined || context === null) return true;
  const src = plainObject(context);
  if (!src) return false;
  if (src.post_id !== undefined && !text(src.post_id)) return false;
  if (text(src.post_id) && envelopePostId && text(src.post_id) !== text(envelopePostId)) return false;
  if (src.price !== undefined && !(typeof src.price === 'number' && Number.isFinite(src.price) && src.price >= 0)) return false;
  for (const field of ['buyer_agent', 'seller_agent', 'source_deal_id']) {
    if (src[field] !== undefined && !text(src[field])) return false;
  }
  return true;
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
  if (!validContext(envelope.context, envelope.post_id)) return false;
  return reputation.verifyMaterial(canonical(envelope), envelope.signature, envelope.source_public_key);
}

function sameNode(target, self) {
  const selfUrl = normalizeBase(self.public_url);
  if (selfUrl && target.public_url && selfUrl === normalizeBase(target.public_url)) return true;
  const selfId = text(self.network_id);
  return Boolean(selfId && selfId === target.network_id && !selfUrl && !target.public_url);
}

/** Does this envelope target the given (accepting) node? */
function matchesTarget(target, self) {
  const targetUrl = normalizeBase(target && target.public_url);
  const selfUrl = normalizeBase(self && self.public_url);
  if (targetUrl && selfUrl) return targetUrl === selfUrl;
  const targetId = text(target && target.network_id);
  const selfId = text(self && self.network_id);
  return Boolean(targetId && selfId && targetId === selfId);
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
 * @param {{ self: object, post: object, target_url?: string, context?: object }} options
 */
async function create(options) {
  const opts = plainObject(options) || {};
  const self = plainObject(opts.self) || {};
  const post = plainObject(opts.post);
  if (!post || !text(post.id)) throw bad(400, 'POST_REQUIRED', 'post_id is required');
  const target = await resolveTarget(self, opts.target_url);
  const sourcePublicUrl = normalizeBase(self.public_url);
  const context = normalizeContext(opts.context, String(post.id));
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
  if (context) envelope.context = context;
  envelope.signature = reputation.signMaterial(canonical(envelope));
  const store = handoffStore();
  store.unshift(envelope);
  if (store.length > MAX_STORED) store.splice(MAX_STORED);
  return { handoff: envelope, verified: true, note: 'deep-link handoff; no cross-node settlement' };
}

/** Read a stored handoff envelope by id (sync, source-local). */
function get(handoffId) {
  const id = text(handoffId);
  if (!id) return null;
  const envelope = handoffStore().find((entry) => plainObject(entry) && entry.handoff_id === id);
  if (!envelope) return null;
  return { handoff: envelope, verified: verifyEnvelope(envelope), note: 'deep-link handoff; no cross-node settlement' };
}

/** Read a stored envelope and, if it targets another node, ask that node
 *  whether the handoff was accepted (best effort; never throws). */
async function getWithAcceptance(handoffId, options) {
  const base = get(handoffId);
  if (!base) return null;
  const self = plainObject(options && options.self) || {};
  const result = { ...base, accepted: false, acceptance: null };
  if (!acceptEnabled()) return result;
  const target = plainObject(base.handoff.target) || {};
  const targetBase = normalizeBase(target.public_url);
  if (!targetBase) return result;
  if (matchesTarget(target, self)) {
    const local = getAccepted(base.handoff.handoff_id);
    if (local) {
      result.accepted = true;
      result.acceptance = local.acceptance;
    }
    return result;
  }
  const res = await network.fetchJson(
    targetBase + '/api/network/handoffs/' + encodeURIComponent(base.handoff.handoff_id),
    PEER_TIMEOUT_MS
  );
  if (res.ok && plainObject(res.json) && res.json.accepted === true) {
    result.accepted = true;
    result.acceptance = res.json.acceptance || res.json.record || res.json;
  }
  return result;
}

/** Resolve a handoff payload from a full envelope or from handoff_id + source_url. */
async function resolveHandoff(options) {
  const opts = plainObject(options) || {};
  const supplied = plainObject(opts.handoff);
  if (supplied) return supplied;
  const id = text(opts.handoff_id);
  const sourceUrl = normalizeBase(opts.source_url);
  if (!id) throw bad(400, 'HANDOFF_REQUIRED', 'handoff object or handoff_id is required');
  if (!sourceUrl) throw bad(400, 'SOURCE_URL_REQUIRED', 'source_url is required when handoff_id is used');
  const res = await network.fetchJson(
    sourceUrl + '/api/network/handoff/' + encodeURIComponent(id),
    PEER_TIMEOUT_MS
  );
  if (!res.ok) throw bad(400, 'SOURCE_UNREACHABLE', 'could not fetch handoff from source: ' + res.error);
  const envelope = plainObject(res.json) && plainObject(res.json.handoff) ? res.json.handoff : null;
  if (!envelope) throw bad(400, 'INVALID_HANDOFF', 'source did not return a handoff envelope');
  return envelope;
}

function acceptanceRecord(envelope, self, account) {
  const acceptedAt = data.nowIso();
  return {
    schema: ACCEPTANCE_SCHEMA,
    handoff_id: envelope.handoff_id,
    source_network_id: envelope.source_network_id,
    source_public_url: envelope.source_public_url || null,
    target_network_id: selfNetworkId(self),
    target_public_url: normalizeBase(self.public_url),
    post_id: envelope.post_id,
    item_url: envelope.item_url,
    context: envelope.context || null,
    accepted_by: account ? account.id : null,
    accepted_by_name: account ? account.display_name || null : null,
    accepted_at: acceptedAt,
    handoff_verified: true,
  };
}

function acceptResult(record, alreadyAccepted) {
  return {
    accepted: true,
    handoff_id: record.handoff_id,
    target_network_id: record.target_network_id,
    accepted_by: record.accepted_by,
    accepted_by_name: record.accepted_by_name,
    accepted_at: record.accepted_at,
    context: record.context,
    local_record: record,
    ...(alreadyAccepted ? { already_accepted: true } : {}),
  };
}

/**
 * Accept a signed handoff on this node. Verification is offline against the
 * envelope's source_public_key; the target must be this node. A record is
 * persisted — no funds/orders/contracts move.
 * @param {{ self: object, handoff?: object, handoff_id?: string, source_url?: string, account: object }} options
 */
async function accept(options) {
  if (!acceptEnabled()) throw bad(404, 'HANDOFF_ACCEPT_DISABLED', 'handoff acceptance is disabled');
  const opts = plainObject(options) || {};
  const self = plainObject(opts.self) || {};
  const envelope = await resolveHandoff(opts);
  if (!verifyEnvelope(envelope)) throw bad(400, 'INVALID_HANDOFF', 'handoff envelope signature is invalid');
  if (!matchesTarget(envelope.target, self)) {
    throw bad(409, 'TARGET_MISMATCH', 'handoff targets a different node');
  }
  const existing = getAccepted(envelope.handoff_id);
  if (existing) return acceptResult(existing.acceptance, true);
  const record = acceptanceRecord(envelope, self, opts.account);
  const store = acceptanceStore();
  store.unshift(record);
  if (store.length > MAX_ACCEPTED) store.splice(MAX_ACCEPTED);
  return acceptResult(record, false);
}

function list() {
  const records = acceptanceStore().filter((record) => plainObject(record));
  return { schema_version: LIST_SCHEMA, count: records.length, handoffs: records };
}

function getAccepted(handoffId) {
  const id = text(handoffId);
  if (!id) return null;
  const record = acceptanceStore().find((entry) => plainObject(entry) && entry.handoff_id === id);
  if (!record) return null;
  return { accepted: true, handoff_id: id, acceptance: record };
}

function reset() {
  data.state.network_handoffs = [];
  data.state.handoff_acceptances = [];
}

module.exports = {
  SCHEMA,
  ACCEPTANCE_SCHEMA,
  LIST_SCHEMA,
  enabled,
  acceptEnabled,
  canonical,
  normalizeContext,
  verifyEnvelope,
  create,
  get,
  getWithAcceptance,
  accept,
  list,
  getAccepted,
  reset,
};
