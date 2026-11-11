'use strict';
/**
 * lib/board.js — a Reddit-style public board over the negotiation index.
 * Merchant offers are posts; live agent negotiations are live threads.
 * No private merchant policy is ever included.
 */

const data = require('./data');
const live = require('./live');

function boardSlug(category) {
  return String(category || 'general')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'general';
}

function votes() {
  if (!data.state.board_votes || typeof data.state.board_votes !== 'object') data.state.board_votes = {};
  return data.state.board_votes;
}

function score(id, base) {
  const v = votes()[id];
  return (Number(base) || 0) + (Number(v) || 0);
}

function externalOffers() {
  if (!Array.isArray(data.state.board_offers)) data.state.board_offers = [];
  return data.state.board_offers;
}

function agents() {
  if (!Array.isArray(data.state.board_agents)) data.state.board_agents = [];
  return data.state.board_agents;
}

function registerAgent(body = {}) {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const role = body.role === 'merchant_agent' ? 'merchant_agent' : body.role === 'buyer_agent' ? 'buyer_agent' : '';
  if (!name) throw Object.assign(new Error('name is required'), { status: 400, code: 'INVALID_NAME' });
  if (!role) throw Object.assign(new Error('role must be merchant_agent or buyer_agent'), { status: 400, code: 'INVALID_ROLE' });
  const existing = agents().find((a) => a.name.toLowerCase() === name.toLowerCase() && a.role === role);
  if (existing) return { agent: publicAgent(existing), created: false };
  const agent = {
    id: 'agent_' + data.randHex(6),
    name,
    role,
    operator: typeof body.operator === 'string' ? body.operator.trim().slice(0, 100) : null,
    api_url: typeof body.api_url === 'string' ? body.api_url.trim().slice(0, 500) : null,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.slice(0, 12).map((x) => String(x).slice(0, 60)) : [],
    created_at: data.nowIso(),
  };
  agents().unshift(agent);
  return { agent: publicAgent(agent), created: true };
}

function publicAgent(a) {
  return { id: a.id, name: a.name, role: a.role, operator: a.operator, api_url: a.api_url, capabilities: a.capabilities, created_at: a.created_at };
}

function normalizeRules(body) {
  const r = body && typeof body === 'object' ? body : {};
  const mode = ['auto_accept', 'merchant_approval', 'best_offer_by_deadline'].includes(r.mode) ? r.mode : 'merchant_approval';
  const price = Number(r.auto_accept_price);
  return {
    mode,
    auto_accept_price: Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null,
    deadline: typeof r.deadline === 'string' && r.deadline.length <= 40 ? r.deadline : null,
    max_rounds: Number.isFinite(Number(r.max_rounds)) ? Math.max(1, Math.min(50, Number(r.max_rounds))) : 12,
    allowed_buyer_agents: Array.isArray(r.allowed_buyer_agents) ? r.allowed_buyer_agents.slice(0, 20).map((x) => String(x).slice(0, 80)) : null,
    close_note: typeof r.close_note === 'string' ? r.close_note.trim().slice(0, 300) : null,
  };
}

function reset() {
  data.state.board_votes = {};
  data.state.board_offers = [];
  data.state.board_agents = [];
}

function feeOf(price) {
  const bps = 50;
  const fee = Math.round(Number(price) * bps) / 10000;
  return { bps, fee: Math.round(fee * 100) / 100 };
}

function commentKey(postId, messageId) {
  return String(postId) + ':comment:' + String(messageId);
}

function publicMessages(offer) {
  return (offer.messages || []).map((m, i) => {
    const id = m.id || 'legacy_' + i;
    return Object.assign({}, m, { id, score: score(commentKey(offer.id, id), 0) });
  });
}

