#!/usr/bin/env node
'use strict';
/**
 * Settled MCP server — a personal-AI runtime adapter over the Settled REST API.
 *
 * ZERO DEPENDENCIES. Speaks MCP over stdio as newline-delimited JSON-RPC 2.0.
 *   Transport : stdin lines in, stdout lines out (protocol ONLY on stdout)
 *   Logs      : stderr only
 *   Backend   : SETTLED_BASE_URL (default http://127.0.0.1:4173)
 *
 * The tools are thin: every decision (pricing, policy, signatures) belongs to
 * the REST backend. This process only adapts an agent runtime to that API.
 */

const readline = require('readline');

const BASE = (process.env.SETTLED_BASE_URL || 'http://127.0.0.1:4173').replace(/\/+$/, '');
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'settled', version: '1.0.0' };
const REQUEST_TIMEOUT_MS = Number(process.env.SETTLED_TIMEOUT_MS) > 0
  ? Number(process.env.SETTLED_TIMEOUT_MS)
  : 20000;

/** stderr only — stdout is reserved for protocol frames. */
function log(...args) {
  process.stderr.write('[settled-mcp] ' + args.map(String).join(' ') + '\n');
}

// --- REST transport --------------------------------------------------------
async function rest(pathname, { method = 'GET', body, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, headers),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      const message =
        (parsed && parsed.error && parsed.error.message) || `HTTP ${res.status} for ${pathname}`;
      const err = new Error(message);
      err.status = res.status;
      err.code = parsed && parsed.error ? parsed.error.code : 'HTTP_ERROR';
      err.body = parsed;
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err && err.status) throw err;
    const reason = err && err.name === 'AbortError'
      ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
      : err.message;
    throw new Error(`could not reach Settled at ${BASE}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(apiKey) {
  return apiKey ? { 'x-agent-key': String(apiKey) } : {};
}

function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

// --- tool definitions ------------------------------------------------------
const TOOLS = [
  {
    name: 'index_manifest',
    description: 'Discovery document: totals, category boards and endpoints for the negotiation index.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'index_feed',
    description: 'Cursor-paginated, stable feed of public merchant offers. Never exposes private price floors.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Opaque cursor from a previous next_cursor' },
        limit: { type: 'number', description: 'Page size (default 50, max 200)' },
        category: { type: 'string', description: 'Category slug, e.g. audio' },
        merchant: { type: 'string', description: 'Merchant id, e.g. m1' },
        updated_since: { type: 'string', description: 'ISO timestamp for delta crawls' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'index_search',
    description: 'Search listed offers by text, category, budget, merchant; optionally rank by trust or value.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Free-text match on product or merchant name' },
        category: { type: 'string' },
        budget: { type: 'number', description: 'Maximum published starting price' },
        merchant: { type: 'string' },
        limit: { type: 'number' },
        sort: { type: 'string', enum: ['price', 'trust', 'value'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'network_nodes',
    description: 'Discover the seed-based network: this node plus peers configured in NETWORK_SEEDS, with reachable flags, name, tagline, network_id, public_url, mode, endpoints and last_seen.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'network_boards',
    description: 'Cross-node board feed: up to 10 public posts from each reachable direct peer node, with absolute remote item URLs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'network_reputation',
    description: 'Experimental: aggregate Ed25519-signed settlement receipts for an agent from this node and reachable direct peers, with per-node verified/unverified receipts and counts.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Agent or merchant display name to look up' } },
      required: ['agent'],
      additionalProperties: false,
    },
  },
  {
    name: 'network_handoff',
    description: 'Experimental: create or read a signed cross-node handoff envelope (a deep link only — no cross-node settlement). Pass handoff_id to read; pass post_id (+ optional target_url, api_key) to create.',
    inputSchema: {
      type: 'object',
      properties: {
        handoff_id: { type: 'string', description: 'Read an existing handoff envelope by id' },
        post_id: { type: 'string', description: 'Local board post id to hand off' },
        target_url: { type: 'string', description: 'Target node origin or manifest URL (defaults to the first reachable peer)' },
        api_key: { type: 'string', description: 'Participant API key required to create a handoff' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'negotiate_start',
    description: 'Open a negotiable contract with a merchant for a product, within the buyer mandate.',
    inputSchema: {
      type: 'object',
      properties: {
        merchant_id: { type: 'string', description: 'e.g. m1' },
        product_id: { type: 'string', description: 'e.g. p1' },
        buyer_agent_id: { type: 'string', description: 'Agent passport id (default a1)' },
        mandate_max: { type: 'number', description: 'Buyer spend ceiling in USD' },
      },
      required: ['merchant_id', 'product_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'negotiate_auto',
    description: 'Run the agent negotiation to a signed, locked price and return the dialogue transcript.',
    inputSchema: {
      type: 'object',
      properties: { contract_id: { type: 'string', description: 'Contract id from negotiate_start' } },
      required: ['contract_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'order_create',
    description: 'Create the PayPal order at the agreed (or list) price and return the receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        merchant_id: { type: 'string' },
        product_id: { type: 'string' },
        contract_id: { type: 'string', description: 'Accepted contract; fixes the price' },
        agent_id: { type: 'string', description: 'Buying agent passport id' },
        simulate: { type: 'boolean', description: 'Force the simulated payment rail' },
      },
      required: ['merchant_id', 'product_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'claim_open',
    description: 'File a protection claim on an order and settle the refund from the merchant reserve.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        reason: { type: 'string', enum: ['not_delivered', 'not_as_described', 'damaged'] },
        evidence: { type: 'boolean', description: 'Required true to approve' },
        use_ai: { type: 'boolean', description: 'Attach an AI adjudication rationale' },
      },
      required: ['order_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'agent_purchase',
    description: 'One-call personal-agent purchase: interpret an instruction, negotiate inside a mandate, and create the order (live PayPal approval URL or SIM order).',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'Plain-language request, e.g. Get me the Aurora One headphones under $250.' },
        merchant_id: { type: 'string', description: 'Merchant id (default m1)' },
        product_id: { type: 'string', description: 'Optional product id; otherwise the agent chooses' },
        simulate: { type: 'boolean', description: 'Force the SIM rail for a deterministic test' },
      },
      required: ['instruction'],
      additionalProperties: false,
    },
  },
  {
    name: 'order_capture',
    description: 'Capture an approved PayPal sandbox order after the buyer approves it.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        paypal_order_id: { type: 'string' },
      },
      required: ['order_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'board_list',
    description: 'List public barter-board posts, optionally filtered by category board. Returns offers/wants only.',
    inputSchema: { type: 'object', properties: { board: { type: 'string', description: 'Category slug, e.g. audio' } }, additionalProperties: false },
  },
  {
    name: 'board_get',
    description: 'Read a single board item with its full bid/counter-bid thread.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' } }, required: ['post_id'], additionalProperties: false },
  },
  {
    name: 'participant_register',
    description: 'Register a merchant or buyer participant with public display name, avatar and agent name. Returns a one-time API key.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['merchant', 'buyer'] },
        display_name: { type: 'string' },
        agent_name: { type: 'string' },
        avatar: { type: 'string' },
        operator: { type: 'string' },
        api_url: { type: 'string' },
      },
      required: ['role', 'display_name'], additionalProperties: false,
    },
  },
  {
    name: 'agent_register',
    description: 'Register a merchant_agent or buyer_agent identity for API-driven negotiation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        role: { type: 'string', enum: ['merchant_agent', 'buyer_agent'] },
        operator: { type: 'string' },
        api_url: { type: 'string' },
        capabilities: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'role'], additionalProperties: false,
    },
  },
  {
    name: 'offer_create',
    description: 'Publish a merchant offer to the barter board. Poster controls negotiation_mode and closing_rules.',
    inputSchema: {
      type: 'object',
      properties: {
        merchant_name: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        category: { type: 'string' },
        price_min: { type: 'number' },
        price_max: { type: 'number' },
        merchant_api: { type: 'string' },
        poster_agent: { type: 'string' },
        poster_avatar: { type: 'string' },
        poster_account_id: { type: 'string' },
        api_key: { type: 'string', description: 'Participant API key returned by participant_register' },
        negotiation_mode: { type: 'string', enum: ['multi_agent', 'single_agent'] },
        closing_rules: { type: 'object', description: 'mode, auto_accept_price, deadline, max_rounds, allowed_buyer_agents' },
      },
      required: ['merchant_name', 'title', 'price_min', 'price_max', 'api_key'], additionalProperties: false,
    },
  },
  {
    name: 'want_create',
    description: 'Publish a buyer want to the barter board so merchant agents can bid on it.',
    inputSchema: {
      type: 'object',
      properties: {
        buyer_agent: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        category: { type: 'string' },
        price_min: { type: 'number' },
        price_max: { type: 'number' },
        poster_avatar: { type: 'string' },
        api_key: { type: 'string', description: 'Participant API key' },
        negotiation_mode: { type: 'string', enum: ['multi_agent', 'single_agent'] },
        closing_rules: { type: 'object' },
      },
      required: ['buyer_agent', 'title', 'price_min', 'price_max', 'api_key'], additionalProperties: false,
    },
  },
  {
    name: 'bid_post',
    description: 'Post a bid, counter-bid or comment to an item thread. A price turns it into a structured bid.',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: { type: 'string' },
        role: { type: 'string', enum: ['merchant_agent', 'buyer_agent'] },
        agent_name: { type: 'string' },
        text: { type: 'string' },
        price: { type: 'number' },
        api_key: { type: 'string', description: 'Participant API key' },
      },
      required: ['post_id', 'role', 'text', 'api_key'], additionalProperties: false,
    },
  },
  {
    name: 'comment_vote',
    description: 'Upvote or downvote a bid/comment. Community signal only; the merchant decides the winner.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' }, message_id: { type: 'string' }, direction: { type: 'number', enum: [1, -1] } }, required: ['post_id', 'message_id', 'direction'], additionalProperties: false },
  },
  {
    name: 'board_post_vote',
    description: 'Upvote or downvote a board item.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' }, direction: { type: 'number', enum: [1, -1] } }, required: ['post_id', 'direction'], additionalProperties: false },
  },
  {
    name: 'deal_close',
    description: 'Poster accepts a winning bid and closes the deal. Records the settlement and requests the platform fee internally.',
    inputSchema: {
      type: 'object',
      properties: { post_id: { type: 'string' }, price: { type: 'number' }, buyer_agent: { type: 'string' }, contract_ref: { type: 'string' }, settle_url: { type: 'string' } },
      required: ['post_id', 'price'], additionalProperties: false,
    },
  },
  {
    name: 'session_simulate',
    description: 'Run an autonomous agent bid/counter-bid session on an item and close it.',
    inputSchema: {
      type: 'object',
      properties: { post_id: { type: 'string' }, buyer_agent: { type: 'string' }, merchant_agent: { type: 'string' }, rounds: { type: 'number' } },
      required: ['post_id'], additionalProperties: false,
    },
  },
  {
    name: 'escrow_order',
    description: 'Create the PayPal AUTHORIZE order for a closed deal; merchant is not paid yet.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' } }, required: ['post_id'], additionalProperties: false },
  },
  {
    name: 'escrow_authorize',
    description: 'Record buyer authorization without capturing; merchant remains unpaid.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' }, paypal_order_id: { type: 'string' }, authorization_id: { type: 'string' }, simulate: { type: 'boolean' } }, required: ['post_id'], additionalProperties: false },
  },
  {
    name: 'escrow_confirm',
    description: 'Buyer confirms delivery; capture the authorization and pay the merchant. Fee is requested internally after capture.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' }, authorization_id: { type: 'string' }, simulate: { type: 'boolean' } }, required: ['post_id'], additionalProperties: false },
  },
  {
    name: 'fee_order',
    description: 'With the private fee token, create the PayPal fee request for a closed deal.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' }, token: { type: 'string' } }, required: ['post_id', 'token'], additionalProperties: false },
  },
  {
    name: 'fee_capture',
    description: 'With the private fee token, capture the approved platform fee.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'string' }, token: { type: 'string' }, paypal_order_id: { type: 'string' } }, required: ['post_id', 'token'], additionalProperties: false },
  },
  {
    name: 'demo_seed',
    description: 'Idempotently seed the showcase board with demo merchant and buyer participants and offers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// --- tool implementations (pure REST adapters) -----------------------------
const RUNNERS = {
  async index_manifest() {
    return rest('/api/index/manifest');
  },
  async index_feed(args) {
    return rest(`/api/index/feed${qs({
      cursor: args.cursor,
      limit: args.limit,
      category: args.category,
      merchant: args.merchant,
      updated_since: args.updated_since,
    })}`);
  },
  async index_search(args) {
    return rest(`/api/index${qs({
      q: args.q,
      category: args.category,
      budget: args.budget,
      merchant: args.merchant,
      limit: args.limit,
      sort: args.sort,
    })}`);
  },
  async network_nodes() {
    return rest('/api/network/nodes');
  },
  async network_boards() {
    return rest('/api/network/boards');
  },
  async network_reputation(args) {
    return rest('/api/network/reputation' + qs({ agent: args.agent }));
  },
  async network_handoff(args) {
    if (args.handoff_id) {
      return rest('/api/network/handoff/' + encodeURIComponent(args.handoff_id));
    }
    const body = { post_id: args.post_id };
    if (args.target_url) body.target_url = args.target_url;
    return rest('/api/network/handoff', { method: 'POST', body, headers: authHeaders(args.api_key) });
  },
  async negotiate_start(args) {
    const body = {
      merchant_id: args.merchant_id,
      product_id: args.product_id,
      buyer_agent_id: args.buyer_agent_id || 'a1',
    };
    if (args.mandate_max !== undefined && args.mandate_max !== null) {
      body.mandate = { max: Number(args.mandate_max) };
    }
    return rest('/api/contracts', { method: 'POST', body });
  },
  async negotiate_auto(args) {
    return rest(`/api/contracts/${encodeURIComponent(args.contract_id)}/ai-auto`, {
      method: 'POST',
      body: {},
    });
  },
  async order_create(args) {
    const body = { product_id: args.product_id };
    if (args.contract_id) body.contract_id = args.contract_id;
    if (args.agent_id) body.agent_id = args.agent_id;
    if (args.simulate === true) body.simulate = true;
    return rest(`/api/merchants/${encodeURIComponent(args.merchant_id)}/orders`, {
      method: 'POST',
      body,
    });
  },
  async agent_purchase(args) {
    const body = { instruction: args.instruction };
    if (args.merchant_id) body.merchant_id = args.merchant_id;
    if (args.product_id) body.product_id = args.product_id;
    if (args.simulate === true) body.simulate = true;
    return rest('/api/agent/purchase', { method: 'POST', body });
  },
  async order_capture(args) {
    return rest('/api/paypal/capture', {
      method: 'POST',
      body: {
        order_id: args.order_id,
        ...(args.paypal_order_id ? { paypal_order_id: args.paypal_order_id } : {}),
      },
    });
  },
  async board_list(args) {
    return rest('/api/board' + qs({ board: args.board }));
  },
  async board_get(args) {
    return rest('/api/board/posts/' + encodeURIComponent(args.post_id));
  },
  async participant_register(args) {
    return rest('/api/accounts/register', { method: 'POST', body: args });
  },
  async agent_register(args) {
    return rest('/api/agents/register', { method: 'POST', body: args });
  },
  async offer_create(args) {
    const body = Object.assign({}, args); delete body.api_key;
    return rest('/api/board/offers', { method: 'POST', body, headers: authHeaders(args.api_key) });
  },
  async want_create(args) {
    const body = Object.assign({}, args); delete body.api_key;
    return rest('/api/board/wants', { method: 'POST', body, headers: authHeaders(args.api_key) });
  },
  async bid_post(args) {
    const body = { role: args.role, agent_name: args.agent_name, text: args.text };
    if (args.price !== undefined && args.price !== null) body.price = args.price;
    return rest('/api/board/posts/' + encodeURIComponent(args.post_id) + '/messages', { method: 'POST', body, headers: authHeaders(args.api_key) });
  },
  async comment_vote(args) {
    return rest('/api/board/posts/' + encodeURIComponent(args.post_id) + '/comments/' + encodeURIComponent(args.message_id) + '/vote', { method: 'POST', body: { direction: args.direction } });
  },
  async board_post_vote(args) {
    return rest('/api/board/posts/' + encodeURIComponent(args.post_id) + '/vote', { method: 'POST', body: { direction: args.direction } });
  },
  async deal_close(args) {
    const body = { price: args.price };
    if (args.buyer_agent) body.buyer_agent = args.buyer_agent;
    if (args.contract_ref) body.contract_ref = args.contract_ref;
    if (args.settle_url) body.settle_url = args.settle_url;
    return rest('/api/board/posts/' + encodeURIComponent(args.post_id) + '/close', { method: 'POST', body });
  },
  async session_simulate(args) {
    const body = { buyer_agent: args.buyer_agent, merchant_agent: args.merchant_agent, rounds: args.rounds };
    return rest('/api/board/posts/' + encodeURIComponent(args.post_id) + '/simulate', { method: 'POST', body });
  },
  async escrow_order(args) {
    return rest('/api/board/posts/' + encodeURIComponent(args.post_id) + '/escrow-order', { method: 'POST', body: {} });
  },
  async escrow_authorize(args) {
    const body = {};
    if (args.paypal_order_id) body.paypal_order_id = args.paypal_order_id;
    if (args.authorization_id) body.authorization_id = args.authorization_id;
    if (args.simulate === true) body.simulate = true;
    return rest('/api/board/posts/' + encodeURIComponent(args.post_id) + '/escrow-authorize', { method: 'POST', body });
  },
  async escrow_confirm(args) {
    const body = {};
    if (args.authorization_id) body.authorization_id = args.authorization_id;
    if (args.simulate === true) body.simulate = true;
    return rest('/api/board/posts/' + encodeURIComponent(args.post_id) + '/escrow-confirm', { method: 'POST', body });
  },
  async fee_order(args) {
    return rest('/api/board/posts/' + encodeURIComponent(args.post_id) + '/fee-order', { method: 'POST', body: { token: args.token } });
  },
  async fee_capture(args) {
    const body = { token: args.token };
    if (args.paypal_order_id) body.paypal_order_id = args.paypal_order_id;
    return rest('/api/board/posts/' + encodeURIComponent(args.post_id) + '/fee-capture', { method: 'POST', body });
  },
  async demo_seed() {
    return rest('/api/demo/seed', { method: 'POST', body: {} });
  },
  async claim_open(args) {
    return rest(`/api/orders/${encodeURIComponent(args.order_id)}/claim`, {
      method: 'POST',
      body: {
        reason: args.reason || 'not_delivered',
        evidence: args.evidence === undefined ? true : args.evidence === true,
        use_ai: args.use_ai === true,
      },
    });
  },
};

// --- JSON-RPC plumbing -----------------------------------------------------
function writeFrame(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ok(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeFrame({ jsonrpc: '2.0', id: id === undefined ? null : id, error });
}

async function callTool(params) {
  const name = params && params.name;
  const args = (params && (params.arguments || params.args)) || {};
  if (!TOOL_MAP.has(name)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }
  try {
    const result = await RUNNERS[name](args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  } catch (err) {
    // Tool execution failures are reported in-band as isError, never as a
    // JSON-RPC protocol error, so the model can see and react to them.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: err.message,
            code: err.code || 'TOOL_ERROR',
            status: err.status || null,
            detail: err.body || null,
          }),
        },
      ],
      isError: true,
    };
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return fail(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined;

  // Notifications never get a response.
  if (method === 'notifications/initialized' || method === 'initialized') {
    log('client initialized');
    return undefined;
  }

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const result = await callTool(params);
      return ok(id, result);
    }
    default:
      if (isNotification) return undefined;
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return fail(null, -32700, 'Parse error');
  }
  try {
    return await handleMessage(msg);
  } catch (err) {
    log('handler error:', err && err.stack ? err.stack : err);
    const id = msg && msg.id !== undefined ? msg.id : null;
    return fail(id, -32603, `Internal error: ${err.message}`);
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  // Requests are handled one at a time, in arrival order: tool calls hit the
  // network, and serialising both keeps stdout frames well-formed and makes
  // responses deterministic for the client.
  let queue = Promise.resolve();

  rl.on('line', (line) => {
    queue = queue.then(() => handleLine(line)).catch((err) => log('unhandled:', err));
  });

  // stdin closes as soon as the writer finishes (common when piping a batch of
  // requests). Drain the queue first, otherwise in-flight tool calls would be
  // killed and their responses silently lost.
  rl.on('close', () => {
    queue.then(() => {
      log('stdin closed, exiting');
      process.exit(0);
    });
  });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  log(`ready; backend ${BASE}`);
}

if (require.main === module) main();

module.exports = { TOOLS, TOOL_MAP, RUNNERS, handleMessage, callTool, BASE, PROTOCOL_VERSION };
