'use strict';
/**
 * lib/mcp-http.js — stateless MCP Streamable-HTTP adapter for external AIs.
 *
 * Any MCP client can POST JSON-RPC 2.0 to /mcp:
 *   initialize, tools/list, tools/call, ping, notifications/initialized.
 * Tool execution is delegated to mcp/server.js (same seven tools as stdio).
 */

const path = require('path');

const PROTOCOL_VERSION = process.env.MCP_PROTOCOL_VERSION || '2024-11-05';
const SERVER_INFO = { name: 'bit-settled', version: '1.0.0' };

// mcp/server.js resolves its REST base at require time.
if (!process.env.SETTLED_BASE_URL) {
  process.env.SETTLED_BASE_URL =
    process.env.PUBLIC_BASE_URL ||
    `http://127.0.0.1:${Number(process.env.PORT || 4173)}`;
}
const mcp = require(path.join(__dirname, '..', 'mcp', 'server.js'));

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });
  res.end(body);
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return error(null, -32600, 'Invalid Request');
  const { id, method, params } = msg;
  const notification = id === undefined;

  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: mcp.TOOLS });
  if (method === 'tools/call') return result(id, await mcp.callTool(params || {}));
  if (notification) return null;
  return error(id, -32601, `Method not found: ${method}`);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const e = new Error('payload too large');
      e.status = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return true;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST JSON-RPC to /mcp' } });
    return true;
  }
  let msg;
  try {
    msg = await readBody(req);
  } catch (err) {
    send(res, err.status || 400, error(null, -32700, err.message || 'Parse error'));
    return true;
  }
  try {
    const out = await handleMessage(msg);
    if (!out) {
      res.writeHead(202, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end('');
      return true;
    }
    send(res, 200, out);
  } catch (err) {
    send(res, 200, error(msg && msg.id, -32603, err.message || 'Internal error'));
  }
  return true;
}

module.exports = { handle, PROTOCOL_VERSION, SERVER_INFO };
