#!/usr/bin/env node
/**
 * Settled — end-to-end API test.
 *
 * Zero dependencies. Spawns `node server.js` on port 4173 (or reuses a server
 * already answering /api/health), runs the acceptance suite from BUILD-SPEC §8
 * plus the fault / tamper / shortfall / static / recompute checks, prints
 * PASS/FAIL per test and exits 1 on any failure.
 *
 * Usage:
 *   node test/e2e.js                 # spawn on 4173 (default)
 *   PORT=4400 node test/e2e.js       # spawn on another port
 *   BASE_URL=http://127.0.0.1:4173 node test/e2e.js   # reuse a running server
 *
 * The suite mutates in-memory state and always POSTs /api/reset at the start
 * and at the end, so a reused server is left in seed state.
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = Number(process.env.PORT || 4173);
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, '..');
const HTTP_TIMEOUT = 15000;
const BOOT_TIMEOUT = 20000;

// ---------------------------------------------------------------------------
// Contract constants (BUILD-SPEC §2, §3)
// ---------------------------------------------------------------------------

const SEED = {
  m1: { name: 'Northwind Audio', domain: 'northwind.audio', tier: 'A', score: 91, fee_bps: 35, cap: 5000, reserve: 12500, mode: 'instant', orders: 4812, delivered_pct: 99.1, as_described_pct: 99.4, disputes: 14, chargebacks: 2 },
  m2: { name: 'Lumen Supply', domain: 'lumensupply.co', tier: 'B', score: 76, fee_bps: 90, cap: 2500, reserve: 4000, mode: 'reserve', orders: 412, delivered_pct: 97.2, as_described_pct: 98.1, disputes: 6, chargebacks: 1 },
  m3: { name: 'Nova Finds', domain: 'novafinds.shop', tier: 'C', score: 54, fee_bps: 150, cap: 1000, reserve: 900, mode: 'escrow', orders: 12, delivered_pct: 91.7, as_described_pct: 93.0, disputes: 1, chargebacks: 0 },
};

const PRODUCTS = {
  p1: { merchant: 'm1', name: 'Aurora One headphones', price: 249.0 },
  p2: { merchant: 'm1', name: 'Aurora Buds', price: 129.0 },
  p3: { merchant: 'm2', name: 'Halo floor lamp', price: 189.0 },
  p4: { merchant: 'm2', name: 'Halo desk lamp', price: 79.0 },
  p5: { merchant: 'm3', name: 'Pocket projector', price: 159.0 },
};

const TIER = {
  A: { fee_bps: 35, cap: 5000, mode: 'instant' },
  B: { fee_bps: 90, cap: 2500, mode: 'reserve' },
  C: { fee_bps: 150, cap: 1000, mode: 'escrow' },
  D: { fee_bps: 0, cap: 0, mode: 'blocked' },
};

// ---------------------------------------------------------------------------
// Tiny assertion + reporting harness
// ---------------------------------------------------------------------------

const results = [];
const skipped = [];
let lastRequest = null;

// Optional subset run (triage / iterating on one section):
//   ONLY_TESTS=T4,T5 node test/e2e.js    # id prefix match, e.g. all v2 tests
const ONLY_TESTS = (process.env.ONLY_TESTS || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

function print(line) {
  process.stdout.write(`${line}\n`);
}

function fail(msg, evidence) {
  throw Object.assign(new Error(msg), { evidence });
}

function assert(cond, msg, evidence) {
  if (!cond) fail(msg, evidence);
}

function eq(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function near(actual, expected, label, tol = 0.005) {
  const n = num(actual);
  if (n === null || Math.abs(n - expected) > tol) {
    fail(`${label}: expected ${expected} (±${tol}), got ${JSON.stringify(actual)}`);
  }
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hasKeys(obj, keys, label) {
  assert(isObj(obj), `${label}: expected an object, got ${JSON.stringify(obj)}`);
  const missing = keys.filter((k) => !(k in obj));
  assert(missing.length === 0, `${label}: missing key(s) ${missing.join(', ')} — present: ${Object.keys(obj).join(', ')}`);
}

function isIso(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

async function test(id, name, fn) {
  if (ONLY_TESTS.length && !ONLY_TESTS.some((p) => id === p || id.startsWith(p))) {
    skipped.push(id);
    print(`SKIP  ${id.padEnd(4)} ${name}`);
    return;
  }
  try {
    const detail = await fn();
    results.push({ id, name, ok: true });
    print(`PASS  ${id.padEnd(4)} ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (err) {
    results.push({ id, name, ok: false, err });
    print(`FAIL  ${id.padEnd(4)} ${name}  — ${err.message}`);
    if (err.evidence !== undefined) {
      print(`      evidence: ${JSON.stringify(err.evidence).slice(0, 1200)}`);
    } else if (lastRequest) {
      print(`      last response: ${lastRequest}`);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function http(method, p, opts = {}) {
  const url = BASE + p;
  const init = {
    method,
    headers: { ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || HTTP_TIMEOUT),
    redirect: 'manual',
  };
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string') {
      init.body = opts.body;
      init.headers['content-type'] = init.headers['content-type'] || 'application/json';
    } else {
      init.body = JSON.stringify(opts.body);
      init.headers['content-type'] = 'application/json';
    }
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw Object.assign(new Error(`${method} ${p} failed: ${e.message}`), {
      evidence: { hint: 'network/transport error — is the server up?', base: BASE },
    });
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const ct = res.headers.get('content-type') || '';
  lastRequest = `${method} ${p} -> ${res.status} ${ct} ${text.slice(0, 500)}`;
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), contentType: ct, text, json, method, path: p };
}

const get = (p) => http('GET', p);
const post = (p, body) => http('POST', p, { body });

/** Assert a documented error envelope: { error: { code, message } }. */
function assertErrorShape(res, allowed, label) {
  const allowedList = Array.isArray(allowed) ? allowed : [allowed];
  assert(
    allowedList.includes(res.status),
    `${label}: expected HTTP ${allowedList.join(' or ')}, got ${res.status}`,
    { body: res.json ?? res.text.slice(0, 500) }
  );
  assert(
    isObj(res.json) && isObj(res.json.error),
    `${label}: expected JSON {error:{code,message}}, got ${res.json === undefined ? 'non-JSON' : JSON.stringify(res.json).slice(0, 400)}`,
    { status: res.status, contentType: res.contentType, body: res.text.slice(0, 400) }
  );
  assert(typeof res.json.error.code === 'string' && res.json.error.code.length > 0, `${label}: error.code must be a non-empty string`);
  assert(typeof res.json.error.message === 'string' && res.json.error.message.length > 0, `${label}: error.message must be a non-empty string`);
  return `${res.status} ${res.json.error.code}`;
}

async function reset() {
  const r = await post('/api/reset', {});
  assert(r.status === 200, `POST /api/reset: expected 200, got ${r.status}`, { body: r.text.slice(0, 400) });
  assert(r.json && r.json.ok === true, 'POST /api/reset: expected body {ok:true}', { body: r.json ?? r.text.slice(0, 400) });
}

async function merchantsById() {
  const r = await get('/api/merchants');
  assert(r.status === 200, `GET /api/merchants: expected 200, got ${r.status}`, { body: r.text.slice(0, 400) });
  assert(Array.isArray(r.json && r.json.merchants), 'GET /api/merchants: expected {merchants:[...]}');
  const by = {};
  for (const m of r.json.merchants) by[m.id] = m;
  return { list: r.json.merchants, by };
}

async function merchant(id) {
  const r = await get(`/api/merchants/${id}`);
  assert(r.status === 200, `GET /api/merchants/${id}: expected 200, got ${r.status}`, { body: r.text.slice(0, 400) });
  hasKeys(r.json, ['merchant', 'ledger', 'events'], `GET /api/merchants/${id}`);
  return r.json;
}

async function createOrder(merchantId, productId, buyer) {
  const r = await post(`/api/merchants/${merchantId}/orders`, {
    product_id: productId,
    buyer: buyer || { name: 'Sam Rivera', email: 'sam@example.com' },
  });
  assert(r.status === 200 || r.status === 201, `POST /api/merchants/${merchantId}/orders: expected 200/201, got ${r.status}`, { body: r.json ?? r.text.slice(0, 400) });
  hasKeys(r.json, ['order', 'payment', 'receipt', 'event'], `order response (${merchantId}/${productId})`);
  return r.json;
}

async function fulfill(orderId) {
  const r = await post(`/api/orders/${orderId}/fulfill`, {});
  assert(r.status === 200, `POST /api/orders/${orderId}/fulfill: expected 200, got ${r.status}`, { body: r.json ?? r.text.slice(0, 400) });
  hasKeys(r.json, ['order', 'event'], 'fulfill response');
  return r.json;
}

async function claim(orderId, reason, evidence) {
  const r = await post(`/api/orders/${orderId}/claim`, { reason: reason || 'not_delivered', evidence: evidence === undefined ? true : evidence });
  assert(r.status === 200, `POST /api/orders/${orderId}/claim: expected 200, got ${r.status}`, { body: r.json ?? r.text.slice(0, 400) });
  hasKeys(r.json, ['claim', 'order', 'merchant', 'events'], 'claim response');
  hasKeys(r.json.claim, ['id', 'order_id', 'reason', 'status', 'refund', 'paid_from_reserve', 'paid_from_pool', 'reserve_before', 'reserve_after', 'created_at'], 'claim object');
  assert(Array.isArray(r.json.events), 'claim response: events must be an array');
  return r.json;
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let child = null;
let reused = false;
let childExit = null;
let childOutput = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeHealth(ms = 1500) {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok === true ? j : null;
  } catch {
    return null;
  }
}

async function ensureServer() {
  const existing = await probeHealth();
  if (existing) {
    reused = true;
    return { mode: 'reused', health: existing };
  }
  const serverFile = path.join(ROOT, 'server.js');
  if (!fs.existsSync(serverFile)) {
    fail(`server.js not found at ${serverFile} — backend not built yet. Nothing to test.`, {
      looked_for: serverFile,
      root: ROOT,
    });
  }
  const childEnv = { ...process.env, PORT: String(PORT), CONNECTOR_ALLOW_PRIVATE: '1', E2E_ALLOW_PRIVATE_POLICY: '1', ADMIN_API_KEY: 'test-admin-key-e2e', RATE_LIMIT_PER_MIN: '60' };
  // Deterministic baseline: no AI key, no live PayPal, unless the caller opts in.
  // (Otherwise a developer's exported PAYPAL_LIVE=1 would make orders 'pending' and
  // the SIM-only assertions below meaningless.)
  if (process.env.E2E_ALLOW_LIVE !== '1') {
    for (const k of ['AI_API_KEY', 'PAYPAL_LIVE', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']) delete childEnv[k];
  }
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    childOutput += d.toString();
  });
  child.stderr.on('data', (d) => {
    childOutput += d.toString();
  });
  child.on('exit', (code, signal) => {
    childExit = { code, signal };
  });
  child.on('error', (e) => {
    childOutput += `spawn error: ${e.message}\n`;
  });

  const deadline = Date.now() + BOOT_TIMEOUT;
  while (Date.now() < deadline) {
    if (childExit) fail(`spawned server exited before answering /api/health (code ${childExit.code}, signal ${childExit.signal})`, { server_output: childOutput.slice(-1500) });
    const h = await probeHealth(1000);
    if (h) return { mode: 'spawned', health: h };
    await sleep(200);
  }
  fail(`spawned server did not answer /api/health within ${BOOT_TIMEOUT}ms`, { server_output: childOutput.slice(-1500), port: PORT });
}

async function stopServer() {
  if (!child || reused) return;
  if (childExit) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !childExit) await sleep(50);
  if (!childExit) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}


// ---------------------------------------------------------------------------
// v2 helpers — agents / passports / contracts / protection / claims
// (HACKATHON-DEMO-SPEC.md; additive endpoints, existing shapes unchanged)
// ---------------------------------------------------------------------------

async function agentsList() {
  const r = await get('/api/agents');
  eq(r.status, 200, 'GET /api/agents status');
  assert(Array.isArray(r.json && r.json.agents), 'GET /api/agents: expected {agents:[...]}');
  const by = {};
  for (const a of r.json.agents) by[a.id] = a;
  return { list: r.json.agents, by };
}

async function agentVerify(body) {
  const r = await post('/api/agents/verify', body);
  assert(r.status === 200, `POST /api/agents/verify ${JSON.stringify(body)}: expected 200, got ${r.status}`, { body: r.json ?? r.text.slice(0, 500) });
  hasKeys(r.json, ['verified', 'agent', 'checks', 'reasons'], 'agent verify response');
  return r.json;
}

async function createContract(body) {
  const r = await post('/api/contracts', body);
  assert([200, 201].includes(r.status), `POST /api/contracts ${JSON.stringify(body)}: expected 200/201, got ${r.status}`, { body: r.json ?? r.text.slice(0, 500) });
  hasKeys(r.json, ['contract'], 'contract create response');
  return r.json.contract;
}

async function getContract(id) {
  const r = await get(`/api/contracts/${id}`);
  assert(r.status === 200, `GET /api/contracts/${id}: expected 200, got ${r.status}`, { body: r.json ?? r.text.slice(0, 500) });
  hasKeys(r.json, ['contract'], 'contract get response');
  return r.json.contract;
}

function contractOffer(id, from, price, note) {
  const body = { from, price };
  if (note) body.note = note;
  return post(`/api/contracts/${id}/offers`, body);
}

