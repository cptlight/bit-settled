'use strict';
/**
 * lib/reputation.js — EXPERIMENTAL portable settlement receipts (Ed25519).
 *
 * A node signs one receipt per settled side (merchant + buyer agent) when an
 * escrow-confirm captures payment. Receipts are self-contained and verify
 * offline against the node's public key, which is published in the instance
 * manifest as `reputation_public_key`.
 *
 * The private key lives only in data.state (the persisted state bucket); it is
 * never written elsewhere, logged or returned. Feature flag: REPUTATION_ENABLED=0.
 *
 * Scope note: this is reputation evidence, not settlement. A receipt proves a
 * node observed a settled deal; it does not move money or modify settlement.
 */

const crypto = require('crypto');
const data = require('./data');
const network = require('./network');
const persist = require('./persist');

const RECEIPT_SCHEMA = 'bitsettled-reputation-receipt/1';
const AGGREGATE_SCHEMA = 'bitsettled-reputation/1';
const OUTCOME = 'settled';
const PEER_TIMEOUT_MS = 2500;
const REQUIRED_FIELDS = [
  'schema', 'id', 'issuer_network_id', 'issuer_public_key',
  'subject_agent', 'role', 'post_id', 'outcome', 'issued_at', 'signature',
];

function enabled() {
  return process.env.EXPERIMENTAL_FEDERATION !== '0' && process.env.REPUTATION_ENABLED !== '0';
}

function networkId() {
  return (process.env.NETWORK_ID || '').trim() || 'bitsettled-main';
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeAgent(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// --- key material: persisted only in data.state ----------------------------
function storedKey() {
  return plainObject(data.state.reputation_key) ? data.state.reputation_key : null;
}

function assignKey(pair) {
  data.state.reputation_key = {
    alg: 'ed25519',
    private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    created_at: data.nowIso(),
  };
  return data.state.reputation_key;
}

/** Generate (once) and return the node's Ed25519 keypair. */
function ensureKey() {
  const existing = storedKey();
  if (existing && text(existing.private_key) && text(existing.public_key)) {
    try {
      crypto.createPrivateKey(existing.private_key);
      return existing;
    } catch {
      // Corrupt persisted key: fall through and generate a fresh identity.
    }
  }
  const pair = crypto.generateKeyPairSync('ed25519');
  const key = assignKey(pair);
  // Persist immediately when STATE_PATH is configured (debounced, state bucket).
  persist.schedule();
  return key;
}

function publicKeyPem() {
  // PEM exports carry a trailing newline; normalize so manifests, receipts and
  // handoff envelopes compare byte-for-byte across nodes.
  return ensureKey().public_key.trim();
}

function privateKeyObject() {
  return crypto.createPrivateKey(ensureKey().private_key);
}

/** Sign/verify a canonical JSON string with the node Ed25519 key (base64url). */
function signMaterial(material) {
  return crypto.sign(null, Buffer.from(material, 'utf8'), privateKeyObject()).toString('base64url');
}

function verifyMaterial(material, signature, publicKeyPemValue) {
  try {
    const key = crypto.createPublicKey(String(publicKeyPemValue || ''));
    return crypto.verify(null, Buffer.from(material, 'utf8'), key, Buffer.from(String(signature || ''), 'base64url'));
  } catch {
    return false;
  }
}

/** Stable signing projection — field order is the serialization contract. */
function canonicalReceipt(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    id: receipt.id,
    issuer_network_id: receipt.issuer_network_id,
    issuer_public_key: receipt.issuer_public_key,
    subject_agent: receipt.subject_agent,
    role: receipt.role,
    post_id: receipt.post_id,
    outcome: receipt.outcome,
    issued_at: receipt.issued_at,
  });
}

