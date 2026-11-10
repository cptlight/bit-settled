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

function reset() {
  data.state.board_votes = {};
  data.state.board_offers = [];
}

function feeOf(price) {
  const bps = 50;
  const fee = Math.round(Number(price) * bps) / 10000;
  return { bps, fee: Math.round(fee * 100) / 100 };
}

function externalPost(offer) {
  return {
    id: offer.id,
    kind: 'external',
    board: boardSlug(offer.category || 'general'),
    category: offer.category || 'General',
    title: offer.title,
    author: offer.merchant_name,
    merchant: { name: offer.merchant_name, api_url: offer.merchant_api || null, domain: offer.merchant_domain || null },
    product: offer.product || null,
    price: offer.price_min,
    published_range: { min: offer.price_min, max: offer.price_max },
    body: offer.body || 'Merchant offer — negotiate directly against the merchant API.',
    status: offer.status || 'open',
    score: score(offer.id, 1),
    comments: (offer.messages || []).length,
    messages: offer.messages || [],
    merchant_api: offer.merchant_api || null,
    offer_url: offer.offer_url || null,
    settle_url: offer.settle_url || null,
    terms: offer.terms || null,
    agreed_price: offer.agreed_price || null,
    contract_ref: offer.contract_ref || null,
    fee_bps: offer.fee_bps || null,
    platform_fee: offer.platform_fee || 0,
    created_at: offer.created_at,
    updated_at: offer.updated_at,
  };
}

function createOffer(body = {}) {
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 160) : '';
  const merchant = typeof body.merchant_name === 'string' ? body.merchant_name.trim().slice(0, 120) : '';
  if (!title) throw Object.assign(new Error('title is required'), { status: 400, code: 'INVALID_TITLE' });
  if (!merchant) throw Object.assign(new Error('merchant_name is required'), { status: 400, code: 'INVALID_MERCHANT' });
  const min = Number(body.price_min);
  const max = Number(body.price_max);
  if (!Number.isFinite(min) || min <= 0) throw Object.assign(new Error('price_min must be positive'), { status: 400, code: 'INVALID_PRICE' });
  if (!Number.isFinite(max) || max < min) throw Object.assign(new Error('price_max must be >= price_min'), { status: 400, code: 'INVALID_PRICE' });
  const merchantApi = typeof body.merchant_api === 'string' ? body.merchant_api.trim().slice(0, 500) : '';
  const offerUrl = typeof body.offer_url === 'string' ? body.offer_url.trim().slice(0, 500) : '';
  if (!merchantApi && !offerUrl) throw Object.assign(new Error('merchant_api or offer_url is required'), { status: 400, code: 'INVALID_OFFER_URL' });
  const now = data.nowIso();
  const offer = {
    id: 'ext_' + data.randHex(6),
    merchant_name: merchant,
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
  const price = body.price === undefined || body.price === null || body.price === '' ? null : Number(body.price);
  if (price !== null && (!Number.isFinite(price) || price <= 0)) throw Object.assign(new Error('price must be positive'), { status: 400, code: 'INVALID_PRICE' });
  const msg = {
    role,
    agent_name: typeof body.agent_name === 'string' ? body.agent_name.trim().slice(0, 80) : (role === 'merchant_agent' ? 'Merchant agent' : 'Buyer agent'),
    text,
    price,
    created_at: data.nowIso(),
  };
  offer.messages.push(msg);
  if (price !== null) offer.last_price = price;
  offer.updated_at = msg.created_at;
  return externalPost(offer);
}

function recordDeal(id, body = {}) {
  const offer = externalOffers().find((o) => o.id === id);
  if (!offer) return null;
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error('price must be positive'), { status: 400, code: 'INVALID_PRICE' });
  const fee = feeOf(price);
  offer.status = 'deal';
  offer.agreed_price = Math.round(price * 100) / 100;
  offer.contract_ref = typeof body.contract_ref === 'string' ? body.contract_ref.trim().slice(0, 200) : null;
  offer.buyer_agent = typeof body.buyer_agent === 'string' ? body.buyer_agent.trim().slice(0, 80) : 'Buyer agent';
  offer.merchant_agent = typeof body.merchant_agent === 'string' ? body.merchant_agent.trim().slice(0, 80) : 'Merchant agent';
  offer.fee_bps = fee.bps;
  offer.platform_fee = fee.fee;
  offer.settle_url = typeof body.settle_url === 'string' ? body.settle_url.trim().slice(0, 500) : offer.settle_url;
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
  if (id.startsWith('ext_')) {
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

module.exports = { list, get, start, vote, reset, boardSlug, createOffer, appendMessage, recordDeal };