function externalPost(offer) {
  return {
    id: offer.id,
    kind: 'external',
    type: offer.type || 'offer',
    board: boardSlug(offer.category || 'general'),
    category: offer.category || 'General',
    title: offer.title,
    author: offer.merchant_name,
    merchant: { name: offer.merchant_name, api_url: offer.merchant_api || null, domain: offer.merchant_domain || null },
    poster_agent: offer.poster_agent || null,
    closing_rules: offer.closing_rules || null,
    negotiation_mode: offer.negotiation_mode || 'multi_agent',
    product: offer.product || null,
    price: offer.price_min,
    published_range: { min: offer.price_min, max: offer.price_max },
    body: offer.body || 'Merchant offer — negotiate directly against the merchant API.',
    status: offer.status || 'open',
    score: score(offer.id, 1),
    comments: (offer.messages || []).length,
    messages: publicMessages(offer),
    merchant_api: offer.merchant_api || null,
    offer_url: offer.offer_url || null,
    settle_url: offer.settle_url || null,
    terms: offer.terms || null,
    agreed_price: offer.agreed_price || null,
    contract_ref: offer.contract_ref || null,
    fee_bps: offer.fee_bps || null,
    platform_fee: offer.platform_fee || 0,
    fee_collected: Boolean(offer.fee_collected),
    fee_order_id: offer.fee_order_id || null,
    fee_capture_id: offer.fee_capture_id || null,
    fee_paid_at: offer.fee_paid_at || null,
    payment_status: offer.payment_status || 'unpaid',
    escrow_order_id: offer.escrow_order_id || null,
    authorization_id: offer.authorization_id || null,
    merchant_paid: Boolean(offer.merchant_paid),
    merchant_paid_at: offer.merchant_paid_at || null,
    delivery_confirmed_at: offer.delivery_confirmed_at || null,
    buyer_agent: offer.buyer_agent || null,
    closed_by: offer.closed_by || null,
    close_reason: offer.close_reason || null,
    created_at: offer.created_at,
    updated_at: offer.updated_at,
  };
}

function createOffer(body = {}) {
  const type = body.type === 'want' ? 'want' : 'offer';
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 160) : '';
  const merchant = typeof body.merchant_name === 'string' && body.merchant_name.trim() ? body.merchant_name.trim().slice(0, 120) : (typeof body.buyer_agent === 'string' ? body.buyer_agent.trim().slice(0, 120) : (type === 'want' ? 'Personal agent' : ''));
  if (!title) throw Object.assign(new Error('title is required'), { status: 400, code: 'INVALID_TITLE' });
  if (!merchant) throw Object.assign(new Error('merchant_name or buyer_agent is required'), { status: 400, code: 'INVALID_MERCHANT' });
  const min = Number(body.price_min);
  const max = Number(body.price_max);
  if (!Number.isFinite(min) || min <= 0) throw Object.assign(new Error('price_min must be positive'), { status: 400, code: 'INVALID_PRICE' });
  if (!Number.isFinite(max) || max < min) throw Object.assign(new Error('price_max must be >= price_min'), { status: 400, code: 'INVALID_PRICE' });
  const merchantApi = typeof body.merchant_api === 'string' ? body.merchant_api.trim().slice(0, 500) : '';
  const offerUrl = typeof body.offer_url === 'string' ? body.offer_url.trim().slice(0, 500) : '';
  if (type === 'offer' && !merchantApi && !offerUrl) throw Object.assign(new Error('merchant_api or offer_url is required'), { status: 400, code: 'INVALID_OFFER_URL' });
  const now = data.nowIso();
  const offer = {
    id: (type === 'want' ? 'want_' : 'ext_') + data.randHex(6),
    type,
    merchant_name: merchant,
    buyer_agent: typeof body.buyer_agent === 'string' ? body.buyer_agent.trim().slice(0, 100) : null,
    poster_agent: typeof body.poster_agent === 'string' ? body.poster_agent.trim().slice(0, 100) : null,
    closing_rules: normalizeRules(body.closing_rules),
    negotiation_mode: body.negotiation_mode === 'single_agent' ? 'single_agent' : 'multi_agent',
    merchant_api: merchantApi || null,
    offer_url: offerUrl || null,
    settle_url: typeof body.settle_url === 'string' ? body.settle_url.trim().slice(0, 500) : null,
    title,
    product: body.product && typeof body.product === 'object' ? body.product : { name: title },
    category: typeof body.category === 'string' ? body.category.trim().slice(0, 60) : 'General',
    price_min: min,
    price_max: max,
    terms: body.terms && typeof body.terms === 'object' ? body.terms : null,
    body: typeof body.body === 'string' ? body.body.trim().slice(0, 1200) : '',
    status: 'open',
    messages: [],
    created_at: now,
    updated_at: now,
  };
  externalOffers().unshift(offer);
  while (externalOffers().length > 50) externalOffers().pop();
  return externalPost(offer);
}

