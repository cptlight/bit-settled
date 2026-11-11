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

let cache = { at: 0, key: '', peers: [] };
let inflight = null;

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

function response(self, peers, meta) {
  const nodes = [self, ...peers];
  return {
    network_id: self.network_id,
    count: nodes.length,
    reachable_count: nodes.filter((node) => node.reachable).length,
    generated_at: new Date().toISOString(),
    cached: Boolean(meta && meta.cached),
    seeds: (meta && meta.seeds) || [],
    nodes,
  };
}

/**
 * Self + peers for GET /api/network/nodes.
 * @param {{ self?: object, refresh?: boolean }} [options]
 */
async function nodes(options) {
  const opts = plainObject(options) || {};
  const self = selfNode(opts.self);
  const selfManifest = self.public_url ? self.public_url + MANIFEST_PATH : null;
  const seeds = seedUrls().filter((url) => url !== selfManifest);
  const key = seeds.join('\n');
  const fresh = cache.at > 0 && cache.key === key && Date.now() - cache.at < cacheMs();
  if (!opts.refresh && fresh) return response(self, cache.peers, { cached: true, seeds });
  const peers = await loadPeers(seeds, timeoutMs());
  return response(self, peers, { cached: false, seeds });
}

module.exports = {
  MANIFEST_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CACHE_MS,
  manifestUrl,
  seedUrls,
  selfNode,
  fetchPeer,
  nodes,
};
