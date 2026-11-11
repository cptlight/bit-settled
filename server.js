'use strict';
/**
 * Settled — reputation settles with the payment.
 * Zero-dependency Node HTTP server implementing BUILD-SPEC v1 §5.
 *
 *   node server.js      ->  http://127.0.0.1:4173
 *
 * Files owned here: this file + lib/{data,risk,ledger,paypal}.js
 * public/ and test/ are owned by other agents.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const data = require('./lib/data');
const risk = require('./lib/risk');
const ledger = require('./lib/ledger');
const paypal = require('./lib/paypal');
const passport = require('./lib/passport');
const contracts = require('./lib/contract');
const protection = require('./lib/protection');
const catalog = require('./lib/catalog');
const adapters = require('./lib/adapters');
const connectors = require('./lib/connectors');
const ai = require('./lib/ai');
const live = require('./lib/live');
const mcpHttp = require('./lib/mcp-http');
const board = require('./lib/board');
const agentBuy = require('./lib/agent-buy');

/**
 * lib/paypal-flow.js is authored in parallel (paypal-platform-scout). Resolve it
 * lazily and tolerate its absence so the server always boots; once the file
 * exists a plain restart (or the first /api/paypal/* request) picks it up.
 */
let paypalFlowModule = null;
function getPaypalFlow() {
  if (paypalFlowModule) return paypalFlowModule;
  try {
    // eslint-disable-next-line global-require
    const mod = require('./lib/paypal-flow');
    if (mod && typeof mod.handle === 'function') paypalFlowModule = mod;
  } catch {
    paypalFlowModule = null;
  }
  return paypalFlowModule;
}

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024; // 1 MiB
const PLATFORM_FEE_BPS = (() => {
  const n = Number(process.env.PLATFORM_FEE_BPS);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : 50; // 0.50% default
})();

const CLAIM_REASONS = new Set(['not_delivered', 'not_as_described', 'damaged']);
const TIERS = ['A', 'B', 'C', 'D'];

/** One signed issuance event per merchant so the dashboard timeline starts populated. */
function seedLedgerEvents() {
  for (const m of data.listMerchants()) {
    const already = data.state.events.some(
      (e) => e.merchant_id === m.id && e.type === 'ledger_issued'
    );
    if (already) continue;
    ledger.appendEvent(m.id, 'ledger_issued', {
      merchant_id: m.id,
      tier: m.tier,
      score: m.score,
      fee_bps: m.fee_bps,
      cap: m.cap,
      mode: m.mode,
      reserve: m.reserve,
      note: 'Portable trust ledger issued',
    });
  }
}

// ---------------------------------------------------------------- helpers --
const { round2, randHex, nowIso } = data;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function fail(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 400, code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns {} for an empty body. */
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw Object.assign(new Error('body is not valid JSON'), { status: 400, code: 'INVALID_JSON' });
  }
}

/** Recompute risk for a merchant and emit tier_change when it fires. */
function recomputeWithEvents(merchant) {
  const result = risk.recompute(merchant);
  const events = [];
  if (result.tier_changed) {
    events.push(
      ledger.appendEvent(merchant.id, 'tier_change', {
        from: result.from,
        to: result.to,
        score: result.score,
        fee_bps: merchant.fee_bps,
        cap: merchant.cap,
        mode: merchant.mode,
      })
    );
  }
  return { result, events };
}

/** §5 merchant summary returned by claim(). */
function merchantSummary(merchant) {
  return {
    id: merchant.id,
    tier: merchant.tier,
    score: merchant.score,
    reserve: round2(merchant.reserve),
    coverage: merchant.coverage,
    fee_bps: merchant.fee_bps,
    cap: merchant.cap,
    mode: merchant.mode,
  };
}

// ------------------------------------------------------------- API routes --

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    mode: paypal.mode(),
    merchants: data.listMerchants().length,
  });
}

function handleMerchants(req, res) {
  sendJson(res, 200, { merchants: data.listMerchants().map(data.publicMerchant) });
}

function handleMerchantDetail(req, res, id) {
  const merchant = data.getMerchant(id);
  if (!merchant) return fail(res, 404, 'MERCHANT_NOT_FOUND', `no merchant with id '${id}'`);
  const bundle = ledger.issueCredential(merchant);
  sendJson(res, 200, {
    merchant: data.publicMerchant(merchant),
    ledger: bundle,
    events: data.eventsFor(id),
  });
}

function handleMerchantLedger(req, res, id) {
  const merchant = data.getMerchant(id);
  if (!merchant) return fail(res, 404, 'MERCHANT_NOT_FOUND', `no merchant with id '${id}'`);
  sendJson(res, 200, ledger.issueCredential(merchant));
}

async function handleMerchantVerify(req, res, id) {
  const merchant = data.getMerchant(id);
  if (!merchant) return fail(res, 404, 'MERCHANT_NOT_FOUND', `no merchant with id '${id}'`);

  const body = await readJson(req);
  // Optional: verify a credential supplied by the caller (tamper demos).
  let bundle;
  if (body.credential && body.signature) {
    bundle = { credential: body.credential, signature: body.signature, alg: ledger.ALG };
  } else {
    bundle = ledger.issueCredential(merchant);
  }
  const { valid, checks } = ledger.inspect(bundle.credential, bundle.signature);
  sendJson(res, 200, { valid, checks, credential: bundle.credential });
}

function handleMerchantEvents(req, res, id) {
  const merchant = data.getMerchant(id);
  if (!merchant) return fail(res, 404, 'MERCHANT_NOT_FOUND', `no merchant with id '${id}'`);
  sendJson(res, 200, { events: data.eventsFor(id) });
}