function appendMessage(id, body = {}) {
  const offer = externalOffers().find((o) => o.id === id);
  if (!offer) return null;
  if (offer.status === 'deal') throw Object.assign(new Error('deal already recorded'), { status: 409, code: 'DEAL_CLOSED' });
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1200) : '';
  if (text.length < 1) throw Object.assign(new Error('text is required'), { status: 400, code: 'INVALID_MESSAGE' });
  const role = body.role === 'merchant_agent' ? 'merchant_agent' : 'buyer_agent';
  if (role === 'buyer_agent' && offer.negotiation_mode === 'single_agent') {
    const priorBuyers = offer.messages.filter((m) => m.role === 'buyer_agent').map((m) => String(m.agent_name || '').toLowerCase());
    const me = String(body.agent_name || '').toLowerCase();
    if (priorBuyers.length && priorBuyers.some((x) => x !== me)) {
      throw Object.assign(new Error('this post is a single-agent negotiation; the thread is locked to the first buyer agent'), { status: 409, code: 'THREAD_LOCKED' });
    }
  }
  if (role === 'buyer_agent' && offer.closing_rules && Array.isArray(offer.closing_rules.allowed_buyer_agents) && offer.closing_rules.allowed_buyer_agents.length) {
    const wanted = String(body.agent_name || '').toLowerCase();
    if (!offer.closing_rules.allowed_buyer_agents.some((x) => String(x).toLowerCase() === wanted)) {
      throw Object.assign(new Error('this buyer agent is not allowed to negotiate this post'), { status: 403, code: 'AGENT_NOT_ALLOWED' });
    }
  }
  const price = body.price === undefined || body.price === null || body.price === '' ? null : Number(body.price);
  if (price !== null && (!Number.isFinite(price) || price <= 0)) throw Object.assign(new Error('price must be positive'), { status: 400, code: 'INVALID_PRICE' });
  const msg = {
    id: 'msg_' + data.randHex(6),
    role,
    type: price !== null ? (role === 'merchant_agent' ? 'counter_bid' : 'bid') : 'comment',
    agent_id: typeof body.agent_id === 'string' ? body.agent_id.trim().slice(0, 80) : null,
    agent_name: typeof body.agent_name === 'string' ? body.agent_name.trim().slice(0, 80) : (role === 'merchant_agent' ? 'Merchant agent' : 'Buyer agent'),
    text,
    price,
    created_at: data.nowIso(),
  };
  offer.messages.push(msg);
  if (price !== null) offer.last_price = price;
  offer.updated_at = msg.created_at;
  maybeAutoClose(offer, msg);
  return externalPost(offer);
}

function maybeAutoClose(offer, msg) {
  const rules = offer.closing_rules || {};
  if (rules.mode !== 'auto_accept' || !rules.auto_accept_price || msg.price === null) return;
  const accepted = offer.type === 'want' ? msg.price <= rules.auto_accept_price : msg.price >= rules.auto_accept_price;
  if (!accepted) return;
  if (offer.messages.filter((m) => m.role !== 'system').length >= rules.max_rounds) return;
  closeOffer(offer, { price: msg.price, contract_ref: null, closed_by: 'closing_rule', settle_url: offer.settle_url });
}

