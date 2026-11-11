# Adapters, index feed & agent integration

*How inventory gets in, how indexers and personal AIs get offers out, and how a negotiated price reaches a checkout. Written against the frozen [ADAPTER-SPEC.md](ADAPTER-SPEC.md) and [INDEX-FEED-SPEC.md](INDEX-FEED-SPEC.md); this page is the map, those are the contracts.*

**One line:** any inventory source → one registry and one paginated feed → any agent/indexer → negotiated contract → PayPal settlement.

---

## 1. Architecture

```
   INVENTORY IN                     SETTLED                          AGENTS / INDEXERS IN
┌──────────────────┐        ┌────────────────────────┐        ┌───────────────────────────┐
│ merchant.html    │        │ lib/adapters.js        │        │ GET /api/index/manifest   │
│  CSV / JSON      │  POST  │  normalize + validate  │        │ GET /api/index/feed       │
│  Shopify payload ├───────►│  upsert by sku/id      │        │ GET /api/index  (search)  │
│  Woo payload     │ import │  derive negotiation    │        │ GET /api/agent-manifest   │
│  remote feed URL │        │        │               │        │ GET /api/index/openapi.json│
└──────────────────┘        │        ▼               │        └─────────────┬─────────────┘
                            │  per-product policy    │                      │
┌──────────────────┐        │  sell range (private)  │   published range    │
│ merchant console │        │  publish range (public)│──────────────────────►
│  ranges, terms,  ├───────►│  auto-accept, terms    │   feed items only
│  agent tone      │        └───────────┬────────────┘
└──────────────────┘                    │ negotiate (contract + mandate)
                                        ▼
                            ┌────────────────────────┐
                            │ /negotiate.html        │  hosted checkout adapter
                            │ POST /api/contracts    │  (SIM or live PayPal)
                            │ POST .../ai-auto       │
                            │ POST /api/merchants/:id/orders
                            │ POST /api/orders/:id/claim
                            └────────────────────────┘
```

Four surfaces, one data model:

1. **Inventory adapters** — get products into a merchant catalog from whatever the merchant already has.
2. **Indexer feed** — a stable, versioned, paginated emission of *public* offers for a central indexer to crawl.
3. **Runtime adapters** — an agent manifest (REST + OpenAPI), a local **MCP server** (`mcp/server.js`) and an A2A-style discovery card, so any personal-AI runtime can connect without custom code.
4. **Checkout adapters** — where the negotiated price is actually paid; today hosted + PayPal button, Shopify/Woo plugins on the roadmap.

**The index is a discovery layer, not a marketplace.** It never holds funds, never sees a private floor, and every negotiation still happens directly against the merchant's own contract endpoint with the buyer agent's passport and mandate.

---

## 2. Adapter table

Status reflects **this repo** (prototype, in-memory). "Payload" means the platform's object shape is accepted as JSON — no OAuth app, no webhook subscription.