async function handleCreateOrder(req, res, merchantId) {
  const merchant = data.getMerchant(merchantId);
  if (!merchant) return fail(res, 404, 'MERCHANT_NOT_FOUND', `no merchant with id '${merchantId}'`);

  const body = await readJson(req);
  const productId = body.product_id;
  if (!productId || typeof productId !== 'string') {
    return fail(res, 400, 'INVALID_REQUEST', "body.product_id is required");
  }
  const product = data.getProduct(merchant, productId);
  if (!product) {
    return fail(res, 404, 'PRODUCT_NOT_FOUND', `no product '${productId}' for merchant '${merchantId}'`);
  }
  if (merchant.mode === 'blocked') {
    return fail(res, 409, 'MERCHANT_BLOCKED', `merchant '${merchantId}' is blocked (tier D); purchases are disabled`);
  }

  const buyer = {
    name: (body.buyer && typeof body.buyer.name === 'string' && body.buyer.name) || 'Guest',
    email: (body.buyer && typeof body.buyer.email === 'string' && body.buyer.email) || 'guest@example.com',
  };

  // --- Agent / negotiated-contract extension (all additive & optional) ------
  // Absent contract_id and agent_id, this handler behaves exactly as before.
  let negotiated = null;
  if (body.contract_id !== undefined && body.contract_id !== null) {
    if (typeof body.contract_id !== 'string') {
      return fail(res, 400, 'INVALID_REQUEST', 'body.contract_id must be a string');
    }
    negotiated = contracts.getContract(body.contract_id);
    if (!negotiated) {
      return fail(res, 404, 'CONTRACT_NOT_FOUND', `no contract with id '${body.contract_id}'`);
    }
    if (negotiated.status !== 'accepted' || !negotiated.agreed_price) {
      return fail(
        res,
        409,
        'CONTRACT_NOT_ACCEPTED',
        `contract '${negotiated.id}' has status '${negotiated.status}', expected 'accepted'`
      );
    }
    if (negotiated.merchant_id !== merchant.id) {
      return fail(
        res,
        409,
        'CONTRACT_MERCHANT_MISMATCH',
        `contract '${negotiated.id}' belongs to merchant '${negotiated.merchant_id}'`
      );
    }
    if (negotiated.product_id !== product.id) {
      return fail(
        res,
        409,
        'CONTRACT_PRODUCT_MISMATCH',
        `contract '${negotiated.id}' is for product '${negotiated.product_id}'`
      );
    }
  }

  // A negotiated contract fixes the price; otherwise list price applies.
  const amount = negotiated ? round2(negotiated.agreed_price) : round2(product.price);

  // An explicit agent_id must present a valid passport before it may spend.
  if (body.agent_id !== undefined && body.agent_id !== null) {
    if (typeof body.agent_id !== 'string') {
      return fail(res, 400, 'INVALID_REQUEST', 'body.agent_id must be a string');
    }
    if (negotiated && negotiated.buyer_agent_id !== body.agent_id) {
      return fail(
        res,
        409,
        'CONTRACT_AGENT_MISMATCH',
        `contract '${negotiated.id}' was negotiated by agent '${negotiated.buyer_agent_id}'`
      );
    }
    const verdict = passport.verifyAgent(body.agent_id, {
      merchant_id: merchant.id,
      amount,
      category: merchant.category,
    });
    if (!verdict.verified) {
      return fail(
        res,
        403,
        'AGENT_NOT_VERIFIED',
        `agent '${body.agent_id}' failed verification: ${verdict.reasons.join(', ') || 'unknown'}`
      );
    }
  }

  // Assurance of Contract: the portable proof of what was agreed and by whom.
  const acc = negotiated
    ? {
        contract_id: negotiated.id,
        hash: negotiated.hash,
        transcript_hash: ledger.sha256hex(JSON.stringify(negotiated.transcript)),
        terms: negotiated.terms,
        buyer_agent_id: negotiated.buyer_agent_id,
      }
    : null;

  const fee_bps = merchant.fee_bps;
  const fee = round2((amount * fee_bps) / 10000);
  const prot = { mode: merchant.mode, cap: merchant.cap };

  // Payment rail: live PayPal order, or the simulated rail. `simulate:true`
  // forces SIM even on a live-configured server so the deterministic
  // "Run full demo" path never depends on the PayPal sandbox being reachable.
  const forceSim = body.simulate === true;
  const liveRail = paypal.isLive() && !forceSim;
  const platform_fee = round2((amount * PLATFORM_FEE_BPS) / 10000);
  const merchant_net = round2(amount - platform_fee);
  const platform_fee_collected = liveRail && process.env.PAYPAL_PLATFORM_FEES === '1' && Boolean(process.env.PAYPAL_PLATFORM_FEE_PAYEE);

  let paymentResult;
  try {
    if (liveRail) {
      paymentResult = await paypal.createOrder({
        amount,
        currency: 'USD',
        returnUrl: `${process.env.PUBLIC_BASE_URL || `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`}/store.html?merchant=${encodeURIComponent(merchantId)}`,
        platformFee: platform_fee,
        platformFeeBps: PLATFORM_FEE_BPS,
      });
    } else {
      paymentResult = { id: 'SIM-' + randHex(8), approval_url: null, simulated: true };
    }
  } catch (err) {
    return fail(res, 502, 'PAYMENT_PROVIDER_ERROR', `payment provider failed: ${err.message}`);
  }

  const order = {
    id: 'ord_' + randHex(8),
    merchant_id: merchant.id,
    product_id: product.id,
    product_name: product.name,
    amount,
    fee_bps,
    fee,
    platform_fee_bps: PLATFORM_FEE_BPS,
    platform_fee,
    merchant_net,
    platform_fee_collected,
    protection: prot,
    status: liveRail ? 'pending' : 'paid',
    payment_id: paymentResult.id,
    buyer,
    created_at: nowIso(),
    captured_at: liveRail ? null : nowIso(),
    delivered_at: null,
    // Tracks the caller's explicit `simulate` flag (demo determinism), not the
    // payment rail: a plain order on a SIM server is still `simulated: false`.
    simulated: forceSim,
  };
  if (acc) order.acc = acc;
  if (body.agent_id) order.agent_id = body.agent_id;
  data.state.orders.push(order);

  // New order counts toward volume; then re-derive risk.
  merchant.metrics.orders += 1;
  const { events: tierEvents } = recomputeWithEvents(merchant);

  const eventPayload = {
    order_id: order.id,
    product_id: product.id,
    product_name: product.name,
    amount,
    fee_bps,
    fee,
    platform_fee_bps: PLATFORM_FEE_BPS,
    platform_fee,
    merchant_net,
    mode: prot.mode,
    cap: prot.cap,
    payment_id: order.payment_id,
  };
  if (acc) eventPayload.acc = acc;
  if (body.agent_id) eventPayload.agent_id = body.agent_id;
  const event = ledger.appendEvent(merchant.id, 'order', eventPayload);

  const bundle = ledger.issueCredential(merchant);
  const receipt = {
    order_id: order.id,
    paid: amount,
    platform_fee_bps: PLATFORM_FEE_BPS,
    platform_fee,
    merchant_net,
    platform_fee_collected,
    captured_at: order.captured_at,
    credential_hash: ledger.credentialHash(bundle),
  };
  if (acc) receipt.acc = acc;

  const payment = {
    mode: paypal.mode(),
    id: paymentResult.id,
    captured: !liveRail,
  };
  if (paymentResult.approval_url) payment.approval_url = paymentResult.approval_url;

  const response = { order, payment, receipt, event };
  if (acc) response.acc = acc;

  // 200 (not 201): BUILD-SPEC §5 enumerates only 400/404/409 and treats every
  // non-error response as 200, so callers may assume 200 on success.
  sendJson(res, 200, response);
  // (tier events, if any, are already persisted on the merchant's event stream)
  void tierEvents;
}

