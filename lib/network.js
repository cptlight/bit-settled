'use strict';
/**
 * lib/network.js — seed-based discovery of independent bitsettled nodes.
 *
 * There is no central registry. Every node publishes its identity at
 * /.well-known/bitsettled.json (lib/instance.js); operators list the nodes they
 * want to discover in NETWORK_SEEDS, a comma-separated list of origins or
 * manifest URLs. This module fans out to those manifests with a short timeout,
 * caches the result briefly, dedupes, and returns self + peers.
 *
 * Failure isolation: a bad or unreachable seed never throws — it is reported
 * per node with reachable:false so one dead peer cannot break discovery.
 */

const MANIFEST_PATH = '/.well-known/bitsettled.json';
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_CACHE_MS = 30000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_BOARD_BYTES = 256 * 1024;
const MAX_NODES = 25;
const MAX_BOARD_PEERS = 8;
const MAX_BOARD_POSTS = 10;
const DEFAULT_BOARDS_CACHE_MS = 20000;
const DEFAULT_HOPS = 2;

let cache = { at: 0, key: '', peers: [] };
let inflight = null;
let gossipCache = { at: 0, key: '', nodes: [] };
let gossipInflight = null;
let boardsCache = { at: 0, key: '', nodes: [] };
let boardsInflight = null;