| Adapter | Direction | Status | Input shape | Notes |
|---|---|---|---|---|
| `csv` | inventory in | **ready** | `{adapter:"csv", data:"sku,name,price,category,...\n..."}` | Header aliases accepted (`sku\|id`, `name\|title`, `category\|product_type`, `description\|body_html`, plus `sell_min`, `sell_max`, `publish_min`, `publish_max`, `auto_accept`, `max_discount_pct`, `negotiable`, `listed`). Quoted CSV and real newlines supported. |
| `json` | inventory in | **ready** | `{adapter:"json", data:{products:[…]}}` | Same fields as CSV; unknown fields ignored. |
| `shopify` | inventory in | **ready (payload)** | `{adapter:"shopify", data:{products:[{id,title,variants:[{price,sku}],product_type,body_html}]}}` | Maps to catalog products; **no OAuth / no Storefront app yet** — you paste or proxy the JSON. |
| `woocommerce` | inventory in | **ready (payload)** | `{adapter:"woocommerce", data:{products:[{id,name,price,sku,categories:[{name}],description}]}}` | Same caveat: payload, not a live plugin. |
| `feed` | inventory in (pull) | **ready** | `{adapter:"feed", url:"https://merchant.example/catalog.json"}` | 5 s timeout; JSON array or `{products}`; production needs an allowlist. Private range fields are applied only if the remote payload explicitly supplies them — production feeds should be treated as untrusted and stripped. |
| `rest` | agents in | **ready** | HTTP JSON | `GET` manifest/feed/search, `POST` contracts/orders/claim. OpenAPI 3.0.3 at `/api/index/openapi.json`. |
| `mcp` | agents in | **ready locally** | stdio MCP (JSON-RPC 2.0) | `mcp/server.js` exposes 30 tools across discovery, offers/wants, bids, closing, escrow, fee requests and network discovery. The REST API also serves remote MCP at `/mcp`. |
| `a2a` | agents in | **discovery only** | A2A-style card | `GET /.well-known/agent-card.json` and `GET /api/a2a/agent-card` advertise skills (negotiate/verify/claim); full A2A task lifecycle, streaming and push are **roadmap**. Offer items also carry the merchant agent name and `negotiate_url`. |
| `hosted` | checkout out | **ready** | Browser flow | `/negotiate.html?merchant=…&product=…` — contract → order → claim. SIM by default, live PayPal sandbox when configured. |
| `paypal-button` | checkout out | **ready** | PayPal JS SDK | Server creates the order at the agreed amount; the SDK button approves/captures. Live mode only. |
| `widget` | checkout out | **ready** | `<script>` tag | `public/settled-widget.js` — one-line install on any storefront; opens hosted `/negotiate.html` with `data-merchant`/`data-product`; no price logic and no payment code in the widget. |
| `shopify-plugin` | checkout out | **roadmap** | Cart / draft order | Per the platform research, Shopify checkout is platform-authoritative: a real connector needs a discount function + theme app extension (Plus for line reprice), not a naive price patch. |
| `woocommerce-plugin` | checkout out | **roadmap** | Cart filters | PHP plugin would own the cart total; not built in this repo. |

Registry: `GET /api/adapters` returns this list, versioned as `settled-adapters/1.0`.

```bash
curl -s http://127.0.0.1:4173/api/adapters | python3 -m json.tool
```

---

## 3. Endpoints

| Method | Path | What it returns |
|---|---|---|
| `GET` | `/api/adapters` | Adapter registry (inventory / agents / checkout, with status) |
| `POST` | `/api/merchants/:id/catalog/import` | Import/upsert products from one adapter |
| `POST` | `/api/merchants/:id/catalog/sync` | Alias with `{source:{adapter,…}}` |
| `GET` | `/api/merchants/:id/catalog` | Merchant view: products + full negotiation config |
| `GET` | `/api/index/manifest` | Discovery document: schema version, totals, categories, endpoint URLs |
| `GET` | `/api/index/feed` | Paginated public offers (`cursor`, `limit`, `category`, `merchant`, `updated_since`) |
| `GET` | `/api/index` | Human/hosted search (`q`, `category`, `budget`, `merchant`, `limit`) |
| `GET` | `/api/index/openapi.json` | OpenAPI 3.0.3 for manifest/feed/search/contracts/ai-auto/orders/claim |
| `GET` | `/api/agent-manifest` | Agent tool manifest (`settled-agent/1.0`) |
| `GET` | `/.well-known/settled-agent.json` | Same manifest at the conventional discovery path |

Private fields (`sell_min`, `sell_max`, `auto_accept`) are stripped from every public response. Only `published_range` is emitted.

### Inventory in — import examples

CSV (use a file for real newlines; this single-line form is valid JSON):

```bash
curl -s -X POST http://127.0.0.1:4173/api/merchants/m1/catalog/import \
  -H 'content-type: application/json' \
  -d '{"adapter":"csv","data":"sku,name,price,category\nAURORA-ONE,Aurora One,249,Audio\nHALO-LAMP,Halo lamp,189,Lighting"}'
```

JSON:

```bash
curl -s -X POST http://127.0.0.1:4173/api/merchants/m1/catalog/import \
  -H 'content-type: application/json' \
  -d '{"adapter":"json","data":{"products":[{"name":"Halo lamp","price":189,"category":"Lighting","description":"Warm dimmable floor lamp"}]}}'
```