async function handleFulfill(req, res, orderId) {
  const order = data.getOrder(orderId);
  if (!order) return fail(res, 404, 'ORDER_NOT_FOUND', `no order with id '${orderId}'`);
  // Only a freshly paid order can be fulfilled; a second fulfill is a 409.
  if (order.status !== 'paid') {
    return fail(res, 409, 'ORDER_NOT_PAID', `order '${orderId}' has status '${order.status}', cannot fulfill`);
  }

  const merchant = data.getMerchant(order.merchant_id);
  order.delivered_at = nowIso();
  order.status = 'delivered'; // §8.4: fulfill moves the order to `delivered`

  if (merchant) {
    merchant.delivered_count = (merchant.delivered_count || 0) + 1;
    if (merchant.metrics.orders > 0) {
      merchant.metrics.delivered_pct =
        Math.round((merchant.delivered_count / merchant.metrics.orders) * 1000) / 10;
    }
    recomputeWithEvents(merchant);
  }

  const event = ledger.appendEvent(order.merchant_id, 'delivery', {
    order_id: order.id,
    delivered_at: order.delivered_at,
    product_id: order.product_id,
  });

  sendJson(res, 200, { order, event });
}

async function handleClaim(req, res, orderId) {
  const order = data.getOrder(orderId);
  if (!order) return fail(res, 404, 'ORDER_NOT_FOUND', `no order with id '${orderId}'`);

  const body = await readJson(req);
  const reason = body.reason;
  if (!CLAIM_REASONS.has(reason)) {
    return fail(
      res,
      400,
      'INVALID_REASON',
      `body.reason must be one of: ${Array.from(CLAIM_REASONS).join(', ')}`
    );
  }
  if (body.evidence !== true) {
    return fail(res, 400, 'EVIDENCE_REQUIRED', 'body.evidence must be true to approve a claim');
  }
  if (order.status === 'claimed' || order.status === 'refunded') {
    return fail(res, 409, 'ORDER_ALREADY_CLAIMED', `order '${orderId}' has status '${order.status}'`);
  }

  const merchant = data.getMerchant(order.merchant_id);
  if (!merchant) return fail(res, 404, 'MERCHANT_NOT_FOUND', `no merchant for order '${orderId}'`);

  // Refund is bounded by the order amount, the protection cap, and the
  // funds actually available in the merchant reserve + network pool.
  const available = round2((Number(merchant.reserve) || 0) + (Number(data.state.network_pool) || 0));
  const refund = round2(Math.min(order.amount, order.protection.cap, available));
  if (refund <= 0) {
    return fail(res, 409, 'INSUFFICIENT_RESERVE', 'no reserve or pool funds are available for this claim');
  }

  // --- AI claim explainer (advisory only; the rule engine stays final) ------
  // Runs BEFORE any reserve mutation so a slow/failed LLM never leaves money
  // half-settled. `use_ai` is opt-in so the existing deterministic path is
  // byte-identical when it is absent.
  let claimAi = null;
  if (body.use_ai === true) {
    try {
      claimAi = await ai.explainClaim({ order, merchant, reason, evidence: true });
    } catch (err) {
      claimAi = {
        used: false,
        provider: ai.config().provider,
        model: null,
        recommendation: 'review',
        confidence: 0,
        rationale: `AI explainer unavailable: ${err.message}`,
        error: err.message,
      };
    }
  }

  // --- Live PayPal refund, before we touch merchant reserve ----------------
  // Simulated orders keep the SIM refund rail even on a live-configured server,
  // so the deterministic "Run full demo" path still settles offline.
  const needsLiveRefund = paypal.isLive() && order.simulated !== true;
  let paypalRefundId = 'SIM-RF-' + randHex(8);

  if (needsLiveRefund) {
    if (!order.capture_id) {
      return fail(
        res,
        409,
        'ORDER_NOT_CAPTURED',
        `order '${orderId}' has no PayPal capture yet; capture it before claiming`
      );
    }
    if (typeof paypal.refundCapture !== 'function') {
      return fail(res, 502, 'PAYMENT_PROVIDER_ERROR', 'paypal adapter does not support refunds');
    }
    try {
      const refundResult = await paypal.refundCapture(order.capture_id, { amount: refund });
      const realId = refundResult && (refundResult.id || refundResult.refund_id);
      if (!realId) throw new Error('refund response missing id');
      paypalRefundId = realId;
    } catch (err) {
      return fail(res, 502, 'PAYMENT_PROVIDER_ERROR', `refund failed: ${err.message}`);
    }
  }

  const reserveBefore = round2(merchant.reserve);

  const fromReserve = round2(Math.min(refund, reserveBefore));
  const shortfall = round2(refund - fromReserve);
  const fromPool = round2(Math.min(shortfall, data.state.network_pool));

  merchant.reserve = round2(reserveBefore - fromReserve);
  data.state.network_pool = round2(data.state.network_pool - fromPool);

  // A claim is a dispute event for reputation purposes.
  merchant.metrics.disputes += 1;
  const { events: tierEvents } = recomputeWithEvents(merchant);

  order.status = 'refunded';
  order.refunded_at = nowIso();

  // Instant-recourse metadata (additive): the PayPal refund id, the promised
  // settlement SLA, and who filed the claim (human or agent).
  const actor = typeof body.actor === 'string' && body.actor ? body.actor : 'buyer';
  const slaMs = 1200;

  const claim = {
    id: 'clm_' + randHex(8),
    order_id: order.id,
    merchant_id: merchant.id,
    reason,
    status: 'approved',
    refund,
    paid_from_reserve: fromReserve,
    paid_from_pool: fromPool,
    reserve_before: reserveBefore,
    reserve_after: round2(merchant.reserve),
    paypal_refund_id: paypalRefundId,
    sla_ms: slaMs,
    actor,
    created_at: nowIso(),
  };
  if (claimAi) claim.ai = claimAi;
  data.state.claims.push(claim);
  order.claim_id = claim.id;
  order.paypal_refund_id = paypalRefundId;

  const claimEvent = ledger.appendEvent(merchant.id, 'claim', {
    claim_id: claim.id,
    order_id: order.id,
    reason,
    refund,
    status: 'approved',
    actor,
  });
  const refundEvent = ledger.appendEvent(merchant.id, 'refund', {
    claim_id: claim.id,
    order_id: order.id,
    refund,
    paid_from_reserve: fromReserve,
    paid_from_pool: fromPool,
    network_pool_after: data.state.network_pool,
    paypal_refund_id: paypalRefundId,
    sla_ms: slaMs,
    actor,
  });
  const reserveEvent = ledger.appendEvent(merchant.id, 'reserve_change', {
    reserve_before: reserveBefore,
    reserve_after: round2(merchant.reserve),
    delta: round2(merchant.reserve - reserveBefore),
    reason: 'claim_refund',
    claim_id: claim.id,
  });

  const newEvents = [claimEvent, refundEvent, reserveEvent, ...tierEvents];

  const claimResponse = {
    claim,
    order,
    merchant: merchantSummary(merchant),
    events: newEvents,
    // Mirrored at the top level as well as inside `claim` so either reading of
    // "claim response" works for consumers.
    paypal_refund_id: paypalRefundId,
    sla_ms: slaMs,
    actor,
  };
  if (claimAi) claimResponse.ai = claimAi;
  sendJson(res, 200, claimResponse);
}