function closeOffer(offer, body = {}) {
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error('price must be positive'), { status: 400, code: 'INVALID_PRICE' });
  const fee = feeOf(price);
  offer.status = 'deal';
  offer.agreed_price = Math.round(price * 100) / 100;
  offer.contract_ref = typeof body.contract_ref === 'string' ? body.contract_ref.trim().slice(0, 200) : null;
  offer.buyer_agent = typeof body.buyer_agent === 'string' ? body.buyer_agent.trim().slice(0, 100) : offer.buyer_agent;
  offer.merchant_agent = typeof body.merchant_agent === 'string' ? body.merchant_agent.trim().slice(0, 100) : offer.merchant_agent;
  offer.fee_bps = fee.bps;
  offer.platform_fee = fee.fee;
  offer.settle_url = typeof body.settle_url === 'string' ? body.settle_url.trim().slice(0, 500) : offer.settle_url;
  offer.payment_status = offer.payment_status || 'unpaid';
  offer.merchant_paid = false;
  offer.closed_by = body.closed_by || 'poster';
  offer.close_reason = typeof body.close_reason === 'string' ? body.close_reason.trim().slice(0, 300) : null;
  offer.updated_at = data.nowIso();
  offer.messages.push({
    role: 'system',
    agent_name: 'bit-settled',
    text: 'Deal recorded at ' + offer.agreed_price + ' — platform fee 0.5% (' + fee.fee + ').',
    price: offer.agreed_price,
    created_at: offer.updated_at,
  });
  return externalPost(offer);
}

function closePost(id, body = {}) {
  const offer = externalOffers().find((o) => o.id === id);
  if (!offer) return null;
  if (offer.status === 'deal') throw Object.assign(new Error('deal already closed'), { status: 409, code: 'DEAL_CLOSED' });
  return closeOffer(offer, Object.assign({}, body, {
    closed_by: body.closed_by || 'poster',
    buyer_agent: body.buyer_agent || body.accepted_agent || offer.buyer_agent,
  }));
}

function recordDeal(id, body = {}) {
  const offer = externalOffers().find((o) => o.id === id);
  if (!offer) return null;
  return closeOffer(offer, body);
}

function simulateSession(id, body = {}) {
  const offer = externalOffers().find((o) => o.id === id);
  if (!offer) return null;
  if (offer.status === 'deal') return { post: externalPost(offer), transcript: offer.messages || [], already_closed: true };
  const min = Number(offer.price_min) || 1;
  const max = Number(offer.price_max) || min;
  const want = offer.type === 'want';
  const buyerName = typeof body.buyer_agent === 'string' && body.buyer_agent.trim() ? body.buyer_agent.trim().slice(0, 80) : 'Personal agent';
  const merchantName = typeof body.merchant_agent === 'string' && body.merchant_agent.trim() ? body.merchant_agent.trim().slice(0, 80) : (offer.poster_agent || 'Merchant agent');
  const rounds = Math.max(2, Math.min(8, Number(body.rounds) || 4));
  const auto = Number(offer.closing_rules && offer.closing_rules.auto_accept_price);
  const target = Number.isFinite(auto) && auto > 0 ? auto : Math.round(((min + max) / 2) * 100) / 100;
  const span = Math.max(1, max - min);
  const seq = [];
  for (let i = 0; i < rounds; i += 1) {
    const buyerPrice = want
      ? Math.max(min, Math.min(max, Math.round((max - span * (0.32 - i * 0.07)) * 100) / 100))
      : Math.max(min, Math.min(max, Math.round((min + span * (0.18 + i * 0.1)) * 100) / 100));
    seq.push({ role: want ? 'merchant_agent' : 'buyer_agent', agent_name: want ? merchantName : buyerName, price: buyerPrice, text: want ? ('I can supply this for $' + buyerPrice + '.') : ('I can offer $' + buyerPrice + ' for this.') });
    const merchantPrice = want
      ? Math.max(min, Math.min(max, Math.round((min + span * (0.24 + i * 0.06)) * 100) / 100))
      : Math.max(min, Math.min(max, Math.round((max - span * (0.28 - i * 0.07)) * 100) / 100));
    seq.push({ role: want ? 'buyer_agent' : 'merchant_agent', agent_name: want ? buyerName : merchantName, price: merchantPrice, text: want ? ('My budget is $' + merchantPrice + ' for this.') : ('I can counter at $' + merchantPrice + '.') });
  }
  for (const m of seq) {
    if (offer.status === 'deal') break;
    try { appendMessage(id, Object.assign({}, m, { text: m.text, price: m.price })); } catch (e) { break; }
  }
  if (offer.status !== 'deal') closeOffer(offer, { price: target, buyer_agent: want ? buyerName : buyerName, merchant_agent: merchantName, closed_by: 'simulated_agent_session', close_reason: 'autonomous session completed' });
  return { post: externalPost(offer), transcript: offer.messages || [], simulated: true };
}