Shopify payload (paste the Admin/Storefront shape you already have):

```bash
curl -s -X POST http://127.0.0.1:4173/api/merchants/m1/catalog/import \
  -H 'content-type: application/json' \
  -d '{"adapter":"shopify","data":{"products":[{"id":9001,"title":"Aurora One","variants":[{"price":"249.00","sku":"AURORA-ONE"}],"product_type":"Audio","body_html":"Reference-grade over-ear headphones"}]}}'
```

Remote feed (pull):

```bash
curl -s -X POST http://127.0.0.1:4173/api/merchants/m1/catalog/import \
  -H 'content-type: application/json' \
  -d '{"adapter":"feed","url":"https://merchant.example/catalog.json"}'
```

Response shape: `{adapter, imported, updated, skipped, products, catalog, errors}`. `skipped` counts rows without a usable name/price, `errors` carries per-row messages (capped at 50 per import), and `catalog` is the refreshed merchant view.

Import is an **upsert by `sku`** (or the platform `id`); a row with no key inserts a new product, so include a `sku` to make re-imports idempotent. Defaults derived from price are `sell_min = round(price×0.82)`, `auto_accept = round(price×0.95)`, `publish_min = round(sell_min×1.05)`, `publish_max = price`; explicit range fields in the payload override them.

Errors: unknown adapter → `400 INVALID_ADAPTER`; unreachable/invalid remote feed → `502 ADAPTER_FETCH_FAILED`; per-row failures never abort the import.

Not all adapters are wired to live systems: `shopify` / `woocommerce` accept **payloads** so you can import an export today; live OAuth connectors are roadmap.

### Index out — manifest, feed, OpenAPI

```bash
# 1. Discovery
curl -s http://127.0.0.1:4173/api/index/manifest | python3 -m json.tool

# 2. First page
curl -s 'http://127.0.0.1:4173/api/index/feed?limit=2' | python3 -m json.tool

# 3. Next page — pass page 1's opaque next_cursor back; never parse it
CURSOR=$(curl -s 'http://127.0.0.1:4173/api/index/feed?limit=2' | python3 -c "import json,sys; print(json.load(sys.stdin)['next_cursor'])")
curl -s "http://127.0.0.1:4173/api/index/feed?limit=2&cursor=$CURSOR" | python3 -m json.tool

# 4. Filters / delta crawl
curl -s 'http://127.0.0.1:4173/api/index/feed?category=audio&merchant=m1&updated_since=2026-11-05T00:00:00Z'

# 5. Machine-readable contract for the whole surface
curl -s http://127.0.0.1:4173/api/index/openapi.json | python3 -m json.tool
```

Feed item (the only offer shape agents should depend on):

```json
{
  "offer_id": "m1:p1",
  "merchant": { "id": "m1", "name": "Northwind Audio", "tier": "A", "score": 91, "agent": "Northwind Seller Agent" },
  "product": { "id": "p1", "name": "Aurora One headphones", "category": "Audio", "price": 249 },
  "published_range": { "min": 214, "max": 249 },
  "terms": { "delivery_days": 3, "returns_days": 30, "warranty_months": 12 },
  "protection": { "fee_bps": 35, "cap": 5000, "mode": "instant" },
  "negotiate_url": "/negotiate.html?merchant=m1&product=p1",
  "updated_at": "2026-11-05T…"
}
```

`offer_id` is stable (`merchantId:productId`), ordering is by `offer_id` (not price) so pagination cannot skip, `next_cursor` is `null` on the last page, and `schema_version` is `settled-index/1.0`. Pin the schema version; treat cursors as opaque.

### Agents in — agent manifest

```bash
curl -s http://127.0.0.1:4173/api/agent-manifest | python3 -m json.tool
curl -s http://127.0.0.1:4173/.well-known/settled-agent.json | python3 -m json.tool
```

The manifest lists `auth: "agent_passport+mandate"` and the tool surface: `index.manifest`, `index.feed`, `index.search`, `negotiate.start`, `negotiate.auto`, `order.create`, `claim.open`.

---

## 4. Sequence — how a central indexer plugs in