async function handleTrustVerify(req, res) {
  const body = await readJson(req);
  const merchantId = body.merchant_id;
  if (!merchantId || typeof merchantId !== 'string') {
    return fail(res, 400, 'INVALID_REQUEST', 'body.merchant_id is required');
  }
  const minTier = typeof body.min_tier === 'string' ? body.min_tier.toUpperCase() : 'C';
  if (!TIERS.includes(minTier)) {
    return fail(res, 400, 'INVALID_MIN_TIER', `body.min_tier must be one of: ${TIERS.join(', ')}`);
  }

  const merchant = data.getMerchant(merchantId);
  if (!merchant) return fail(res, 404, 'MERCHANT_NOT_FOUND', `no merchant with id '${merchantId}'`);

  // Verify a caller-supplied credential when present (tamper/portability demo);
  // otherwise issue the merchant's current credential and verify that envelope.
  const bundle = body.credential && body.signature
    ? { credential: body.credential, signature: body.signature, alg: ledger.ALG }
    : ledger.issueCredential(merchant);
  const { checks } = ledger.inspect(bundle.credential, bundle.signature);

  const reasons = [];
  if (!checks.signature) reasons.push('signature_invalid');
  if (!checks.issuer) reasons.push('issuer_mismatch');
  if (!checks.not_expired) reasons.push('credential_expired');
  if (risk.rankOf(merchant.tier) < risk.rankOf(minTier)) {
    reasons.push(`tier_below_minimum:${merchant.tier}<${minTier}`);
  }
  const verified = checks.signature && checks.issuer && checks.not_expired && reasons.length === 0;

  sendJson(res, 200, {
    verified,
    merchant_id: merchant.id,
    tier: merchant.tier,
    score: merchant.score,
    cap: merchant.cap,
    fee_bps: merchant.fee_bps,
    mode: merchant.mode,
    reasons,
    credential: bundle.credential,
    signature: bundle.signature,
    checked_at: nowIso(),
  });
}

function handleListOrders(req, res, query) {
  sendJson(res, 200, { orders: data.ordersFor(query.get('merchant') || null) });
}

function handleListEvents(req, res, query) {
  sendJson(res, 200, { events: data.eventsFor(query.get('merchant') || null) });
}

function handleReset(req, res) {
  data.reset();
  live.reset();
  board.reset();
  catalog.resetUpdated();
  seedLedgerEvents();
  sendJson(res, 200, { ok: true });
}

async function handlePaypalCapture(req, res) {
  const body = await readJson(req);
  const paymentId = body.order_id || body.payment_id;
  if (!paymentId) return fail(res, 400, 'INVALID_REQUEST', 'body.order_id is required');

  try {
    const capture = await paypal.captureOrder(paymentId);
    // Finalize the matching order only after a successful capture.
    const order = data.state.orders.find((o) => o.payment_id === paymentId);
    if (order) {
      order.payment_captured_at = nowIso();
      ledger.appendEvent(order.merchant_id, 'payment_captured', {
        order_id: order.id,
        payment_id: paymentId,
        status: capture && capture.status ? capture.status : 'COMPLETED',
      });
    }
    sendJson(res, 200, { ok: true, capture, order: order || null });
  } catch (err) {
    return fail(res, 502, 'PAYMENT_PROVIDER_ERROR', `capture failed: ${err.message}`);
  }
}

// ------------------------------------------------- agent passport (§2) ------

function handleAgents(req, res) {
  const agents = passport.listAgentSeeds().map(passport.publicAgent);
  sendJson(res, 200, { agents });
}

async function handleAgentVerify(req, res) {
  const body = await readJson(req);

  const context = {};
  if (body.merchant_id !== undefined) context.merchant_id = body.merchant_id;
  if (body.amount !== undefined) context.amount = body.amount;
  if (body.category !== undefined) context.category = body.category;

  // A caller may present a passport for offline verification (tamper probe).
  if (body.credential && typeof body.credential === 'object') {
    const result = passport.verifyCredential(body.credential, body.signature, context);
    return sendJson(res, 200, {
      verified: result.verified,
      agent: result.agent,
      checks: result.checks,
      reasons: result.reasons,
      passport: {
        credential: body.credential,
        signature: body.signature || body.credential.sig || null,
        alg: passport.ALG,
      },
      checked_at: nowIso(),
    });
  }

  const agentId = body.agent_id;
  if (!agentId || typeof agentId !== 'string') {
    return fail(res, 400, 'INVALID_REQUEST', 'body.agent_id is required');
  }
  const seed = passport.getAgentSeed(agentId);
  if (!seed) return fail(res, 404, 'AGENT_NOT_FOUND', `no agent with id '${agentId}'`);

  const verdict = passport.verifyAgent(seed, context);
  sendJson(res, 200, {
    verified: verdict.verified,
    agent: verdict.agent,
    checks: verdict.checks,
    reasons: verdict.reasons,
    passport: verdict.passport,
    checked_at: nowIso(),
  });
}

function handleAgentPassport(req, res, agentId) {
  const bundle = passport.issuePassport(agentId);
  if (!bundle) return fail(res, 404, 'AGENT_NOT_FOUND', `no agent with id '${agentId}'`);
  sendJson(res, 200, bundle);
}

// --------------------------------------------- negotiable contracts (§2) ---

async function handleCreateContract(req, res) {
  const body = await readJson(req);
  // Negotiation is only available inside the effective window (product override
  // beats the merchant's category rule). Closed -> 409, checked before create.
  if (typeof body.merchant_id === 'string' && typeof body.product_id === 'string') {
    const merchant = data.getMerchant(body.merchant_id);
    const product = merchant ? data.getProduct(merchant, body.product_id) : null;
    if (merchant && product) {
      const window = data.effectiveWindow(product, merchant);
      if (!data.windowOpen(window)) {
        return fail(
          res,
          409,
          'NEGOTIATION_WINDOW_CLOSED',
          `negotiation for product '${product.id}' is closed${
            window && window.to ? ` (window ended ${window.to})` : ''
          }`
        );
      }
    }
  }
  const contract = contracts.create(body);
  sendJson(res, 200, { contract: contracts.publicContract(contract) });
}