function verifyReceipt(receipt, issuerKeyPem) {
  if (!plainObject(receipt)) return { verified: false, reason: 'malformed_receipt' };
  if (REQUIRED_FIELDS.some((field) => typeof receipt[field] !== 'string' || !receipt[field])) {
    return { verified: false, reason: 'missing_fields' };
  }
  if (receipt.schema !== RECEIPT_SCHEMA) return { verified: false, reason: 'unknown_schema' };
  if (!issuerKeyPem) return { verified: false, reason: 'issuer_key_unknown' };
  if (String(receipt.issuer_public_key).trim() !== String(issuerKeyPem).trim()) {
    return { verified: false, reason: 'issuer_key_mismatch' };
  }
  if (!verifyMaterial(canonicalReceipt(receipt), receipt.signature, issuerKeyPem)) {
    return { verified: false, reason: 'signature_invalid' };
  }
  return { verified: true };
}

// --- local issuance --------------------------------------------------------
function receiptStore() {
  if (!Array.isArray(data.state.reputation_receipts)) data.state.reputation_receipts = [];
  return data.state.reputation_receipts;
}

function allReceipts() {
  return receiptStore().filter((receipt) => plainObject(receipt));
}

function listReceipts(agent) {
  const wanted = normalizeAgent(agent);
  if (!wanted) return [];
  return allReceipts().filter((receipt) => normalizeAgent(receipt.subject_agent) === wanted);
}

function issueReceipt(post, role, subjectAgent) {
  const postId = String(post.id);
  const subject = text(subjectAgent);
  if (!subject) return null;
  const existing = receiptStore().find((receipt) =>
    plainObject(receipt) &&
    receipt.post_id === postId &&
    receipt.role === role &&
    receipt.subject_agent === subject &&
    receipt.issuer_network_id === networkId()
  );
  if (existing) return existing;
  const receipt = {
    schema: RECEIPT_SCHEMA,
    id: 'rcpt_' + data.randHex(12),
    issuer_network_id: networkId(),
    issuer_public_key: publicKeyPem(),
    subject_agent: subject,
    role,
    post_id: postId,
    outcome: OUTCOME,
    issued_at: data.nowIso(),
  };
  receipt.signature = signMaterial(canonicalReceipt(receipt));
  receiptStore().unshift(receipt);
  return receipt;
}

/**
 * Issue the merchant + buyer-agent receipts for a settled post.
 * Idempotent: an existing receipt for (post, role, subject) is returned.
 * @param {object} post public board post (must have id, merchant/author, buyer_agent)
 * @returns {object[]} receipts (unsigned view backed by state)
 */
function issueSettlementReceipts(post) {
  if (!enabled() || !plainObject(post) || !text(post.id)) return [];
  const receipts = [];
  const merchant = (plainObject(post.merchant) && text(post.merchant.name)) || text(post.author);
  if (merchant) {
    const receipt = issueReceipt(post, 'merchant', merchant);
    if (receipt) receipts.push(receipt);
  }
  if (text(post.buyer_agent)) {
    const receipt = issueReceipt(post, 'buyer_agent', post.buyer_agent);
    if (receipt) receipts.push(receipt);
  }
  return receipts.map((receipt) => ({ ...receipt }));
}

// --- aggregation over local + direct peers ---------------------------------
function selfNodeOf(self) {
  const src = plainObject(self) || {};
  const publicUrl = text(src.public_url);
  return {
    network_id: text(src.network_id) || networkId(),
    name: text(src.name) || 'bitsettled',
    public_url: publicUrl ? publicUrl.replace(/\/+$/, '') : null,
    self: true,
    reachable: true,
  };
}

function decorated(receipt, result) {
  const out = { ...receipt, verified: result.verified === true };
  if (result.reason) out.reason = result.reason;
  return out;
}

function makeEntry(node, publicKey, receipts, extra) {
  const list = Array.isArray(receipts) ? receipts : [];
  const verifiedCount = list.filter((receipt) => receipt.verified === true).length;
  return {
    node,
    public_key: publicKey || null,
    count: list.length,
    verified_count: verifiedCount,
    unverified_count: list.length - verifiedCount,
    receipts: list,
    ...(extra || {}),
  };
}

function aggregateResponse(self, agent, nodes) {
  const all = nodes.reduce((acc, entry) => acc.concat(entry.receipts), []);
  const verifiedCount = all.filter((receipt) => receipt.verified === true).length;
  return {
    schema_version: AGGREGATE_SCHEMA,
    network_id: text(self.network_id) || networkId(),
    agent,
    generated_at: data.nowIso(),
    count: all.length,
    verified_count: verifiedCount,
    unverified_count: all.length - verifiedCount,
    nodes,
  };
}