1. **Discover** — `GET /api/index/manifest`. Read `schema_version`, totals, categories, and the endpoint URLs; cache it (it changes rarely).
2. **Crawl pages** — `GET /api/index/feed?limit=100`, follow `next_cursor` until `null`. Store `offer_id` and `updated_at`; dedupe on `offer_id`.
3. **Delta refresh** — re-crawl with `updated_since=<last generated_at>` instead of a full pass.
4. **Normalize** — map category taxonomy, price bands, trust tier, protection and terms into your own search document. Never expect a floor.
5. **Serve** — expose `search(category, budget, trust, terms)` and `get(offer_id)`; re-emit your own feed if you like.
6. **Hand off** — send the user (or their agent) to `negotiate_url`, which runs the contract → order → claim flow against the merchant. Settlement stays PayPal; the indexer holds no funds and never sees a private range.

Failure handling: if the feed 5xx's, keep serving the last cache and retry with jitter. If an offer disappears from the feed (unlisted/paused), stop routing to it; the contract endpoint will refuse it anyway.

## 5. Sequence — how a personal AI plugs in

1. **Discover tools** — `GET /api/agent-manifest` (or `/.well-known/…`), or load `/api/index/openapi.json` into a function-calling model / MCP wrapper.
2. **Find an offer** — `GET /api/index?q=headphones&budget=250` or the paginated feed.
3. **Present authority** — the agent already holds a passport + signed mandate (`buyer_agent_id: "a1"`, `mandate.max`). This is what limits what it may spend.
4. **Negotiate** — `POST /api/contracts` with `{merchant_id, product_id, buyer_agent_id, mandate:{max}}`, then `POST /api/contracts/{id}/ai-auto` for the model/policy negotiation (or `/offers` + `/accept` for a custom policy). The response carries the transcript and signed hash.
5. **Pay** — `POST /api/merchants/{id}/orders` with the `contract_id`; in SIM or with PayPal sandbox credentials configured.
6. **Claim if it fails** — `POST /api/orders/{id}/claim` with `evidence:true`, optionally `use_ai:true` for an AI recommendation; the refund goes through the merchant reserve (Payments v2 refund id when live).

Unknown fields are ignored; unknown ids are `404`, contract/agent mismatches are `409`, and an unverified agent is `403 AGENT_NOT_VERIFIED` before any order exists.

---

## 6. Runtime adapters — MCP server, A2A card, drop-in widget

Three ways a personal-AI runtime or a storefront connects without custom integration work. All of them are thin: none holds price logic, private ranges or funds.

### MCP server (`mcp/server.js`)

Zero-dependency **stdio JSON-RPC 2.0**; proxies to the REST API at `SETTLED_BASE_URL` (default `http://127.0.0.1:4173`). stdout is protocol only; logs go to stderr.

```bash
node server.js &                                  # API up
node mcp/server.js                                # MCP over stdio
```

Claude Desktop / Cursor:

```json
{"mcpServers":{"settled":{"command":"node","args":["/abs/path/settled/mcp/server.js"],"env":{"SETTLED_BASE_URL":"http://127.0.0.1:4173"}}}}
```

Tools: `index_manifest`, `index_feed`, `index_search`, `negotiate_start`, `negotiate_auto`, `order_create`, `claim_open`. It is **local stdio with no remote auth** — a remote MCP deployment (HTTP/SSE + OAuth) is roadmap.

### A2A-style agent card

```bash
curl -s http://127.0.0.1:4173/.well-known/agent-card.json | python3 -m json.tool
curl -s http://127.0.0.1:4173/api/a2a/agent-card | python3 -m json.tool
```

Advertises `protocolVersion`, capabilities (no streaming/push), and the `negotiate` / `verify` / `claim` skills. **Honest label:** discovery card only — not full A2A protocol support.

### Drop-in widget (`public/settled-widget.js`)

```html
<script src="/settled-widget.js" data-merchant="m1" data-product="p1" data-label="Negotiate with AI"></script>
```