function handleGetContract(req, res, id) {
  const contract = contracts.getContract(id);
  if (!contract) return fail(res, 404, 'CONTRACT_NOT_FOUND', `no contract with id '${id}'`);
  const verification = contracts.verifyContract(contract);
  sendJson(res, 200, { contract: contracts.publicContract(contract), verification });
}

async function handleContractOffer(req, res, id) {
  const body = await readJson(req);
  const { contract, decision } = contracts.offer(id, body);
  sendJson(res, 200, { contract: contracts.publicContract(contract), decision });
}

async function handleContractAccept(req, res, id) {
  const body = await readJson(req);
  const { contract } = contracts.accept(id, body);
  sendJson(res, 200, { contract: contracts.publicContract(contract), verification: contracts.verifyContract(contract) });
}

async function handleContractAuto(req, res, id) {
  const body = await readJson(req);
  void body;
  const { contract } = contracts.auto(id);
  sendJson(res, 200, { contract: contracts.publicContract(contract), verification: contracts.verifyContract(contract) });
}

/** AI-driven negotiation (falls back deterministically with no API key). */
async function handleContractAiAuto(req, res, id) {
  const body = await readJson(req);
  void body;
  const { contract, ai: aiInfo } = await contracts.aiAuto(id);
  sendJson(res, 200, { contract: contracts.publicContract(contract), ai: aiInfo, verification: contracts.verifyContract(contract) });
}

// ------------------------------------------------ live negotiation rooms --
async function handleLiveCreate(req, res) {
  const body = await readJson(req);
  const session = await live.create(body);
  sendJson(res, 201, { session });
}

function handleLiveList(req, res) {
  sendJson(res, 200, { sessions: live.list() });
}

function handleLiveGet(req, res, id) {
  const session = live.get(id);
  if (!session) return fail(res, 404, 'LIVE_SESSION_NOT_FOUND', `no live session '${id}'`);
  sendJson(res, 200, { session });
}

// ------------------------------------------------ Reddit-style board --
function handleBoardList(req, res, query) {
  sendJson(res, 200, board.list({ board: query.get('board') || 'all' }));
}

function handleBoardGet(req, res, id) {
  const post = board.get(id);
  if (!post) return fail(res, 404, 'POST_NOT_FOUND', `no board post '${id}'`);
  sendJson(res, 200, { post });
}

async function handleBoardCreate(req, res) {
  const body = await readJson(req);
  const out = await board.start(body);
  sendJson(res, 201, out);
}

async function handleBoardOffer(req, res) {
  const body = await readJson(req);
  sendJson(res, 201, { post: board.createOffer(body) });
}

async function handleBoardWant(req, res) {
  const body = await readJson(req);
  sendJson(res, 201, { post: board.createOffer(Object.assign({}, body, { type: 'want' })) });
}

async function handleBoardSimulate(req, res, id) {
  const body = await readJson(req);
  const out = board.simulateSession(id, body);
  if (!out) return fail(res, 404, 'POST_NOT_FOUND', `no board post '${id}'`);
  sendJson(res, 200, out);
}

async function handleBoardCommentVote(req, res, id, messageId) {
  const body = await readJson(req);
  const out = board.voteComment(id, messageId, body.direction);
  if (!out) return fail(res, 404, 'COMMENT_NOT_FOUND', `no comment '${messageId}' on '${id}'`);
  sendJson(res, 200, out);
}

async function handleBoardFeeOrder(req, res, id) {
  const post = board.get(id);
  if (!post) return fail(res, 404, 'POST_NOT_FOUND', `no board post '${id}'`);
  if (post.kind !== 'external' || post.status !== 'deal') return fail(res, 409, 'FEE_NOT_READY', 'deal must be recorded first');
  const fee = Number(post.platform_fee) || 0;
  if (!(fee > 0)) return fail(res, 409, 'NO_FEE', 'no platform fee on this deal');
  if (post.fee_collected) return sendJson(res, 200, { post, already_paid: true });
  const order = await paypal.createOrder({ amount: fee, currency: 'USD', returnUrl: (process.env.PUBLIC_SITE_URL || process.env.PUBLIC_BASE_URL || '') + '/fee.html?post=' + encodeURIComponent(id) });
  sendJson(res, 200, { post, fee_order_id: order.id, approval_url: order.approval_url || null, amount: fee, mode: paypal.mode() });
}

async function handleBoardFeeCapture(req, res, id) {
  const body = await readJson(req);
  const post = board.get(id);
  if (!post) return fail(res, 404, 'POST_NOT_FOUND', `no board post '${id}'`);
  if (post.kind !== 'external' || post.status !== 'deal') return fail(res, 409, 'FEE_NOT_READY', 'deal must be recorded first');
  const paypalOrderId = body.paypal_order_id || body.order_id;
  if (!paypalOrderId) return fail(res, 400, 'INVALID_ORDER', 'paypal_order_id is required');
  const capture = await paypal.captureOrder(paypalOrderId);
  const updated = board.markFeeCollected(id, { paypal_order_id: paypalOrderId, capture_id: capture && capture.id });
  sendJson(res, 200, { post: updated, capture, mode: paypal.mode() });
}

async function handleBoardClose(req, res, id) {
  const body = await readJson(req);
  const post = board.closePost(id, body);
  if (!post) return fail(res, 404, 'POST_NOT_FOUND', `no board post '${id}'`);
  sendJson(res, 200, { post });
}

async function handleBoardAgentRegister(req, res) {
  const body = await readJson(req);
  sendJson(res, 201, board.registerAgent(body));
}

async function handleBoardMessage(req, res, id) {
  const body = await readJson(req);
  const post = board.appendMessage(id, body);
  if (!post) return fail(res, 404, 'POST_NOT_FOUND', `no board post '${id}'`);
  sendJson(res, 200, { post });
}

async function handleBoardDeal(req, res, id) {
  const body = await readJson(req);
  const post = board.recordDeal(id, body);
  if (!post) return fail(res, 404, 'POST_NOT_FOUND', `no board post '${id}'`);
  sendJson(res, 200, { post });
}

async function handleBoardVote(req, res, id) {
  const body = await readJson(req);
  const out = board.vote(id, body.direction);
  if (!out) return fail(res, 404, 'POST_NOT_FOUND', `no board post '${id}'`);
  sendJson(res, 200, out);
}

// ------------------------------------------------ one-call agent purchase --
async function handleAgentPurchase(req, res) {
  const body = await readJson(req);
  const out = await agentBuy.purchase(body);
  sendJson(res, 200, out);
}

/** Public runtime config — never exposes secrets. */
function handleConfig(req, res) {
  const aiCfg = ai.config();
  const paypalInfo = paypal.info();
  sendJson(res, 200, {
    mode: paypal.isLive() ? 'live' : 'sim',
    currency: 'USD',
    paypal: {
      env: paypalInfo.env,
      client_id: process.env.PAYPAL_CLIENT_ID || null,
      configured: Boolean(paypalInfo.configured),
    },
    ai: {
      enabled: Boolean(aiCfg.enabled),
      provider: aiCfg.provider,
      model: aiCfg.model,
    },
    platform_fee_bps: PLATFORM_FEE_BPS,
  });
}

