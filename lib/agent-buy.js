'use strict';
/**
 * lib/agent-buy.js — one-call "personal agent buys" flow:
 * interpret instruction -> choose public offer -> negotiate inside mandate ->
 * create the merchant order (live PayPal sandbox approval link, or SIM order).
 * The buyer's PayPal approval remains a human step; capture is explicit.
 */

const data = require('./data');
const ai = require('./ai');
const contracts = require('./contract');

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${Number(process.env.PORT || 4173)}`).replace(/\/+$/, '');
}

function publicProducts(merchant) {
  return (merchant.products || [])
    .filter((p) => !p.negotiation || (p.negotiation.listed !== false && p.negotiation.negotiable !== false))
    .map((p) => data.publicProduct(p));
}

async function purchase(body = {}) {
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 400) : '';
  if (instruction.length < 3) throw httpError(400, 'INVALID_INSTRUCTION', 'body.instruction is required');
  const merchantId = typeof body.merchant_id === 'string' && body.merchant_id ? body.merchant_id : 'm1';
  const merchant = data.getMerchant(merchantId);
  if (!merchant) throw httpError(404, 'MERCHANT_NOT_FOUND', `no merchant '${merchantId}'`);
  const products = publicProducts(merchant);
  if (!products.length) throw httpError(409, 'NO_NEGOTIABLE_PRODUCTS', 'no negotiable products');
  let wanted = null;
  if (typeof body.product_id === 'string' && body.product_id) {
    wanted = products.find((p) => p.id === body.product_id) || null;
    if (!wanted) throw httpError(404, 'PRODUCT_NOT_FOUND', `no product '${body.product_id}'`);
  }
  const interpretation = await ai.interpretInstruction({ instruction, products, buyer_name: 'personal agent' });
  const product = wanted || products.find((p) => p.id === interpretation.product_id) || products[0];
  const list = Number(product.price) || 0;
  const published = product.published_range || {};
  const min = Number(published.min) || Math.round(list * 0.82);
  const budget = Math.max(min, Math.min(list, Math.round(Number(interpretation.budget) || list)));
  const contract = contracts.create({
    merchant_id: merchant.id,
    product_id: product.id,
    buyer_agent_id: 'a1',
    mandate: { max: budget },
  });
  const negotiated = await contracts.aiAuto(contract.id);
  if (negotiated.contract.status !== 'accepted') {
    return {
      status: negotiated.contract.status,
      instruction,
      product,
      contract: contracts.publicContract(negotiated.contract),
      ai: negotiated.ai,
      order: null,
      payment: null,
      receipt: null,
      error: 'No deal inside the stated budget.',
    };
  }

  const orderBody = {
    product_id: product.id,
    contract_id: contract.id,
    agent_id: 'a1',
    buyer: { name: 'ProcureBot', email: 'procurebot@acme.example' },
  };
  if (body.simulate === true) orderBody.simulate = true;
  const res = await fetch(`${baseUrl()}/api/merchants/${encodeURIComponent(merchant.id)}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orderBody),
  });
  const text = await res.text();
  let out;
  try { out = text ? JSON.parse(text) : null; } catch { out = null; }
  if (!res.ok) {
    const message = out && out.error && out.error.message ? out.error.message : `order failed (${res.status})`;
    throw httpError(502, 'ORDER_FAILED', message);
  }
  return {
    status: 'accepted',
    instruction,
    product,
    contract: contracts.publicContract(negotiated.contract),
    ai: negotiated.ai,
    order: out.order,
    payment: out.payment,
    receipt: out.receipt,
  };
}

module.exports = { purchase };