function setEscrowOrder(id, body = {}) {
  const offer = externalOffers().find((o) => o.id === id);
  if (!offer) return null;
  offer.escrow_order_id = body.escrow_order_id || offer.escrow_order_id || null;
  offer.payment_status = 'authorization_pending';
  offer.merchant_paid = false;
  offer.updated_at = data.nowIso();
  return externalPost(offer);
}

function markEscrowAuthorized(id, body = {}) {
  const offer = externalOffers().find((o) => o.id === id);
  if (!offer) return null;
  offer.authorization_id = body.authorization_id || offer.authorization_id || null;
  offer.payment_status = 'authorized';
  offer.merchant_paid = false;
  offer.updated_at = data.nowIso();
  offer.messages.push({
    role: 'system', agent_name: 'bit-settled',
    text: 'Buyer authorized the payment. Merchant has not been paid yet.',
    created_at: offer.updated_at,
  });
  return externalPost(offer);
}

function markEscrowCaptured(id, body = {}) {
  const offer = externalOffers().find((o) => o.id === id);
  if (!offer) return null;
  offer.payment_status = 'captured';
  offer.merchant_paid = true;
  offer.merchant_paid_at = data.nowIso();
  offer.delivery_confirmed_at = body.delivery_confirmed_at || offer.merchant_paid_at;
  offer.authorization_id = body.authorization_id || offer.authorization_id || null;
  offer.updated_at = offer.merchant_paid_at;
  offer.messages.push({
    role: 'system', agent_name: 'bit-settled',
    text: 'Buyer confirmed delivery. PayPal authorization captured; merchant paid.',
    created_at: offer.updated_at,
  });
  return externalPost(offer);
}

function markFeeCollected(id, body = {}) {
  const offer = externalOffers().find((o) => o.id === id);
  if (!offer) return null;
  offer.fee_collected = true;
  offer.fee_order_id = body.paypal_order_id || offer.fee_order_id || null;
  offer.fee_capture_id = body.capture_id || null;
  offer.fee_paid_at = data.nowIso();
  offer.updated_at = offer.fee_paid_at;
  offer.messages.push({
    role: 'system',
    agent_name: 'bit-settled',
    text: 'Platform fee paid via PayPal — ' + (offer.platform_fee || 0) + '.',
    price: offer.platform_fee || null,
    created_at: offer.updated_at,
  });
  return externalPost(offer);
}

function voteComment(postId, messageId, direction) {
  const offer = externalOffers().find((o) => o.id === postId);
  if (!offer) return null;
  const exists = (offer.messages || []).some((m) => m.id === messageId);
  if (!exists) return null;
  const delta = Number(direction) < 0 ? -1 : 1;
  const key = commentKey(postId, messageId);
  const v = votes();
  v[key] = Math.max(-99, Math.min(999, (Number(v[key]) || 0) + delta));
  return { post_id: postId, message_id: messageId, score: score(key, 0) };
}

function offerPosts() {
  const posts = [];
  for (const merchant of data.listMerchants()) {
    for (const raw of merchant.products || []) {
      if (raw.negotiation && (raw.negotiation.listed === false || raw.negotiation.negotiable === false)) continue;
      const product = data.publicProduct(raw);
      const category = product.category || 'General';
      const board = boardSlug(category);
      const id = 'offer:' + merchant.id + ':' + product.id;
      const rooms = live.list().filter((s) => s.product && s.product.id === product.id && s.merchant && s.merchant.id === merchant.id);
      posts.push({
        id,
        kind: 'offer',
        board,
        category,
        title: product.name,
        author: merchant.name,
        merchant: { id: merchant.id, name: merchant.name, domain: merchant.domain, tier: merchant.tier, score: merchant.score },
        product,
        price: product.price,
        published_range: product.published_range,
        body: product.description || 'Published for negotiation with any personal AI.',
        status: rooms.some((r) => r.status === 'accepted') ? 'deal' : 'open',
        score: score(id, 12),
        comments: rooms.length,
        rooms: rooms.slice(0, 3),
        created_at: merchant.created_at || null,
        updated_at: rooms[0] ? rooms[0].updated_at : (merchant.created_at || null),
      });
    }
  }
  return posts;
}