// ------------------------------------------------------ protection (§2) ----

async function handleProtectionQuote(req, res) {
  const body = await readJson(req);
  const qt = protection.quote(body);
  sendJson(res, 200, { quote: qt });
}

function handleListClaims(req, res, query) {
  const merchantId = query.get('merchant') || null;
  const list = data.state.claims
    .filter((c) => !merchantId || c.merchant_id === merchantId)
    .slice()
    .sort((a, b) => {
      const t = Date.parse(b.created_at) - Date.parse(a.created_at);
      return t !== 0 ? t : String(b.id).localeCompare(String(a.id));
    });
  sendJson(res, 200, { claims: list });
}

// ------------------------------------------------------- catalog / index ----

function handleCategories(req, res) {
  sendJson(res, 200, catalog.categories());
}

function handleIndex(req, res, query) {
  sendJson(res, 200, catalog.index({
    category: query.get('category'),
    q: query.get('q'),
    budget: query.get('budget'),
    merchant: query.get('merchant'),
    limit: query.get('limit'),
    sort: query.get('sort'),
  }));
}

function handleCatalogGetAgent(req, res, merchantId) {
  const view = catalog.catalogFor(merchantId);
  sendJson(res, 200, { agent: view.agent, merchant: view.merchant });
}

async function handleAgentConfigUpdate(req, res, merchantId) {
  const body = await readJson(req);
  sendJson(res, 200, catalog.updateAgent(merchantId, body));
}

function handleCatalogGet(req, res, merchantId) {
  sendJson(res, 200, catalog.catalogFor(merchantId));
}

async function handleCatalogCreate(req, res, merchantId) {
  const body = await readJson(req);
  sendJson(res, 200, catalog.createProduct(merchantId, body));
}

async function handleCatalogUpdate(req, res, merchantId, productId) {
  const body = await readJson(req);
  sendJson(res, 200, catalog.updateProduct(merchantId, productId, body));
}

// ------------------------------------------ agent-assisted setup (§AI-SETUP) --

async function handleAgentAutoconfigure(req, res, merchantId) {
  // Body is optional; consume it so clients can send {} (or nothing).
  await readJson(req);
  sendJson(res, 200, catalog.autoconfigure(merchantId));
}

async function handleAgentCatalog(req, res, merchantId) {
  const body = await readJson(req);
  sendJson(res, 200, await catalog.agentAddProducts(merchantId, body));
}

// --------------------------------------------------- adapters & index feed ---

function handleAdapters(req, res) {
  sendJson(res, 200, adapters.registry());
}

async function handleCatalogImport(req, res, merchantId) {
  const body = await readJson(req);
  // Import through the connector layer so imports inherit category rules.
  sendJson(res, 200, await connectors.importInto(merchantId, body));
}

async function handleCatalogSync(req, res, merchantId) {
  const body = await readJson(req);
  sendJson(res, 200, await connectors.syncNow(merchantId, body));
}

// ------------------------------------------------ inventory connector (§1) --

function handleConnectorGet(req, res, merchantId) {
  sendJson(res, 200, connectors.getConnector(merchantId));
}

async function handleConnectorPut(req, res, merchantId) {
  const body = await readJson(req);
  sendJson(res, 200, connectors.putConnector(merchantId, body));
}

// ------------------------------------------------- category rules (§2) -----

function handleRulesGet(req, res, merchantId) {
  sendJson(res, 200, catalog.getRules(merchantId));
}

async function handleRulePut(req, res, merchantId, category) {
  const body = await readJson(req);
  sendJson(res, 200, catalog.putCategoryRule(merchantId, category, body));
}

async function handleRulesApply(req, res, merchantId) {
  const body = await readJson(req);
  sendJson(res, 200, catalog.applyRules(merchantId, body));
}

function handleIndexManifest(req, res) {
  sendJson(res, 200, catalog.manifest());
}

function handleIndexFeed(req, res, query) {
  sendJson(res, 200, catalog.feed({
    cursor: query.get('cursor'),
    limit: query.get('limit'),
    category: query.get('category'),
    merchant: query.get('merchant'),
    updated_since: query.get('updated_since'),
  }));
}

/** OpenAPI document served straight from public/index-openapi.json. */
let openapiCache = null;
function handleIndexOpenapi(req, res) {
  if (!openapiCache) {
    try {
      openapiCache = fs.readFileSync(path.join(PUBLIC_DIR, 'index-openapi.json'), 'utf8');
    } catch {
      return fail(res, 500, 'OPENAPI_UNAVAILABLE', 'OpenAPI document not generated');
    }
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(openapiCache),
    'Cache-Control': 'no-cache',
  });
  res.end(openapiCache);
}

/**
 * A2A-style discovery card. Deliberately labelled as A2A *style* — this is a
 * discovery document, not a claim of full A2A protocol support.
 */
function handleA2aAgentCard(req, res) {
  sendJson(res, 200, {
    protocolVersion: '0.2.0',
    name: 'Settled',
    description: 'PayPal merchant negotiation index and assurance layer',
    url: '/',
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'negotiate',
        name: 'Negotiate a purchase',
        description: 'Find a merchant offer, negotiate within a mandate, sign a contract',
        tags: ['commerce', 'negotiation'],
        examples: ['Negotiate the Aurora One under $240'],
      },
      {
        id: 'verify',
        name: 'Verify merchant trust',
        description: 'Check the signed merchant credential',
        tags: ['trust'],
      },
      {
        id: 'claim',
        name: 'Open a claim',
        description: 'File a buyer/agent claim and get a reserve refund',
        tags: ['recourse'],
      },
    ],
    // Pointers to the runtime adapters that actually ship.
    endpoints: {
      mcp: 'mcp/server.js (stdio JSON-RPC 2.0)',
      agentManifest: '/api/agent-manifest',
      indexManifest: '/api/index/manifest',
      openapi: '/api/index/openapi.json',
    },
  });
}