Options: `data-position="bottom-right|bottom-left"`, `data-theme="dark|light"`, `data-inline="true"`. It renders a button that opens `/negotiate.html?merchant=…&product=…` in a new tab — no private data, no payment code, no external assets. `/embed-demo.html` shows the one-line install on a faux storefront with a "what happened" panel.

---

## 7. Privacy

- **The private floor never leaves the server.** `publicProduct()` strips `sell_min`, `sell_max`, `auto_accept`; the index emits only `published_range` (the merchant's chosen public "from" price).
- **The feed is public on purpose** (demo sandbox); in production it is the merchant's *published* offer, not its reservation price. A discount can go below `publish_min` only if the merchant configured it — the buyer never learns the true floor.
- **Manifest / OpenAPI / agent manifest** contain no secrets — no API keys, no client ids, no reserve balances. `GET /api/config` is the only place secrets are even referenced, and it returns booleans/model names, never values.
- **Prototype gap:** the demo has no auth on the index or import endpoints. Production needs merchant auth on import, an allowlist for remote `feed` pulls, agent passport/mandate on contract creation, and signed index requests.
- **No bulk scraping contract yet** — the demo feed is open; the production posture is per-agent rate limits, ETag/If-None-Match, and no full-history dumps.

## 8. Production notes

- **Caching / ETag** — serve the manifest and feed with `ETag`; clients send `If-None-Match` and get `304` on no change. The demo build does not send ETags yet (roadmap). Cache manifest for ~60 s, feed pages for a few seconds.
- **Rate limits** — per-token/per-agent on `/api/index/feed` and `/api/contracts`; expensive paths (`ai-auto`) should be budgeted per agent, since each call is an LLM round-trip. No unbounded crawl.
- **Cursor semantics** — opaque, forward-only, stable ordering by `offer_id`. Do not build cursors yourself from field values.
- **Idempotency** — imports upsert by `sku`/`id`; repeated imports should not duplicate products. Contract create is not idempotent (each call makes a new contract); orders should pass a client idempotency key in production (roadmap).
- **Feed pulls** — 5 s timeout today; production adds retry with jitter, size cap, content-type check, SSRF allowlist, and signature verification for merchant feeds.
- **In-memory store** — this prototype resets on restart and runs single-process. Production: durable catalog + feed index, `updated_at` from a real write path, object storage for snapshots.
- **Versioning** — `settled-index/1.0`, `settled-adapters/1.0`, `settled-agent/1.0`; additive changes only within a minor version, breaking changes bump the major and keep the old endpoint for a deprecation window.

## 9. Try it in 60 seconds

```bash
cd bit-settled && node server.js          # http://127.0.0.1:4173

# indexer: discover → page → read one offer
curl -s http://127.0.0.1:4173/api/index/manifest | python3 -m json.tool
curl -s 'http://127.0.0.1:4173/api/index/feed?limit=2' | python3 -m json.tool

# agent: find → negotiate → (order → claim covered in /negotiate.html)
curl -s 'http://127.0.0.1:4173/api/index?q=aurora&budget=250' | python3 -m json.tool

# merchant: import inventory from a Shopify payload
curl -s -X POST http://127.0.0.1:4173/api/merchants/m1/catalog/import \
  -H 'content-type: application/json' \
  -d '{"adapter":"shopify","data":{"products":[{"id":9001,"title":"Aurora One","variants":[{"price":"249.00","sku":"AURORA-ONE"}],"product_type":"Audio"}]}}'

# agent surface + full contract for the API
curl -s http://127.0.0.1:4173/api/agent-manifest | python3 -m json.tool
curl -s http://127.0.0.1:4173/api/index/openapi.json | head -c 400
```

UI: `/merchant.html` (import panel), `/market.html` (For indexers panel), `/negotiate.html?merchant=m1&product=p1` (hosted checkout).

---

*Status honesty: inventory adapters, the index feed/manifest/OpenAPI, a local stdio MCP server, an A2A-style discovery card and the drop-in widget ship in this repo; live OAuth connectors (Shopify/Woo apps), cart-price plugins, remote MCP with auth, full A2A, and production auth/ETag/rate limits are roadmap. Nothing here moves money by default — checkout is SIM unless PayPal sandbox credentials are configured.*