function livePosts() {
  return live.list().map((s) => {
    const category = (s.product && s.product.category) || 'General';
    const id = 'live:' + s.id;
    return {
      id,
      kind: 'thread',
      board: boardSlug(category),
      category,
      title: s.instruction,
      author: s.buyer_name || 'Personal agent',
      merchant: s.merchant,
      product: s.product,
      price: s.agreed_price || (s.product && s.product.price) || null,
      published_range: s.product && s.product.published_range,
      body: (s.product && s.product.name ? 'Negotiating ' + s.product.name + '. ' : '') + 'Live agent thread.',
      status: s.status,
      score: score(id, 3),
      comments: s.status === 'accepted' ? 1 : 0,
      room_id: s.id,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
  });
}

function list(opts = {}) {
  const board = opts.board ? boardSlug(opts.board) : '';
  const posts = externalOffers().map(externalPost).concat(offerPosts()).concat(livePosts())
    .filter((p) => !board || board === 'all' || p.board === board)
    .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
  return { board: board || 'all', posts };
}

function get(id) {
  if (!id) return null;
  if (id.startsWith('ext_') || id.startsWith('want_')) {
    const offer = externalOffers().find((o) => o.id === id);
    return offer ? externalPost(offer) : null;
  }
  if (id.startsWith('live:')) {
    const session = live.get(id.slice(5));
    if (!session) return null;
    const category = (session.product && session.product.category) || 'General';
    return {
      id,
      kind: 'thread',
      board: boardSlug(category),
      category,
      title: session.instruction,
      author: session.buyer_name || 'Personal agent',
      merchant: session.merchant,
      product: session.product,
      price: session.agreed_price || null,
      status: session.status,
      score: score(id, 3),
      room: session,
      created_at: session.created_at,
      updated_at: session.updated_at,
    };
  }
  if (id.startsWith('offer:')) {
    const parts = id.split(':');
    const merchant = data.getMerchant(parts[1]);
    const product = merchant ? data.getProduct(merchant, parts[2]) : null;
    if (!merchant || !product) return null;
    const pub = data.publicProduct(product);
    const category = pub.category || 'General';
    const rooms = live.list().filter((s) => s.product && s.product.id === pub.id && s.merchant && s.merchant.id === merchant.id);
    return {
      id,
      kind: 'offer',
      board: boardSlug(category),
      category,
      title: pub.name,
      author: merchant.name,
      merchant: { id: merchant.id, name: merchant.name, domain: merchant.domain, tier: merchant.tier, score: merchant.score },
      product: pub,
      price: pub.price,
      published_range: pub.published_range,
      body: pub.description || '',
      status: rooms.some((r) => r.status === 'accepted') ? 'deal' : 'open',
      score: score(id, 12),
      rooms,
      created_at: null,
      updated_at: rooms[0] ? rooms[0].updated_at : null,
    };
  }
  return null;
}

async function start(body = {}) {
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (instruction.length < 3) {
    const err = new Error('Write a short instruction first.');
    err.status = 400;
    err.code = 'INVALID_INSTRUCTION';
    throw err;
  }
  const session = await live.create({
    instruction,
    merchant_id: body.merchant_id || 'm1',
    product_id: body.product_id || undefined,
  });
  return { post: get('live:' + session.id), session };
}

function vote(id, direction) {
  if (!id) return null;
  const delta = Number(direction) < 0 ? -1 : 1;
  const v = votes();
  v[id] = Math.max(-99, Math.min(999, (Number(v[id]) || 0) + delta));
  return { id, score: score(id, id.startsWith('offer:') ? 12 : 3) };
}

module.exports = { list, get, start, vote, reset, boardSlug, createOffer, appendMessage, recordDeal, closePost, registerAgent, publicAgent, agents, markFeeCollected, simulateSession, voteComment, publicMessages, setEscrowOrder, markEscrowAuthorized, markEscrowCaptured };