/** Agent card for any personal AI (also served at /.well-known). */
function handleAgentManifest(req, res) {
  sendJson(res, 200, {
    schema_version: 'settled-agent/1.0',
    name: 'Settled',
    description: 'PayPal merchant negotiation index and assurance layer',
    auth: 'agent_passport+mandate',
    endpoints: {
      manifest: '/api/index/manifest',
      feed: '/api/index/feed',
      search: '/api/index',
      negotiate: '/api/contracts',
      auto: '/api/contracts/{id}/ai-auto',
      order: '/api/merchants/{id}/orders',
      purchase: '/api/agent/purchase',
      capture: '/api/paypal/capture',
      claim: '/api/orders/{id}/claim',
    },
    tools: [
      { name: 'index.manifest', endpoint: 'GET /api/index/manifest' },
      { name: 'index.feed', endpoint: 'GET /api/index/feed' },
      { name: 'index.search', endpoint: 'GET /api/index' },
      { name: 'negotiate.start', endpoint: 'POST /api/contracts' },
      { name: 'negotiate.auto', endpoint: 'POST /api/contracts/{id}/ai-auto' },
      { name: 'order.create', endpoint: 'POST /api/merchants/{id}/orders' },
      { name: 'purchase.one_call', endpoint: 'POST /api/agent/purchase' },
      { name: 'payment.capture', endpoint: 'POST /api/paypal/capture' },
      { name: 'claim.open', endpoint: 'POST /api/orders/{id}/claim' },
    ],
  });
}

// ------------------------------------------------------------ static files --
const STATIC_ROUTES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/store.html': { file: 'store.html', type: 'text/html; charset=utf-8' },
  '/agent.html': { file: 'agent.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let file;
  let type;
  const route = STATIC_ROUTES[pathname];
  if (route) {
    file = route.file;
    type = route.type;
  } else {
    // Flat files inside public/ only (no traversal); used for test pages and assets.
    const name = pathname.replace(/^\/+/, '');
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(name).toLowerCase();
    if (!MIME_TYPES[ext]) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    file = name;
    type = MIME_TYPES[ext];
  }
  const full = path.join(PUBLIC_DIR, file);
  // Defence in depth: never escape public/.
  if (!full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`404 Not Found (${file} not generated yet)`);
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ----------------------------------------------------------------- router --
const server = http.createServer(async (req, res) => {
  let parsed;
  try {
    parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return fail(res, 400, 'INVALID_URL', 'could not parse request URL');
  }
  const query = parsed.searchParams;
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname || '/');
  } catch {
    return fail(res, 400, 'INVALID_URL', 'could not decode request path');
  }
  const method = (req.method || 'GET').toUpperCase();

  // API namespace first.
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    try {
      // PayPal flow routes (owned by paypal-platform-scout) get first refusal.
      // The module lands in parallel, so this is resolved lazily and skipped
      // entirely while lib/paypal-flow.js is absent.
      if (pathname.startsWith('/api/paypal/')) {
        const flow = getPaypalFlow();
        if (flow) {
          const handled = await flow.handle(req, res, parsed);
          if (handled) return undefined;
        }
      }
      return await routeApi(req, res, method, pathname, query);
    } catch (err) {
      const status = err.status || 500;
      const code = err.code || 'INTERNAL_ERROR';
      if (status >= 500) console.error('[settled] error:', err);
      return fail(res, status, code, err.message || 'unexpected error');
    }
  }

  // Remote MCP Streamable HTTP endpoint for external AIs.
  if (pathname === '/mcp' || pathname === '/mcp/') {
    return mcpHttp.handle(req, res);
  }

  // Agent card at the well-known location (outside the /api namespace).
  if ((method === 'GET' || method === 'HEAD') && pathname === '/.well-known/settled-agent.json') {
    return handleAgentManifest(req, res);
  }
  if ((method === 'GET' || method === 'HEAD') && pathname === '/.well-known/agent-card.json') {
    return handleA2aAgentCard(req, res);
  }

  // Static.
  if (method !== 'GET' && method !== 'HEAD') {
    return fail(res, 405, 'METHOD_NOT_ALLOWED', `${method} is not allowed on ${pathname}`);
  }
  return serveStatic(req, res, pathname);
});

