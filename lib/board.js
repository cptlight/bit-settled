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

function reset() {
  data.state.board_votes = {};
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
  const posts = offerPosts().concat(livePosts())
    .filter((p) => !board || board === 'all' || p.board === board)
    .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
  return { board: board || 'all', posts };
}

function get(id) {
  if (!id) return null;
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

module.exports = { list, get, start, vote, reset, boardSlug };