function envMs(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function timeoutMs() {
  return envMs('NETWORK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

function cacheMs() {
  return envMs('NETWORK_CACHE_MS', DEFAULT_CACHE_MS);
}

/** Transitive discovery depth. Default 2 = seed peers plus their peers. */
function hops() {
  const n = Number(process.env.NETWORK_HOPS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_HOPS;
}

function boardsCacheMs() {
  return envMs('NETWORK_BOARDS_CACHE_MS', DEFAULT_BOARDS_CACHE_MS);
}

/** Parse an http(s) URL, or return null. */
function cleanUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Normalize one NETWORK_SEEDS entry to a manifest URL.
 *   https://peer.example                     -> https://peer.example/.well-known/bitsettled.json
 *   peer.example:8080                        -> https://peer.example:8080/.well-known/bitsettled.json
 *   https://peer.example/custom/manifest.json -> unchanged
 */
function manifestUrl(seed) {
  let url = cleanUrl(seed);
  if (!url && typeof seed === 'string' && seed.trim()) {
    // Bare host[:port] is accepted as an https origin.
    url = cleanUrl('https://' + seed.trim());
  }
  if (!url) return null;
  url.hash = '';
  url.search = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname) url.pathname = MANIFEST_PATH;
  else if (/\.json$/i.test(pathname)) url.pathname = pathname;
  else if (!pathname.endsWith(MANIFEST_PATH)) url.pathname = pathname + MANIFEST_PATH;
  else url.pathname = pathname;
  return url.toString();
}

/** Normalized, deduped manifest URLs from NETWORK_SEEDS (or an explicit raw string). */
function seedUrls(raw) {
  const source = raw === undefined ? process.env.NETWORK_SEEDS : raw;
  const seen = new Set();
  const out = [];
  for (const part of String(source || '').split(/[,\n]+/)) {
    const url = manifestUrl(part);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function endpointsOf(manifest, manifestUrlValue) {
  const endpoints = plainObject(manifest && manifest.endpoints) ? { ...manifest.endpoints } : {};
  if (!endpoints.manifest) endpoints.manifest = manifestUrlValue;
  return endpoints;
}

/** This instance's node, built from lib/instance.js info. */
function selfNode(info) {
  const src = plainObject(info) || {};
  const publicUrl = trimmed(src.public_url);
  const normalizedPublicUrl = publicUrl ? publicUrl.replace(/\/+$/, '') : null;
  const endpoints = endpointsOf(src, MANIFEST_PATH);
  return {
    self: true,
    network_id: trimmed(src.network_id),
    name: trimmed(src.name) || 'bitsettled',
    tagline: typeof src.tagline === 'string' ? src.tagline : '',
    public_url: normalizedPublicUrl,
    mode: trimmed(src.mode) || 'unknown',
    endpoints,
    last_seen: new Date().toISOString(),
    reachable: true,
    manifest_url: normalizedPublicUrl ? normalizedPublicUrl + MANIFEST_PATH : MANIFEST_PATH,
  };
}

/** One peer node from a fetched manifest (or from a failed fetch). */
function peerNode(manifest, url, extra) {
  const m = plainObject(manifest) || {};
  const opts = plainObject(extra) || {};
  const fallbackUrl = originOf(url);
  const publicUrl = trimmed(m.public_url);
  const resolvedPublicUrl = publicUrl ? publicUrl.replace(/\/+$/, '') : fallbackUrl;
  const reachable = opts.reachable !== false;
  return {
    self: false,
    network_id: trimmed(m.network_id) || resolvedPublicUrl || url,
    name: trimmed(m.name) || hostOf(url),
    tagline: typeof m.tagline === 'string' ? m.tagline : '',
    public_url: resolvedPublicUrl,
    mode: trimmed(m.mode) || 'unknown',
    endpoints: endpointsOf(m, url),
    last_seen: opts.last_seen || (reachable ? new Date().toISOString() : null),
    reachable,
    manifest_url: url,
    ...(opts.error ? { error: opts.error } : {}),
  };
}

/** Fetch one peer manifest with a hard timeout; never throws. */
async function fetchPeer(url, ms) {
  const limit = Number.isFinite(ms) && ms > 0 ? ms : timeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_MANIFEST_BYTES) throw new Error('manifest too large');
    const text = await res.text();
    if (text.length > MAX_MANIFEST_BYTES) throw new Error('manifest too large');
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw new Error('manifest is not valid JSON');
    }
    if (!plainObject(manifest)) throw new Error('manifest is not a JSON object');
    return peerNode(manifest, url, { reachable: true });
  } catch (err) {
    const cause = err && err.cause;
    const causeCode = cause && (cause.code || (Array.isArray(cause.errors) && cause.errors[0] && cause.errors[0].code));
    const reason = err && err.name === 'AbortError'
      ? `timed out after ${limit}ms`
      : `${(err && err.message) || 'fetch failed'}${causeCode ? ` (${causeCode})` : ''}`;
    return peerNode(null, url, { reachable: false, error: reason });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse JSON with a hard timeout; never throws.
 * Returns { ok:true, json } or { ok:false, error }.
 */
async function fetchJson(url, ms, maxBytes) {
  const limit = Number.isFinite(ms) && ms > 0 ? ms : timeoutMs();
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_MANIFEST_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > cap) throw new Error('response too large');
    const text = await res.text();
    if (text.length > cap) throw new Error('response too large');
    return { ok: true, json: JSON.parse(text) };
  } catch (err) {
    const reason = err && err.name === 'AbortError'
      ? `timed out after ${limit}ms`
      : (err && err.message) || 'fetch failed';
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Keep the last successful last_seen when a later refresh fails. */
function preserveLastSeen(peers) {
  if (!cache.peers.length) return peers;
  const previous = new Map();
  for (const peer of cache.peers) {
    if (peer && peer.last_seen && peer.manifest_url) previous.set(peer.manifest_url, peer.last_seen);
  }
  for (const peer of peers) {
    if (!peer.reachable && !peer.last_seen && previous.has(peer.manifest_url)) {
      peer.last_seen = previous.get(peer.manifest_url);
    }
  }
  return peers;
}

/** Drop exact duplicate node identities (two seeds pointing at one node). */
function dedupePeers(peers) {
  const seen = new Set();
  const out = [];
  for (const peer of peers) {
    if (!peer) continue;
    const key = peer.reachable
      ? `${peer.network_id}|${peer.public_url || ''}`
      : `unreachable|${peer.manifest_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(peer);
  }
  return out;
}

/** Fetch all peers, coalescing concurrent refreshes and updating the cache. */
function loadPeers(seeds, ms) {
  const key = seeds.join('\n');
  if (inflight && inflight.key === key) return inflight.promise;
  const promise = (async () => {
    const fetched = await Promise.all(seeds.map((url) => fetchPeer(url, ms)));
    const peers = dedupePeers(preserveLastSeen(fetched));
    cache = { at: Date.now(), key, peers };
    return peers;
  })();
  inflight = { key, promise };
  promise.finally(() => {
    if (inflight && inflight.promise === promise) inflight = null;
  });
  return promise;
}

/** Direct peers for this self, from the 30s cache unless refresh is requested. */
async function directPeers(self, refresh) {
  const selfManifest = self.public_url ? self.public_url + MANIFEST_PATH : null;
  const seeds = seedUrls().filter((url) => url !== selfManifest);
  const key = seeds.join('\n');
  const fresh = cache.at > 0 && cache.key === key && Date.now() - cache.at < cacheMs();
  if (!refresh && fresh) return { peers: cache.peers, cached: true };
  const peers = await loadPeers(seeds, timeoutMs());
  return { peers, cached: false };
}

function nodeIdentity(node) {
  if (!plainObject(node)) return null;
  const id = trimmed(node.network_id) || '';
  const rawUrl = trimmed(node.public_url);
  const url = rawUrl ? rawUrl.replace(/\/+$/, '') : '';
  if (!id && !url) return null;
  return `${id}|${url}`;
}

/** True when a gossiped node is this instance (avoid self-loops). */
function isSelf(node, self) {
  if (!plainObject(node)) return false;
  const id = trimmed(node.network_id);
  const rawUrl = trimmed(node.public_url);
  const url = rawUrl ? rawUrl.replace(/\/+$/, '') : null;
  if (self.public_url && url === self.public_url) return true;
  if (!self.network_id || id !== self.network_id) return false;
  return !self.public_url || !url || url === self.public_url;
}

/** Normalize a node learned from a peer's /api/network/nodes response. */
function gossipNode(raw, via) {
  const publicUrl = trimmed(raw.public_url);
  const normalizedPublicUrl = publicUrl ? publicUrl.replace(/\/+$/, '') : null;
  const manifest = normalizedPublicUrl ? normalizedPublicUrl + MANIFEST_PATH : (trimmed(raw.manifest_url) || MANIFEST_PATH);
  return {
    self: false,
    network_id: trimmed(raw.network_id) || normalizedPublicUrl || 'unknown',
    name: trimmed(raw.name) || 'Unnamed node',
    tagline: typeof raw.tagline === 'string' ? raw.tagline : '',
    public_url: normalizedPublicUrl,
    mode: trimmed(raw.mode) || 'unknown',
    endpoints: endpointsOf(raw, manifest),
    last_seen: trimmed(raw.last_seen) || new Date().toISOString(),
    reachable: true,
    manifest_url: trimmed(raw.manifest_url) || manifest,
    via,
  };
}

function gossipKey(self, direct, depth) {
  const reachable = direct.filter((peer) => peer && peer.reachable && peer.public_url);
  return [depth, nodeIdentity(self), ...reachable.map(nodeIdentity)].join('|');
}

/**
 * One transitive gossip round: ask each reachable direct peer for its node list,
 * merge the nodes we do not already know, cap the fan-out and mark each node
 * with the direct peer it arrived `via`. Failures are skipped, never thrown.
 */
function loadGossip(self, direct, ms, depth) {
  const key = gossipKey(self, direct, depth);
  if (gossipInflight && gossipInflight.key === key) return gossipInflight.promise;
  const promise = (async () => {
    const targets = direct.filter((peer) => peer && peer.reachable && peer.public_url);
    const known = new Set([nodeIdentity(self)]);
    for (const peer of direct) known.add(nodeIdentity(peer));
    const room = Math.max(0, MAX_NODES - 1 - direct.length);
    const gossip = [];
    if (!room || !targets.length) {
      gossipCache = { at: Date.now(), key, nodes: gossip };
      return gossip;
    }
    const fetched = await Promise.all(targets.map(async (peer) => {
      const base = peer.public_url.replace(/\/+$/, '');
      // gossip=0 keeps reciprocal seed pairs (A seeds B, B seeds A) from
      // recursively asking each other for their transitive layers.
      const res = await fetchJson(base + '/api/network/nodes?gossip=0', ms);
      return res.ok && plainObject(res.json) && Array.isArray(res.json.nodes) ? res.json.nodes : [];
    }));
    for (let i = 0; i < fetched.length && gossip.length < room; i += 1) {
      const peer = targets[i];
      const via = peer.network_id || peer.public_url || peer.name;
      for (const raw of fetched[i]) {
        if (gossip.length >= room) break;
        if (!plainObject(raw) || raw.reachable === false || raw.self === true) continue;
        // A node carrying `via` is itself transitive; include it only when we
        // are allowed a third hop (NETWORK_HOPS >= 3).
        if (raw.via && depth < 3) continue;
        const id = nodeIdentity(raw);
        if (!id || known.has(id) || isSelf(raw, self)) continue;
        known.add(id);
        gossip.push(gossipNode(raw, via));
      }
    }
    gossipCache = { at: Date.now(), key, nodes: gossip };
    return gossip;
  })();
  gossipInflight = { key, promise };
  promise.finally(() => {
    if (gossipInflight && gossipInflight.promise === promise) gossipInflight = null;
  });
  return promise;
}

function response(self, peers, meta) {
  const opts = meta || {};
  const gossip = Array.isArray(opts.gossip) ? opts.gossip : [];
  const nodes = [self, ...peers, ...gossip];
  return {
    network_id: self.network_id,
    count: nodes.length,
    reachable_count: nodes.filter((node) => node.reachable).length,
    direct_count: peers.length,
    gossip_count: gossip.length,
    hops: opts.hops === undefined ? 1 : opts.hops,
    generated_at: new Date().toISOString(),
    cached: Boolean(opts.cached),
    seeds: opts.seeds || [],
    nodes,
  };
}

/**
 * Self + direct peers + (NETWORK_HOPS >= 2) transitive gossip nodes.
 * @param {{ self?: object, refresh?: boolean }} [options]
 */
async function nodes(options) {
  const opts = plainObject(options) || {};
  const self = selfNode(opts.self);
  const refresh = opts.refresh === true;
  const directState = await directPeers(self, refresh);
  const direct = directState.peers;
  // Callers that only need direct peers (e.g. our own gossip round) pass
  // gossip:false, which also keeps the reported hop count honest.
  const depth = opts.gossip === false ? 1 : hops();
  let cached = directState.cached;
  let gossip = [];
  if (depth >= 2) {
    const key = gossipKey(self, direct, depth);
    const fresh = gossipCache.at > 0 && gossipCache.key === key && Date.now() - gossipCache.at < cacheMs();
    if (!refresh && fresh) {
      gossip = gossipCache.nodes;
    } else {
      cached = false;
      gossip = await loadGossip(self, direct, timeoutMs(), depth);
    }
  }
  const selfManifest = self.public_url ? self.public_url + MANIFEST_PATH : null;
  const seeds = seedUrls().filter((url) => url !== selfManifest);
  return response(self, direct, { cached, seeds, gossip, hops: depth });
}

// ------------------------------------------------ cross-node boards --------

function boardPeerList(self, peers) {
  const seen = new Set();
  const targets = [];
  for (const peer of peers) {
    if (!peer || !peer.reachable || !peer.public_url) continue;
    const base = peer.public_url.replace(/\/+$/, '');
    if (self.public_url && base === self.public_url) continue;
    if (seen.has(base)) continue;
    seen.add(base);
    targets.push(peer);
    if (targets.length >= MAX_BOARD_PEERS) break;
  }
  return targets;
}

/** Keep only the public fields a cross-node board reader needs. */
function boardPost(raw, base) {
  if (!plainObject(raw) || raw.id === undefined || raw.id === null || raw.id === '') return null;
  const id = String(raw.id);
  const range = plainObject(raw.published_range);
  const min = Number(range && range.min);
  const max = Number(range && range.max);
  return {
    id,
    title: typeof raw.title === 'string' ? raw.title : '',
    category: trimmed(raw.category) || 'General',
    published_range: range && Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null,
    status: trimmed(raw.status) || 'open',
    item_url: `${base}/item.html?post=${encodeURIComponent(id)}`,
  };
}

async function fetchPeerBoard(peer, ms) {
  const base = peer.public_url.replace(/\/+$/, '');
  const node = {
    network_id: peer.network_id,
    name: peer.name,
    public_url: base,
    mode: peer.mode,
  };
  const res = await fetchJson(base + '/api/board', ms, MAX_BOARD_BYTES);
  if (!res.ok) return { node, posts: [], reachable: false, error: res.error };
  const rawPosts = plainObject(res.json) && Array.isArray(res.json.posts) ? res.json.posts : [];
  const external = rawPosts.filter((post) => post && (post.kind === 'external' || /^(ext_|want_)/.test(String(post.id))));
  const posts = external.slice(0, MAX_BOARD_POSTS).map((post) => boardPost(post, base)).filter(Boolean);
  return { node, posts, reachable: true };
}

function loadBoards(targets, ms) {
  const key = targets.map((peer) => `${peer.network_id}|${peer.public_url}`).join('|');
  if (boardsInflight && boardsInflight.key === key) return boardsInflight.promise;
  const promise = (async () => {
    const nodes = await Promise.all(targets.map((peer) => fetchPeerBoard(peer, ms)));
    boardsCache = { at: Date.now(), key, nodes };
    return nodes;
  })();
  boardsInflight = { key, promise };
  promise.finally(() => {
    if (boardsInflight && boardsInflight.promise === promise) boardsInflight = null;
  });
  return promise;
}

/**
 * Public posts from reachable direct peers for GET /api/network/boards.
 * @param {{ self?: object, refresh?: boolean }} [options]
 */
async function boards(options) {
  const opts = plainObject(options) || {};
  const self = selfNode(opts.self);
  const refresh = opts.refresh === true;
  const directState = await directPeers(self, refresh);
  const targets = boardPeerList(self, directState.peers);
  const key = targets.map((peer) => `${peer.network_id}|${peer.public_url}`).join('|');
  const fresh = boardsCache.at > 0 && boardsCache.key === key && Date.now() - boardsCache.at < boardsCacheMs();
  let nodes;
  let cached = false;
  if (!refresh && fresh) {
    nodes = boardsCache.nodes;
    cached = true;
  } else {
    nodes = await loadBoards(targets, timeoutMs());
  }
  return {
    network_id: self.network_id,
    count: nodes.length,
    total_posts: nodes.reduce((sum, entry) => sum + (Array.isArray(entry.posts) ? entry.posts.length : 0), 0),
    generated_at: new Date().toISOString(),
    cached,
    nodes,
  };
}

module.exports = {
  MANIFEST_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CACHE_MS,
  DEFAULT_HOPS,
  MAX_NODES,
  MAX_BOARD_PEERS,
  MAX_BOARD_POSTS,
  manifestUrl,
  seedUrls,
  selfNode,
  fetchPeer,
  fetchJson,
  nodes,
  boards,
};
