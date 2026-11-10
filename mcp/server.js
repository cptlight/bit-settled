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
async function rest(pathname, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
