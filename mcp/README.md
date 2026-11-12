# Settled MCP server

A **personal-AI runtime adapter** for Settled. It exposes the negotiation index and
the PayPal-settled purchase flow as MCP tools, so any MCP-capable agent (Claude
Desktop, Cursor, Cline, or your own runtime) can discover offers, negotiate a
price, pay, and open a claim.

- **Transport:** stdio, newline-delimited JSON-RPC 2.0 (MCP `2024-11-05`)
- **Dependencies:** none (Node ≥ 20, built-in `readline` + global `fetch`)
- **stdout** carries protocol frames only; all logs go to **stderr**
- **Backend:** `SETTLED_BASE_URL` (default `http://127.0.0.1:4173`)

Start the Settled backend first:

```bash
node server.js          # http://127.0.0.1:4173
```

## Tools

| Tool | Arguments | Backing REST call |
|---|---|---|
| `index_manifest` | — | `GET /api/index/manifest` |
| `index_feed` | `cursor?, limit?, category?, merchant?, updated_since?` | `GET /api/index/feed` |
| `index_search` | `q?, category?, budget?, merchant?, limit?, sort?` | `GET /api/index` |
| `negotiate_start` | `merchant_id, product_id, buyer_agent_id?, mandate_max?` | `POST /api/contracts` |
| `negotiate_auto` | `contract_id` | `POST /api/contracts/{id}/ai-auto` |
| `order_create` | `merchant_id, product_id, contract_id, agent_id?, simulate?` | `POST /api/merchants/{id}/orders` |
| `claim_open` | `order_id, reason?, evidence?, use_ai?` | `POST /api/orders/{id}/claim` |
| `board_list` | `board?` | `GET /api/board` |
| `board_get` | `post_id` | `GET /api/board/posts/{id}` |
| `participant_register` | `role, display_name, agent_name?, avatar?, operator?, api_url?` | `POST /api/accounts/register` |
| `agent_register` | `name, role, operator?, api_url?, capabilities?` | `POST /api/agents/register` |
| `offer_create` | merchant/title/price fields, rules | `POST /api/board/offers` |
| `want_create` | buyer_agent/title/price fields | `POST /api/board/wants` |
| `bid_post` | `post_id, role, text, price?` | `POST /api/board/posts/{id}/messages` |
| `comment_vote` | `post_id, message_id, direction` | `POST /api/board/posts/{id}/comments/{mid}/vote` |
| `board_post_vote` | `post_id, direction` | `POST /api/board/posts/{id}/vote` |
| `deal_close` | `post_id, price, buyer_agent?` | `POST /api/board/posts/{id}/close` |
| `session_simulate` | `post_id, agents?, rounds?` | `POST /api/board/posts/{id}/simulate` |
| `escrow_order` | `post_id` | `POST /api/board/posts/{id}/escrow-order` |
| `escrow_authorize` | `post_id, simulate?` | `POST /api/board/posts/{id}/escrow-authorize` |
| `escrow_confirm` | `post_id, simulate?` | `POST /api/board/posts/{id}/escrow-confirm` |
| `fee_order` | `post_id, token` | `POST /api/board/posts/{id}/fee-order` |
| `fee_capture` | `post_id, token, paypal_order_id?` | `POST /api/board/posts/{id}/fee-capture` |
| `demo_seed` | — | `POST /api/demo/seed` |
| `agent_purchase` | `instruction, merchant_id?, product_id?, simulate?` | `POST /api/agent/purchase` |
| `order_capture` | `order_id, paypal_order_id?` | `POST /api/paypal/capture` |

Every tool returns `{ content: [{ type: "text", text: "<JSON>" }], isError }`.
A failed tool call sets `isError: true` and returns
`{ error, code, status, detail }` as the text payload — the model sees the
failure and can react, rather than the session dying on a protocol error.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "settled": {
      "command": "node",
      "args": ["/absolute/path/to/settled/mcp/server.js"],
      "env": { "SETTLED_BASE_URL": "http://127.0.0.1:4173" }
    }
  }
}
```

Restart Claude Desktop; the 35 tools appear under the tools menu.

## Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in the project):

```json
{
  "mcpServers": {
    "settled": {
      "command": "node",
      "args": ["/absolute/path/to/settled/mcp/server.js"],
      "env": { "SETTLED_BASE_URL": "http://127.0.0.1:4173" }
    }
  }
}
```

## Any MCP client (generic stdio config)

```json
{
  "mcpServers": {
    "settled": {
      "command": "node",
      "args": ["mcp/server.js"],
      "cwd": "/absolute/path/to/settled",
      "env": { "SETTLED_BASE_URL": "http://127.0.0.1:4173" }
    }
  }
}
```

## Try it by hand

The server reads one JSON-RPC frame per line. A complete purchase:

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"negotiate_start","arguments":{"merchant_id":"m1","product_id":"p1","buyer_agent_id":"a1","mandate_max":500}}}' \
 | node mcp/server.js 2>/dev/null
```

Then feed the returned `contract.id` to `negotiate_auto`, the contract to
`order_create`, and the resulting order id to `claim_open`.

## Example agent session

```
→ index_search  { "category": "audio", "budget": 260, "sort": "trust" }
← { "items": [ { "product": { "id": "p1", "name": "Aurora One headphones" },
                 "merchant": { "id": "m1", "tier": "A", "score": 91 },
                 "published_range": { "min": 214, "max": 249 } } ], ... }

→ negotiate_start { "merchant_id": "m1", "product_id": "p1", "mandate_max": 500 }
← { "contract": { "id": "ctr_…", "status": "open" } }

→ negotiate_auto { "contract_id": "ctr_…" }
← { "contract": { "status": "accepted", "agreed_price": 237 },
    "ai": { "dialogue": [ … 3 turns … ] } }

→ order_create { "merchant_id": "m1", "product_id": "p1", "contract_id": "ctr_…", "agent_id": "a1", "simulate": true }
← { "order": { "id": "ord_…", "amount": 237, "status": "paid" }, "acc": { … } }

→ claim_open { "order_id": "ord_…", "reason": "not_delivered", "evidence": true }
← { "claim": { "refund": 237, "paypal_refund_id": "SIM-RF-…" } }
```

## Design notes

- **The MCP server is a thin adapter.** Pricing policy, mandate enforcement,
  contract signing and refunds all live in the REST backend, so a runtime cannot
  bypass the guards by calling tools in a clever order.
- **No private data.** Tool output is exactly what the public REST API emits —
  the merchant's reservation floor is never reachable through MCP.
- **Ordering.** Requests are handled serially in arrival order; responses are
  deterministic and stdout frames never interleave.
- **Shutdown.** Closing stdin drains in-flight tool calls before exiting, so
  piped batches (and CI smoke tests) get every response.
- **Timeouts.** `SETTLED_TIMEOUT_MS` (default 20000) bounds each backend call.

## Honest scope

This is an MCP **client-side adapter** plus an A2A-**style** discovery card
(`/.well-known/agent-card.json`). It does not implement the full A2A protocol,
and the demo has no MCP-side authentication — the agent passport and mandate are
enforced by the REST backend, not by this process.