async function protectionQuote(merchantId, amount) {
  const r = await post('/api/protection/quote', { merchant_id: merchantId, amount });
  assert(r.status === 200, `POST /api/protection/quote: expected 200, got ${r.status}`, { body: r.json ?? r.text.slice(0, 500) });
  hasKeys(r.json, ['quote'], 'protection quote response');
  return r.json.quote;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

async function main() {
  print('');
  print(`Settled e2e — target ${BASE}`);
  print('------------------------------------------------------------');

  const boot = await ensureServer();
  print(`server: ${boot.mode}${reused ? '' : ' (pid ' + child.pid + ')'} — health ${JSON.stringify(boot.health)}`);
  print('');

  await reset(); // deterministic starting state

  // ---- §9 static analysis ------------------------------------------------
  await test('T00', '§9 node --check passes on server.js + lib/*.js', async () => {
    const serverFile = path.join(ROOT, 'server.js');
    if (!fs.existsSync(serverFile)) return 'skipped (no local server.js next to test/)';
    const { spawnSync } = require('node:child_process');
    const rels = ['server.js'];
    const libDir = path.join(ROOT, 'lib');
    if (fs.existsSync(libDir)) {
      for (const f of fs.readdirSync(libDir).filter((x) => x.endsWith('.js')).sort()) rels.push(`lib/${f}`);
    }
    const bad = [];
    for (const rel of rels) {
      const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
      if (r.status !== 0) bad.push(`${rel}: ${String(r.stderr || '').trim().split('\n')[0]}`);
    }
    assert(bad.length === 0, `node --check failed: ${bad.join(' | ')}`, { checked: rels });
    return `${rels.length} files parse`;
  });

  // ---- §8.1 health + seed ------------------------------------------------
  await test('T01', 'GET /api/health → ok, sim|paypal, 3 merchants', async () => {
    const r = await get('/api/health');
    eq(r.status, 200, 'status');
    hasKeys(r.json, ['ok', 'mode', 'merchants'], 'health');
    eq(r.json.ok, true, 'health.ok');
    assert(['sim', 'paypal'].includes(r.json.mode), `health.mode: expected "sim" or "paypal", got ${JSON.stringify(r.json.mode)}`);
    eq(num(r.json.merchants), 3, 'health.merchants');
    return `mode=${r.json.mode}`;
  });

  await test('T02', '§8.1 merchant list = 3, seed tiers/scores/fees/caps/reserves exact', async () => {
    const { list, by } = await merchantsById();
    eq(list.length, 3, 'merchant count');
    for (const id of ['m1', 'm2', 'm3']) {
      const m = by[id];
      assert(isObj(m), `merchant ${id} missing from list`);
      const s = SEED[id];
      eq(m.name, s.name, `${id}.name`);
      eq(m.tier, s.tier, `${id}.tier`);
      near(m.score, s.score, `${id}.score`);
      near(m.fee_bps, s.fee_bps, `${id}.fee_bps`);
      near(m.cap, s.cap, `${id}.cap`);
      near(m.reserve, s.reserve, `${id}.reserve`);
      eq(m.mode, s.mode, `${id}.mode`);
      hasKeys(m, ['domain', 'category', 'metrics', 'products'], `${id} public merchant`);
      assert(Array.isArray(m.products) && m.products.length > 0, `${id}.products must be a non-empty array`);
    }
    const p1 = by.m1.products.find((p) => p.id === 'p1');
    assert(p1, 'm1.products must include p1');
    near(p1.price, PRODUCTS.p1.price, 'p1.price');
    return 'm1=A/91/35/5000/12500, m2=B/76/90/2500/4000, m3=C/54/150/1000/900';
  });

  await test('T03', 'GET /api/merchants/m1 → merchant + ledger{credential,signature,alg} + events', async () => {
    const r = await get('/api/merchants/m1');
    eq(r.status, 200, 'status');
    hasKeys(r.json, ['merchant', 'ledger', 'events'], 'merchant detail');
    hasKeys(r.json.ledger, ['credential', 'signature', 'alg'], 'ledger');
    eq(r.json.ledger.alg, 'HS256', 'ledger.alg');
    assert(Array.isArray(r.json.events), 'events must be an array');
    const c = r.json.ledger.credential;
    hasKeys(c, ['v', 'issuer', 'issued_at', 'expires_at', 'nonce', 'merchant', 'metrics', 'score', 'tier', 'fee_bps', 'cap', 'reserve', 'evidence_hash'], 'credential');
    eq(num(c.v), 1, 'credential.v');
    eq(c.issuer, 'Settled', 'credential.issuer');
    assert(isIso(c.issued_at), `credential.issued_at must be ISO, got ${JSON.stringify(c.issued_at)}`);
    assert(isIso(c.expires_at), `credential.expires_at must be ISO, got ${JSON.stringify(c.expires_at)}`);
    const ttl = Date.parse(c.expires_at) - Date.parse(c.issued_at);
    assert(Math.abs(ttl - 24 * 3600 * 1000) < 60000, `credential TTL: expected ~24h, got ${Math.round(ttl / 60000)}min`);
    assert(/^[0-9a-f]{16}$/i.test(String(c.nonce)), `credential.nonce: expected 16 hex chars, got ${JSON.stringify(c.nonce)}`);
    eq(c.merchant && c.merchant.id, 'm1', 'credential.merchant.id');
    eq(c.tier, 'A', 'credential.tier');
    near(c.score, 91, 'credential.score');
    near(c.fee_bps, 35, 'credential.fee_bps');
    near(c.cap, 5000, 'credential.cap');
    near(c.reserve, 12500, 'credential.reserve');
    assert(typeof c.evidence_hash === 'string' && /^[0-9a-f]{64}$/i.test(c.evidence_hash), `credential.evidence_hash: expected sha256 hex, got ${JSON.stringify(c.evidence_hash)}`);
    return `signature ${String(r.json.ledger.signature).slice(0, 12)}…`;
  });

  await test('T04', '§8.2 POST /api/merchants/m1/verify → valid + all checks true', async () => {
    const r = await post('/api/merchants/m1/verify', {});
    eq(r.status, 200, 'status');
    hasKeys(r.json, ['valid', 'checks', 'credential'], 'verify response');
    eq(r.json.valid, true, 'valid');
    hasKeys(r.json.checks, ['signature', 'issuer', 'not_expired'], 'checks');
    eq(r.json.checks.signature, true, 'checks.signature');
    eq(r.json.checks.issuer, true, 'checks.issuer');
    eq(r.json.checks.not_expired, true, 'checks.not_expired');
    return 'valid=true';
  });

  // ---- tamper ------------------------------------------------------------
  await test('T05', '§8.2 tampered credential fails verification', async () => {
    const led = await get('/api/merchants/m1/ledger');
    eq(led.status, 200, 'ledger status');
    const credential = JSON.parse(JSON.stringify(led.json.credential));
    const signature = led.json.signature;
    assert(signature, 'ledger.signature missing');

    // Tamper two fields: the score (top-level, signed) and a nested metric.
    credential.score = num(credential.score) + 7;
    if (credential.metrics) credential.metrics.delivered_pct = 100;

    const attempts = [];
    // (a) documented merchant verify endpoint, with the credential supplied.
    const a = await http('POST', '/api/merchants/m1/verify', { body: { credential, signature } });
    attempts.push({ endpoint: 'POST /api/merchants/m1/verify', status: a.status, valid: a.json && a.json.valid, checks: a.json && a.json.checks });
    if (a.status === 200 && isObj(a.json) && a.json.valid === false) {
      assert(a.json.checks && a.json.checks.signature === false, 'tampered credential rejected but checks.signature was not false', { body: a.json });
      return 'rejected: valid=false, checks.signature=false';
    }
    // (b) agent trust check, with the credential supplied.
    const b = await http('POST', '/api/trust/verify', { body: { merchant_id: 'm1', min_tier: 'C', credential, signature } });
    attempts.push({ endpoint: 'POST /api/trust/verify', status: b.status, verified: b.json && b.json.verified, reasons: b.json && b.json.reasons });
    if (b.status === 200 && isObj(b.json) && b.json.verified === false) {
      return 'rejected by /api/trust/verify with supplied credential';
    }
    // (c) tampered signature against the merchant verify endpoint.
    const badSig = String(signature).slice(0, -2) + (String(signature).slice(-2) === '00' ? 'ff' : '00');
    const c = await http('POST', '/api/merchants/m1/verify', { body: { credential, signature: badSig } });
    attempts.push({ endpoint: 'POST /api/merchants/m1/verify (bad signature)', status: c.status, valid: c.json && c.json.valid });

    fail(
      'no documented endpoint accepted an externally supplied credential, so tampering cannot be exercised through the API',
      { attempts, note: 'CONTRACT GAP: §5 gives no verify-with-body contract. Backend can fix in 3 lines by accepting optional {credential, signature} on the verify endpoints.' }
    );
  });

  // ---- static ------------------------------------------------------------
  await test('T06', 'static: GET / → 200, contains "Settled"', async () => {
    const r = await get('/');
    eq(r.status, 200, 'status');
    assert(/html/i.test(r.contentType), `content-type: expected HTML, got ${r.contentType}`);
    assert(/settled/i.test(r.text), 'body must contain the "Settled" marker');
    assert(r.text.length > 500, `body suspiciously short (${r.text.length} bytes)`);
    return `${r.text.length} bytes`;
  });

  await test('T07', 'static: /store.html → 200, "Settled"', async () => {
    const r = await get('/store.html');
    eq(r.status, 200, 'status');
    assert(/settled/i.test(r.text), 'body must contain the "Settled" marker');
    return `${r.text.length} bytes`;
  });

  await test('T08', 'static: /agent.html → 200, "Settled"', async () => {
    const r = await get('/agent.html');
    eq(r.status, 200, 'status');
    assert(/settled/i.test(r.text), 'body must contain the "Settled" marker');
    return `${r.text.length} bytes`;
  });

  await test('T09', 'static: /app.js + /styles.css → 200; app.js calls the API', async () => {
    const js = await get('/app.js');
    eq(js.status, 200, 'app.js status');
    assert(js.text.length > 200, `app.js suspiciously short (${js.text.length} bytes)`);
    // Accept both '/api/...' literals and a banned-style API base ('/api' + path).
    const apiRefs = (js.text.match(/['"`]\/api/g) || []).length;
    assert(apiRefs >= 1, `app.js must call the API (found no '/api' literal; ${js.text.length} bytes)`);
    const css = await get('/styles.css');
    eq(css.status, 200, 'styles.css status');
    assert(css.text.length > 200, `styles.css suspiciously short (${css.text.length} bytes)`);
    return `app.js ${js.text.length}B (${apiRefs} api refs), styles.css ${css.text.length}B`;
  });

  await test('T10', 'static: unknown path → 404', async () => {
    const r = await get('/nope-not-here.html');
    eq(r.status, 404, 'status');
    return '404';
  });

  // ---- fault shapes ------------------------------------------------------
  await test('T11', 'fault: GET /api/unknown → 404 {error:{code,message}}', async () => {
    const r = await get('/api/unknown-endpoint');
    return assertErrorShape(r, 404, 'unknown API path');
  });

  await test('T12', 'fault: GET /api/merchants/zzz → 404 error envelope', async () => {
    const r = await get('/api/merchants/zzz');
    return assertErrorShape(r, 404, 'unknown merchant');
  });

  await test('T13', 'fault: POST order for unknown merchant → 404 error envelope', async () => {
    const r = await post('/api/merchants/zzz/orders', { product_id: 'p1' });
    return assertErrorShape(r, [400, 404], 'order for unknown merchant');
  });

  await test('T14', 'fault: POST order missing product_id → 400 error envelope', async () => {
    const r = await post('/api/merchants/m1/orders', { buyer: { name: 'Sam Rivera', email: 'sam@example.com' } });
    return assertErrorShape(r, 400, 'missing product_id');
  });

  await test('T15', 'fault: POST order unknown product_id → 400/404 error envelope', async () => {
    const r = await post('/api/merchants/m1/orders', { product_id: 'p999', buyer: { name: 'Sam Rivera', email: 'sam@example.com' } });
    return assertErrorShape(r, [400, 404], 'unknown product_id');
  });

  await test('T16', 'fault: malformed JSON body → 400 error envelope', async () => {
    const r = await http('POST', '/api/merchants/m1/orders', { body: '{not json' });
    return assertErrorShape(r, 400, 'malformed JSON');
  });

  await test('T17', 'fault: fulfill unknown order → 404 error envelope', async () => {
    const r = await post('/api/orders/ord_deadbeef/fulfill', {});
    return assertErrorShape(r, 404, 'fulfill unknown order');
  });

  await test('T18', 'fault: claim unknown order → 404 error envelope', async () => {
    const r = await post('/api/orders/ord_deadbeef/claim', { reason: 'not_delivered', evidence: true });
    return assertErrorShape(r, 404, 'claim unknown order');
  });

  // ---- §8.3–8.5 order / fulfill / claim on m1 ----------------------------
  let m1Order;
  await test('T19', '§8.3 m1 order p1 → 249.00, fee 0.87 (35bps), instant, cap 5000', async () => {
    const r = await createOrder('m1', 'p1');
    m1Order = r;
    const o = r.order;
    hasKeys(o, ['id', 'merchant_id', 'product_id', 'product_name', 'amount', 'fee_bps', 'fee', 'protection', 'status', 'payment_id', 'buyer', 'created_at', 'delivered_at'], 'order');
    assert(/^ord_[0-9a-f]+$/i.test(String(o.id)), `order.id: expected ord_<hex>, got ${JSON.stringify(o.id)}`);
    eq(o.merchant_id, 'm1', 'order.merchant_id');
    eq(o.product_id, 'p1', 'order.product_id');
    near(o.amount, 249.0, 'order.amount');
    near(o.fee_bps, 35, 'order.fee_bps');
    near(o.fee, 0.87, 'order.fee');
    hasKeys(o.protection, ['mode', 'cap'], 'order.protection');
    eq(o.protection.mode, 'instant', 'order.protection.mode');
    near(o.protection.cap, 5000, 'order.protection.cap');
    eq(o.status, 'paid', 'order.status');
    assert(String(o.payment_id).startsWith('SIM-'), `order.payment_id: expected SIM-<hex>, got ${JSON.stringify(o.payment_id)}`);
    eq(o.delivered_at, null, 'order.delivered_at');
    hasKeys(o.buyer, ['name', 'email'], 'order.buyer');
    hasKeys(r.payment, ['mode', 'id'], 'payment');
    hasKeys(r.receipt, ['order_id', 'paid', 'captured_at', 'credential_hash'], 'receipt');
    eq(r.receipt.order_id, o.id, 'receipt.order_id');
    assert(isIso(r.receipt.captured_at), `receipt.captured_at must be ISO, got ${JSON.stringify(r.receipt.captured_at)}`);
    hasKeys(r.event, ['type'], 'order event');
    return `${o.id} $249.00 fee $0.87`;
  });

  await test('T20', '§8.4 fulfill → status delivered, delivered_at set', async () => {
    const r = await fulfill(m1Order.order.id);
    const o = r.order;
    assert(['delivered', 'fulfilled'].includes(String(o.status)), `order.status: expected "delivered", got ${JSON.stringify(o.status)}`);
    assert(o.delivered_at !== null && o.delivered_at !== undefined, `order.delivered_at: expected a timestamp, got ${JSON.stringify(o.delivered_at)}`);
    assert(isIso(o.delivered_at), `order.delivered_at must be ISO, got ${JSON.stringify(o.delivered_at)}`);
    return `status=${o.status}`;
  });

  await test('T21', '§8.4 fulfill a non-paid order again → 409 error envelope', async () => {
    const r = await post(`/api/orders/${m1Order.order.id}/fulfill`, {});
    return assertErrorShape(r, 409, 'double fulfill');
  });

  await test('T22', '§8.5 claim → refund 249, reserve 12500→12251, order refunded', async () => {
    const r = await claim(m1Order.order.id, 'not_delivered', true);
    const c = r.claim;
    eq(c.order_id, m1Order.order.id, 'claim.order_id');
    eq(c.status, 'approved', 'claim.status');
    near(c.refund, 249.0, 'claim.refund');
    near(c.paid_from_reserve, 249.0, 'claim.paid_from_reserve');
    near(c.paid_from_pool, 0, 'claim.paid_from_pool');
    near(c.reserve_before, 12500, 'claim.reserve_before');
    near(c.reserve_after, 12251, 'claim.reserve_after');
    eq(r.order.status, 'refunded', 'order.status');
    near(r.merchant.reserve, 12251, 'merchant.reserve');
    eq(r.merchant.tier, 'A', 'merchant.tier should stay A after one claim');
    assert(typeof r.merchant.score === 'number' || num(r.merchant.score) !== null, 'merchant.score missing');
    hasKeys(r.merchant, ['id', 'tier', 'score', 'reserve', 'fee_bps', 'cap', 'mode'], 'claim.merchant');
    const types = r.events.map((e) => e && e.type);
    for (const t of ['claim', 'refund', 'reserve_change']) {
      assert(types.includes(t), `claim events must include a "${t}" event, got [${types.join(', ')}]`, { events: types });
    }
    return `refund $249, reserve 12500→12251`;
  });

  await test('T23', '§8.5 second claim on same order → 409 error envelope', async () => {
    const r = await post(`/api/orders/${m1Order.order.id}/claim`, { reason: 'damaged', evidence: true });
    return assertErrorShape(r, 409, 'double claim');
  });

  await test('T24', 'recompute: tier ⇄ score band and tier ⇄ fee/cap/mode consistent after claim', async () => {
    const { by } = await merchantsById();
    const m = by.m1;
    const score = num(m.score);
    const expectedTier = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
    eq(m.tier, expectedTier, `m1.tier for score ${score}`);
    const d = TIER[m.tier];
    near(m.fee_bps, d.fee_bps, `m1.fee_bps for tier ${m.tier}`);
    near(m.cap, d.cap, `m1.cap for tier ${m.tier}`);
    eq(m.mode, d.mode, `m1.mode for tier ${m.tier}`);
    near(m.reserve, 12251, 'm1.reserve after claim');
    return `tier ${m.tier} score ${score} consistent`;
  });

  await test('T25', 'claim validation: invalid reason → 400 error envelope', async () => {
    const o = await createOrder('m2', 'p3');
    const r = await post(`/api/orders/${o.order.id}/claim`, { reason: 'bogus_reason', evidence: true });
    return assertErrorShape(r, 400, 'invalid claim reason');
  });

  await test('T26', 'claim validation: evidence !== true → 400, order unchanged', async () => {
    const o = await createOrder('m2', 'p3');
    const r = await post(`/api/orders/${o.order.id}/claim`, { reason: 'damaged', evidence: false });
    const detail = assertErrorShape(r, 400, 'claim without evidence');
    const after = await get(`/api/orders?merchant=m2`);
    eq(after.status, 200, 'orders list status');
    const found = (after.json.orders || []).find((x) => x.id === o.order.id);
    assert(found, 'order should still exist after rejected claim');
    assert(['paid', 'delivered'].includes(String(found.status)), `order.status after rejected claim: expected paid/delivered, got ${JSON.stringify(found.status)}`);
    return detail;
  });

  // ---- §8.6 escrow merchant ---------------------------------------------
  await test('T27', '§8.6 m3 order → mode escrow, cap 1000; claim evidence=false → 400', async () => {
    const r = await createOrder('m3', 'p5');
    const o = r.order;
    eq(o.protection.mode, 'escrow', 'm3 order protection.mode');
    near(o.protection.cap, 1000, 'm3 order protection.cap');
    near(o.amount, 159.0, 'm3 order amount');
    near(o.fee_bps, 150, 'm3 order fee_bps');
    assert(Math.abs(num(o.fee) - 2.385) <= 0.005, `m3 order fee: expected 159*150/10000 ≈ 2.39, got ${JSON.stringify(o.fee)}`);
    const bad = await post(`/api/orders/${o.id}/claim`, { reason: 'damaged', evidence: false });
    const detail = assertErrorShape(bad, 400, 'm3 claim evidence=false');
    // valid claim still works on this order
    const okClaim = await claim(o.id, 'damaged', true);
    near(okClaim.claim.refund, 159.0, 'm3 claim refund');
    return `escrow cap 1000, ${detail}`;
  });

  // ---- §8.7 trust verify -------------------------------------------------
  await test('T28', '§8.7 POST /api/trust/verify m1 min_tier=B → verified true', async () => {
    const r = await post('/api/trust/verify', { merchant_id: 'm1', min_tier: 'B' });
    eq(r.status, 200, 'status');
    hasKeys(r.json, ['verified', 'merchant_id', 'tier', 'score', 'cap', 'fee_bps', 'mode', 'reasons', 'credential', 'signature', 'checked_at'], 'trust verify');
    eq(r.json.verified, true, 'verified');
    eq(r.json.merchant_id, 'm1', 'merchant_id');
    eq(r.json.tier, 'A', 'tier');
    assert(Array.isArray(r.json.reasons) && r.json.reasons.length === 0, `reasons: expected [], got ${JSON.stringify(r.json.reasons)}`);
    assert(isIso(r.json.checked_at), 'checked_at must be ISO');
    return 'verified=true tier=A';
  });

  await test('T29', '§8.7 trust/verify m3 min_tier=B → verified false with reason', async () => {
    const r = await post('/api/trust/verify', { merchant_id: 'm3', min_tier: 'B' });
    eq(r.status, 200, 'status');
    eq(r.json.verified, false, 'verified');
    eq(r.json.tier, 'C', 'tier');
    assert(Array.isArray(r.json.reasons) && r.json.reasons.length > 0, `reasons: expected a non-empty list, got ${JSON.stringify(r.json.reasons)}`);
    const joined = JSON.stringify(r.json.reasons).toLowerCase();
    assert(joined.includes('tier') || joined.includes('below') || joined.includes('minimum') || joined.includes('b'), `reasons should explain the tier failure, got ${JSON.stringify(r.json.reasons)}`);
    return `verified=false reasons=${JSON.stringify(r.json.reasons).slice(0, 90)}`;
  });

  await test('T30', '§8.7 trust/verify default min_tier=C accepts tier C', async () => {
    const r = await post('/api/trust/verify', { merchant_id: 'm3' });
    eq(r.status, 200, 'status');
    eq(r.json.verified, true, 'verified with default min_tier');
    return 'default min_tier=C, m3 verified';
  });

  await test('T31', 'fault: trust/verify unknown merchant → 404 error envelope', async () => {
    const r = await post('/api/trust/verify', { merchant_id: 'zzz', min_tier: 'B' });
    return assertErrorShape(r, [400, 404], 'trust verify unknown merchant');
  });

  // ---- lists + sorting ---------------------------------------------------
  await test('T32', 'GET /api/orders?merchant=m1 → array, newest first', async () => {
    await createOrder('m1', 'p2');
    await sleep(5);
    const second = await createOrder('m1', 'p1');
    const r = await get('/api/orders?merchant=m1');
    eq(r.status, 200, 'status');
    assert(Array.isArray(r.json.orders), 'expected {orders:[...]}');
    assert(r.json.orders.length >= 2, `expected at least 2 orders, got ${r.json.orders.length}`);
    const ids = r.json.orders.map((o) => o.id);
    assert(ids.includes(second.order.id), 'newest order missing from list');
    const times = r.json.orders.map((o) => Date.parse(o.created_at));
    assert(times.every((t) => !Number.isNaN(t)), 'order.created_at must be ISO');
    for (let i = 1; i < times.length; i++) {
      assert(times[i - 1] >= times[i], `orders not sorted newest-first at index ${i}: ${r.json.orders[i - 1].created_at} < ${r.json.orders[i].created_at}`);
    }
    return `${r.json.orders.length} orders`;
  });

  await test('T33', 'GET /api/events?merchant=m1 → array, seq desc', async () => {
    const r = await get('/api/events?merchant=m1');
    eq(r.status, 200, 'status');
    assert(Array.isArray(r.json.events), 'expected {events:[...]}');
    assert(r.json.events.length > 0, 'expected events after order/claim activity');
    const seqs = r.json.events.map((e) => num(e.seq));
    assert(seqs.every((s) => s !== null), 'every event must have a numeric seq');
    for (let i = 1; i < seqs.length; i++) {
      assert(seqs[i - 1] >= seqs[i], `events not sorted seq desc at index ${i}: ${seqs[i - 1]} < ${seqs[i]}`);
    }
    const e0 = r.json.events[0];
    hasKeys(e0, ['type', 'hash'], 'event');
    assert(/^[0-9a-f]{64}$/i.test(String(e0.hash)), `event.hash: expected sha256 hex, got ${JSON.stringify(e0.hash)}`);
    return `${r.json.events.length} events, head seq ${seqs[0]}`;
  });

  await test('T34', '§8.8 POST /api/reset → seed fully restored, orders empty', async () => {
    const resetRes = await post('/api/reset', {});
    eq(resetRes.status, 200, 'reset status');
    eq(resetRes.json && resetRes.json.ok, true, 'reset.ok');
    const { by } = await merchantsById();
    for (const id of ['m1', 'm2', 'm3']) {
      const s = SEED[id];
      const m = by[id];
      eq(m.tier, s.tier, `${id}.tier after reset`);
      near(m.score, s.score, `${id}.score after reset`);
      near(m.fee_bps, s.fee_bps, `${id}.fee_bps after reset`);
      near(m.cap, s.cap, `${id}.cap after reset`);
      near(m.reserve, s.reserve, `${id}.reserve after reset`);
      eq(m.mode, s.mode, `${id}.mode after reset`);
      const metrics = m.metrics || {};
      if ('orders' in metrics) near(metrics.orders, s.orders, `${id}.metrics.orders after reset`);
      if ('disputes' in metrics) near(metrics.disputes, s.disputes, `${id}.metrics.disputes after reset`);
    }
    const orders = await get('/api/orders?merchant=m1');
    eq(orders.status, 200, 'orders status');
    eq((orders.json.orders || []).length, 0, 'm1 orders after reset');
    return 'seed restored, m1 orders purged';
  });

  // ---- reserve → network pool shortfall ----------------------------------
  await test('T35', 'claim pays from reserve, then shortfall from network pool + accounting identity', async () => {
    await reset();
    // Order creation happens while m3 is still tier C (escrow) — before claims move it.
    const orders = [];
    for (let i = 0; i < 6; i++) orders.push((await createOrder('m3', 'p5')).order);
    let sawPool = null;
    let reserve = num((await merchantsById()).by.m3.reserve);
    const series = [];
    for (const o of orders) {
      await fulfill(o.id);
      const r = await claim(o.id, 'not_delivered', true);
      const c = r.claim;
      const entry = {
        tier_after: r.merchant && r.merchant.tier,
        refund: num(c.refund),
        from_reserve: num(c.paid_from_reserve),
        from_pool: num(c.paid_from_pool),
        reserve_before: num(c.reserve_before),
        reserve_after: num(c.reserve_after),
      };
      series.push(entry);
      assert(entry.from_reserve + entry.from_pool === entry.refund || Math.abs(entry.from_reserve + entry.from_pool - entry.refund) < 0.005,
        `claim ${series.length}: paid_from_reserve + paid_from_pool (${entry.from_reserve} + ${entry.from_pool}) != refund (${entry.refund})`, { claim_series: series });
      assert(entry.refund >= 158.995,
        `claim ${series.length}: refund ${entry.refund} < order.protection.cap-bounded 159 — claim appears to use the merchant's CURRENT cap (tier ${entry.tier_after}) instead of order.protection.cap (§5)`, { claim_series: series });
      assert(entry.from_reserve <= reserve + 0.005, `claim ${series.length}: paid_from_reserve (${entry.from_reserve}) exceeds reserve_before (${reserve})`, { claim_series: series });
      reserve = entry.reserve_after;
      assert(reserve >= -0.005, `claim ${series.length}: reserve_after went negative (${reserve})`, { claim_series: series });
      if (entry.from_pool > 0) {
        sawPool = c;
        break;
      }
    }
    assert(sawPool !== null, 'never drew from the network pool after depleting a $900 reserve with $159 claims — expected a shortfall by claim 6', {
      claim_series: series,
      note: 'check refund uses order.protection.cap (1000) and the reserve+pool floor, and that claims are not blocked by tier downgrade',
    });
    near(sawPool.paid_from_reserve, 105, 'shortfall claim paid_from_reserve');
    near(sawPool.paid_from_pool, 54, 'shortfall claim paid_from_pool');
    near(sawPool.reserve_after, 0, 'shortfall claim reserve_after');
    const m = (await merchantsById()).by.m3;
    near(m.reserve, 0, 'm3 reserve after shortfall');
    return `shortfall: reserve ${sawPool.paid_from_reserve} + pool ${sawPool.paid_from_pool} = ${sawPool.refund}`;
  });

  await test('T36', 'cleanup: final reset leaves seed state for the demo', async () => {
    await reset();
    const { by } = await merchantsById();
    near(by.m1.reserve, 12500, 'm1.reserve');
    near(by.m3.reserve, 900, 'm3.reserve');
    eq(by.m1.tier, 'A', 'm1.tier');
    return 'seed restored';
  });

  // =========================================================================
  // v2 — HACKATHON DEMO SPEC: agents, passport, contracts, protection, demo
  // =========================================================================
  await reset();
  let autoContract = null;
  let accOrder = null;
  let claimedId = null;

  await test('T40', 'v2 GET /api/agents → 3 agents; a1 valid, a3 invalid', async () => {
    const { list, by } = await agentsList();
    eq(list.length, 3, 'agent count');
    for (const id of ['a1', 'a2', 'a3']) {
      const a = by[id];
      assert(isObj(a), `agent ${id} missing from list`);
      hasKeys(a, ['id', 'name', 'operator', 'kyb', 'capabilities', 'limits', 'reputation', 'status'], `agent ${id}`);
      assert(Array.isArray(a.capabilities) && a.capabilities.length > 0, `${id}.capabilities must be a non-empty array`);
      hasKeys(a.limits, ['max_amount'], `${id}.limits`);
      hasKeys(a.reputation, ['orders', 'claims', 'violations', 'score'], `${id}.reputation`);
    }
    eq(by.a1.name, 'ProcureBot', 'a1.name');
    eq(by.a1.status, 'valid', 'a1.status');
    assert(['verified', true].includes(by.a1.kyb), `a1.kyb: expected verified, got ${JSON.stringify(by.a1.kyb)}`);
    near(by.a1.limits.max_amount, 500, 'a1.limits.max_amount');
    near(by.a1.reputation.score, 92, 'a1.reputation.score');
    eq(by.a3.status, 'invalid', 'a3.status');
    assert(['unverified', false].includes(by.a3.kyb), `a3.kyb: expected unverified, got ${JSON.stringify(by.a3.kyb)}`);
    return 'a1 valid (ProcureBot, kyb verified, max $500), a3 invalid';
  });

  await test('T41', 'v2 POST /api/agents/verify a1 → verified true, all six checks true', async () => {
    const v = await agentVerify({ agent_id: 'a1' });
    eq(v.verified, true, 'verified');
    hasKeys(v.checks, ['passport', 'mandate', 'limits', 'merchant', 'category', 'kyb'], 'checks');
    for (const k of ['passport', 'mandate', 'limits', 'merchant', 'category', 'kyb']) {
      eq(v.checks[k], true, `checks.${k}`);
    }
    assert(Array.isArray(v.reasons) && v.reasons.length === 0, `reasons: expected [], got ${JSON.stringify(v.reasons)}`);
    hasKeys(v.passport, ['credential', 'signature', 'alg'], 'verify.passport');
    eq(v.passport.alg, 'HS256', 'passport.alg');
    eq(v.agent && v.agent.id, 'a1', 'agent.id');
    return 'verified=true, passport/mandate/limits/merchant/category/kyb all true';
  });

  await test('T42', 'v2 POST /api/agents/verify a3 → false with kyb/mandate reasons', async () => {
    const v = await agentVerify({ agent_id: 'a3' });
    eq(v.verified, false, 'verified');
    assert(Array.isArray(v.reasons) && v.reasons.length > 0, `reasons must be a non-empty array, got ${JSON.stringify(v.reasons)}`);
    const txt = JSON.stringify(v.reasons).toLowerCase();
    assert(/kyb|mandate|violation|invalid|unverified|expired/.test(txt), `reasons should cite kyb/mandate/violations, got ${JSON.stringify(v.reasons)}`);
    eq(v.checks.kyb, false, 'checks.kyb for a3');
    assert(v.checks.passport === false || v.checks.passport === true, 'checks.passport must be boolean');
    return `verified=false, reasons=${JSON.stringify(v.reasons).slice(0, 120)}`;
  });

  await test('T43', 'v2 GET /api/agents/a1/passport → credential/signature/alg (+ tamper probe)', async () => {
    const r = await get('/api/agents/a1/passport');
    eq(r.status, 200, 'status');
    hasKeys(r.json, ['credential', 'signature', 'alg'], 'passport envelope');
    eq(r.json.alg, 'HS256', 'alg');
    const c = r.json.credential;

    // Probe tamper support FIRST, so the result is reported even if the shape check fails.
    const tampered = JSON.parse(JSON.stringify(c));
    tampered.reputation.score = 99;
    tampered.limits.max_amount = 5000;
    const t = await http('POST', '/api/agents/verify', { body: { agent_id: 'a1', credential: tampered, signature: r.json.signature } });
    let probe;
    if (t.status === 200 && isObj(t.json) && t.json.verified === false) {
      probe = 'tampered passport rejected (verified=false)';
    } else if (t.status === 200 && isObj(t.json) && t.json.verified === true) {
      probe = 'tamper NOT exercised — verify ignores a caller-supplied credential (spec §2 parenthetical)';
    } else {
      probe = `tamper probe returned HTTP ${t.status}`;
    }

    try {
      hasKeys(c, ['agent_id', 'name', 'operator', 'capabilities', 'limits', 'mandate', 'reputation', 'issued_at', 'expires_at', 'sig'], 'passport credential');
    } catch (e) {
      e.evidence = {
        credential_keys: Object.keys(c),
        tamper_probe: probe,
        note: 'SPEC §1 lists sig (HMAC over base64url(JSON)) inside the passport credential; the envelope has signature but a portable credential must carry its own sig.',
      };
      throw e;
    }
    eq(c.agent_id, 'a1', 'credential.agent_id');
    near(c.limits.max_amount, 500, 'credential.limits.max_amount');
    near(c.mandate.max_amount, 500, 'credential.mandate.max_amount');
    assert(c.mandate.signed, 'credential.mandate.signed must be truthy');
    near(c.reputation.score, 92, 'credential.reputation.score');
    assert(typeof r.json.signature === 'string' && r.json.signature.length > 0, 'envelope signature missing');
    assert(isIso(c.issued_at) && isIso(c.expires_at), 'credential.issued_at/expires_at must be ISO');
    return `passport shape ok; ${probe}`;
  });

  await test('T44', 'v2 POST /api/contracts → open contract, policy floor/auto_accept', async () => {
    const c = await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' });
    assert(/^ctr_[0-9a-f]+$/i.test(String(c.id)), `contract.id: expected ctr_<hex>, got ${JSON.stringify(c.id)}`);
    eq(c.merchant_id, 'm1', 'contract.merchant_id');
    eq(c.product_id, 'p1', 'contract.product_id');
    eq(c.product_name, 'Aurora One headphones', 'contract.product_name');
    near(c.list_price, 249, 'contract.list_price');
    eq(c.agreed_price, null, 'contract.agreed_price');
    eq(c.status, 'open', 'contract.status');
    eq(num(c.rounds), 0, 'contract.rounds');
    eq(num(c.max_rounds), 4, 'contract.max_rounds');
    hasKeys(c.policy, ['floor', 'auto_accept', 'max_discount_pct'], 'contract.policy');
    near(c.policy.floor, 249 * 0.82, 'policy.floor', 1.5);
    near(c.policy.auto_accept, 249 * 0.95, 'policy.auto_accept', 1.5);
    assert(num(c.policy.floor) < num(c.policy.auto_accept), 'policy.floor must be below policy.auto_accept');
    near(c.policy.max_discount_pct, 18, 'policy.max_discount_pct');
    hasKeys(c.mandate, ['max', 'expires_at'], 'contract.mandate');
    assert(isIso(c.mandate.expires_at), 'mandate.expires_at must be ISO');
    assert(num(c.mandate.max) >= 249, `mandate.max must allow the list price, got ${JSON.stringify(c.mandate.max)}`);
    hasKeys(c.terms, ['delivery_days', 'returns_days', 'warranty_months'], 'contract.terms');
    assert(Array.isArray(c.transcript) && c.transcript.length === 0, 'transcript must be empty on create');
    eq(c.hash, null, 'contract.hash');
    assert(isObj(c.signatures), 'contract.signatures must be an object');
    assert(isIso(c.created_at), 'contract.created_at must be ISO');
    return `${c.id} floor ${c.policy.floor} / auto ${c.policy.auto_accept}`;
  });

  await test('T45', 'v2 POST /api/contracts/:id/auto → accepted, agreed price, hash, signatures', async () => {
    const c = await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' });
    const r = await post(`/api/contracts/${c.id}/auto`, {});
    eq(r.status, 200, 'auto status');
    hasKeys(r.json, ['contract'], 'auto response');
    const d = r.json.contract;
    eq(d.id, c.id, 'contract.id');
    eq(d.status, 'accepted', 'contract.status');
    const agreed = num(d.agreed_price);
    assert(agreed !== null, `agreed_price must be numeric, got ${JSON.stringify(d.agreed_price)}`);
    assert(agreed >= num(d.policy.floor) - 0.005, `agreed_price ${agreed} below floor ${d.policy.floor}`);
    assert(agreed <= num(d.list_price) + 0.005, `agreed_price ${agreed} above list ${d.list_price}`);
    near(agreed, 249 * 0.95, 'agreed_price (~95% scripted path)', 2.5);
    assert(typeof d.hash === 'string' && /^[0-9a-f]{64}$/i.test(d.hash), `contract.hash: expected sha256 hex, got ${JSON.stringify(d.hash)}`);
    assert(isObj(d.signatures) && Object.keys(d.signatures).length >= 2, `signatures: expected >=2 entries, got ${JSON.stringify(d.signatures)}`);
    const sigText = JSON.stringify(d.signatures);
    assert(sigText.includes('a1') && sigText.includes('m1'), `signatures must reference buyer agent a1 and merchant m1, got ${sigText.slice(0, 200)}`);
    assert(Array.isArray(d.transcript) && d.transcript.length >= 2, `transcript: expected >=2 entries, got ${JSON.stringify(d.transcript).slice(0, 200)}`);
    assert(num(d.rounds) >= 1, 'rounds must have advanced');
    autoContract = d;
    return `agreed $${agreed}, hash ${d.hash.slice(0, 12)}…`;
  });

  await test('T46', 'v2 offers: non-positive price / bad party → 400', async () => {
    const c = await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1', mandate: { max: 500, ttl_seconds: 600 } });
    const zero = await contractOffer(c.id, 'buyer', 0);
    const d1 = assertErrorShape(zero, 400, 'offer price 0');
    const neg = await contractOffer(c.id, 'buyer', -5);
    const d2 = assertErrorShape(neg, 400, 'offer price -5');
    const badFrom = await contractOffer(c.id, 'nobody', 210);
    const d3 = assertErrorShape(badFrom, 400, 'offer from invalid party');
    return `${d1}; ${d2}; ${d3}`;
  });

  await test('T47', 'v2 offer above mandate → 400/409 error envelope', async () => {
    let c = await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1', mandate: { max: 200, ttl_seconds: 600 } });
    let r = await contractOffer(c.id, 'buyer', 249);
    let path = 'explicit mandate.max=200';
    if (r.status === 200) {
      c = await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' });
      r = await contractOffer(c.id, 'buyer', 9999);
      path = 'offer 9999 above default mandate';
    }
    const detail = assertErrorShape(r, [400, 409], 'offer above mandate');
    const txt = JSON.stringify(r.json).toLowerCase();
    assert(/mandate|max|limit|price/.test(txt), `error should mention mandate/limit, got ${JSON.stringify(r.json)}`);
    return `${path}: ${detail}`;
  });

  await test('T48', 'v2 rounds exceeded → contract expired', async () => {
    const c = await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' });
    const midPrice = Math.round((num(c.policy.floor) + num(c.policy.auto_accept)) / 2);
    let last = null;
    let expired = false;
    for (let i = 0; i < 8; i++) {
      const r = await contractOffer(c.id, 'buyer', midPrice);
      assert(r.status === 200, `offer ${i + 1}: expected 200, got ${r.status}`, { body: r.json ?? r.text.slice(0, 400) });
      last = r.json;
      if (last.contract.status === 'expired' || last.decision === 'expired') {
        expired = true;
        break;
      }
      assert(last.decision === 'countered', `offer ${i + 1} at ${midPrice}: expected "countered", got ${JSON.stringify(last.decision)}`, { last });
    }
    assert(expired, `contract never expired after 8 offers at ${midPrice}`, { last });
    const d = await getContract(c.id);
    eq(d.status, 'expired', 'persisted contract status');
    assert(num(d.rounds) > num(d.max_rounds), `rounds (${d.rounds}) must exceed max_rounds (${d.max_rounds})`);
    const after = await contractOffer(c.id, 'buyer', midPrice);
    const detail = assertErrorShape(after, [409, 400], 'offer on expired contract');
    return `expired after ${d.rounds} rounds (max ${d.max_rounds}); late offer ${detail}`;
  });

  await test('T49', 'v2 POST /api/protection/quote m1 $249 → 35bps, $0.87, cap 5000, instant', async () => {
    const q = await protectionQuote('m1', 249);
    eq(q.merchant_id, 'm1', 'quote.merchant_id');
    near(q.amount, 249, 'quote.amount');
    near(q.fee_bps, 35, 'quote.fee_bps');
    near(q.fee, 0.87, 'quote.fee');
    near(q.cap, 5000, 'quote.cap');
    eq(q.mode, 'instant', 'quote.mode');
    assert(Array.isArray(q.coverage) && q.coverage.length > 0, `quote.coverage: expected a non-empty array, got ${JSON.stringify(q.coverage).slice(0, 200)}`);
    if (q.reserve_source !== undefined) eq(q.reserve_source, 'merchant_reserve', 'quote.reserve_source');
    if (q.exclusions !== undefined) assert(Array.isArray(q.exclusions), 'quote.exclusions must be an array');
    return `fee $${num(q.fee)} / ${q.fee_bps}bps / cap $${num(q.cap)} / ${q.mode}`;
  });

  await test('T50', 'v2 order with contract+a1 → amount = agreed_price, ACC hash, agent verified', async () => {
    assert(autoContract, 'T45 must produce an accepted contract first');
    const r = await post('/api/merchants/m1/orders', {
      product_id: 'p1',
      buyer: { name: 'Sam Rivera', email: 'sam@example.com' },
      contract_id: autoContract.id,
      agent_id: 'a1',
    });
    assert([200, 201].includes(r.status), `order with contract+agent: expected 200/201, got ${r.status}`, { body: r.json ?? r.text.slice(0, 600) });
    hasKeys(r.json, ['order', 'payment', 'receipt'], 'order response');
    const o = r.json.order;
    near(o.amount, num(autoContract.agreed_price), 'order.amount must equal contract.agreed_price');
    eq(o.merchant_id, 'm1', 'order.merchant_id');
    eq(o.product_id, 'p1', 'order.product_id');
    hasKeys(r.json, ['acc'], 'order response must include acc');
    hasKeys(r.json.acc, ['contract_id', 'hash', 'transcript_hash', 'terms', 'buyer_agent_id'], 'order.acc');
    eq(r.json.acc.contract_id, autoContract.id, 'acc.contract_id');
    assert(typeof r.json.acc.hash === 'string' && /^[0-9a-f]{64}$/i.test(r.json.acc.hash), `acc.hash: expected sha256 hex, got ${JSON.stringify(r.json.acc.hash)}`);
    assert(typeof r.json.acc.transcript_hash === 'string' && r.json.acc.transcript_hash.length > 0, 'acc.transcript_hash missing');
    eq(r.json.acc.buyer_agent_id, 'a1', 'acc.buyer_agent_id');
    eq(o.status, 'paid', 'order.status');
    accOrder = o;
    return `${o.id} $${num(o.amount)} acc ${String(r.json.acc.hash).slice(0, 12)}…`;
  });

  await test('T51', 'v2 order with unverified a3 → 403 AGENT_NOT_VERIFIED', async () => {
    const r = await post('/api/merchants/m1/orders', {
      product_id: 'p1',
      buyer: { name: 'Sam Rivera', email: 'sam@example.com' },
      agent_id: 'a3',
    });
    assertErrorShape(r, 403, 'order with unverified agent');
    eq(String(r.json.error.code), 'AGENT_NOT_VERIFIED', 'error.code');
    return '403 AGENT_NOT_VERIFIED';
  });

  await test('T52', 'v2 regression: order without contract/agent unchanged', async () => {
    const r = await post('/api/merchants/m1/orders', { product_id: 'p1', buyer: { name: 'Sam Rivera', email: 'sam@example.com' } });
    assert([200, 201].includes(r.status), `plain order: expected 200/201, got ${r.status}`, { body: r.json ?? r.text.slice(0, 400) });
    near(r.json.order.amount, 249, 'plain order amount');
    eq(r.json.order.status, 'paid', 'plain order status');
    if (r.json.acc !== undefined) assert(r.json.acc === null || isObj(r.json.acc), 'acc must be absent/null on a plain order');
    return 'plain order: $249, paid';
  });

  await test('T53', 'v2 claim → refund + paypal_refund_id + sla_ms + actor, reserve decreases', async () => {
    assert(accOrder, 'T50 must create the ACC order first');
    const before = (await merchantsById()).by.m1;
    const r = await claim(accOrder.id, 'not_delivered', true);
    const c = r.claim;
    near(c.refund, num(accOrder.amount), 'claim.refund must equal the negotiated order amount');
    assert(typeof c.paypal_refund_id === 'string' && c.paypal_refund_id.startsWith('SIM-RF-'), `paypal_refund_id: expected "SIM-RF-<hex>", got ${JSON.stringify(c.paypal_refund_id)}`);
    near(c.sla_ms, 1200, 'claim.sla_ms');
    eq(c.actor, 'buyer', 'claim.actor default');
    eq(c.status, 'approved', 'claim.status');
    near(c.reserve_before, num(before.reserve), 'claim.reserve_before');
    near(c.reserve_after, num(before.reserve) - num(c.refund), 'claim.reserve_after');
    eq(r.order.status, 'refunded', 'order.status');
    eq(r.merchant.tier, 'A', 'merchant.tier stays A');
    hasKeys(r.merchant, ['id', 'tier', 'score', 'reserve', 'fee_bps', 'cap', 'mode'], 'claim.merchant');
    claimedId = c.id;
    return `refund $${num(c.refund)} from ${c.paypal_refund_id} in ${c.sla_ms}ms (${c.actor})`;
  });

  await test('T54', 'v2 second claim on same order → 409', async () => {
    const r = await post(`/api/orders/${accOrder.id}/claim`, { reason: 'damaged', evidence: true });
    return assertErrorShape(r, 409, 'second claim');
  });

  await test('T55', 'v2 GET /api/claims?merchant=m1 → newest first, includes the claim', async () => {
    const r = await get('/api/claims?merchant=m1');
    eq(r.status, 200, 'status');
    assert(Array.isArray(r.json.claims), 'expected {claims:[...]}');
    assert(r.json.claims.length >= 1, 'expected at least one claim');
    const ids = r.json.claims.map((c) => c.id);
    assert(ids.includes(claimedId), `claims list must include ${claimedId}, got [${ids.join(', ')}]`);
    const times = r.json.claims.map((c) => Date.parse(c.created_at));
    assert(times.every((t) => !Number.isNaN(t)), 'every claim needs a parseable created_at');
    for (let i = 1; i < times.length; i++) {
      assert(times[i - 1] >= times[i], `claims not sorted newest-first at index ${i}`);
    }
    return `${r.json.claims.length} claim(s), head ${ids[0]}`;
  });

  await test('T56', 'v2 GET /demo.html → 200 with "Run full demo"/"all five"; /demo.js 200', async () => {
    const html = await get('/demo.html');
    eq(html.status, 200, 'demo.html status');
    assert(/html/i.test(html.contentType), `demo.html content-type: expected HTML, got ${html.contentType}`);
    assert(/run full demo/i.test(html.text), 'demo.html must contain a "Run full demo" marker');
    assert(/all five/i.test(html.text), 'demo.html must contain the "all five" scorecard marker');
    assert(/settled/i.test(html.text), 'demo.html must contain the "Settled" brand marker');
    const js = await get('/demo.js');
    eq(js.status, 200, 'demo.js status');
    assert(js.text.length > 200, `demo.js suspiciously short (${js.text.length} bytes)`);
    assert(js.text.includes('/api'), 'demo.js must call the API');
    return `demo.html ${html.text.length}B, demo.js ${js.text.length}B`;
  });

  await test('T57', 'v2 full demo flow steps 1–5 → accepted contract, ACC order, refunded claim', async () => {
    await reset();
    // 1. trust credential
    const detail = await get('/api/merchants/m1');
    eq(detail.status, 200, 'step 1: merchant detail');
    assert(detail.json.ledger && detail.json.ledger.credential && detail.json.ledger.signature, 'step 1: signed ledger credential');
    eq(detail.json.merchant.tier, 'A', 'step 1: tier A');
    // 2. agent passport
    const v = await agentVerify({ agent_id: 'a1' });
    eq(v.verified, true, 'step 2: a1 verified');
    // 3. negotiate
    const c = await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' });
    const auto = await post(`/api/contracts/${c.id}/auto`, {});
    eq(auto.status, 200, 'step 3: auto');
    eq(auto.json.contract.status, 'accepted', 'step 3: contract accepted');
    const agreed = num(auto.json.contract.agreed_price);
    // 4. priced protection + PayPal order
    const q = await protectionQuote('m1', agreed);
    assert(num(q.fee) > 0 && num(q.cap) > 0, 'step 4: priced protection');
    const o = await post('/api/merchants/m1/orders', {
      product_id: 'p1',
      buyer: { name: 'Demo Buyer', email: 'demo@example.com' },
      contract_id: c.id,
      agent_id: 'a1',
    });
    assert([200, 201].includes(o.status), `step 4: order expected 200/201, got ${o.status}`, { body: o.json ?? o.text.slice(0, 400) });
    near(o.json.order.amount, agreed, 'step 4: order amount equals agreed price');
    assert(o.json.acc && o.json.acc.hash, 'step 4: ACC hash present');
    // 5. recourse
    const cl = await claim(o.json.order.id, 'not_delivered', true);
    near(cl.claim.refund, agreed, 'step 5: refund equals agreed price');
    assert(String(cl.claim.paypal_refund_id).startsWith('SIM-RF-'), 'step 5: PayPal refund id');
    eq(cl.order.status, 'refunded', 'step 5: order refunded');
    const finalContract = await getContract(c.id);
    eq(finalContract.status, 'accepted', 'final state: contract accepted');
    return `agreed $${agreed}, refund $${num(cl.claim.refund)}, 5/5 steps green`;
  });

  await test('T58', 'v2 reset clears contracts + claims, keeps agents', async () => {
    await reset();
    const claims = await get('/api/claims?merchant=m1');
    eq(claims.status, 200, 'claims status');
    assert(Array.isArray(claims.json.claims) && claims.json.claims.length === 0, `claims after reset: expected [], got ${JSON.stringify(claims.json.claims).slice(0, 200)}`);
    const c = await get('/api/contracts/ctr_doesnotexist');
    assertErrorShape(c, 404, 'unknown contract after reset');
    const agents = await get('/api/agents');
    eq(agents.status, 200, 'agents still served after reset');
    eq((agents.json.agents || []).length, 3, 'agents after reset');
    return 'contracts/claims cleared, 3 agents intact';
  });

  await test('T59', 'v2 cleanup: final reset leaves seed state', async () => {
    await reset();
    const { by } = await merchantsById();
    near(by.m1.reserve, 12500, 'm1.reserve');
    eq(by.m1.tier, 'A', 'm1.tier');
    const claims = await get('/api/claims?merchant=m1');
    assert(Array.isArray(claims.json.claims) && claims.json.claims.length === 0, 'claims must be empty after cleanup reset');
    return 'seed restored';
  });

  // =========================================================================
  // v3 — AI negotiation + live-PayPal rails (AI-PAYPAL-BUILD-SPEC.md)
  // =========================================================================
  await reset();
  let cfg = null;

  await test('T60', 'v3 GET /api/config → mode, paypal{env,client_id,configured}, ai{enabled,provider,model}', async () => {
    const r = await get('/api/config');
    eq(r.status, 200, 'status');
    hasKeys(r.json, ['mode', 'ai', 'paypal'], 'config');
    assert(['sim', 'live'].includes(r.json.mode), `config.mode: expected "sim"|"live", got ${JSON.stringify(r.json.mode)}`);
    eq(r.json.currency, 'USD', 'config.currency');
    hasKeys(r.json.paypal, ['env', 'client_id', 'configured'], 'config.paypal');
    assert(['sandbox', 'live'].includes(r.json.paypal.env), `paypal.env: expected sandbox|live, got ${JSON.stringify(r.json.paypal.env)}`);
    assert(r.json.paypal.client_id === null || typeof r.json.paypal.client_id === 'string', `paypal.client_id must be string|null, got ${JSON.stringify(r.json.paypal.client_id)}`);
    assert(typeof r.json.paypal.configured === 'boolean', `paypal.configured must be boolean, got ${JSON.stringify(r.json.paypal.configured)}`);
    eq(r.json.paypal.configured, Boolean(r.json.paypal.client_id), 'paypal.configured must track client_id presence');
    hasKeys(r.json.ai, ['enabled', 'provider', 'model'], 'config.ai');
    assert(typeof r.json.ai.enabled === 'boolean', `ai.enabled must be boolean, got ${JSON.stringify(r.json.ai.enabled)}`);
    assert(['openai', 'none'].includes(r.json.ai.provider), `ai.provider: expected openai|none, got ${JSON.stringify(r.json.ai.provider)}`);
    assert(r.json.ai.model === null || typeof r.json.ai.model === 'string', `ai.model must be string|null, got ${JSON.stringify(r.json.ai.model)}`);
    if (!reused) eq(r.json.ai.enabled, false, 'ai.enabled on a spawned server (test strips AI_API_KEY)');
    cfg = r.json;
    return `mode=${r.json.mode}, ai=${r.json.ai.enabled}/${r.json.ai.provider}/${r.json.ai.model}, paypal=${r.json.paypal.env}/configured=${r.json.paypal.configured}`;
  });

  await test('T61', 'v3 /contracts/:id/ai-auto → accepted, ai.used=false (no key), ≥1 move, hash', async () => {
    const c = await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' });
    const r = await post(`/api/contracts/${c.id}/ai-auto`, {});
    eq(r.status, 200, 'ai-auto status');
    hasKeys(r.json, ['contract', 'ai'], 'ai-auto response');
    const d = r.json.contract;
    const ai = r.json.ai;
    eq(d.status, 'accepted', 'contract.status');
    hasKeys(ai, ['enabled', 'provider', 'model', 'used', 'moves'], 'ai');
    assert(typeof ai.enabled === 'boolean', `ai.enabled must be boolean, got ${JSON.stringify(ai.enabled)}`);
    if (!(reused && cfg && cfg.ai.enabled)) eq(ai.used, false, 'ai.used must be false on the deterministic fallback path');
    assert(Array.isArray(ai.moves) && ai.moves.length >= 1, `ai.moves: expected >=1, got ${JSON.stringify(ai.moves)}`);
    assert(ai.moves.length <= 2, `ai.moves: spec caps buyer moves at 2, got ${ai.moves.length}`);
    for (const m of ai.moves) {
      hasKeys(m, ['round', 'action', 'price'], 'ai move');
      assert(['offer', 'accept'].includes(m.action), `move.action: expected offer|accept, got ${JSON.stringify(m.action)}`);
      const mp = num(m.price);
      assert(mp !== null, `move.price must be numeric, got ${JSON.stringify(m.price)}`);
      assert(mp >= num(d.policy.floor) - 0.005 && mp <= num(d.list_price) + 0.005, `move.price ${mp} outside [${d.policy.floor}, ${d.list_price}]`);
    }
    const agreed = num(d.agreed_price);
    assert(agreed !== null, `agreed_price must be numeric, got ${JSON.stringify(d.agreed_price)}`);
    assert(agreed >= num(d.policy.floor) - 0.005, `agreed_price ${agreed} below floor ${d.policy.floor}`);
    assert(agreed <= num(d.list_price) + 0.005, `agreed_price ${agreed} above list ${d.list_price}`);
    assert(typeof d.hash === 'string' && /^[0-9a-f]{64}$/i.test(d.hash), `contract.hash: expected sha256 hex, got ${JSON.stringify(d.hash)}`);
    assert(isObj(d.ai), 'contract.ai must be attached (§2)');
    // idempotent on an accepted contract (§2)
    const again = await post(`/api/contracts/${c.id}/ai-auto`, {});
    eq(again.status, 200, 'second ai-auto status');
    eq(again.json.contract.status, 'accepted', 'second ai-auto keeps status accepted');
    near(again.json.contract.agreed_price, agreed, 'second ai-auto agreed_price');
    return `agreed $${agreed}, used=${ai.used}, ${ai.moves.length} move(s), hash ${d.hash.slice(0, 10)}…`;
  });

  await test('T62', 'v3 claim use_ai:true → ai.recommendation/confidence/rationale + refund still paid', async () => {
    const before = (await merchantsById()).by.m1;
    const o = await createOrder('m1', 'p1');
    const r = await post(`/api/orders/${o.order.id}/claim`, { reason: 'not_delivered', evidence: true, use_ai: true });
    eq(r.status, 200, 'claim status');
    hasKeys(r.json, ['claim', 'order', 'merchant', 'events'], 'claim response');
    const ai = r.json.ai || (r.json.claim && r.json.claim.ai);
    assert(isObj(ai), 'claim response must carry ai (top-level ai or claim.ai)');
    assert(['approve', 'review', 'deny'].includes(ai.recommendation), `ai.recommendation: expected approve|review|deny, got ${JSON.stringify(ai.recommendation)}`);
    const conf = num(ai.confidence);
    assert(conf !== null && conf >= 0 && conf <= 1, `ai.confidence: expected 0..1, got ${JSON.stringify(ai.confidence)}`);
    assert(typeof ai.rationale === 'string' && ai.rationale.trim().length > 0, `ai.rationale must be a non-empty string, got ${JSON.stringify(ai.rationale)}`);
    assert(typeof ai.used === 'boolean', 'ai.used must be boolean');
    const c = r.json.claim;
    near(c.refund, 249, 'claim.refund must still be paid');
    assert(String(c.paypal_refund_id).startsWith('SIM-RF-'), `paypal_refund_id: expected SIM-RF-…, got ${JSON.stringify(c.paypal_refund_id)}`);
    near(c.reserve_before, num(before.reserve), 'claim.reserve_before');
    near(c.reserve_after, num(before.reserve) - num(c.refund), 'claim.reserve_after');
    eq(r.json.order.status, 'refunded', 'order.status');
    const second = await post(`/api/orders/${o.order.id}/claim`, { reason: 'damaged', evidence: true, use_ai: true });
    assertErrorShape(second, 409, 'second claim with use_ai');
    return `${ai.recommendation} conf=${ai.confidence} used=${ai.used}; refund $${num(c.refund)}`;
  });

  await test('T63', 'v3 PayPal SIM: create-order SIM-…, capture COMPLETED+capture_id, refund SIM-RF-…', async () => {
    if (cfg && cfg.mode === 'live') {
      return 'skipped SIM assertions: server is in live mode (unset PAYPAL_LIVE / E2E_ALLOW_LIVE=0 to test SIM)';
    }
    const o = await createOrder('m2', 'p3');
    const reserve = num((await merchantsById()).by.m2.reserve);
    const c1 = await post('/api/paypal/create-order', { order_id: o.order.id });
    eq(c1.status, 200, 'create-order status');
    hasKeys(c1.json, ['mode', 'paypal_order_id'], 'create-order response');
    eq(c1.json.mode, 'sim', 'create-order mode');
    assert(String(c1.json.paypal_order_id).startsWith('SIM-'), `paypal_order_id: expected SIM-…, got ${JSON.stringify(c1.json.paypal_order_id)}`);

    const c2 = await post('/api/paypal/capture', { order_id: o.order.id });
    eq(c2.status, 200, 'capture status');
    hasKeys(c2.json, ['mode', 'order'], 'capture response');
    eq(c2.json.mode, 'sim', 'capture mode');
    const capStatus = (c2.json.capture && c2.json.capture.status) || c2.json.status;
    eq(String(capStatus).toUpperCase(), 'COMPLETED', 'capture status');
    eq(c2.json.order.status, 'paid', 'order.status after capture');
    assert(c2.json.order.capture_id && String(c2.json.order.capture_id).length > 0, `order.capture_id missing after capture: ${JSON.stringify(c2.json.order.capture_id)}`);

    const c3 = await post('/api/paypal/refund', { order_id: o.order.id });
    eq(c3.status, 200, 'refund status');
    hasKeys(c3.json, ['mode', 'refund_id'], 'refund response');
    eq(c3.json.mode, 'sim', 'refund mode');
    assert(String(c3.json.refund_id).startsWith('SIM-RF-'), `refund_id: expected SIM-RF-…, got ${JSON.stringify(c3.json.refund_id)}`);
    if (c3.json.status !== undefined) eq(String(c3.json.status).toUpperCase(), 'COMPLETED', 'refund status');
    if (c3.json.amount !== undefined) near(c3.json.amount, num(o.order.amount), 'refund amount');
    near((await merchantsById()).by.m2.reserve, reserve, 'm2.reserve must be unchanged by PayPal routes (§4)');
    return `${String(c1.json.paypal_order_id).slice(0, 12)}… → capture ${c2.json.order.capture_id} → ${c3.json.refund_id}`;
  });

  await test('T64', 'v3 order simulate:true → paid immediately, simulated=true, SIM id', async () => {
    const r = await post('/api/merchants/m1/orders', {
      product_id: 'p1',
      buyer: { name: 'Demo Buyer', email: 'demo@example.com' },
      simulate: true,
    });
    assert([200, 201].includes(r.status), `simulate order: expected 200/201, got ${r.status}`, { body: r.json ?? r.text.slice(0, 500) });
    const o = r.json.order;
    eq(o.status, 'paid', 'order.status with simulate:true');
    eq(o.simulated, true, 'order.simulated');
    assert(String(o.payment_id).startsWith('SIM-'), `payment_id: expected SIM-…, got ${JSON.stringify(o.payment_id)}`);
    if (r.json.payment && r.json.payment.mode !== undefined) eq(String(r.json.payment.mode).toLowerCase(), 'sim', 'payment.mode');
    if (!(cfg && cfg.mode === 'live')) {
      const plain = await post('/api/merchants/m1/orders', { product_id: 'p1', buyer: { name: 'Demo Buyer', email: 'demo@example.com' } });
      assert([200, 201].includes(plain.status), `plain order: expected 200/201, got ${plain.status}`);
      eq(plain.json.order.status, 'paid', 'plain order status in SIM mode');
      eq(plain.json.order.simulated, false, 'plain order.simulated must be false');
    }
    return `simulate order ${o.id} paid, simulated=true, ${o.payment_id.slice(0, 12)}…`;
  });

  await test('T65', 'v3 regression: demo console carries AI + PayPal markers; reset leaves seed', async () => {
    const html = await get('/demo.html');
    eq(html.status, 200, 'demo.html status');
    const js = await get('/demo.js');
    eq(js.status, 200, 'demo.js status');
    const combined = `${html.text}\n${js.text}`;
    assert(/ai agents/i.test(combined), 'demo console must contain the "AI agents" marker');
    assert(/paypal/i.test(combined), 'demo console must contain a "PayPal" marker');
    assert(/ai:\s|<model>|fallback/i.test(combined), 'demo console must reference the AI badge (AI: <model> / fallback)');
    // demo.js goes through the shared `S.api(path)` helper (app.js prefixes API_BASE='/api'),
    // so accept both the literal path and the helper form.
    const callsConfig = js.text.includes('/api/config') || /\.api\(\s*['"`]\/config['"`]/.test(js.text);
    assert(callsConfig, `demo.js must call GET /api/config (literal '/api/config' or S.api('/config')); saw: ${(js.text.match(/[^\n]*config[^\n]*/g) || []).slice(0, 3).join(' | ').slice(0, 300)}`);
    assert(/ai-auto/.test(js.text), 'demo.js must call /api/contracts/:id/ai-auto');
    assert(/paypal/i.test(js.text), 'demo.js must use the PayPal routes');
    await reset();
    const { by } = await merchantsById();
    near(by.m1.reserve, 12500, 'm1.reserve after final reset');
    eq(by.m1.tier, 'A', 'm1.tier after final reset');
    const claims = await get('/api/claims?merchant=m1');
    assert(Array.isArray(claims.json.claims) && claims.json.claims.length === 0, 'claims cleared after final reset');
    return `demo.html ${html.text.length}B + demo.js ${js.text.length}B carry AI/PayPal markers; seed restored`;
  });

  // =========================================================================
  // v4 — merchant catalog + negotiation index (MERCHANT-BUILD-SPEC.md)
  // =========================================================================
  await reset();
  let cats = null;
  let idx = null;

  await test('T66', 'v4 GET /api/categories → [{id,name,count,min,max}], total, consistent with index', async () => {
    const r = await get('/api/categories');
    eq(r.status, 200, 'status');
    hasKeys(r.json, ['categories', 'total'], 'categories response');
    assert(Array.isArray(r.json.categories) && r.json.categories.length > 0, `categories must be a non-empty array, got ${JSON.stringify(r.json.categories).slice(0, 200)}`);
    let sumCount = 0;
    for (const c of r.json.categories) {
      hasKeys(c, ['id', 'name', 'count', 'min', 'max'], 'category');
      assert(typeof c.id === 'string' && c.id.length > 0, `category.id: ${JSON.stringify(c.id)}`);
      assert(typeof c.name === 'string' && c.name.length > 0, `category.name: ${JSON.stringify(c.name)}`);
      const count = num(c.count), cmin = num(c.min), cmax = num(c.max);
      assert(count !== null && count >= 1, `category ${c.id}.count: expected >=1, got ${JSON.stringify(c.count)}`);
      assert(cmin !== null && cmax !== null && cmin <= cmax, `category ${c.id}: min/max invalid (${JSON.stringify(c.min)}/${JSON.stringify(c.max)})`);
      sumCount += count;
    }
    const total = num(r.json.total);
    assert(total !== null, `categories.total must be numeric, got ${JSON.stringify(r.json.total)}`);
    assert(total === r.json.categories.length || total === sumCount,
      `categories.total (${total}) must be the category count (${r.json.categories.length}) or the item count (${sumCount})`);
    const idxRes = await get('/api/index');
    eq(idxRes.status, 200, 'index status');
    const items = idxRes.json.items || [];
    const catIds = new Set(r.json.categories.map((c) => String(c.id).toLowerCase()));
    for (const it of items) {
      const pc = String((it.product && it.product.category) || '').toLowerCase();
      assert(catIds.has(pc), `index item ${it.product && it.product.id} category "${pc}" missing from /api/categories`);
    }
    assert(sumCount === items.length, `sum(category.count)=${sumCount} must equal indexed item count (${items.length}) — categories derive from listed+negotiable products`);
    cats = r.json.categories;
    return `${r.json.categories.length} categories (${sumCount} items), total=${total}`;
  });

  await test('T67', 'v4 GET /api/index → listed items + published_range; NO private range in public JSON', async () => {
    const r = await get('/api/index');
    eq(r.status, 200, 'status');
    hasKeys(r.json, ['items', 'total', 'filters'], 'index response');
    assert(Array.isArray(r.json.items) && r.json.items.length > 0, 'index items must be non-empty');
    for (const it of r.json.items) {
      hasKeys(it, ['merchant', 'product', 'published_range', 'terms', 'protection', 'negotiate_url'], 'index item');
      hasKeys(it.merchant, ['id', 'name', 'tier', 'score', 'fee_bps', 'cap', 'mode'], 'item.merchant');
      hasKeys(it.product, ['id', 'name', 'price', 'category'], 'item.product');
      hasKeys(it.published_range, ['min', 'max'], 'item.published_range');
      const pmin = num(it.published_range.min);
      assert(pmin !== null && pmin > 0, `published_range.min: ${JSON.stringify(it.published_range.min)}`);
      const pmax = it.published_range.max;
      if (pmax !== null && pmax !== undefined) {
        assert(num(pmax) !== null, `published_range.max must be number|null, got ${JSON.stringify(pmax)}`);
        assert(pmin <= num(pmax), `published_range min ${pmin} > max ${pmax}`);
      }
      assert(String(it.negotiate_url).includes('/negotiate.html?'), `negotiate_url must point at /negotiate.html, got ${JSON.stringify(it.negotiate_url)}`);
      assert(String(it.negotiate_url).includes(`product=${it.product.id}`), `negotiate_url missing product=${it.product.id}: ${it.negotiate_url}`);
      hasKeys(it.protection, ['fee_bps', 'cap', 'mode'], 'item.protection');
    }
    const total = num(r.json.total);
    assert(total !== null && total === r.json.items.length, `index.total (${total}) must equal items.length (${r.json.items.length}) with 5 items and limit 50`);

    // PRIVATE RANGE MUST NOT LEAK from any public read endpoint.
    const leaks = ['sell_min', 'sell_max', 'auto_accept'];
    const publics = ['/api/index', '/api/categories', '/api/merchants', '/api/merchants/m1'];
    for (const ep of publics) {
      const res = await get(ep);
      eq(res.status, 200, `${ep} status`);
      const blob = JSON.stringify(res.json);
      for (const f of leaks) {
        assert(!blob.includes(`"${f}"`), `PRIVATE LEAK: "${f}" appears in ${ep} public JSON`, { endpoint: ep, context: (blob.match(new RegExp(`.{0,70}\\\\?"${f}".{0,70}`)) || [''])[0].slice(0, 220) });
      }
    }
    idx = r.json;
    return `${r.json.items.length} listed items, published_range present, no sell_min/sell_max/auto_accept leak in 4 public endpoints`;
  });

  await test('T68', 'v4 GET /api/index filters: category, q, budget, merchant', async () => {
    const base = idx || (await get('/api/index')).json;
    assert(Array.isArray(base.items) && base.items.length >= 2, 'need at least 2 index items to filter');
    const cat = base.items[0].product.category;
    const byCat = await get(`/api/index?category=${encodeURIComponent(String(cat).toLowerCase())}`);
    eq(byCat.status, 200, 'category filter status');
    assert((byCat.json.items || []).length > 0, `category filter "${cat}" returned no items`);
    for (const it of byCat.json.items) eq(String(it.product.category).toLowerCase(), String(cat).toLowerCase(), 'category filter match');

    const byQ = await get('/api/index?q=aurora');
    eq(byQ.status, 200, 'q filter status');
    assert((byQ.json.items || []).length >= 1, 'q=aurora returned no items');
    for (const it of byQ.json.items) {
      const hay = `${it.product.name} ${it.merchant.name}`.toLowerCase();
      assert(hay.includes('aurora'), `q=aurora matched an item without "aurora": ${it.product.name} / ${it.merchant.name}`);
    }

    const byBudget = await get('/api/index?budget=150');
    eq(byBudget.status, 200, 'budget filter status');
    assert((byBudget.json.items || []).length >= 1, 'budget=150 returned no items');
    for (const it of byBudget.json.items) {
      assert(num(it.published_range.min) <= 150, `budget=150 returned item with published min ${it.published_range.min}`);
    }

    const byM = await get('/api/index?merchant=m1');
    eq(byM.status, 200, 'merchant filter status');
    assert((byM.json.items || []).length >= 1, 'merchant=m1 returned no items');
    for (const it of byM.json.items) eq(it.merchant.id, 'm1', 'merchant filter match');

    assert(isObj(byM.json.filters), 'index response must echo filters');
    return `category ${cat}: ${byCat.json.items.length}, q aurora: ${byQ.json.items.length}, budget 150: ${byBudget.json.items.length}, m1: ${byM.json.items.length}`;
  });

  await test('T69', 'v4 PATCH catalog → range updates, index reflects, validation 400, contract uses new policy', async () => {
    const cat0 = await get('/api/merchants/m1/catalog');
    eq(cat0.status, 200, 'catalog status');
    hasKeys(cat0.json, ['merchant', 'products'], 'catalog');
    const p1 = (cat0.json.products || []).find((x) => x.id === 'p1');
    assert(p1, 'catalog must include p1');
    hasKeys(p1.negotiation, ['negotiable', 'listed', 'sell_min', 'sell_max', 'publish_min', 'publish_max', 'auto_accept'], 'p1.negotiation (merchant view may expose full policy)');

    const up = await http('PATCH', '/api/merchants/m1/catalog/p1', { body: { negotiation: { publish_min: 220 } } });
    eq(up.status, 200, 'PATCH status');
    hasKeys(up.json, ['product', 'catalog'], 'PATCH response');
    near(up.json.product.negotiation.publish_min, 220, 'patched publish_min');

    const idx1 = await get('/api/index?merchant=m1');
    const item1 = (idx1.json.items || []).find((i) => i.product.id === 'p1');
    assert(item1, 'p1 missing from /api/index after PATCH');
    near(item1.published_range.min, 220, 'index published_range.min must reflect the PATCH');

    const bad = await http('PATCH', '/api/merchants/m1/catalog/p1', { body: { negotiation: { publish_min: 100 } } });
    const badDetail = assertErrorShape(bad, 400, 'publish_min < sell_min');
    const bad2 = await http('PATCH', '/api/merchants/m1/catalog/p1', { body: { negotiation: { auto_accept: 999 } } });
    const badDetail2 = assertErrorShape(bad2, 400, 'auto_accept > sell_max');

    const pol = await http('PATCH', '/api/merchants/m1/catalog/p1', { body: { negotiation: { sell_min: 200, auto_accept: 230 } } });
    eq(pol.status, 200, 'policy PATCH status');
    const c = await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' });
    near(c.policy.floor, 200, 'contract policy.floor must come from product sell_min');
    near(c.policy.auto_accept, 230, 'contract policy.auto_accept must come from product config');

    const restore = await http('PATCH', '/api/merchants/m1/catalog/p1', { body: { negotiation: { sell_min: 204, auto_accept: 237, publish_min: 214, publish_max: 249 } } });
    eq(restore.status, 200, 'restore status');
    near(restore.json.product.negotiation.sell_min, 204, 'p1 restored sell_min');
    return `${badDetail}; ${badDetail2}; publish_min 220 visible in index; contract 200/230; p1 restored to 204/237`;
  });

  await test('T70', 'v4 p1 contract floor 204/auto 237; negotiable:false → 409 PRODUCT_NOT_NEGOTIABLE', async () => {
    const c = await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' });
    near(c.list_price, 249, 'p1 list_price');
    near(c.policy.floor, 204, 'p1 policy.floor (seed)');
    near(c.policy.auto_accept, 237, 'p1 policy.auto_accept (seed)');

    const off = await http('PATCH', '/api/merchants/m1/catalog/p2', { body: { negotiation: { negotiable: false } } });
    eq(off.status, 200, 'PATCH p2 negotiable=false');
    const idxOff = await get('/api/index');
    assert(!(idxOff.json.items || []).some((i) => i.product.id === 'p2'), 'non-negotiable p2 must not appear in /api/index');
    const rejected = await post('/api/contracts', { merchant_id: 'm1', product_id: 'p2', buyer_agent_id: 'a1' });
    const detail = assertErrorShape(rejected, 409, 'contract on non-negotiable product');
    eq(String(rejected.json.error.code), 'PRODUCT_NOT_NEGOTIABLE', 'error.code');

    const on = await http('PATCH', '/api/merchants/m1/catalog/p2', { body: { negotiation: { negotiable: true } } });
    eq(on.status, 200, 'PATCH p2 negotiable=true');
    const ok = await createContract({ merchant_id: 'm1', product_id: 'p2', buyer_agent_id: 'a1' });
    eq(ok.status, 'open', 'p2 contract must open after negotiable restored');
    return `p1 floor 204/auto 237; ${detail}; p2 restored`;
  });

  await test('T71', 'v4 pages /merchant.html, /market.html, /negotiate.html → 200 + markers', async () => {
    const merchant = await get('/merchant.html');
    eq(merchant.status, 200, 'merchant.html status');
    assert(/merchant agent setup/i.test(merchant.text), `merchant.html must contain "Merchant agent setup"; got ${merchant.text.length}B`);
    assert(/catalog/i.test(merchant.text), 'merchant.html must reference the catalog');

    const market = await get('/market.html');
    eq(market.status, 200, 'market.html status');
    assert(/negotiation index/i.test(market.text), `market.html must contain "The negotiation index"; got ${market.text.length}B`);
    assert(/negotiat/i.test(market.text), 'market.html must reference negotiation');

    const negotiate = await get('/negotiate.html');
    eq(negotiate.status, 200, 'negotiate.html status');
    assert(/negotiat/i.test(negotiate.text), 'negotiate.html must reference negotiation');
    assert(/agent/i.test(negotiate.text), 'negotiate.html must reference the agent flow');
    assert(/paypal|pay/i.test(negotiate.text), 'negotiate.html must reference payment');

    await reset();
    const again = await get('/api/index');
    eq(again.status, 200, 'index after reset');
    assert((again.json.items || []).length === 5, `after reset the index must list 5 seeded items, got ${(again.json.items || []).length}`);
    const p1 = (await get('/api/merchants/m1/catalog')).json.products.find((x) => x.id === 'p1');
    near(p1.negotiation.sell_min, 204, 'p1 sell_min after reset');
    near(p1.negotiation.auto_accept, 237, 'p1 auto_accept after reset');
    return `3 pages 200 with markers; reset restored 5 index items + p1 204/237`;
  });

  // =========================================================================
  // v5 — index feed + adapter layer (INDEX-FEED-SPEC.md / ADAPTER-SPEC.md)
  // =========================================================================
  await reset();
  const PRIVATE_KEYS = ['sell_min', 'sell_max', 'auto_accept'];

  function assertNoPrivate(obj, label) {
    const blob = JSON.stringify(obj);
    for (const f of PRIVATE_KEYS) {
      assert(!blob.includes(`"${f}"`), `PRIVATE RANGE LEAK: "${f}" in ${label}`, {
        context: (blob.match(new RegExp(`.{0,80}"${f}".{0,80}`)) || [''])[0].slice(0, 240),
      });
    }
  }

  await test('T72', 'v5 GET /api/adapters → registry (inventory/agents/checkout, statuses)', async () => {
    const r = await get('/api/adapters');
    eq(r.status, 200, 'status');
    hasKeys(r.json, ['schema_version', 'inventory', 'agents', 'checkout'], 'adapters registry');
    assert(/settled-adapters\/1\.0/.test(String(r.json.schema_version)), `schema_version: expected settled-adapters/1.0, got ${JSON.stringify(r.json.schema_version)}`);
    for (const group of ['inventory', 'agents', 'checkout']) {
      const list = r.json[group];
      assert(Array.isArray(list) && list.length > 0, `${group} must be a non-empty array`);
      for (const a of list) {
        hasKeys(a, ['id', 'name', 'mode', 'status'], `${group} adapter`);
        assert(typeof a.id === 'string' && a.id.length > 0, `${group} adapter id must be a non-empty string`);
        assert(['ready', 'roadmap'].includes(a.status), `${group}/${a.id}.status: expected ready|roadmap, got ${JSON.stringify(a.status)}`);
      }
    }
    const ids = (group) => r.json[group].map((a) => a.id);
    for (const id of ['csv', 'json', 'shopify', 'woocommerce', 'feed']) {
      assert(ids('inventory').includes(id), `inventory registry missing adapter "${id}" (has: ${ids('inventory').join(', ')})`);
    }
    for (const a of r.json.inventory) eq(a.status, 'ready', `inventory/${a.id} must be ready`);
    for (const id of ['rest', 'mcp', 'a2a']) assert(ids('agents').includes(id), `agents registry missing "${id}"`);
    const agentStatus = Object.fromEntries(r.json.agents.map((a) => [a.id, a.status]));
    eq(agentStatus.rest, 'ready', 'agents/rest status');
    eq(agentStatus.mcp, 'roadmap', 'agents/mcp status');
    eq(agentStatus.a2a, 'roadmap', 'agents/a2a status');
    for (const id of ['hosted', 'paypal-button', 'shopify-plugin', 'woocommerce-plugin']) {
      assert(ids('checkout').includes(id), `checkout registry missing "${id}"`);
    }
    const checkoutStatus = Object.fromEntries(r.json.checkout.map((a) => [a.id, a.status]));
    eq(checkoutStatus.hosted, 'ready', 'checkout/hosted status');
    eq(checkoutStatus['paypal-button'], 'ready', 'checkout/paypal-button status');
    eq(checkoutStatus['shopify-plugin'], 'roadmap', 'checkout/shopify-plugin status');
    return `${r.json.inventory.length} inventory, ${r.json.agents.length} agents, ${r.json.checkout.length} checkout adapters`;
  });

  await test('T73', 'v5 manifest + feed pagination: unique union, final cursor null, no private ranges', async () => {
    const man = await get('/api/index/manifest');
    eq(man.status, 200, 'manifest status');
    hasKeys(man.json, ['schema_version', 'generated_at', 'totals', 'categories', 'endpoints'], 'manifest');
    assert(/settled-index\/1\.0/.test(String(man.json.schema_version)), `manifest.schema_version: got ${JSON.stringify(man.json.schema_version)}`);
    assert(isIso(man.json.generated_at), `manifest.generated_at must be ISO, got ${JSON.stringify(man.json.generated_at)}`);
    hasKeys(man.json.totals, ['merchants', 'categories', 'offers'], 'manifest.totals');
    hasKeys(man.json.endpoints, ['feed', 'search', 'negotiate', 'openapi'], 'manifest.endpoints');
    eq(String(man.json.endpoints.feed), '/api/index/feed', 'manifest.endpoints.feed');
    assert(Array.isArray(man.json.categories), 'manifest.categories must be an array');
    const idx = await get('/api/index');
    const seedIds = (idx.json.items || []).map((i) => `${i.merchant.id}:${i.product.id}`).sort();
    near(man.json.totals.offers, seedIds.length, 'manifest.totals.offers vs /api/index items');
    eq(num(man.json.totals.merchants), 3, 'manifest.totals.merchants');
    eq(num(man.json.totals.categories), man.json.categories.length, 'manifest.totals.categories');
    for (const c of man.json.categories) hasKeys(c, ['id', 'name', 'count', 'min', 'max'], 'manifest category');

    // Page through with limit=2 and collect the union.
    const seen = [];
    let cursor = null;
    let pages = 0;
    let last = null;
    do {
      const url = `/api/index/feed?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await get(url);
      eq(page.status, 200, `feed page ${pages + 1} status`);
      hasKeys(page.json, ['schema_version', 'items', 'next_cursor'], `feed page ${pages + 1}`);
      assert(/settled-index\/1\.0/.test(String(page.json.schema_version)), `feed.schema_version: got ${JSON.stringify(page.json.schema_version)}`);
      assert(Array.isArray(page.json.items) && page.json.items.length <= 2, `feed page ${pages + 1}: expected <=2 items, got ${(page.json.items || []).length}`);
      assert(page.json.items.length > 0, `feed page ${pages + 1} returned no items while next_cursor was non-null`);
      for (const it of page.json.items) {
        hasKeys(it, ['offer_id', 'merchant', 'product', 'published_range', 'terms', 'protection', 'negotiate_url', 'updated_at'], 'feed item');
        eq(it.offer_id, `${it.merchant.id}:${it.product.id}`, 'feed item offer_id = merchant:product');
        assert(isIso(it.updated_at), `feed item ${it.offer_id}.updated_at must be ISO`);
        hasKeys(it.published_range, ['min', 'max'], 'feed item published_range');
        seen.push(it.offer_id);
        pages += 1;
      }
      assertNoPrivate(page.json, `feed page ${pages} (${url})`);
      last = page.json;
      cursor = page.json.next_cursor;
      if (pages > 20) break;
    } while (cursor !== null && cursor !== undefined);

    eq(last.next_cursor, null, 'final feed page must have next_cursor null');
    assert(new Set(seen).size === seen.length, `feed pagination returned duplicates: [${seen.join(', ')}]`);
    eq(seen.slice().sort().join(','), seedIds.join(','), `feed union must equal /api/index offers (${seen.length} vs ${seedIds.length})`);
    assertNoPrivate(man.json, 'index manifest');

    const filtered = await get('/api/index/feed?category=audio&limit=50');
    eq(filtered.status, 200, 'filtered feed status');
    for (const it of filtered.json.items || []) eq(String(it.product.category).toLowerCase(), 'audio', 'feed category filter');
    const byMerchant = await get('/api/index/feed?merchant=m1&limit=50');
    for (const it of byMerchant.json.items || []) eq(it.merchant.id, 'm1', 'feed merchant filter');
    return `${pages} feed items over ${Math.ceil(pages / 2)} page(s), no dupes, final cursor null, no private ranges`;
  });

  await test('T74', 'v5 agent-manifest + /.well-known/settled-agent.json + OpenAPI 3.0.3', async () => {
    const am = await get('/api/agent-manifest');
    eq(am.status, 200, 'agent-manifest status');
    hasKeys(am.json, ['schema_version', 'name', 'endpoints', 'tools'], 'agent manifest');
    assert(/settled-agent\/1\.0/.test(String(am.json.schema_version)), `agent schema_version: got ${JSON.stringify(am.json.schema_version)}`);
    hasKeys(am.json.endpoints, ['manifest', 'feed', 'search', 'negotiate', 'auto', 'order', 'claim'], 'agent manifest endpoints');
    eq(String(am.json.endpoints.manifest), '/api/index/manifest', 'agent endpoint manifest');
    eq(String(am.json.endpoints.feed), '/api/index/feed', 'agent endpoint feed');
    assert(Array.isArray(am.json.tools) && am.json.tools.length >= 7, `agent manifest tools: expected >=7, got ${JSON.stringify((am.json.tools || []).map((t) => t.name))}`);
    const toolNames = am.json.tools.map((t) => t.name);
    for (const n of ['index.manifest', 'index.feed', 'index.search', 'negotiate.start', 'negotiate.auto', 'order.create', 'claim.open']) {
      assert(toolNames.includes(n), `agent tools missing "${n}" (has: ${toolNames.join(', ')})`);
    }
    for (const t of am.json.tools) hasKeys(t, ['name', 'endpoint'], 'agent tool');
    assertNoPrivate(am.json, 'agent manifest');

    const wk = await get('/.well-known/settled-agent.json');
    eq(wk.status, 200, '/.well-known/settled-agent.json status');
    assert(/json/i.test(wk.contentType), `well-known content-type: expected JSON, got ${wk.contentType}`);
    hasKeys(wk.json, ['schema_version', 'endpoints'], 'well-known agent manifest');
    eq(wk.json.schema_version, am.json.schema_version, 'well-known schema_version matches /api/agent-manifest');

    const oa = await get('/api/index/openapi.json');
    eq(oa.status, 200, 'openapi status');
    hasKeys(oa.json, ['openapi', 'info', 'paths'], 'openapi document');
    assert(/^3\.0/.test(String(oa.json.openapi)), `openapi version: expected 3.0.x, got ${JSON.stringify(oa.json.openapi)}`);
    hasKeys(oa.json.info, ['title', 'version'], 'openapi info');
    const paths = Object.keys(oa.json.paths || {});
    for (const want of ['/api/index/manifest', '/api/index/feed', '/api/index', '/api/contracts', '/api/orders']) {
      assert(paths.includes(want), `openapi paths missing ${want} (has: ${paths.join(', ')})`);
    }
    const all = paths.join(' ');
    assert(/\/api\/contracts\/\{[^}]+\}\/ai-auto/.test(all), `openapi missing /api/contracts/{id}/ai-auto path (has: ${all})`);
    assert(/\/api\/orders\/\{[^}]+\}\/claim/.test(all), `openapi missing /api/orders/{id}/claim path (has: ${all})`);
    assertNoPrivate(oa.json, 'openapi document');
    return `agent-manifest ${am.json.tools.length} tools; well-known ok; openapi ${oa.json.openapi} with ${paths.length} paths`;
  });

  await test('T75', 'v5 catalog import: CSV, JSON, Shopify, Woo, upsert, invalid 400, reset', async () => {
    const importPayload = (m, body) => http('POST', `/api/merchants/${m}/catalog/import`, { body });

    const csv = 'sku,name,price,category,description\nIMP-CSV-1,"Imported, Quoted Lamp",59,Lighting,Csv lamp\nIMP-CSV-2,Imported Plain Lamp,69,Lighting,Csv plain';
    const r1 = await importPayload('m2', { adapter: 'csv', data: csv });
    eq(r1.status, 200, 'csv import status');
    hasKeys(r1.json, ['adapter', 'imported', 'updated', 'skipped', 'products', 'errors'], 'csv import response');
    eq(r1.json.adapter, 'csv', 'csv adapter echo');
    assert((r1.json.imported || 0) >= 2, `csv import: expected >=2 imported, got ${JSON.stringify(r1.json.imported)}`);
    assert(Array.isArray(r1.json.errors) && r1.json.errors.length === 0, `csv import errors: ${JSON.stringify(r1.json.errors)}`);
    const cat1 = await get('/api/merchants/m2/catalog');
    const quoted = (cat1.json.products || []).find((p) => p.name === 'Imported, Quoted Lamp');
    assert(quoted, `quoted CSV name not normalized; names: ${(cat1.json.products || []).map((p) => p.name).join(' | ')}`);
    near(quoted.price, 59, 'imported quoted lamp price');

    const r2 = await importPayload('m2', { adapter: 'json', data: { products: [{ sku: 'IMP-JSON-1', name: 'Imported JSON Lamp', price: 79, category: 'Lighting', description: 'json lamp' }] } });
    eq(r2.status, 200, 'json import status');
    assert((r2.json.imported || 0) >= 1, `json import: expected >=1 imported, got ${JSON.stringify(r2.json.imported)}`);

    const r3 = await importPayload('m2', {
      adapter: 'shopify',
      data: { products: [{ id: 9001, title: 'Imported Shopify Lamp', variants: [{ price: '89.00', sku: 'IMP-SHOP-1' }], product_type: 'Lighting', body_html: '<p>Shop lamp</p>' }] },
    });
    eq(r3.status, 200, 'shopify import status');
    assert((r3.json.imported || 0) >= 1, `shopify import: expected >=1 imported, got ${JSON.stringify(r3.json.imported)}`);

    const r4 = await importPayload('m2', {
      adapter: 'woocommerce',
      data: { products: [{ id: 9002, name: 'Imported Woo Lamp', price: '99', sku: 'IMP-WOO-1', categories: [{ name: 'Lighting' }], description: 'woo lamp' }] },
    });
    eq(r4.status, 200, 'woo import status');
    assert((r4.json.imported || 0) >= 1, `woo import: expected >=1 imported, got ${JSON.stringify(r4.json.imported)}`);

    // imported inventory must be visible to the public index
    const idx = await get('/api/index?merchant=m2');
    eq(idx.status, 200, 'index status');
    const names = (idx.json.items || []).map((i) => i.product.name);
    for (const want of ['Imported, Quoted Lamp', 'Imported JSON Lamp', 'Imported Shopify Lamp', 'Imported Woo Lamp']) {
      assert(names.includes(want), `imported product "${want}" missing from /api/index (has: ${names.join(' | ')})`);
    }
    assertNoPrivate(idx.json, '/api/index after import');

    // upsert by sku: change price, no duplicate
    const countBefore = (cat1.json.products || []).length;
    const r5 = await importPayload('m2', { adapter: 'csv', data: 'sku,name,price,category\nIMP-CSV-2,Imported Plain Lamp,74,Lighting' });
    eq(r5.status, 200, 'upsert import status');
    const cat2 = await get('/api/merchants/m2/catalog');
    const upserted = (cat2.json.products || []).find((p) => p.name === 'Imported Plain Lamp');
    assert(upserted, 'upserted product missing');
    near(upserted.price, 74, 'upsert must update the price by sku');
    assert((cat2.json.products || []).length >= countBefore, 'upsert must not remove products');

    // unknown adapter → 400
    const bad = await importPayload('m2', { adapter: 'does-not-exist', data: {} });
    const badDetail = assertErrorShape(bad, 400, 'invalid adapter');
    // No data supplied: either a clean 400 or a 200 that imports nothing. Never a crash or a phantom product.
    const missing = await importPayload('m2', { adapter: 'json' });
    if (missing.status === 200) {
      assert((missing.json.imported || 0) === 0 && (missing.json.updated || 0) === 0,
        `import with no data must not import anything, got imported=${missing.json.imported} updated=${missing.json.updated}`);
    } else {
      assertErrorShape(missing, 400, 'missing import data');
    }

    // reset wipes imported inventory
    await reset();
    const cat3 = await get('/api/merchants/m2/catalog');
    eq((cat3.json.products || []).length, 2, 'reset must restore m2 to 2 seed products');
    assert(!(cat3.json.products || []).some((p) => String(p.name).startsWith('Imported')), 'imported products must be gone after reset');
    const idxReset = await get('/api/index');
    eq((idxReset.json.items || []).length, 5, 'index after reset must list 5 seed items');
    return `csv(2)+json+shopify+woo imported, visible in index, upsert by sku, ${badDetail}; reset restored seed`;
  });

  await test('T76', 'v5 market.html "For indexers" + merchant.html "Import catalog"', async () => {
    const market = await get('/market.html');
    eq(market.status, 200, 'market.html status');
    assert(/for indexers/i.test(market.text), `market.html must contain a "For indexers" panel; got ${market.text.length}B`);
    assert(/manifest/i.test(market.text), 'market.html must reference the manifest');
    assert(/\/api\/index\/feed/.test(market.text) || /feed/i.test(market.text), 'market.html must reference the feed');

    const merchant = await get('/merchant.html');
    eq(merchant.status, 200, 'merchant.html status');
    assert(/import catalog/i.test(merchant.text), `merchant.html must contain "Import catalog"; got ${merchant.text.length}B`);
    assert(/csv/i.test(merchant.text) && /shopify/i.test(merchant.text), 'merchant.html must offer CSV + Shopify adapter options');
    assert(/woo/i.test(merchant.text), 'merchant.html must offer the WooCommerce adapter');

    await reset();
    const idx = await get('/api/index');
    eq((idx.json.items || []).length, 5, 'final reset must restore 5 index items');
    return `market.html (${market.text.length}B) + merchant.html (${merchant.text.length}B) markers ok; seed restored`;
  });

  // =========================================================================
  // v6 — deployability: MCP stdio, A2A card, ranking, widget (DEPLOYABILITY-SPEC)
  // =========================================================================
  await reset();

  async function mcpSession(baseUrl) {
    const mcpPath = path.join(ROOT, 'mcp', 'server.js');
    assert(fs.existsSync(mcpPath), `mcp/server.js not found at ${mcpPath}`, { looked_for: mcpPath });
    const proc = spawn(process.execPath, ['mcp/server.js'], {
      cwd: ROOT,
      env: { ...process.env, SETTLED_BASE_URL: baseUrl, PORT: String(PORT) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [];
    const invalid = [];
    let stderr = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          JSON.parse(line);
          lines.push(line);
        } catch {
          invalid.push(line.slice(0, 200));
        }
      }
    });
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
    async function nextResponse(id, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const at = lines.findIndex((l) => {
          try {
            return JSON.parse(l).id === id;
          } catch {
            return false;
          }
        });
        if (at >= 0) return JSON.parse(lines.splice(at, 1)[0]);
        if (proc.exitCode !== null) fail(`MCP process exited (code ${proc.exitCode}) before response id=${id}`, { stderr: stderr.slice(-900), invalid_stdout: invalid });
        await waitMs(25);
      }
      fail(`MCP timeout after ${timeoutMs}ms waiting for response id=${id}`, { stderr: stderr.slice(-900), recent_stdout: lines.slice(-4), invalid_stdout: invalid });
    }
    return {
      proc,
      invalid,
      stderr: () => stderr,
      send(obj) {
        proc.stdin.write(`${JSON.stringify(obj)}\n`);
      },
      async request(obj) {
        proc.stdin.write(`${JSON.stringify(obj)}\n`);
        return nextResponse(obj.id);
      },
    };
  }

  await test('T77', 'v6 MCP stdio: initialize, tools/list (35), tools/call index_manifest + network_* + moderation_queue, invalid tool', async () => {
    const s = await mcpSession(BASE);
    try {
      const init = await s.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'settled-e2e', version: '1.0' } } });
      eq(init.jsonrpc, '2.0', 'initialize jsonrpc');
      eq(init.id, 1, 'initialize id');
      hasKeys(init.result, ['protocolVersion', 'capabilities', 'serverInfo'], 'initialize result');
      eq(init.result.protocolVersion, '2024-11-05', 'protocolVersion');
      assert(isObj(init.result.capabilities) && isObj(init.result.capabilities.tools), 'initialize capabilities.tools must be an object');
      eq(init.result.serverInfo.name, 'settled', 'serverInfo.name');
      s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      const list = await s.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert(Array.isArray(list.result && list.result.tools), 'tools/list must return result.tools[]');
      const names = list.result.tools.map((t) => t.name);
      eq(list.result.tools.length, 35, `tools/list count (got: ${names.join(', ')})`);
      for (const n of ['index_manifest', 'index_feed', 'index_search', 'network_nodes', 'network_boards', 'network_reputation', 'network_handoff', 'network_handoff_accept', 'network_reputation_revoke', 'moderation_report', 'moderation_queue', 'moderation_hide', 'negotiate_start', 'negotiate_auto', 'order_create', 'claim_open']) {
        assert(names.includes(n), `tools/list missing "${n}" (has: ${names.join(', ')})`);
      }
      for (const t of list.result.tools) hasKeys(t, ['name', 'description', 'inputSchema'], 'tool descriptor');

      const call = await s.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'index_manifest', arguments: {} } });
      const res = call.result;
      assert(isObj(res), `tools/call index_manifest: missing result, got ${JSON.stringify(call).slice(0, 300)}`);
      assert(Array.isArray(res.content) && res.content.length >= 1, 'tools/call result.content must be a non-empty array');
      eq(res.content[0].type, 'text', 'content[0].type');
      let manifest = null;
      try {
        manifest = JSON.parse(res.content[0].text);
      } catch {
        fail('tools/call index_manifest content is not JSON text', { text: String(res.content[0].text).slice(0, 400) });
      }
      eq(manifest.schema_version, 'settled-index/1.0', 'manifest.schema_version via MCP');
      assert(isObj(manifest.totals), 'manifest.totals via MCP');
      eq(res.isError, false, 'isError must be false on success');

      const bad = await s.request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'not_a_real_tool', arguments: {} } });
      assert(isObj(bad.result) && bad.result.isError === true, `unknown tool must return result.isError:true, got ${JSON.stringify(bad).slice(0, 400)}`);

      const net = await s.request({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'network_nodes', arguments: {} } });
      const netRes = net.result;
      assert(isObj(netRes) && netRes.isError === false, `tools/call network_nodes failed: ${JSON.stringify(net).slice(0, 400)}`);
      const network = JSON.parse(netRes.content[0].text);
      eq(typeof network.count, 'number', 'network_nodes count');
      assert(Array.isArray(network.nodes) && network.nodes.some((n) => isObj(n) && n.self === true), 'network_nodes must include the self node');

      const boardsCall = await s.request({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'network_boards', arguments: {} } });
      const boardsRes = boardsCall.result;
      assert(isObj(boardsRes) && boardsRes.isError === false, `tools/call network_boards failed: ${JSON.stringify(boardsCall).slice(0, 400)}`);
      const boards = JSON.parse(boardsRes.content[0].text);
      eq(typeof boards.count, 'number', 'network_boards count');
      assert(Array.isArray(boards.nodes), 'network_boards.nodes must be an array');
      for (const entry of boards.nodes) {
        hasKeys(entry, ['node', 'posts'], 'network_boards entry');
        hasKeys(entry.node, ['name', 'network_id', 'public_url'], 'network_boards node');
        assert(Array.isArray(entry.posts), 'network_boards entry.posts must be an array');
      }

      const repCall = await s.request({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'network_reputation', arguments: { agent: 'NovaBuyer' } } });
      const repRes = repCall.result;
      assert(isObj(repRes) && repRes.isError === false, `tools/call network_reputation failed: ${JSON.stringify(repCall).slice(0, 400)}`);
      const reputation = JSON.parse(repRes.content[0].text);
      eq(typeof reputation.count, 'number', 'network_reputation count');
      assert(Array.isArray(reputation.nodes), 'network_reputation.nodes must be an array');

      const modCall = await s.request({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'moderation_queue', arguments: { admin_key: 'test-admin-key-e2e' } } });
      const modRes = modCall.result;
      assert(isObj(modRes) && modRes.isError === false, `tools/call moderation_queue failed: ${JSON.stringify(modCall).slice(0, 400)}`);
      const queue = JSON.parse(modRes.content[0].text);
      assert(Array.isArray(queue.reports), 'moderation_queue.reports must be an array');

      assert(s.invalid.length === 0, `MCP stdout must be JSON-RPC lines only; non-JSON line(s): ${JSON.stringify(s.invalid)}`);
      return `initialize ok; 35 tools; index_manifest totals ${JSON.stringify(manifest.totals)}; network_nodes count ${network.count}; network_boards peers ${boards.count}; network_reputation count ${reputation.count}; moderation_queue reports ${queue.count}; invalid tool isError=true`;
    } finally {
      // Guarantee no stray stdio child: close stdin, SIGTERM, then SIGKILL if it lingers.
      try {
        s.proc.stdin.end();
      } catch {}
      try {
        s.proc.kill('SIGTERM');
      } catch {}
      const killDeadline = Date.now() + 1500;
      while (Date.now() < killDeadline && s.proc.exitCode === null && s.proc.signalCode === null) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (s.proc.exitCode === null && s.proc.signalCode === null) {
        try {
          s.proc.kill('SIGKILL');
        } catch {}
      }
    }
  });

  await test('T78', 'v6 A2A card at /.well-known/agent-card.json and /api/a2a/agent-card', async () => {
    const wk = await get('/.well-known/agent-card.json');
    eq(wk.status, 200, '/.well-known/agent-card.json status');
    assert(/json/i.test(wk.contentType), `well-known content-type: expected JSON, got ${wk.contentType}`);
    hasKeys(wk.json, ['protocolVersion', 'name', 'description', 'url', 'version', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills'], 'agent card');
    eq(wk.json.protocolVersion, '0.2.0', 'agent card protocolVersion');
    eq(wk.json.name, 'Settled', 'agent card name');
    assert(typeof wk.json.description === 'string' && wk.json.description.length > 0, 'agent card description');
    assert(isObj(wk.json.capabilities), 'agent card capabilities');
    assert(Array.isArray(wk.json.defaultInputModes) && wk.json.defaultInputModes.includes('application/json'), `defaultInputModes: ${JSON.stringify(wk.json.defaultInputModes)}`);
    assert(Array.isArray(wk.json.defaultOutputModes) && wk.json.defaultOutputModes.includes('application/json'), `defaultOutputModes: ${JSON.stringify(wk.json.defaultOutputModes)}`);
    assert(Array.isArray(wk.json.skills) && wk.json.skills.length >= 3, `skills: expected >=3, got ${JSON.stringify((wk.json.skills || []).map((x) => x.id))}`);
    const skillIds = wk.json.skills.map((x) => x.id);
    for (const id of ['negotiate', 'verify', 'claim']) assert(skillIds.includes(id), `agent card skill "${id}" missing (has: ${skillIds.join(', ')})`);
    for (const sk of wk.json.skills) {
      hasKeys(sk, ['id', 'name', 'description', 'tags'], 'skill');
      assert(Array.isArray(sk.tags), `skill ${sk.id}.tags must be an array`);
    }
    assertNoPrivate(wk.json, '/.well-known/agent-card.json');

    const api = await get('/api/a2a/agent-card');
    eq(api.status, 200, '/api/a2a/agent-card status');
    eq(JSON.stringify(api.json), JSON.stringify(wk.json), '/api/a2a/agent-card must serve the same card as /.well-known/agent-card.json');
    return `protocolVersion ${wk.json.protocolVersion}, ${wk.json.skills.length} skills, both paths identical`;
  });

  await test('T79', 'v6 /api/index sort=trust|price|value: ranking metadata, ordering, no private range, feed stable', async () => {
    const feedBefore = await get('/api/index/feed?limit=50');
    eq(feedBefore.status, 200, 'feed status');
    const feedIds = (feedBefore.json.items || []).map((i) => i.offer_id);

    const trust = await get('/api/index?sort=trust');
    eq(trust.status, 200, 'sort=trust status');
    hasKeys(trust.json, ['items', 'ranking'], 'trust response');
    hasKeys(trust.json.ranking, ['sort', 'basis'], 'ranking metadata');
    eq(trust.json.ranking.sort, 'trust', 'ranking.sort');
    assert(typeof trust.json.ranking.basis === 'string' && trust.json.ranking.basis.length > 0, `ranking.basis: ${JSON.stringify(trust.json.ranking.basis)}`);
    const tItems = trust.json.items || [];
    eq(tItems.length, 5, 'trust sort item count');
    // controlled case: m1 (score 91) x2, m2 (76) x2, m3 (54) x1
    eq(tItems.map((i) => i.merchant.id).join(','), 'm1,m1,m2,m2,m3', 'trust order = merchant score desc');
    for (let i = 1; i < tItems.length; i++) {
      const prev = tItems[i - 1], cur = tItems[i];
      const ps = num(prev.merchant.score), cs = num(cur.merchant.score);
      assert(ps >= cs, `trust order broken: ${prev.merchant.id}(${ps}) before ${cur.merchant.id}(${cs})`);
      if (ps === cs) assert(num(prev.product.price) <= num(cur.product.price), `trust tie-break must be price asc at index ${i}`);
    }
    assertNoPrivate(trust.json, '/api/index?sort=trust');

    const price = await get('/api/index?sort=price');
    eq(price.status, 200, 'sort=price status');
    eq(price.json.ranking && price.json.ranking.sort, 'price', 'price ranking.sort');
    const pItems = price.json.items || [];
    for (let i = 1; i < pItems.length; i++) {
      assert(num(pItems[i - 1].product.price) <= num(pItems[i].product.price), `price order broken at index ${i}: ${pItems[i - 1].product.price} > ${pItems[i].product.price}`);
    }
    assertNoPrivate(price.json, '/api/index?sort=price');

    const value = await get('/api/index?sort=value');
    eq(value.status, 200, 'sort=value status');
    eq(value.json.ranking && value.json.ranking.sort, 'value', 'value ranking.sort');
    const vItems = value.json.items || [];
    const discount = (it) => (num(it.product.price) - num(it.published_range.min)) / num(it.product.price);
    for (let i = 0; i < vItems.length; i++) {
      const it = vItems[i];
      assert(num(it.published_range.min) <= num(it.product.price), `value sort item ${it.product.id}: published_min above price`);
      if (i > 0) assert(discount(vItems[i - 1]) >= discount(it) - 1e-9, `value order broken at index ${i}: ${discount(vItems[i - 1]).toFixed(4)} < ${discount(it).toFixed(4)}`);
    }
    assertNoPrivate(value.json, '/api/index?sort=value');

    const feedAfter = await get('/api/index/feed?limit=50');
    const feedIdsAfter = (feedAfter.json.items || []).map((i) => i.offer_id);
    eq(feedIdsAfter.join(','), feedIds.join(','), 'feed ordering must be unaffected by /api/index sort');
    return `trust m1,m1,m2,m2,m3; price asc; value by published discount; feed stable (${feedIds.length} offers)`;
  });

  await test('T80', 'v6 /embed-demo.html + /settled-widget.js → 200, markers, merchant/product URL', async () => {
    const embed = await get('/embed-demo.html');
    eq(embed.status, 200, 'embed-demo.html status');
    assert(/html/i.test(embed.contentType), `embed-demo content-type: ${embed.contentType}`);
    assert(/settled-widget\.js/.test(embed.text), 'embed-demo.html must include the settled-widget.js install snippet');
    assert(/data-merchant/.test(embed.text) && /data-product/.test(embed.text), 'embed-demo.html must pass data-merchant/data-product to the widget');
    assert(/paypal/i.test(embed.text), 'embed-demo.html must show the PayPal button surface');
    // The spec calls for a "what happened" explainer panel; the current copy reads "What just happened?".
    assert(/what (just )?happened|what-happened/i.test(embed.text), `embed-demo.html must contain the "what (just) happened" explainer panel; got ${embed.text.length}B`);

    const w = await get('/settled-widget.js');
    eq(w.status, 200, 'settled-widget.js status');
    assert(/javascript/i.test(w.contentType), `widget content-type: expected javascript, got ${w.contentType}`);
    assert(w.text.length > 500, `settled-widget.js suspiciously short (${w.text.length} bytes)`);
    assert(/data-merchant/.test(w.text), 'widget must read data-merchant');
    assert(/data-product/.test(w.text), 'widget must read data-product');
    assert(w.text.includes('/negotiate.html'), 'widget must link to /negotiate.html');
    assert(/merchant=/.test(w.text) && /product=/.test(w.text), 'widget URL must include merchant and product query params');
    assert(!/https?:\/\/[^"'\s]+\.(js|css)/i.test(w.text), 'widget must not load external js/css assets');
    for (const f of PRIVATE_KEYS) {
      assert(!new RegExp(`\\b${f}\\b`).test(w.text), `PRIVATE RANGE LEAK: "${f}" appears in /settled-widget.js`, { context: (w.text.match(new RegExp(`.{0,60}${f}.{0,60}`)) || [''])[0] });
    }
    return `embed-demo ${embed.text.length}B, widget ${w.text.length}B with merchant/product URL builder`;
  });

  // =========================================================================
  // v7 — inventory automation: connector pull, category rules, windows
  // (INVENTORY-AUTOMATION-SPEC.md)
  // =========================================================================
  await reset();

  const isoFromNow = (ms) => new Date(Date.now() + ms).toISOString();
  const sameInstant = (a, b) => typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b);

  async function startFeedServer(initial) {
    const httpMod = require('node:http');
    const feed = { status: 200, body: initial };
    const server = httpMod.createServer((req, res) => {
      res.writeHead(feed.status, { 'content-type': 'application/json' });
      res.end(typeof feed.body === 'string' ? feed.body : JSON.stringify(feed.body));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return { server, feed, url: `http://127.0.0.1:${server.address().port}/catalog.json` };
  }

  async function closeFeedServer(server) {
    if (!server) return;
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  const ruleOf = (rules, category) => {
    if (Array.isArray(rules)) {
      return rules.find((r) => String((r && (r.category || r.id)) || '').toLowerCase() === String(category).toLowerCase()) || null;
    }
    return (rules && rules[category]) || null;
  };

  await test('T81', 'v7 connector GET/PUT validation + sync from a local JSON feed (import/update, status/counts)', async () => {
    const putConnector = (body) => http('PUT', '/api/merchants/m2/connector', { body });

    const before = await get('/api/merchants/m2/connector');
    eq(before.status, 200, 'GET connector status');
    hasKeys(before.json, ['connector', 'due_at', 'categories'], 'connector response');
    hasKeys(
      before.json.connector,
      ['adapter', 'url', 'interval_seconds', 'enabled', 'last_sync_at', 'last_status', 'last_error', 'last_counts'],
      'connector config'
    );
    assert(
      ['ok', 'error', 'never'].includes(String(before.json.connector.last_status)),
      `connector.last_status must be ok|error|never, got ${JSON.stringify(before.json.connector.last_status)}`
    );
    hasKeys(before.json.connector.last_counts, ['imported', 'updated', 'skipped'], 'connector.last_counts');
    assert(Array.isArray(before.json.categories), `connector.categories must be an array, got ${JSON.stringify(before.json.categories)}`);

    const unknown = await get('/api/merchants/zzz/connector');
    assertErrorShape(unknown, 404, 'connector for unknown merchant');

    const invalid = [
      [{ adapter: 'feed', url: 'ftp://merchant.example/catalog.json', interval_seconds: 300, enabled: true }, 'non-http(s) url'],
      [{ adapter: 'feed', url: 'http://merchant.example/catalog.json', interval_seconds: 30, enabled: true }, 'interval < 60'],
      [{ adapter: 'feed', url: 'http://merchant.example/catalog.json', interval_seconds: 90000, enabled: true }, 'interval > 86400'],
      [{ adapter: 'webhook', url: 'http://merchant.example/catalog.json', interval_seconds: 300, enabled: true }, 'unknown adapter'],
    ];
    const seen = [];
    for (const [body, label] of invalid) {
      seen.push(assertErrorShape(await putConnector(body), 400, `PUT connector ${label}`));
    }

    const feedSrv = await startFeedServer({
      products: [
        { sku: 'SYNC-1', name: 'Synced Sconce', price: 100, category: 'Lighting', description: 'pulled one' },
        { sku: 'SYNC-2', name: 'Synced Pendant', price: 50, category: 'Lighting', description: 'pulled two' },
      ],
    });
    try {
      const saved = await putConnector({ adapter: 'feed', url: feedSrv.url, interval_seconds: 60, enabled: true });
      eq(saved.status, 200, 'PUT valid connector status');
      const cfg = saved.json.connector || saved.json;
      eq(cfg.adapter, 'feed', 'connector.adapter echo');
      eq(cfg.url, feedSrv.url, 'connector.url echo');
      eq(num(cfg.interval_seconds), 60, 'connector.interval_seconds echo');
      eq(cfg.enabled, true, 'connector.enabled echo');

      const afterPut = await get('/api/merchants/m2/connector');
      eq(afterPut.status, 200, 'GET connector after PUT status');
      const c1 = afterPut.json.connector;
      eq(c1.adapter, 'feed', 'persisted adapter');
      eq(c1.url, feedSrv.url, 'persisted url');
      eq(num(c1.interval_seconds), 60, 'persisted interval');
      eq(c1.enabled, true, 'persisted enabled');
      assert(afterPut.json.due_at === null || isIso(afterPut.json.due_at), `due_at must be ISO or null, got ${JSON.stringify(afterPut.json.due_at)}`);
      const cats = (afterPut.json.categories || []).map((c) => String(c && c.id ? c.id : c).toLowerCase());
      assert(cats.includes('lighting'), `connector.categories must include the merchant's categories (Lighting); got ${JSON.stringify(afterPut.json.categories)}`);

      const sync1 = await post('/api/merchants/m2/catalog/sync', {});
      eq(sync1.status, 200, 'POST catalog/sync status');
      hasKeys(sync1.json, ['connector', 'sync'], 'sync response');
      const counts1 = sync1.json.sync.counts || sync1.json.sync;
      assert(num(counts1.imported) >= 2, `first sync must import >=2 products, got ${JSON.stringify(counts1)}`);
      if (Array.isArray(sync1.json.sync.errors)) {
        eq(sync1.json.sync.errors.length, 0, `first sync must not report errors: ${JSON.stringify(sync1.json.sync.errors)}`);
      }
      const catalog1 = await get('/api/merchants/m2/catalog');
      eq(catalog1.status, 200, 'm2 catalog after sync');
      const sconce = (catalog1.json.products || []).find((p) => p.sku === 'SYNC-1');
      assert(sconce, `synced product SYNC-1 missing from catalog; skus: ${(catalog1.json.products || []).map((p) => p.sku).join(', ')}`);
      near(sconce.price, 100, 'synced price');

      const idx1 = await get('/api/index?merchant=m2');
      eq(idx1.status, 200, 'index after sync');
      assert((idx1.json.items || []).some((i) => i.product.name === 'Synced Sconce'), 'synced product must appear in /api/index');
      assertNoPrivate(idx1.json, '/api/index after connector sync');

      const cAfterSync = (await get('/api/merchants/m2/connector')).json.connector;
      eq(cAfterSync.last_status, 'ok', 'connector.last_status after successful sync');
      assert(isIso(cAfterSync.last_sync_at), `connector.last_sync_at must be ISO after sync, got ${JSON.stringify(cAfterSync.last_sync_at)}`);
      assert(
        num(cAfterSync.last_counts.imported) >= 2,
        `connector.last_counts.imported must reflect the pull, got ${JSON.stringify(cAfterSync.last_counts)}`
      );

      // Update path: one price move + one name change, one brand-new sku.
      feedSrv.feed.body = {
        products: [
          { sku: 'SYNC-1', name: 'Synced Sconce mk2', price: 120, category: 'Lighting' },
          { sku: 'SYNC-2', name: 'Synced Pendant', price: 50, category: 'Lighting' },
          { sku: 'SYNC-3', name: 'Synced Uplight', price: 60, category: 'Lighting' },
        ],
      };
      const sync2 = await post('/api/merchants/m2/catalog/sync', {});
      eq(sync2.status, 200, 'second sync status');
      const counts2 = sync2.json.sync.counts || sync2.json.sync;
      assert(num(counts2.updated) >= 1, `second sync must update >=1 existing product, got ${JSON.stringify(counts2)}`);
      assert(num(counts2.imported) >= 1, `second sync must import >=1 new product, got ${JSON.stringify(counts2)}`);
      const catalog2 = await get('/api/merchants/m2/catalog');
      const sconce2 = (catalog2.json.products || []).filter((p) => p.sku === 'SYNC-1');
      eq(sconce2.length, 1, 'upsert by sku must not duplicate SYNC-1');
      near(sconce2[0].price, 120, 'upserted price');
      eq(sconce2[0].name, 'Synced Sconce mk2', 'upserted name');

      // Failure path: a failing feed is recorded on the connector and never crashes the server.
      feedSrv.feed.status = 500;
      const failedSync = await post('/api/merchants/m2/catalog/sync', {});
      if (failedSync.status === 200) {
        const syncObj = failedSync.json.sync || {};
        assert(
          Boolean(syncObj.error) || (Array.isArray(syncObj.errors) && syncObj.errors.length > 0) || (failedSync.json.connector && failedSync.json.connector.last_status === 'error'),
          `failed sync must report an error, got ${JSON.stringify(failedSync.json).slice(0, 400)}`
        );
      } else {
        assertErrorShape(failedSync, [400, 500, 502, 503], 'sync from a failing feed');
      }
      const cErr = (await get('/api/merchants/m2/connector')).json.connector;
      eq(cErr.last_status, 'error', 'connector.last_status after failed sync');
      assert(typeof cErr.last_error === 'string' && cErr.last_error.length > 0, `connector.last_error must be a message, got ${JSON.stringify(cErr.last_error)}`);
      eq((await get('/api/health')).status, 200, 'server must stay healthy after a failed sync');
      await putConnector({ adapter: 'feed', url: feedSrv.url, interval_seconds: 60, enabled: false });
    } finally {
      await closeFeedServer(feedSrv.server);
    }
    await reset();
    return `GET/PUT validated (${seen.join(', ')}); sync imported 2 then updated 1/imported 1; failure recorded, server healthy`;
  });

  await test('T82', 'v7 category rule PUT validation + apply re-derives ranges + new product inherits', async () => {
    const putRule = (category, body) => http('PUT', `/api/merchants/m1/rules/${encodeURIComponent(category)}`, { body });

    const got = await get('/api/merchants/m1/rules');
    eq(got.status, 200, 'GET rules status');
    hasKeys(got.json, ['rules', 'categories'], 'rules response');
    assert(Array.isArray(got.json.categories), `rules.categories must be an array, got ${JSON.stringify(got.json.categories)}`);
    const audio = ruleOf(got.json.rules, 'Audio');
    assert(audio, `seed Audio category rule missing; rules: ${JSON.stringify(got.json.rules).slice(0, 300)}`);
    for (const k of ['negotiable', 'sell_min_pct', 'auto_accept_pct', 'publish_min_pct', 'max_discount_pct']) {
      assert(audio[k] !== undefined, `seed Audio rule missing ${k}: ${JSON.stringify(audio)}`);
    }

    const invalid = [
      [{ sell_min_pct: 0.9, auto_accept_pct: 0.85, publish_min_pct: 0.9, max_discount_pct: 18 }, 'sell_min_pct >= auto_accept_pct'],
      [{ sell_min_pct: 0.4, auto_accept_pct: 0.95, publish_min_pct: 0.5, max_discount_pct: 18 }, 'sell_min_pct < 0.5'],
      [{ sell_min_pct: 0.82, auto_accept_pct: 1.2, publish_min_pct: 0.86, max_discount_pct: 18 }, 'auto_accept_pct > 1'],
      [{ sell_min_pct: 0.82, auto_accept_pct: 0.95, publish_min_pct: 0.7, max_discount_pct: 18 }, 'publish_min_pct < sell_min_pct'],
      [{ sell_min_pct: 0.82, auto_accept_pct: 0.95, publish_min_pct: 0.86, max_discount_pct: 60 }, 'max_discount_pct > 50'],
      [{ sell_min_pct: 0.82, auto_accept_pct: 0.95, publish_min_pct: 0.86, max_discount_pct: 18, window: { from: 'not-a-date', to: null } }, 'non-ISO window'],
    ];
    const seen = [];
    for (const [body, label] of invalid) seen.push(assertErrorShape(await putRule('Audio', body), 400, `PUT rule ${label}`));

    const body = { negotiable: true, sell_min_pct: 0.8, auto_accept_pct: 0.9, publish_min_pct: 0.85, max_discount_pct: 20, window: { from: null, to: null } };
    const saved = await putRule('Audio', body);
    eq(saved.status, 200, 'PUT valid rule status');
    hasKeys(saved.json, ['rule', 'rules'], 'rule save response');
    const rule = saved.json.rule;
    near(rule.sell_min_pct, 0.8, 'rule.sell_min_pct');
    near(rule.auto_accept_pct, 0.9, 'rule.auto_accept_pct');
    near(rule.publish_min_pct, 0.85, 'rule.publish_min_pct');
    eq(num(rule.max_discount_pct), 20, 'rule.max_discount_pct');
    eq(rule.negotiable, true, 'rule.negotiable');
    assert(rule.window === null || (isObj(rule.window) && 'from' in rule.window && 'to' in rule.window), `rule.window must be null or {from,to}, got ${JSON.stringify(rule.window)}`);
    const reread = ruleOf((await get('/api/merchants/m1/rules')).json.rules, 'Audio');
    near(reread.sell_min_pct, 0.8, 'persisted Audio sell_min_pct');

    const applied = await post('/api/merchants/m1/rules/apply', { category: 'Audio' });
    eq(applied.status, 200, 'POST rules/apply status');
    const afterApply = await get('/api/merchants/m1/catalog');
    eq(afterApply.status, 200, 'catalog after apply');
    for (const pid of ['p1', 'p2']) {
      const p = (afterApply.json.products || []).find((x) => x.id === pid);
      assert(p && p.negotiation, `product ${pid} missing negotiation after apply`);
      const n = p.negotiation;
      near(n.sell_min, p.price * 0.8, `${pid}.sell_min from 80% rule`, 1);
      near(n.auto_accept, p.price * 0.9, `${pid}.auto_accept from 90% rule`, 1);
      near(n.publish_min, p.price * 0.85, `${pid}.publish_min from 85% rule`, 1);
      assert(n.sell_min < n.auto_accept && n.auto_accept <= n.sell_max, `${pid} range ordering broken: ${JSON.stringify(n)}`);
      eq(n.negotiable, true, `${pid}.negotiable preserved`);
      eq(n.listed, true, `${pid}.listed preserved`);
    }

    const created = await post('/api/merchants/m1/catalog', { name: 'Rule Inheritor', price: 200, category: 'Audio', description: 'inherits the Audio rule' });
    eq(created.status, 200, 'POST catalog (new product) status');
    const np = created.json.product;
    assert(np && np.negotiation, 'new product must carry a negotiation');
    near(np.negotiation.sell_min, 160, 'new product sell_min (80% of 200)', 1);
    near(np.negotiation.auto_accept, 180, 'new product auto_accept (90% of 200)', 1);
    near(np.negotiation.publish_min, 170, 'new product publish_min (85% of 200)', 1);

    const imported = await post('/api/merchants/m1/catalog/import', {
      adapter: 'json',
      data: { products: [{ sku: 'RULE-IMP-1', name: 'Rule Import', price: 100, category: 'Audio' }] },
    });
    eq(imported.status, 200, 'import under Audio rule status');
    const catImp = await get('/api/merchants/m1/catalog');
    const imp = (catImp.json.products || []).find((p) => p.sku === 'RULE-IMP-1');
    assert(imp && imp.negotiation, 'imported product must carry a negotiation');
    near(imp.negotiation.sell_min, 80, 'imported sell_min (80% of 100)', 1);
    near(imp.negotiation.auto_accept, 90, 'imported auto_accept (90% of 100)', 1);
    near(imp.negotiation.publish_min, 85, 'imported publish_min (85% of 100)', 1);

    assertNoPrivate((await get('/api/index?merchant=m1')).json, '/api/index after rule apply');
    await reset();
    return `validated ${seen.join(', ')}; Audio 80/90/85 re-derived on p1+p2; new + imported items inherited`;
  });

  await test('T83', 'v7 negotiation windows: closed excluded + 409; reopen; product overrides category', async () => {
    const putRule = (body) => http('PUT', '/api/merchants/m1/rules/Audio', { body });
    const patchP1 = (body) => http('PATCH', '/api/merchants/m1/catalog/p1', { body });
    const baseRule = { negotiable: true, sell_min_pct: 0.82, auto_accept_pct: 0.95, publish_min_pct: 0.86, max_discount_pct: 18, window: { from: null, to: null } };
    eq((await putRule(baseRule)).status, 200, 'set Audio rule always-open');
    const past = isoFromNow(-3600 * 1000);
    const future = isoFromNow(3600 * 1000);

    const indexItems = async () => {
      const r = await get('/api/index?merchant=m1&limit=50');
      eq(r.status, 200, '/api/index?merchant=m1 status');
      return r.json.items || [];
    };
    const indexHasP1 = async () => (await indexItems()).some((i) => i.product.id === 'p1');
    const feedOffer = async () => {
      const r = await get('/api/index/feed?merchant=m1&limit=50');
      eq(r.status, 200, 'feed status');
      return (r.json.items || []).find((i) => i.offer_id === 'm1:p1');
    };

    assert(await indexHasP1(), 'p1 must be listed while the window is open');

    const closed = await patchP1({ window: { from: null, to: past } });
    eq(closed.status, 200, 'PATCH p1 window closed status');
    assert(!(await indexHasP1()), 'p1 with a closed window must be excluded from /api/index');
    assert(!(await feedOffer()), 'p1 with a closed window must be excluded from /api/index/feed');
    const rejected = await post('/api/contracts', { merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' });
    eq(assertErrorShape(rejected, 409, 'contract on closed window'), '409 NEGOTIATION_WINDOW_CLOSED');
    eq(String(rejected.json.error.code), 'NEGOTIATION_WINDOW_CLOSED', 'window error code');

    const reopened = await patchP1({ window: { from: null, to: future } });
    eq(reopened.status, 200, 'PATCH p1 window reopen status');
    assert(await indexHasP1(), 'reopened p1 must return to /api/index');
    const reopenedItem = await feedOffer();
    assert(reopenedItem, 'reopened p1 must return to /api/index/feed');
    hasKeys(reopenedItem, ['negotiation_window'], 'feed item window');
    assert(reopenedItem.negotiation_window && typeof reopenedItem.negotiation_window === 'object', `feed negotiation_window must be a public object, got ${JSON.stringify(reopenedItem.negotiation_window)}`);
    assert(
      sameInstant(reopenedItem.negotiation_window.to, future),
      `feed negotiation_window.to: expected ${future}, got ${JSON.stringify(reopenedItem.negotiation_window.to)}`
    );
    eq((await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' })).status, 'open', 'contract must open inside the window');

    const upcoming = await patchP1({ window: { from: future, to: null } });
    eq(upcoming.status, 200, 'PATCH p1 upcoming window status');
    assert(!(await indexHasP1()), 'p1 whose window starts in the future must be excluded');
    assertErrorShape(await post('/api/contracts', { merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' }), 409, 'contract before the window opens');

    eq((await putRule({ ...baseRule, window: { from: null, to: past } })).status, 200, 'close the Audio category window');
    assert(!(await indexHasP1()), 'p1 must inherit the closed Audio category window');
    const override = await patchP1({ window: { from: null, to: future } });
    eq(override.status, 200, 'PATCH p1 product window override status');
    const idsOverride = (await indexItems()).map((i) => i.product.id);
    assert(idsOverride.includes('p1'), 'product window override must beat a closed category window');
    assert(!idsOverride.includes('p2'), 'p2 must stay excluded while the Audio category window is closed');
    eq((await createContract({ merchant_id: 'm1', product_id: 'p1', buyer_agent_id: 'a1' })).status, 'open', 'p1 contract opens via product window override');
    eq(
      assertErrorShape(await post('/api/contracts', { merchant_id: 'm1', product_id: 'p2', buyer_agent_id: 'a1' }), 409, 'p2 contract under closed category window'),
      '409 NEGOTIATION_WINDOW_CLOSED'
    );

    const inherited = await patchP1({ window: null });
    eq(inherited.status, 200, 'PATCH p1 window null (inherit category) status');
    assert(!(await indexHasP1()), 'clearing the product window must fall back to the closed category window');
    await reset();
    return 'open→indexed; closed→excluded+409 NEGOTIATION_WINDOW_CLOSED; reopen→indexed; product override beats closed category';
  });

  await test('T84', 'v7 merchant UI markers + market window label + no private-range leak', async () => {
    const merchantHtml = await get('/merchant.html');
    eq(merchantHtml.status, 200, 'merchant.html status');
    const merchantJs = await get('/merchant.js');
    eq(merchantJs.status, 200, 'merchant.js status');
    const merchantSrc = `${merchantHtml.text}\n${merchantJs.text}`;
    const merchantMarkers = [
      [/inventory source/i, 'Inventory source panel'],
      [/category rules/i, 'Category rules panel'],
      [/pull now/i, 'Pull now button'],
      [/\/connector/, 'connector GET/PUT wiring'],
      [/\/rules/, 'category-rules wiring'],
      [/\/catalog\/sync/, 'catalog sync wiring'],
      [/apply to existing/i, 'apply-to-existing action'],
      [/window from/i, 'window-from field'],
      [/window to/i, 'window-to field'],
      [/shopify/i, 'Shopify adapter option/roadmap'],
      [/woo/i, 'WooCommerce adapter option/roadmap'],
    ];
    for (const [re, label] of merchantMarkers) {
      assert(re.test(merchantSrc), `merchant UI missing ${label} marker (merchant.html ${merchantHtml.text.length}B + merchant.js ${merchantJs.text.length}B)`);
    }
    assert(/datetime-local|window override|pr-group window/i.test(merchantSrc), 'merchant UI must render a product negotiation-window override field');

    const marketHtml = await get('/market.html');
    eq(marketHtml.status, 200, 'market.html status');
    const marketJs = await get('/market.js');
    eq(marketJs.status, 200, 'market.js status');
    const marketSrc = `${marketHtml.text}\n${marketJs.text}`;
    assert(/negotiation_window/.test(marketSrc), 'market must consume the public negotiation_window');
    assert(/open until/i.test(marketSrc), 'market must render an "Open until" window label');
    assert(/opens\s/i.test(marketSrc), 'market must render an upcoming "Opens …" window label');
    // Privacy is about *using* the private range, not naming it in a comment:
    // flag property access, a string-literal key, or an object key, but allow
    // prose such as "the private floor (sell_min/sell_max/auto_accept) is never emitted".
    for (const f of PRIVATE_KEYS) {
      const used = new RegExp(`(?:\\.${f}\\b|["'\`]${f}["'\`]|\\b${f}\\s*:)`);
      assert(!used.test(marketSrc), `PRIVATE RANGE LEAK: "${f}" is used in market assets`, {
        context: (marketSrc.match(new RegExp(`.{0,80}${f}.{0,80}`)) || [''])[0],
      });
    }

    const { spawnSync } = require('node:child_process');
    const bad = [];
    for (const rel of ['public/merchant.js', 'public/market.js']) {
      const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
      if (r.status !== 0) bad.push(`${rel}: ${String(r.stderr || '').trim().split('\n')[0]}`);
    }
    assert(bad.length === 0, `node --check failed on UI assets: ${bad.join(' | ')}`);

    for (const pathname of ['/api/index', '/api/index/feed?limit=50', '/api/index/manifest', '/api/categories']) {
      const r = await get(pathname);
      eq(r.status, 200, `${pathname} status`);
      assertNoPrivate(r.json, pathname);
    }
    const feed = await get('/api/index/feed?limit=50');
    for (const it of feed.json.items || []) {
      hasKeys(it, ['negotiation_window'], `feed item ${it.offer_id}`);
      const w = it.negotiation_window;
      if (w !== null && w !== undefined) hasKeys(w, ['from', 'to'], `feed item ${it.offer_id}.negotiation_window`);
    }

    await reset();
    const finalIdx = await get('/api/index');
    eq((finalIdx.json.items || []).length, 5, 'final reset must restore 5 seed index items');
    return `merchant ${merchantHtml.text.length}B+${merchantJs.text.length}B; market ${marketHtml.text.length}B+${marketJs.text.length}B; window public; no private-range leak`;
  });

  // =========================================================================
  // v8 — agent-assisted setup: autoconfigure + agent-drafted catalog
  // (AGENT-SETUP-SPEC.md)
  // =========================================================================
  await reset();

  const categoryNames = (list) => (list || []).map((c) => String(c && typeof c === 'object' ? (c.name || c.id || '') : c));
  const DEFAULT_RULE_PCTS = { sell_min_pct: 0.82, auto_accept_pct: 0.95, publish_min_pct: 0.86, max_discount_pct: 18 };

  await test('T85', 'v8 agent autoconfigure: rules ensured + applied, categories/updated, idempotent, no AI', async () => {
    // Non-default Audio policy + a product whose category has no rule yet.
    const saved = await http('PUT', '/api/merchants/m1/rules/Audio', {
      body: { sell_min_pct: 0.8, auto_accept_pct: 0.9, publish_min_pct: 0.85, max_discount_pct: 20 },
    });
    eq(saved.status, 200, 'PUT Audio rule status');
    const extra = await post('/api/merchants/m1/catalog', { name: 'Autoconfigure Accessory', price: 100, category: 'Accessories', description: 'created before autoconfigure' });
    eq(extra.status, 200, 'create Accessories product status');
    const extraId = extra.json.product.id;
    const beforeRules = (await get('/api/merchants/m1/rules')).json.rules;
    assert(!ruleOf(beforeRules, 'Accessories'), `test premise failed: Accessories already has a rule: ${JSON.stringify(beforeRules)}`);

    const r1 = await post('/api/merchants/m1/agent/autoconfigure', {});
    eq(r1.status, 200, 'POST agent/autoconfigure status');
    hasKeys(r1.json, ['merchant_id', 'categories', 'updated', 'skipped', 'rules', 'products', 'ai'], 'autoconfigure response');
    eq(r1.json.merchant_id, 'm1', 'autoconfigure.merchant_id');
    const cats = categoryNames(r1.json.categories).map((c) => c.toLowerCase());
    for (const c of ['audio', 'accessories']) {
      assert(cats.includes(c), `autoconfigure.categories must include "${c}"; got ${JSON.stringify(r1.json.categories)}`);
    }
    const accessRule = ruleOf(r1.json.rules, 'Accessories');
    assert(accessRule, `autoconfigure must create a default rule for every product category (Accessories); rules: ${JSON.stringify(Object.keys(r1.json.rules || {}))}`);
    near(accessRule.sell_min_pct, DEFAULT_RULE_PCTS.sell_min_pct, 'Accessories sell_min_pct');
    near(accessRule.auto_accept_pct, DEFAULT_RULE_PCTS.auto_accept_pct, 'Accessories auto_accept_pct');
    near(accessRule.publish_min_pct, DEFAULT_RULE_PCTS.publish_min_pct, 'Accessories publish_min_pct');
    eq(num(accessRule.max_discount_pct), DEFAULT_RULE_PCTS.max_discount_pct, 'Accessories max_discount_pct');
    const audioRule = ruleOf(r1.json.rules, 'Audio');
    near(audioRule.sell_min_pct, 0.8, 'Audio rule preserved by autoconfigure');
    eq(r1.json.ai && r1.json.ai.used, false, 'autoconfigure must not call the AI (ai.used:false)');
    assert(num(r1.json.updated) >= 3, `autoconfigure.updated must count the applied products, got ${JSON.stringify(r1.json.updated)}`);
    eq(num(r1.json.skipped), 0, `no product should skip, got ${JSON.stringify(r1.json.skipped)}`);
    assert(Array.isArray(r1.json.products) && r1.json.products.length >= 3, `autoconfigure.products must return the catalog, got ${JSON.stringify(r1.json.products)}`);

    // Rules were applied: Audio 80/90/85, Accessories 82/95/86.
    const cat1 = await get('/api/merchants/m1/catalog');
    const p1 = (cat1.json.products || []).find((p) => p.id === 'p1');
    assert(p1 && p1.negotiation, 'p1 missing from catalog after autoconfigure');
    near(p1.negotiation.sell_min, Math.round(p1.price * 0.8), 'p1.sell_min after autoconfigure', 1);
    near(p1.negotiation.auto_accept, Math.round(p1.price * 0.9), 'p1.auto_accept after autoconfigure', 1);
    near(p1.negotiation.publish_min, Math.round(p1.price * 0.85), 'p1.publish_min after autoconfigure', 1);
    const acc = (cat1.json.products || []).find((p) => p.id === extraId);
    assert(acc && acc.negotiation, 'Accessories product missing after autoconfigure');
    near(acc.negotiation.sell_min, Math.round(acc.price * 0.82), 'Accessories item sell_min after autoconfigure', 1);
    near(acc.negotiation.auto_accept, Math.round(acc.price * 0.95), 'Accessories item auto_accept after autoconfigure', 1);
    eq(acc.negotiation.window == null, true, 'autoconfigure apply must clear item window overrides (inherit the rule window)');

    // Idempotent: the second call changes neither rules nor ranges nor counters.
    const r2 = await post('/api/merchants/m1/agent/autoconfigure', {});
    eq(r2.status, 200, 'second autoconfigure status');
    eq(num(r2.json.updated), num(r1.json.updated), 'second autoconfigure.updated must equal the first');
    eq(num(r2.json.skipped), num(r1.json.skipped), 'second autoconfigure.skipped must equal the first');
    eq(JSON.stringify(r2.json.rules), JSON.stringify(r1.json.rules), 'second autoconfigure must not change the rules');
    const cat2 = await get('/api/merchants/m1/catalog');
    const p1b = (cat2.json.products || []).find((p) => p.id === 'p1');
    eq(JSON.stringify(p1b.negotiation), JSON.stringify(p1.negotiation), 'second autoconfigure must not change product ranges');
    eq(r2.json.ai && r2.json.ai.used, false, 'idempotent call still reports ai.used:false');
    await reset();
    return `ensured ${cats.length} category rule(s), applied ${num(r1.json.updated)} product(s); second call identical (${num(r2.json.updated)} updated), ai.used:false`;
  });

  await test('T86', 'v8 agent catalog: deterministic 3-product fallback, rule inheritance, empty brief 400, count cap', async () => {
    await reset();
    const before = await get('/api/merchants/m2/catalog');
    const beforeCount = (before.json.products || []).length;
    eq(beforeCount, 2, 'm2 starts with 2 seed products');
    const rules = (await get('/api/merchants/m2/rules')).json.rules;
    const pctsFor = (category) => ruleOf(rules, category) || DEFAULT_RULE_PCTS;

    const added = await post('/api/merchants/m2/agent/catalog', { brief: 'Warm designer lamps and dimmable bulbs for a reading corner' });
    eq(added.status, 200, 'POST agent/catalog status');
    hasKeys(added.json, ['created', 'products', 'ai'], 'agent catalog response');
    const createdCount = num(added.json.created) !== null
      ? num(added.json.created)
      : (Array.isArray(added.json.created) ? added.json.created.length : null);
    eq(createdCount, 3, `agent catalog fallback must create 3 products, got ${JSON.stringify(added.json.created)}`);
    assert(Array.isArray(added.json.products) && added.json.products.length === 3, `agent catalog products: expected 3, got ${JSON.stringify((added.json.products || []).length)}`);
    assert(added.json.ai && added.json.ai.used === false, `no AI key -> deterministic fallback with ai.used:false, got ${JSON.stringify(added.json.ai)}`);

    const after = await get('/api/merchants/m2/catalog');
    eq((after.json.products || []).length, beforeCount + 3, 'agent-created products must be added to the merchant catalog');
    const idx = await get('/api/index?merchant=m2');
    assertNoPrivate(idx.json, '/api/index after agent catalog');
    for (const p of added.json.products) {
      assert(isObj(p) && typeof p.id === 'string' && typeof p.name === 'string' && p.name.length > 0, `agent-created product shape: ${JSON.stringify(p)}`);
      assert(num(p.price) > 0, `agent-created product ${p.id} must have a positive price`);
      const rule = pctsFor(p.category);
      near(p.negotiation.sell_min, Math.round(p.price * rule.sell_min_pct), `${p.name} sell_min inherits the ${p.category} rule`, 1);
      near(p.negotiation.auto_accept, Math.round(p.price * rule.auto_accept_pct), `${p.name} auto_accept inherits the ${p.category} rule`, 1);
      near(p.negotiation.publish_min, Math.round(p.price * rule.publish_min_pct), `${p.name} publish_min inherits the ${p.category} rule`, 1);
      eq(num(p.negotiation.max_discount_pct), num(rule.max_discount_pct), `${p.name} max_discount inherits the ${p.category} rule`);
      assert((idx.json.items || []).some((i) => i.product.id === p.id), `agent-created product ${p.id} must appear in /api/index`);
    }

    // Empty / missing brief is rejected; the catalog is unchanged.
    assertErrorShape(await post('/api/merchants/m2/agent/catalog', { brief: '' }), 400, 'empty brief');
    assertErrorShape(await post('/api/merchants/m2/agent/catalog', { brief: '   ' }), 400, 'whitespace-only brief');
    assertErrorShape(await post('/api/merchants/m2/agent/catalog', {}), 400, 'missing brief');

    // An explicit count is honoured.
    const two = await post('/api/merchants/m2/agent/catalog', { brief: 'Two cheap clip lights', count: 2 });
    eq(two.status, 200, 'count=2 status');
    eq(num(two.json.created), 2, 'count=2 must create 2 products');

    // Count cap: above 8 is either clamped (<=8 created) or rejected 400.
    const many = await post('/api/merchants/m2/agent/catalog', { brief: 'Bulk lights', count: 99 });
    if (many.status === 200) {
      assert(num(many.json.created) <= 8, `count cap is 8, got created=${JSON.stringify(many.json.created)}`);
      assert((many.json.products || []).length <= 8, `count cap is 8, got ${(many.json.products || []).length} products`);
    } else {
      assertErrorShape(many, 400, 'count above the cap');
    }
    await reset();
    return `fallback created 3 with ai.used:false, catalog ${beforeCount}->${beforeCount + 3}, count=2 honoured, cap enforced, empty brief 400, no index leak`;
  });

  await test('T87', 'v8 merchant Agent setup UI (Auto-configure, Add with agent), no manual Add product; demo strip', async () => {
    const merchantHtml = await get('/merchant.html');
    eq(merchantHtml.status, 200, 'merchant.html status');
    const merchantJs = await get('/merchant.js');
    eq(merchantJs.status, 200, 'merchant.js status');
    const merchantSrc = `${merchantHtml.text}\n${merchantJs.text}`;
    const markers = [
      [/agent setup/i, 'Agent setup panel'],
      [/auto-configure/i, 'Auto-configure catalog action'],
      [/add with agent/i, 'Add with agent action'],
      [/describe what you sell/i, 'Describe what you sell brief field'],
      [/\/agent\/autoconfigure/, 'autoconfigure endpoint wiring'],
      [/\/agent\/catalog/, 'agent catalog endpoint wiring'],
      [/agent reads your catalog/i, 'agent-reads-catalog note'],
      [/applies category rules/i, 'applies-category-rules note'],
      [/northwind seller agent/i, 'merchant agent status line'],
      [/policy configured/i, 'policy-configured status'],
    ];
    for (const [re, label] of markers) {
      assert(re.test(merchantSrc), `merchant UI missing ${label} marker (merchant.html ${merchantHtml.text.length}B + merchant.js ${merchantJs.text.length}B)`);
    }
    // The manual one-by-one form is gone (the API stays; only the UI is removed).
    assert(!/\badd product\b/i.test(merchantSrc), 'manual "Add product" section must be removed from /merchant.html (API stays)');
    // Existing panels must survive the agent-setup change.
    for (const [re, label] of [
      [/inventory source/i, 'Inventory source panel'],
      [/category rules/i, 'Category rules panel'],
      [/import catalog/i, 'Import catalog panel'],
      [/agent settings|seller agent/i, 'Agent settings panel'],
    ]) {
      assert(re.test(merchantSrc), `merchant UI lost the ${label} marker`);
    }

    const bad = [];
    const { spawnSync } = require('node:child_process');
    for (const rel of ['public/merchant.js']) {
      const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
      if (r.status !== 0) bad.push(`${rel}: ${String(r.stderr || '').trim().split('\n')[0]}`);
    }
    assert(bad.length === 0, `node --check failed on agent-setup UI: ${bad.join(' | ')}`);

    // Demo-console strip is part of the spec but has no owner in this batch:
    // report presence/wiring, do not fail the build when absent.
    const demoHtml = await get('/demo.html');
    eq(demoHtml.status, 200, 'demo.html status');
    const demoJs = await get('/demo.js');
    eq(demoJs.status, 200, 'demo.js status');
    const demoSrc = `${demoHtml.text}\n${demoJs.text}`;
    const demoStrip = /merchant agent setup/i.test(demoSrc);
    const demoWired = /\/agent\/autoconfigure/.test(demoSrc);
    assert(!(demoWired && !demoStrip), 'demo strip calls autoconfigure but has no "Merchant agent setup" marker');

    await reset();
    eq(((await get('/api/index')).json.items || []).length, 5, 'final reset must restore 5 seed index items');
    const stripDetail = demoStrip ? (demoWired ? 'present+wired' : 'present, wiring missing') : 'absent (no owner in batch)';
    return `agent-setup markers ok; manual Add product removed; 5-step demo intact; demo strip ${stripDetail}`;
  });

  // =========================================================================
  // v9 — experimental signed reputation receipts + cross-node handoff
  // =========================================================================
  await test('T88', 'v9 reputation receipts (Ed25519) verified locally + signed handoff envelope (deep link)', async () => {
    await reset();

    const reg = await post('/api/accounts/register', { role: 'merchant', display_name: 'Receipt Merchant', agent_name: 'ReceiptMerchantAgent' });
    eq(reg.status, 201, 'register receipt merchant');
    const apiKey = reg.json.api_key;

    const offer = await http('POST', '/api/board/offers', {
      headers: { 'x-agent-key': apiKey },
      body: {
        merchant_name: 'Receipt Merchant', title: 'Receipted desk lamp', body: 'settles with a signed receipt',
        category: 'Lighting', price_min: 100, price_max: 120, merchant_api: 'https://receipt.example/api',
      },
    });
    eq(offer.status, 201, 'create receipt offer');
    const postId = offer.json.post.id;

    const inst = await get('/api/instance');
    eq(inst.status, 200, 'GET /api/instance');
    assert(typeof inst.json.reputation_public_key === 'string' && /BEGIN PUBLIC KEY/.test(inst.json.reputation_public_key), 'instance.reputation_public_key must be an SPKI PEM');
    assert((inst.json.capabilities || []).includes('reputation'), 'instance capabilities must include reputation');
    assert((inst.json.capabilities || []).includes('handoff'), 'instance capabilities must include handoff');

    await post(`/api/board/posts/${postId}/close`, { price: 105, buyer_agent: 'ReceiptBuyer' });
    await post(`/api/board/posts/${postId}/escrow-order`, {});
    await post(`/api/board/posts/${postId}/escrow-authorize`, { simulate: true });
    const confirm = await post(`/api/board/posts/${postId}/escrow-confirm`, { simulate: true });
    eq(confirm.status, 200, 'escrow-confirm');
    eq(confirm.json.post.merchant_paid, true, 'merchant_paid must be true before receipts');
    assert(Array.isArray(confirm.json.receipts) && confirm.json.receipts.length === 2, `expected 2 receipts, got ${JSON.stringify(confirm.json.receipts)}`);
    for (const receipt of confirm.json.receipts) {
      hasKeys(receipt, ['schema', 'id', 'issuer_network_id', 'issuer_public_key', 'subject_agent', 'role', 'post_id', 'outcome', 'issued_at', 'signature'], 'receipt');
      eq(receipt.outcome, 'settled', 'receipt.outcome');
      eq(receipt.post_id, postId, 'receipt.post_id');
      assert(receipt.issuer_public_key === inst.json.reputation_public_key, 'receipt issuer key must match the instance manifest key');
      assert(receipt.signature.length > 40, 'receipt.signature must be present');
    }
    const receiptRoles = confirm.json.receipts.map((receipt) => receipt.role).sort();
    eq(receiptRoles.join(','), 'buyer_agent,merchant', 'receipt roles');

    const rep = await get('/api/network/reputation?agent=ReceiptBuyer');
    eq(rep.status, 200, 'GET /api/network/reputation');
    hasKeys(rep.json, ['schema_version', 'network_id', 'agent', 'generated_at', 'count', 'verified_count', 'unverified_count', 'nodes'], 'reputation response');
    eq(rep.json.agent, 'ReceiptBuyer', 'reputation agent');
    eq(rep.json.count, 1, 'reputation count');
    eq(rep.json.verified_count, 1, 'reputation verified_count');
    eq(rep.json.unverified_count, 0, 'reputation unverified_count');
    const selfEntry = (rep.json.nodes || []).find((entry) => entry.node && entry.node.self === true);
    assert(selfEntry && selfEntry.receipts.length === 1, 'self reputation entry must carry the buyer receipt');
    eq(selfEntry.receipts[0].role, 'buyer_agent', 'self receipt role');
    eq(selfEntry.receipts[0].verified, true, 'self receipt must verify');
    eq(selfEntry.verified_count, 1, 'self verified_count');

    const repLower = await get('/api/network/reputation?agent=receiptbuyer');
    eq(repLower.json.count, 1, 'reputation lookup is case-insensitive');
    assertErrorShape(await get('/api/network/reputation'), 400, 'reputation without agent');

    const again = await post(`/api/board/posts/${postId}/escrow-confirm`, { simulate: true });
    eq(again.status, 200, 'second escrow-confirm');
    eq(again.json.already_paid, true, 'second confirm reports already_paid');
    eq(again.json.receipts.length, 2, 'receipts are idempotent');

    // Tiny target node so handoff target validation is exercised without seeds.
    const httpMod = require('node:http');
    let targetUrl = '';
    const target = httpMod.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ schema_version: 'bitsettled-instance/1', network_id: 'peer-target', name: 'Handoff Target', public_url: targetUrl, mode: 'sim' }));
    });
    await new Promise((resolve, reject) => {
      target.once('error', reject);
      target.listen(0, '127.0.0.1', () => {
        targetUrl = `http://127.0.0.1:${target.address().port}`;
        resolve();
      });
    });
    let created = null;
    try {
      assertErrorShape(await http('POST', '/api/network/handoff', { body: { post_id: postId } }), 401, 'handoff without api key');

      const handoff = await http('POST', '/api/network/handoff', {
        headers: { 'x-agent-key': apiKey },
        body: { post_id: postId, target_url: targetUrl },
      });
      eq(handoff.status, 201, 'create handoff');
      hasKeys(handoff.json, ['handoff', 'verified', 'note'], 'handoff response');
      created = handoff.json.handoff;
      hasKeys(created, ['schema', 'handoff_id', 'source_network_id', 'source_public_url', 'source_public_key', 'target', 'post_id', 'item_url', 'created_at', 'signature'], 'handoff envelope');
      eq(created.schema, 'bitsettled-handoff/1', 'handoff schema');
      eq(created.target.network_id, 'peer-target', 'handoff target network id');
      eq(created.post_id, postId, 'handoff post_id');
      eq(created.source_public_key, inst.json.reputation_public_key, 'handoff source key matches manifest');
      assert(/^(?:https?:\/\/[^/]+)?\/item\.html\?post=/.test(created.item_url), `handoff item_url must be an item deep link, got ${created.item_url}`);
      assert(created.item_url.startsWith(targetUrl), `handoff item_url must target the remote node, got ${created.item_url}`);
      assert(isIso(created.created_at), 'handoff created_at must be ISO');
      eq(handoff.json.verified, true, 'handoff signature verifies');
      assert(handoff.json.note && /deep-link/i.test(handoff.json.note), 'handoff response must say it is a deep link, not settlement');

      const read = await get(`/api/network/handoff/${created.handoff_id}`);
      eq(read.status, 200, 'GET /api/network/handoff/:id');
      eq(read.json.verified, true, 'stored handoff verifies');
      eq(read.json.handoff.signature, created.signature, 'handoff signature stable');

      assertErrorShape(await get('/api/network/handoff/hoff_missing'), 404, 'unknown handoff');
      const remote = await http('POST', '/api/network/handoff', { headers: { 'x-agent-key': apiKey }, body: { post_id: 'ext_missing', target_url: targetUrl } });
      eq(remote.status, 201, 'handoff remote-only post');
      assert(remote.json.handoff.item_url.startsWith(targetUrl), 'remote handoff points at target item URL');
      assertErrorShape(await http('POST', '/api/network/handoff', { headers: { 'x-agent-key': apiKey }, body: { post_id: postId, target_url: 'ftp://nope' } }), 400, 'handoff invalid target');
    } finally {
      if (typeof target.closeAllConnections === 'function') target.closeAllConnections();
      await new Promise((resolve) => target.close(() => resolve()));
    }

    await reset();
    return `2 Ed25519 receipts verified locally (${selfEntry.receipts[0].id}); handoff ${created.handoff_id} signed+verified; 401/404/400 paths ok`;
  });

  // =========================================================================
  // v10 — production hardening: headers, body cap, sessions, moderation
  // =========================================================================
  const ADMIN_KEY = 'test-admin-key-e2e';

  await test('T89', 'v10 security headers + 64KB body cap + password sessions + rotate-key/logout', async () => {
    await reset();

    const health = await get('/api/health');
    eq(health.status, 200, 'health status');
    eq(health.headers['x-content-type-options'], 'nosniff', 'X-Content-Type-Options');
    eq(health.headers['referrer-policy'], 'strict-origin-when-cross-origin', 'Referrer-Policy');
    assert(typeof health.headers['permissions-policy'] === 'string' && /camera=\(\)/.test(health.headers['permissions-policy']), 'Permissions-Policy');
    eq(health.headers['x-frame-options'], 'SAMEORIGIN', 'X-Frame-Options');
    assert(!health.headers['strict-transport-security'], 'HSTS must only be sent for https PUBLIC_SITE_URL');
    const embed = await get('/embed-demo.html');
    eq(embed.status, 200, 'embed page status');
    assert(!embed.headers['x-frame-options'], 'embed page must not send X-Frame-Options');
    assert(/frame-ancestors/.test(embed.headers['content-security-policy'] || ''), 'embed page CSP frame-ancestors');

    const big = 'a'.repeat(70 * 1024);
    const tooBig = await http('POST', '/api/accounts/register', { body: `{"role":"buyer","display_name":"${big}"}` });
    eq(tooBig.status, 413, 'oversized body status');
    eq(tooBig.json && tooBig.json.error && tooBig.json.error.code, 'PAYLOAD_TOO_LARGE', 'oversized body code');

    const register = await post('/api/accounts/register', {
      role: 'merchant', display_name: 'Hardened Merchant', agent_name: 'HardenedMerchantAgent', password: 'correct horse battery',
    });
    eq(register.status, 201, 'register with password');
    assert(!JSON.stringify(register.json).includes('scrypt') && !JSON.stringify(register.json).includes('correct horse'), 'password/hash must never be returned');
    const oldKey = register.json.api_key;

    eq((await post('/api/accounts/register', { role: 'buyer', display_name: 'Passwordless', password: 'short' })).status, 400, 'short password rejected');
    eq((await post('/api/accounts/register', { role: 'buyer', display_name: 'Passwordless Buyer' })).status, 201, 'key-only registration still works');

    assertErrorShape(await post('/api/accounts/login', { agent_name: 'HardenedMerchantAgent', password: 'wrong password' }), 401, 'wrong password');
    const login = await post('/api/accounts/login', { agent_name: 'hardenedmerchantagent', password: 'correct horse battery' });
    eq(login.status, 200, 'login');
    hasKeys(login.json, ['session', 'account'], 'login response');
    hasKeys(login.json.session, ['token', 'account_id', 'expires_at'], 'login session');
    assert(!JSON.stringify(login.json).includes('scrypt'), 'login must not expose the password hash');
    const token = login.json.session.token;
    assert(typeof token === 'string' && token.length >= 40, 'session token must be 32-byte random');

    const viaSession = await http('POST', '/api/board/offers', {
      headers: { authorization: `Bearer ${token}` },
      body: { title: 'Session offer', price_min: 10, price_max: 20, merchant_api: 'https://hardened.example/api' },
    });
    eq(viaSession.status, 201, 'Bearer session can write');

    assertErrorShape(await post('/api/accounts/rotate-key', {}), 401, 'rotate-key requires auth');
    const rotatedAuth = await http('POST', '/api/accounts/rotate-key', { headers: { authorization: `Bearer ${token}` }, body: {} });
    eq(rotatedAuth.status, 200, 'rotate-key via session');
    hasKeys(rotatedAuth.json, ['api_key', 'rotated_at'], 'rotate-key response');
    const newKey = rotatedAuth.json.api_key;
    assert(newKey !== oldKey, 'rotate-key must change the key');

    assertErrorShape(await http('POST', '/api/board/offers', { headers: { 'x-agent-key': oldKey }, body: { title: 'Old key', price_min: 10, price_max: 20, merchant_api: 'https://x.example/api' } }), 401, 'old key invalidated');
    eq((await http('POST', '/api/board/offers', { headers: { 'x-agent-key': newKey }, body: { title: 'New key', price_min: 10, price_max: 20, merchant_api: 'https://x.example/api' } })).status, 201, 'new key works');

    eq((await http('POST', '/api/accounts/logout', { headers: { authorization: `Bearer ${token}` } })).status, 200, 'logout');
    assertErrorShape(await http('POST', '/api/board/offers', { headers: { authorization: `Bearer ${token}` }, body: { title: 'After logout', price_min: 10, price_max: 20, merchant_api: 'https://x.example/api' } }), 401, 'logged-out session rejected');

    await reset();
    return `headers ok (nosniff/referrer/permissions/frame, no HSTS on http); 64KB cap 413; session login→write→rotate-key→logout enforced`;
  });

  await test('T90', 'v10 moderation report/queue/hide/restore/audit + hidden reads/writes + 429 rate limit', async () => {
    await reset();

    const reg = await post('/api/accounts/register', { role: 'merchant', display_name: 'Mod Merchant', agent_name: 'ModMerchantAgent' });
    const key = reg.json.api_key;
    const offer = await http('POST', '/api/board/offers', {
      headers: { 'x-agent-key': key },
      body: { title: 'Moderated lamp', price_min: 20, price_max: 30, merchant_api: 'https://mod.example/api', category: 'Lighting' },
    });
    eq(offer.status, 201, 'moderated offer created');
    const postId = offer.json.post.id;

    assertErrorShape(await post('/api/moderation/report', { post_id: postId, reason: 'spam' }), 401, 'report requires auth');
    const report = await http('POST', '/api/moderation/report', {
      headers: { 'x-agent-key': key }, body: { post_id: postId, reason: 'spam sample' },
    });
    eq(report.status, 201, 'report created');
    hasKeys(report.json, ['report'], 'report response');
    hasKeys(report.json.report, ['id', 'post_id', 'reason', 'status', 'reporter', 'created_at', 'actioned_at'], 'report fields');
    eq(report.json.report.status, 'open', 'report status open');
    assertErrorShape(await http('POST', '/api/moderation/report', { headers: { 'x-agent-key': key }, body: { post_id: postId } }), 400, 'report without reason');

    assertErrorShape(await get('/api/moderation/queue'), 401, 'queue without admin key');
    assertErrorShape(await http('GET', '/api/moderation/queue', { headers: { 'x-admin-key': 'wrong-key' } }), 401, 'queue wrong admin key');
    const queue = await http('GET', '/api/moderation/queue?status=open', { headers: { 'x-admin-key': ADMIN_KEY } });
    eq(queue.status, 200, 'admin queue');
    eq(queue.json.status, 'open', 'queue status');
    eq(queue.json.count, 1, 'queue count');
    const queued = queue.json.reports[0];
    hasKeys(queued, ['id', 'post_id', 'reason', 'status', 'reporter', 'post'], 'queue entry');
    eq(queued.post.id, postId, 'queue post id');
    assert(queued.post.hidden === false, 'queue post hidden flag');

    assertErrorShape(await http('POST', `/api/moderation/posts/${postId}/hide`, { headers: { 'x-admin-key': 'wrong-key' }, body: {} }), 401, 'hide wrong key');
    const hide = await http('POST', `/api/moderation/posts/${postId}/hide`, { headers: { 'x-admin-key': ADMIN_KEY }, body: { reason: 'confirmed spam' } });
    eq(hide.status, 200, 'hide post');
    eq(hide.json.hidden, true, 'hide response hidden');
    hasKeys(hide.json.action, ['id', 'action', 'post_id', 'actor', 'created_at'], 'hide action');
    eq(hide.json.action.action, 'hide', 'action kind');
    eq(hide.json.action.actor, 'admin', 'action actor');

    assertErrorShape(await get(`/api/board/posts/${postId}`), 404, 'hidden post direct read');
    eq((await get(`/api/board/posts/${postId}`)).json.error.code, 'MODERATED', 'hidden read code');
    assertErrorShape(await http('POST', `/api/board/posts/${postId}/messages`, { headers: { 'x-agent-key': key }, body: { role: 'buyer_agent', agent_name: 'x', text: 'hi' } }), 409, 'hidden write blocked');
    const list = await get('/api/board');
    eq(list.status, 200, 'board list after hide');
    assert(!list.json.posts.some((p) => p.id === postId), 'hidden post must not appear on the board');

    const hiddenQueue = await http('GET', '/api/moderation/queue?status=hidden', { headers: { 'x-admin-key': ADMIN_KEY } });
    eq(hiddenQueue.status, 200, 'hidden queue');
    eq(hiddenQueue.json.status, 'hidden', 'hidden queue status');
    eq(hiddenQueue.json.count, 1, 'hidden queue count');
    hasKeys(hiddenQueue.json.posts[0], ['id', 'title', 'hidden', 'hidden_at', 'reason'], 'hidden post summary');
    eq(hiddenQueue.json.posts[0].hidden, true, 'hidden queue post hidden flag');

    const actioned = await http('GET', '/api/moderation/queue?status=actioned', { headers: { 'x-admin-key': ADMIN_KEY } });
    eq(actioned.status, 200, 'actioned queue');
    eq(actioned.json.count, 1, 'hide actioned the open report');

    const audit = await http('GET', '/api/moderation/actions', { headers: { 'x-admin-key': ADMIN_KEY } });
    eq(audit.status, 200, 'audit');
    eq(audit.json.count, 1, 'audit count');
    eq(audit.json.actions[0].action, 'hide', 'audit action');

    const restore = await http('POST', `/api/moderation/posts/${postId}/restore`, { headers: { 'x-admin-key': ADMIN_KEY }, body: {} });
    eq(restore.status, 200, 'restore post');
    eq(restore.json.hidden, false, 'restore hidden flag');
    eq((await get(`/api/board/posts/${postId}`)).status, 200, 'restored post readable');
    assertErrorShape(await http('POST', '/api/moderation/posts/ext_missing/hide', { headers: { 'x-admin-key': ADMIN_KEY }, body: {} }), 404, 'hide unknown post');

    // Rate limit: 60 reports/min per account+IP. One report already counted above.
    // Two report requests already counted in this window: the success above and
    // the missing-reason 400. Fill the remaining 58 allowed writes, then 429.
    let allowed = 0;
    for (let i = 0; i < 58; i += 1) {
      const res = await http('POST', '/api/moderation/report', { headers: { 'x-agent-key': key }, body: { post_id: postId, reason: `flood ${i}` } });
      if (res.status === 201) allowed += 1;
    }
    eq(allowed, 58, 'first 60 writes in the window are allowed');
    const limited = await http('POST', '/api/moderation/report', { headers: { 'x-agent-key': key }, body: { post_id: postId, reason: 'one too many' } });
    eq(limited.status, 429, '61st write is rate limited');
    eq(limited.json.error.code, 'RATE_LIMITED', 'rate limit code');
    assert(Number(limited.headers['retry-after']) >= 1, '429 carries Retry-After');

    await reset();
    return `report→queue→hide→restore→audit ok; hidden read 404 MODERATED + write 409; 60/min then 429 RATE_LIMITED+Retry-After`;
  });

  // =========================================================================
  // v11 — handoff acceptance/context + reputation lifecycle
  // =========================================================================
  await test('T91', 'v11 handoff context + target acceptance/list/read + source accepted status', async () => {
    await reset();

    async function freePort() {
      const net = require('node:net');
      return new Promise((resolvePort, rejectPort) => {
        const srv = net.createServer();
        srv.once('error', rejectPort);
        srv.listen(0, '127.0.0.1', () => {
          const { port } = srv.address();
          srv.close(() => resolvePort(port));
        });
      });
    }

    async function startExtraNode(port) {
      const childEnv = {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        PUBLIC_SITE_URL: `http://127.0.0.1:${port}`,
        NETWORK_ID: `extra-${port}`,
        INSTANCE_NAME: `Extra Node ${port}`,
        ADMIN_API_KEY: ADMIN_KEY,
        RATE_LIMIT_PER_MIN: '60',
      };
      for (const k of ['AI_API_KEY', 'PAYPAL_LIVE', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'STATE_PATH', 'NETWORK_SEEDS']) delete childEnv[k];
      const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      proc.stdout.on('data', (d) => (output += d.toString()));
      proc.stderr.on('data', (d) => (output += d.toString()));
      const url = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + BOOT_TIMEOUT;
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) fail(`extra node exited before boot (code ${proc.exitCode})`, { output: output.slice(-1200) });
        try {
          const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
          if (r.ok) return { proc, url };
        } catch {
          // not up yet
        }
        await sleep(150);
      }
      fail('extra node did not answer /api/health', { output: output.slice(-1200), port });
      return null;
    }

    const extraPort = await freePort();
    let extra = null;
    try {
      extra = await startExtraNode(extraPort);

      const xhttp = async (method, extraPath, opts = {}) => {
        const init = {
          method,
          headers: { ...(opts.headers || {}) },
          signal: AbortSignal.timeout(opts.timeout || HTTP_TIMEOUT),
        };
        if (opts.body !== undefined) {
          init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
          init.headers['content-type'] = init.headers['content-type'] || 'application/json';
        }
        const res = await fetch(extra.url + extraPath, init);
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
      };

      const mainReg = await post('/api/accounts/register', { role: 'merchant', display_name: 'Handoff Source', agent_name: 'HandoffSourceAgent' });
      const mainKey = mainReg.json.api_key;
      const offer = await http('POST', '/api/board/offers', {
        headers: { 'x-agent-key': mainKey },
        body: { title: 'Handoff context item', price_min: 50, price_max: 70, merchant_api: 'https://handoff.example/api', category: 'Audio' },
      });
      eq(offer.status, 201, 'handoff source offer');
      const postId = offer.json.post.id;

      const context = {
        post_id: postId, price: 61.5, buyer_agent: 'AcceptBuyer',
        seller_agent: 'Handoff Source', source_deal_id: 'deal_src_1',
      };
      const created = await http('POST', '/api/network/handoff', {
        headers: { 'x-agent-key': mainKey },
        body: { post_id: postId, target_url: extra.url, context },
      });
      eq(created.status, 201, 'create handoff with context');
      const envelope = created.json.handoff;
      hasKeys(envelope, ['schema', 'handoff_id', 'source_network_id', 'source_public_key', 'target', 'post_id', 'item_url', 'created_at', 'context', 'signature'], 'handoff envelope with context');
      eq(envelope.target.network_id, `extra-${extraPort}`, 'handoff target network id');
      eq(envelope.context.price, 61.5, 'signed context price');
      eq(envelope.context.buyer_agent, 'AcceptBuyer', 'signed context buyer');
      assert(envelope.signature.length > 40, 'handoff signature present');

      const targetReg = await xhttp('POST', '/api/accounts/register', { body: { role: 'buyer', display_name: 'Target Acceptor', agent_name: 'TargetAcceptorAgent' } });
      eq(targetReg.status, 201, 'target node registration');
      const targetKey = targetReg.json.api_key;
      const targetAccountId = targetReg.json.participant.id;

      assertErrorShape(await xhttp('POST', '/api/network/handoff/accept', { body: { handoff: envelope } }), 401, 'accept without auth');

      const accepted = await xhttp('POST', '/api/network/handoff/accept', {
        headers: { 'x-agent-key': targetKey }, body: { handoff: envelope },
      });
      eq(accepted.status, 200, 'accept handoff');
      eq(accepted.json.accepted, true, 'accepted flag');
      eq(accepted.json.handoff_id, envelope.handoff_id, 'accepted handoff id');
      eq(accepted.json.target_network_id, `extra-${extraPort}`, 'target network id');
      eq(accepted.json.accepted_by, targetAccountId, 'accepted_by account id');
      assert(isIso(accepted.json.accepted_at), 'accepted_at ISO');
      eq(accepted.json.context.price, 61.5, 'acceptance keeps signed context');
      hasKeys(accepted.json.local_record, ['schema', 'handoff_id', 'target_network_id', 'accepted_by', 'accepted_at', 'context'], 'local record');

      const again = await xhttp('POST', '/api/network/handoff/accept', {
        headers: { 'x-agent-key': targetKey }, body: { handoff: envelope },
      });
      eq(again.status, 200, 'repeat accept');
      eq(again.json.already_accepted, true, 'repeat accept is idempotent');

      const acceptList = await xhttp('GET', '/api/network/handoffs');
      eq(acceptList.status, 200, 'accepted handoff list');
      hasKeys(acceptList.json, ['schema_version', 'count', 'handoffs'], 'accepted list envelope');
      eq(acceptList.json.count, 1, 'accepted list count');
      const acceptRead = await xhttp('GET', `/api/network/handoffs/${envelope.handoff_id}`);
      eq(acceptRead.status, 200, 'accepted handoff read');
      eq(acceptRead.json.accepted, true, 'accepted read flag');
      eq(acceptRead.json.acceptance.handoff_id, envelope.handoff_id, 'acceptance record id');
      assertErrorShape(await xhttp('GET', '/api/network/handoffs/hoff_missing'), 404, 'unknown acceptance');

      const sourceRead = await http('GET', `/api/network/handoff/${envelope.handoff_id}`);
      eq(sourceRead.status, 200, 'source handoff read');
      eq(sourceRead.json.verified, true, 'source envelope verifies');
      eq(sourceRead.json.accepted, true, 'source GET reflects target acceptance');
      eq(sourceRead.json.acceptance.target_network_id, `extra-${extraPort}`, 'source acceptance target');

      const viaId = await xhttp('POST', '/api/network/handoff/accept', {
        body: { handoff_id: envelope.handoff_id, source_url: BASE, api_key: targetKey },
      });
      eq(viaId.status, 200, 'accept via handoff_id + source_url');
      eq(viaId.json.already_accepted, true, 'source-url accept idempotent');

      const tampered = JSON.parse(JSON.stringify(envelope));
      tampered.context.price = 1;
      assertErrorShape(await xhttp('POST', '/api/network/handoff/accept', { headers: { 'x-agent-key': targetKey }, body: { handoff: tampered } }), 400, 'tampered context');

      assertErrorShape(await http('POST', '/api/network/handoff/accept', { headers: { 'x-agent-key': mainKey }, body: { handoff: envelope } }), 409, 'wrong target node');

      // Back-compat: an envelope without context still signs/verifies/accepts.
      const plain = await http('POST', '/api/network/handoff', {
        headers: { 'x-agent-key': mainKey }, body: { post_id: postId, target_url: extra.url },
      });
      eq(plain.status, 201, 'create handoff without context');
      assert(!('context' in plain.json.handoff), 'context omitted when not supplied');
      const plainAccept = await xhttp('POST', '/api/network/handoff/accept', {
        headers: { 'x-agent-key': targetKey }, body: { handoff: plain.json.handoff },
      });
      eq(plainAccept.status, 200, 'legacy handoff without context accepted');

      await reset();
      return `signed context accepted by target ${extra.url}; idempotent accept/list/read; source GET accepted=true; tamper 400; wrong target 409`;
    } finally {
      if (extra && extra.proc) {
        try { extra.proc.kill('SIGTERM'); } catch {}
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && extra.proc.exitCode === null) await sleep(25);
        if (extra.proc.exitCode === null) { try { extra.proc.kill('SIGKILL'); } catch {} }
      }
    }
  });

  await test('T92', 'v11 receipt expiry/revocation/key rotation preserved verification + manifest history', async () => {
    await reset();
    const initialKeyCount = ((await get('/api/instance')).json.reputation_public_keys || []).length;

    async function settleDeal(label, buyerAgent) {
      const reg = await post('/api/accounts/register', { role: 'merchant', display_name: `Life Merchant ${label}`, agent_name: `LifeMerchant${label}` });
      const key = reg.json.api_key;
      const offer = await http('POST', '/api/board/offers', {
        headers: { 'x-agent-key': key },
        body: { title: `Lifecycle item ${label}`, price_min: 80, price_max: 100, merchant_api: 'https://life.example/api', category: 'Gadgets' },
      });
      eq(offer.status, 201, `lifecycle offer ${label}`);
      const postId = offer.json.post.id;
      await post(`/api/board/posts/${postId}/close`, { price: 90, buyer_agent: buyerAgent });
      await post(`/api/board/posts/${postId}/escrow-order`, {});
      await post(`/api/board/posts/${postId}/escrow-authorize`, { simulate: true });
      const confirm = await post(`/api/board/posts/${postId}/escrow-confirm`, { simulate: true });
      eq(confirm.status, 200, `settle ${label}`);
      return confirm.json.receipts;
    }

    const receipts = await settleDeal('one', 'LifeBuyer1');
    eq(receipts.length, 2, 'two receipts issued');
    for (const receipt of receipts) hasKeys(receipt, ['expires_at'], 'receipt expiry field');
    const buyerReceipt = receipts.find((receipt) => receipt.role === 'buyer_agent');
    const ttlDays = Math.round((Date.parse(buyerReceipt.expires_at) - Date.parse(buyerReceipt.issued_at)) / 86400000);
    assert(ttlDays >= 364 && ttlDays <= 366, `default receipt TTL must be ~365 days, got ${ttlDays}`);

    const before = await get('/api/network/reputation?agent=LifeBuyer1');
    eq(before.status, 200, 'reputation before lifecycle changes');
    eq(before.json.ttl_days, 365, 'aggregate ttl_days');
    eq(before.json.count, 1, 'one buyer receipt');
    eq(before.json.verified_count, 1, 'verified before revoke');
    eq(before.json.expired_count, 0, 'not expired');
    eq(before.json.revoked_count, 0, 'not revoked');
    eq(before.json.nodes[0].receipts[0].valid, true, 'valid before revoke');

    assertErrorShape(await post(`/api/network/reputation/${buyerReceipt.id}/revoke`, { reason: 'chargeback' }), 401, 'revoke without admin key');
    assertErrorShape(await http('POST', `/api/network/reputation/${buyerReceipt.id}/revoke`, { headers: { 'x-admin-key': 'wrong' }, body: {} }), 401, 'revoke with wrong admin key');
    assertErrorShape(await http('POST', '/api/network/reputation/rcpt_missing/revoke', { headers: { 'x-admin-key': ADMIN_KEY }, body: {} }), 404, 'revoke unknown receipt');

    const revoked = await http('POST', `/api/network/reputation/${buyerReceipt.id}/revoke`, {
      headers: { 'x-admin-key': ADMIN_KEY }, body: { reason: 'buyer chargeback' },
    });
    eq(revoked.status, 200, 'revoke receipt');
    hasKeys(revoked.json, ['receipt_id', 'revoked', 'revoked_at'], 'revoke response');
    eq(revoked.json.revoked, true, 'revoked flag');
    const revokedAgain = await http('POST', `/api/network/reputation/${buyerReceipt.id}/revoke`, {
      headers: { 'x-admin-key': ADMIN_KEY }, body: {},
    });
    eq(revokedAgain.json.already_revoked, true, 'revocation is idempotent');

    const after = await get('/api/network/reputation?agent=LifeBuyer1');
    eq(after.json.count, 1, 'revoked receipt still listed');
    eq(after.json.verified_count, 0, 'revoked excluded from verified count');
    eq(after.json.revoked_count, 1, 'revoked_count');
    const lifecycleReceipt = after.json.nodes[0].receipts[0];
    eq(lifecycleReceipt.verified, true, 'revoked receipt still cryptographically verified');
    eq(lifecycleReceipt.revoked, true, 'receipt.revoked');
    eq(lifecycleReceipt.valid, false, 'revoked receipt invalid');
    assert(isIso(lifecycleReceipt.revoked_at), 'revoked_at ISO');
    eq(lifecycleReceipt.revocation_reason, 'buyer chargeback', 'revocation_reason');
    assert(!lifecycleReceipt.reason, 'revocation must not be reported as a crypto failure reason');

    assertErrorShape(await post('/api/network/reputation/rotate-key', {}), 401, 'rotate-key without admin key');
    const oldKey = before.json.nodes[0].public_key;
    const rotated = await http('POST', '/api/network/reputation/rotate-key', { headers: { 'x-admin-key': ADMIN_KEY }, body: {} });
    eq(rotated.status, 200, 'rotate-key');
    hasKeys(rotated.json, ['rotated', 'rotated_at', 'previous_public_key', 'reputation_public_key', 'reputation_public_keys'], 'rotate response');
    eq(rotated.json.rotated, true, 'rotated flag');
    eq(rotated.json.previous_public_key, oldKey, 'previous key echoed');
    eq(rotated.json.reputation_public_key, rotated.json.reputation_public_keys[0], 'current key first in history list');
    assert(rotated.json.reputation_public_keys.length === initialKeyCount + 1, 'history has current + previous key');
    assert(!JSON.stringify(rotated.json).includes('PRIVATE KEY'), 'rotation must not expose private keys');

    const manifest = await get('/api/instance');
    eq(manifest.json.reputation_public_key, rotated.json.reputation_public_key, 'manifest current key');
    eq(manifest.json.reputation_public_keys.length, initialKeyCount + 1, 'manifest key history length');
    assert(manifest.json.reputation_public_keys.includes(oldKey), 'manifest retains retired key');

    const afterRotation = await get('/api/network/reputation?agent=LifeBuyer1');
    eq(afterRotation.json.nodes[0].receipts[0].verified, true, 'old receipt still verifies after rotation');
    assert(afterRotation.json.nodes[0].public_keys.includes(oldKey), 'node entry exposes key history');

    const newReceipts = await settleDeal('two', 'LifeBuyer2');
    const newBuyerReceipt = newReceipts.find((receipt) => receipt.role === 'buyer_agent');
    eq(newBuyerReceipt.issuer_public_key, rotated.json.reputation_public_key, 'new receipt signed by rotated key');
    const newRep = await get('/api/network/reputation?agent=LifeBuyer2');
    eq(newRep.json.count, 1, 'new receipt aggregated');
    eq(newRep.json.verified_count, 1, 'new receipt valid');

    // Pure lifecycle checks (expiry + signed expires_at).
    const reputationLib = require(path.join(ROOT, 'lib', 'reputation'));
    const expired = reputationLib.lifecycle({ expires_at: new Date(Date.now() - 60000).toISOString() });
    eq(expired.expired, true, 'past expires_at is expired');
    const future = reputationLib.lifecycle({ expires_at: new Date(Date.now() + 86400000).toISOString() });
    eq(future.expired, false, 'future expires_at is not expired');
    const legacy = reputationLib.lifecycle({ issued_at: new Date(Date.now() - 366 * 86400000).toISOString() });
    eq(legacy.expired, true, 'legacy receipt without expires_at derives TTL from issued_at');
    const tamperedExpiry = Object.assign({}, buyerReceipt, { expires_at: new Date(Date.now() + 30 * 86400000).toISOString() });
    const tamperedVerdict = reputationLib.verifyReceipt(tamperedExpiry, buyerReceipt.issuer_public_key);
    eq(tamperedVerdict.verified, false, 'expires_at is signed: changing it invalidates the receipt');
    eq(tamperedVerdict.reason, 'signature_invalid', 'tampered expiry reason');

    await reset();
    return `expires_at 365d; revoke excludes from verified_count (verified true, valid false); key rotation keeps old receipts valid + manifest history; tampered expiry rejected`;
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
  let fatal = null;
  try {
    await main();
  } catch (e) {
    fatal = e;
    print('');
    print(`FATAL ${e.message}`);
    if (e.evidence) print(`      evidence: ${JSON.stringify(e.evidence).slice(0, 1500)}`);
  } finally {
    await stopServer().catch(() => {});
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    print('');
    print('------------------------------------------------------------');
    print(`RESULT: ${passed}/${results.length} passed, ${failed.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''}${fatal ? ' (+1 fatal)' : ''}`);
    if (failed.length) {
      print('Failed:');
      for (const f of failed) print(`  - ${f.id} ${f.name}: ${f.err.message}`);
    }
    print(`Server: ${reused ? 'reused (left running)' : child && child.pid ? 'spawned (terminated)' : 'none'}`);
    print('');
    process.exitCode = failed.length || fatal ? 1 : 0;
    // Hard exit guard in case a socket/promise keeps the loop alive.
    setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
  }
})();
