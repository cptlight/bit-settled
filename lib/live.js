'use strict';
/**
 * lib/live.js — public "tell your agent, watch it negotiate" rooms.
 *
 * A buyer writes a plain-language instruction; the AI chooses a public catalog
 * item and a budget; the existing policy-guarded negotiation runs; the room is
 * readable by anyone with the id. No private merchant policy enters a room.
 */

const data = require('./data');
const ai = require('./ai');
const contracts = require('./contract');

const MAX_SESSIONS = 25;
const MAX_AGE_MS = 60 * 60 * 1000;

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function store() {
  if (!Array.isArray(data.state.live_sessions)) data.state.live_sessions = [];
  return data.state.live_sessions;
}

function reset() {
  data.state.live_sessions = [];
}

function publicProducts(merchant) {
  return (merchant.products || [])
    .filter((p) => !p.negotiation || (p.negotiation.listed !== false && p.negotiation.negotiable !== false))
    .map((p) => data.publicProduct(p));
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    instruction: session.instruction,
    buyer_name: session.buyer_name,
    merchant: session.merchant,
    product: session.product,
    budget: session.budget,
    status: session.status,
    agreed_price: session.agreed_price || null,
    contract_id: session.contract_id,
    contract: session.contract || null,
    transcript: session.transcript || [],
    ai: session.ai || null,
    error: session.error || null,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

function prune() {
  const list = store();
  const cutoff = Date.now() - MAX_AGE_MS;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (Date.parse(list[i].created_at) < cutoff) list.splice(i, 1);
  }
  while (list.length > MAX_SESSIONS) list.shift();
}

function summary(session) {
  return {
    id: session.id,
    instruction: session.instruction,
    buyer_name: session.buyer_name,
    merchant: session.merchant,
    product: session.product,
    budget: session.budget,
    status: session.status,
    agreed_price: session.agreed_price || null,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

function get(id) {
  const session = store().find((s) => s.id === id);
  return session ? publicSession(session) : null;
}

function list() {
  prune();
  return store()
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(summary);
}

function buildTranscript(instruction, aiInfo, contract) {
  const rows = [{ role: 'you', kind: 'instruction', text: instruction }];
  const dialogue = aiInfo && Array.isArray(aiInfo.dialogue) ? aiInfo.dialogue : [];
  if (dialogue.length) {
    dialogue.forEach((d) => {
      rows.push({
        role: String(d.from || '').indexOf('merchant') >= 0 ? 'merchant_agent' : 'buyer_agent',
        kind: d.action || 'offer',
        name: d.agent || null,
        price: d.price !== undefined ? d.price : null,
        text: d.message || '',
        rationale: d.rationale || '',
      });
    });
  } else if (contract && Array.isArray(contract.transcript)) {
    contract.transcript.forEach((e) => {
      rows.push({
        role: String(e.from || '').indexOf('merchant') >= 0 ? 'merchant_agent' : 'buyer_agent',
        kind: e.decision || 'offer',
        price: e.price !== undefined ? e.price : null,
        text: e.note || '',
      });
    });
  }
  if (contract && contract.status === 'accepted') {
    rows.push({ role: 'system', kind: 'accepted', price: contract.agreed_price, text: 'Deal agreed and signed.' });
  } else if (contract && contract.status === 'rejected') {
    rows.push({ role: 'system', kind: 'rejected', text: 'No deal inside the mandate.' });
  } else if (contract && contract.status === 'expired') {
    rows.push({ role: 'system', kind: 'expired', text: 'Negotiation expired.' });
  }
  return rows;
}

async function create(body = {}) {
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 400) : '';
  if (instruction.length < 3) {
    throw httpError(400, 'INVALID_INSTRUCTION', 'Write a short instruction, e.g. “Get me the headphones under $230”.');
  }
  const merchantId = typeof body.merchant_id === 'string' && body.merchant_id ? body.merchant_id : 'm1';
  const merchant = data.getMerchant(merchantId);
  if (!merchant) throw httpError(404, 'MERCHANT_NOT_FOUND', `no merchant '${merchantId}'`);
  if (merchant.agent && merchant.agent.enabled === false) {
    throw httpError(409, 'MERCHANT_AGENT_DISABLED', 'the merchant agent is paused');
  }
  const products = publicProducts(merchant);
  if (!products.length) throw httpError(409, 'NO_NEGOTIABLE_PRODUCTS', 'this merchant has no negotiable products');
  let wanted = null;
  if (typeof body.product_id === 'string' && body.product_id) {
    wanted = products.find((p) => p.id === body.product_id) || null;
    if (!wanted) throw httpError(404, 'PRODUCT_NOT_FOUND', `no negotiable product '${body.product_id}'`);
  }

  const interpretation = await ai.interpretInstruction({
    instruction,
    products,
    buyer_name: 'personal agent',
  });
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
  const now = data.nowIso();
  const session = {
    id: 'live_' + data.randHex(6),
    instruction,
    buyer_name: 'Personal agent',
    merchant: { id: merchant.id, name: merchant.name, domain: merchant.domain, tier: merchant.tier, score: merchant.score },
    product: { id: product.id, name: product.name, price: product.price, category: product.category, published_range: product.published_range },
    budget,
    status: 'negotiating',
    agreed_price: null,
    contract_id: contract.id,
    contract: null,
    transcript: buildTranscript(instruction, null, contract),
    ai: { used: interpretation.used, provider: interpretation.provider, model: interpretation.model, reply: interpretation.reply },
    created_at: now,
    updated_at: now,
  };
  prune();
  store().push(session);

  setImmediate(async () => {
    try {
      const result = await contracts.aiAuto(contract.id);
      session.contract = contracts.publicContract(result.contract);
      session.ai = Object.assign({}, session.ai, result.ai || {});
      session.status = result.contract.status === 'open' ? 'no_deal' : result.contract.status;
      session.agreed_price = result.contract.agreed_price || null;
      session.transcript = buildTranscript(instruction, result.ai, result.contract);
      if (session.status === 'no_deal') {
        session.transcript.push({
          role: 'system',
          kind: 'no_deal',
          text: 'No deal inside the stated budget. Raise the budget and try again.',
        });
      }
      session.updated_at = data.nowIso();
    } catch (err) {
      session.status = 'error';
      session.error = err && err.message ? err.message : 'negotiation failed';
      session.updated_at = data.nowIso();
    }
  });

  return publicSession(session);
}

module.exports = { create, list, get, reset, MAX_SESSIONS };