function localEntry(self, agent) {
  const key = publicKeyPem();
  const receipts = listReceipts(agent).map((receipt) => decorated(receipt, verifyReceipt(receipt, key)));
  return makeEntry(selfNodeOf(self), key, receipts);
}

/** Extract a peer's own (local) receipts from its reputation response. */
function remoteLocalReceipts(json) {
  const body = plainObject(json);
  if (!body) return [];
  if (Array.isArray(body.nodes)) {
    const local = body.nodes.find((entry) => plainObject(entry) && plainObject(entry.node) && entry.node.self === true);
    if (local && Array.isArray(local.receipts)) return local.receipts;
  }
  return Array.isArray(body.receipts) ? body.receipts : [];
}

/** Fetch a peer manifest, its public key and its local receipts; never throws. */
async function peerEntry(peer, agent) {
  const base = String(peer.public_url || '').replace(/\/+$/, '');
  const node = {
    network_id: text(peer.network_id),
    name: text(peer.name) || base,
    public_url: base || null,
    self: false,
    reachable: true,
  };
  const errors = [];
  let publicKey = null;
  const manifest = await network.fetchJson(base + network.MANIFEST_PATH, PEER_TIMEOUT_MS);
  if (!manifest.ok) {
    errors.push('manifest: ' + manifest.error);
  } else if (manifest.json && typeof manifest.json.reputation_public_key === 'string') {
    publicKey = text(manifest.json.reputation_public_key);
  }
  const rep = await network.fetchJson(
    base + '/api/network/reputation?agent=' + encodeURIComponent(agent) + '&local=1',
    PEER_TIMEOUT_MS
  );
  if (!rep.ok) {
    errors.push('reputation: ' + rep.error);
    return makeEntry(node, publicKey, [], { reachable: false, error: errors.join('; ') });
  }
  const wanted = normalizeAgent(agent);
  const receipts = remoteLocalReceipts(rep.json)
    .filter((receipt) => plainObject(receipt) && normalizeAgent(receipt.subject_agent) === wanted)
    .map((receipt) => decorated(receipt, verifyReceipt(receipt, publicKey)));
  return makeEntry(node, publicKey, receipts, errors.length ? { error: errors.join('; ') } : {});
}

/**
 * Aggregate local receipts with reachable direct peers' local receipts.
 * @param {{ self?: object, agent: string, localOnly?: boolean, refresh?: boolean }} options
 */
async function aggregate(options) {
  const opts = plainObject(options) || {};
  const self = plainObject(opts.self) || {};
  const agent = text(opts.agent);
  if (!agent) {
    const err = new Error('agent query parameter is required');
    err.status = 400;
    err.code = 'AGENT_REQUIRED';
    throw err;
  }
  if (agent.length > 120) {
    const err = new Error('agent must be 120 characters or fewer');
    err.status = 400;
    err.code = 'INVALID_AGENT';
    throw err;
  }
  const nodes = [localEntry(self, agent)];
  if (opts.localOnly === true) return aggregateResponse(self, agent, nodes);
  let direct = [];
  try {
    const discovered = await network.nodes({ self, refresh: opts.refresh === true });
    direct = (discovered.nodes || []).filter((node) =>
      plainObject(node) && node.self !== true && !node.via && node.reachable === true && text(node.public_url)
    );
  } catch {
    direct = [];
  }
  const peers = await Promise.all(direct.map((peer) => peerEntry(peer, agent)));
  nodes.push(...peers);
  return aggregateResponse(self, agent, nodes);
}

/** Clear receipts on /api/reset but keep the node keypair (identity persists). */
function reset() {
  data.state.reputation_receipts = [];
}

module.exports = {
  RECEIPT_SCHEMA,
  AGGREGATE_SCHEMA,
  enabled,
  ensureKey,
  publicKeyPem,
  signMaterial,
  verifyMaterial,
  canonicalReceipt,
  verifyReceipt,
  issueSettlementReceipts,
  listReceipts,
  aggregate,
  reset,
};