async function routeApi(req, res, method, pathname, query) {
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]

  // GET /api/health
  if (method === 'GET' && seg.length === 2 && seg[1] === 'health') return handleHealth(req, res);

  // GET /api/config
  if (method === 'GET' && seg.length === 2 && seg[1] === 'config') return handleConfig(req, res);

  // /api/merchants ...
  if (seg[1] === 'merchants') {
    if (seg.length === 2 && method === 'GET') return handleMerchants(req, res);
    const id = seg[2];
    if (seg.length === 3 && method === 'GET') return handleMerchantDetail(req, res, id);
    if (seg.length === 4) {
      const sub = seg[3];
      if (sub === 'ledger' && method === 'GET') return handleMerchantLedger(req, res, id);
      if (sub === 'verify' && method === 'POST') return handleMerchantVerify(req, res, id);
      if (sub === 'events' && method === 'GET') return handleMerchantEvents(req, res, id);
      if (sub === 'orders' && method === 'POST') return handleCreateOrder(req, res, id);
      if (sub === 'agent' && method === 'PATCH') return handleAgentConfigUpdate(req, res, id);
      if (sub === 'agent' && method === 'GET') return handleCatalogGetAgent(req, res, id);
      if (sub === 'catalog' && method === 'GET') return handleCatalogGet(req, res, id);
      if (sub === 'catalog' && method === 'POST') return handleCatalogCreate(req, res, id);
      if (sub === 'connector' && method === 'GET') return handleConnectorGet(req, res, id);
      if (sub === 'connector' && method === 'PUT') return handleConnectorPut(req, res, id);
      if (sub === 'rules' && method === 'GET') return handleRulesGet(req, res, id);
    }
    if (seg.length === 5 && seg[3] === 'catalog') {
      if (seg[4] === 'import' && method === 'POST') return handleCatalogImport(req, res, id);
      if (seg[4] === 'sync' && method === 'POST') return handleCatalogSync(req, res, id);
      if (method === 'PATCH') return handleCatalogUpdate(req, res, id, seg[4]);
    }
    if (seg.length === 5 && seg[3] === 'rules') {
      if (seg[4] === 'apply' && method === 'POST') return handleRulesApply(req, res, id);
      if (method === 'PUT') return handleRulePut(req, res, id, seg[4]);
    }
    if (seg.length === 5 && seg[3] === 'agent') {
      if (seg[4] === 'autoconfigure' && method === 'POST') {
        return handleAgentAutoconfigure(req, res, id);
      }
      if (seg[4] === 'catalog' && method === 'POST') return handleAgentCatalog(req, res, id);
    }
  }

  // /api/categories
  if (seg.length === 2 && seg[1] === 'categories' && method === 'GET') {
    return handleCategories(req, res);
  }

  // /api/index (negotiation index)
  if (seg.length === 2 && seg[1] === 'index' && method === 'GET') {
    return handleIndex(req, res, query);
  }

  // /api/index/manifest | feed | openapi.json  (machine-readable emission)
  if (seg.length === 3 && seg[1] === 'index' && method === 'GET') {
    if (seg[2] === 'manifest') return handleIndexManifest(req, res);
    if (seg[2] === 'feed') return handleIndexFeed(req, res, query);
    if (seg[2] === 'openapi.json') return handleIndexOpenapi(req, res);
  }

  // /api/adapters (inventory/agent/checkout registry)
  if (seg.length === 2 && seg[1] === 'adapters' && method === 'GET') {
    return handleAdapters(req, res);
  }

  // /api/a2a/agent-card (A2A-style discovery card)
  if (seg.length === 3 && seg[1] === 'a2a' && seg[2] === 'agent-card' && method === 'GET') {
    return handleA2aAgentCard(req, res);
  }

  // /api/agent-manifest (agent card)
  if (seg.length === 2 && seg[1] === 'agent-manifest' && method === 'GET') {
    return handleAgentManifest(req, res);
  }

  // /api/orders/:id/fulfill | claim
  if (seg[1] === 'orders') {
    if (seg.length === 2 && method === 'GET') return handleListOrders(req, res, query);
    if (seg.length === 4 && method === 'POST') {
      const orderId = seg[2];
      if (seg[3] === 'fulfill') return handleFulfill(req, res, orderId);
      if (seg[3] === 'claim') return handleClaim(req, res, orderId);
    }
  }

  // /api/agent/purchase — negotiate + create the order in one call.
  if (seg.length === 3 && seg[1] === 'agent' && seg[2] === 'purchase' && method === 'POST') {
    return handleAgentPurchase(req, res);
  }

  // /api/agents ...
  if (seg[1] === 'agents') {
    if (seg.length === 3 && seg[2] === 'register' && method === 'POST') return handleBoardAgentRegister(req, res);
    if (seg.length === 2 && method === 'GET') return handleAgents(req, res);
    if (seg.length === 3 && seg[2] === 'verify' && method === 'POST') return handleAgentVerify(req, res);
    if (seg.length === 4 && seg[3] === 'passport' && method === 'GET') {
      return handleAgentPassport(req, res, seg[2]);
    }
  }

  // /api/board ... (Reddit-style public board)
  if (seg[1] === 'board') {
    if (seg.length === 2 && method === 'GET') return handleBoardList(req, res, query);
    if (seg.length === 3 && seg[2] === 'offers' && method === 'POST') return handleBoardOffer(req, res);
    if (seg.length === 3 && seg[2] === 'wants' && method === 'POST') return handleBoardWant(req, res);
    if (seg.length === 5 && seg[2] === 'posts' && seg[4] === 'close' && method === 'POST') return handleBoardClose(req, res, seg[3]);
    if (seg.length === 5 && seg[2] === 'posts' && seg[4] === 'simulate' && method === 'POST') return handleBoardSimulate(req, res, seg[3]);
    if (seg.length === 7 && seg[2] === 'posts' && seg[4] === 'comments' && seg[6] === 'vote' && method === 'POST') return handleBoardCommentVote(req, res, seg[3], seg[5]);
    if (seg.length === 5 && seg[2] === 'posts' && seg[4] === 'fee-order' && method === 'POST') return handleBoardFeeOrder(req, res, seg[3]);
    if (seg.length === 5 && seg[2] === 'posts' && seg[4] === 'fee-capture' && method === 'POST') return handleBoardFeeCapture(req, res, seg[3]);
    if (seg.length === 5 && seg[2] === 'posts' && seg[4] === 'messages' && method === 'POST') return handleBoardMessage(req, res, seg[3]);
    if (seg.length === 5 && seg[2] === 'posts' && seg[4] === 'deal' && method === 'POST') return handleBoardDeal(req, res, seg[3]);
    if (seg.length === 3 && seg[2] === 'posts' && method === 'POST') return handleBoardCreate(req, res);
    if (seg.length === 4 && seg[2] === 'posts' && method === 'GET') return handleBoardGet(req, res, seg[3]);
    if (seg.length === 5 && seg[2] === 'posts' && seg[4] === 'vote' && method === 'POST') return handleBoardVote(req, res, seg[3]);
  }

  // /api/live ... (public spectator rooms)
  if (seg[1] === 'live') {
    if (seg.length === 3 && seg[2] === 'sessions' && method === 'GET') return handleLiveList(req, res);
    if (seg.length === 3 && seg[2] === 'sessions' && method === 'POST') return handleLiveCreate(req, res);
    if (seg.length === 4 && seg[2] === 'sessions' && method === 'GET') return handleLiveGet(req, res, seg[3]);
  }

  // /api/contracts ...
  if (seg[1] === 'contracts') {
    if (seg.length === 2 && method === 'POST') return handleCreateContract(req, res);
    if (seg.length === 3 && method === 'GET') return handleGetContract(req, res, seg[2]);
    if (seg.length === 4 && method === 'POST') {
      const contractId = seg[2];
      if (seg[3] === 'offers') return handleContractOffer(req, res, contractId);
      if (seg[3] === 'accept') return handleContractAccept(req, res, contractId);
      if (seg[3] === 'auto') return handleContractAuto(req, res, contractId);
      if (seg[3] === 'ai-auto') return handleContractAiAuto(req, res, contractId);
    }
  }

  // /api/protection/quote
  if (seg.length === 3 && seg[1] === 'protection' && seg[2] === 'quote' && method === 'POST') {
    return handleProtectionQuote(req, res);
  }

  // /api/claims
  if (seg.length === 2 && seg[1] === 'claims' && method === 'GET') {
    return handleListClaims(req, res, query);
  }

  // /api/events
  if (seg.length === 2 && seg[1] === 'events' && method === 'GET') {
    return handleListEvents(req, res, query);
  }

  // /api/trust/verify
  if (seg.length === 3 && seg[1] === 'trust' && seg[2] === 'verify' && method === 'POST') {
    return handleTrustVerify(req, res);
  }

  // /api/reset
  if (seg.length === 2 && seg[1] === 'reset' && method === 'POST') return handleReset(req, res);

  // /api/paypal/capture
  if (seg.length === 3 && seg[1] === 'paypal' && seg[2] === 'capture' && method === 'POST') {
    return handlePaypalCapture(req, res);
  }

  return fail(res, 404, 'NOT_FOUND', `no API route for ${method} ${pathname}`);
}

// ------------------------------------------------------------------- boot --
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

seedLedgerEvents();

// Inventory automation: pull due connectors every CONNECTOR_TICK_MS (60s).
// unref'd inside startScheduler so the timer never keeps the process alive.
connectors.startScheduler();

server.listen(PORT, HOST, () => {
  console.log(`[settled] listening on http://${HOST}:${PORT}  mode=${paypal.mode()}`);
  if (!paypal.isLive()) {
    console.log('[settled] PayPal adapter in SIM mode (set PAYPAL_LIVE=1 + credentials for live)');
  }
  console.log(`[settled] inventory scheduler every ${connectors.CONNECTOR_TICK_MS}ms`);
});

module.exports = { server };
