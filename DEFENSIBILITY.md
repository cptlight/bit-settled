# Defensibility & deployability

*Why Settled can actually ship: the checkout is hosted (no replatform), inventory goes in as payloads (no OAuth app needed), discovery is an open feed + agent manifests, and the money path stays PayPal. This page is the honest deployment/defensibility map; the frozen interface contracts are in [DEPLOYABILITY-SPEC.md](DEPLOYABILITY-SPEC.md), [ADAPTERS.md](ADAPTERS.md), [INDEX-FEED-SPEC.md](INDEX-FEED-SPEC.md) and [ADAPTER-SPEC.md](ADAPTER-SPEC.md).*

**One line:** a merchant can be live with negotiation in one script tag (or one hosted URL), a platform can integrate once and serve its whole merchant base, and an agent runtime can connect over REST, MCP or an A2A-style card — without anyone taking custody of funds.

---

## 1. What is deployable today (and what is not)

| Surface | What a deployer does | Status |
|---|---|---|
| **Hosted negotiated checkout** `/negotiate.html?merchant=…&product=…` | Nothing to install: send buyers/agents to the URL. Merchant policy is server-side. | **Ready** |
| **Index feed** `/api/index/manifest` → `/api/index/feed` → `/api/index/openapi.json` | Crawl it, or point an agent runtime at it. | **Ready** |
| **Agent manifests** `/api/agent-manifest`, `/.well-known/settled-agent.json` | Load tools into a function-calling model / wrapper. | **Ready** |
| **Inventory adapters** CSV / JSON / Shopify payload / WooCommerce payload / remote feed | Paste, upload or URL an export; upsert by SKU. | **Ready (payload adapters)** |
| **Personal-AI runtime adapter (MCP)** `mcp/server.js` | Add a stdio MCP server to Claude Desktop / Cursor / any MCP client. | **Shipping in this build** |
| **A2A-style agent card** `/.well-known/agent-card.json`, `/api/a2a/agent-card` | Discovery only; honest label below. | **Shipping in this build** |
| **Drop-in widget** `public/settled-widget.js` + `/embed-demo.html` | One `<script>` tag on any storefront. | **Shipping in this build** |
| **Live Shopify / WooCommerce connectors** (OAuth apps, webhooks) | Install an app, sync inventory live. | **Roadmap** |
| **Cart-price plugins** (platform-authoritative price) | Modify cart/checkout totals natively. | **Roadmap** |
| **Production billing / fee collection** | Platform fee or invoiced SaaS. | **Roadmap** (demo bills nothing) |
| **Durable state, auth, ETag, rate limits** | Run it as a multi-tenant service. | **Roadmap** |

"Shipping in this build" means the code and endpoints are in this repo and exercised by the e2e suite; "Roadmap" means not built here, and this page does not claim otherwise.

## 2. Three deployment paths

| Path | Buyer experience | Merchant / platform work | PayPal's role | Status |
|---|---|---|---|---|
| **A. PayPal-native app / partner** | Merchant enables Settled; buyers see negotiation at checkout. | PayPal-side onboarding + partner agreement; settle via Orders v2 / Payments v2. | Distribution + settlement + protection brand; fee collection via an approved platform fee or invoiced SaaS. | **Integration works on sandbox; partner/commercial terms are roadmap.** |
| **B. Platform / PSP integration** | Platform's merchants get negotiation + trust without building it. | Integrate the REST API + feed once; surface offers in their catalog. | Platform keeps the merchant relationship; PayPal settles; Settled supplies the trust/negotiation layer. | **API + feed ready; multi-tenant auth/tenancy roadmap.** |
| **C. Direct merchant (self-serve)** | Widget or hosted link; no replatform. | `node server.js`, set policy, paste the script tag. | Merchant brings its own PayPal; Settlement still Orders v2. | **Ready on Render/Docker/local (see [DEPLOY.md](DEPLOY.md)).** |

### Path C, concretely

```bash
# local / Docker / Render — all the same zero-dependency Node process
cd bit-settled && node server.js                          # http://127.0.0.1:4173
docker build -t settled-demo . && docker run --rm -p 8080:8080 settled-demo
# Render: connect the repo, render.yaml creates settled-demo (SIM: PAYPAL_LIVE=0, AI_PROVIDER=none)
```

Public demo runs **SIM** (no keys, no money). The recorded video uses the **PayPal sandbox** rail. Live keys are added only as environment variables on a private service — never in `render.yaml` or the repo.

## 3. Personal-AI runtime — MCP server

`mcp/server.js` is a zero-dependency **stdio JSON-RPC 2.0** server that proxies to the REST API at `SETTLED_BASE_URL` (default `http://127.0.0.1:4173`). Protocol output goes to stdout only; logs go to stderr.

Claude Desktop / Cursor config:

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

Seven tools: `index_manifest`, `index_feed`, `index_search`, `negotiate_start`, `negotiate_auto`, `order_create`, `claim_open`. Run it directly to smoke-test:

```bash
node mcp/server.js     # then speak JSON-RPC on stdin: initialize → tools/list → tools/call
```

This is a **local stdio** adapter: it trusts `SETTLED_BASE_URL` and has no remote auth (see §7). A remote MCP deployment (HTTP/SSE with OAuth) is roadmap.

## 4. A2A-style agent card

```bash
curl -s http://127.0.0.1:4173/.well-known/agent-card.json | python3 -m json.tool
curl -s http://127.0.0.1:4173/api/a2a/agent-card | python3 -m json.tool
```

The card advertises `protocolVersion`, capabilities (no streaming, no push), three skills — **negotiate**, **verify**, **claim** — and JSON input/output modes.

**Honest label:** this is an **A2A-style discovery card**, not a claim of full A2A protocol support. Task lifecycle, streaming and push notifications are not implemented.

## 5. Drop-in widget (any storefront)

```html
<script src="/settled-widget.js"
        data-merchant="m1"
        data-product="p1"
        data-label="Negotiate with AI"></script>
```

Options: `data-position="bottom-right|bottom-left"`, `data-theme="dark|light"`, `data-inline="true"` (inline button instead of floating). The widget renders a button that opens the hosted `/negotiate.html?merchant=…&product=…` flow in a new tab — it holds no price logic, no private data and no payment code. `/embed-demo.html` is a minimal storefront page with a PayPal-style button + the widget + a "what happened" panel, so a judge can see the install in context.

## 6. Indexer sequence (short form)

1. `GET /api/index/manifest` — schema version, totals, categories, endpoint URLs.
2. `GET /api/index/feed?limit=100` — follow `next_cursor` to `null`; dedupe on `offer_id`; refresh with `updated_since`.
3. Normalize and rank (see `GET /api/index?sort=trust|price|value` for the reference ranking; `value` uses only `published_min`, never a private floor).
4. Route the user/agent to the item's `negotiate_url`.
5. Settlement remains PayPal; the indexer never sees a private range and never holds funds.

Full detail and curl: [ADAPTERS.md](ADAPTERS.md) §4–5.

## 7. Security & limits (what is true today)

- **No custody.** PayPal settles; the merchant's **reserve** funds claims. The demo reserve/pool is **demo capital**, not a balance sheet — production needs an insurer/LC-backed reserve with per-merchant caps.
- **Authority is explicit.** A buyer agent presents a passport + signed mandate; the contract policy fixes the allowed prices server-side, so the model can argue but cannot exceed the mandate. `403 AGENT_NOT_VERIFIED` fires before an order exists.
- **Privacy is structural.** `publicProduct()` strips `sell_min`/`sell_max`/`auto_accept`; the feed, manifest, OpenAPI and agent card emit only `published_range`. `GET /api/config` returns booleans/model names — never secrets. `.env` is gitignored and not tracked.
- **Failure is clean.** Provider failures return `502` before state mutation; contract/agent/order mismatches return `409`; a second claim on the same order is `409`; imports upsert by SKU so retries don't duplicate.
- **Demo gaps (say them):** no auth on the index/import/negotiate endpoints, in-memory single-process store that resets on restart, no ETag/caching, no per-agent rate limits, no allowlist on remote `feed` pulls, MCP is local-stdio with no auth. All of these are production work, not hidden behaviour.

## 8. Honest roadmap

| Item | Why it matters | What exists today | Next step |
|---|---|---|---|
| **Live Shopify / WooCommerce connectors** | Plug-and-play inventory without exports | Payload adapters accept the platform object shape | OAuth app + webhooks + token storage; map variants/collections |
| **Cart-price plugins** | Platform-authoritative price, not a hosted hop | Hosted checkout + widget | Shopify: discount function + theme app extension (Plus for line reprice); Woo: cart hooks plugin |
| **MCP auth (remote)** | Any agent runtime, not just local stdio | Local stdio MCP server | HTTP/SSE MCP + OAuth/mTLS + per-agent limits |
| **A2A protocol support** | Standard agent-to-agent task flow | A2A-style discovery card only | Task lifecycle, streaming, push |
| **Durable timestamps & feed** | `updated_since` must survive restarts | In-memory `updated_at` | Durable catalog + append-only change log |
| **Insurer / LC-backed reserve** | Instant claims at volume | Demo reserve + $25k pool | Insurer/LC partner, caps, backtested loss curve |
| **Auth, ETag, rate limits** | Multi-tenant, safe at scale | Open demo sandbox | Merchant auth on import, per-agent limits, ETag/If-None-Match, signed feed requests |
| **Fee collection** | Merchant pays bps on protected GMV | No billing in demo | Approved PayPal platform fee or invoiced SaaS |

## 9. One-page value

| Who | What they get | What it costs / risks |
|---|---|---|
| **Buyer** | A negotiation link instead of a fixed price; the agent cannot exceed the stated mandate; signed terms; an instant refund path. | Nothing to install, no fee to the buyer (protection is merchant-paid); needs an agent/passport for the full flow. |
| **Merchant** | Converts price-sensitive carts; keeps a private floor; bounded loss via a per-order cap; adds negotiation with a script tag or hosted URL instead of a replatform; owns the customer relationship. | Pays protection bps only on protected GMV (proposal: 35–150 bps by tier); must set ranges/terms; reserve or insurer capital behind claims. |
| **PayPal** | A priced protection/assurance SKU on branded checkout volume, a reason for agents to settle on its rails, and the outcome data that makes risk pricing better. | None yet: the demo moves no money and has no partner agreement; this is a proposed integration, not a shipped PayPal product. |

The strategic case (novelty audit, `$1.34B` protection cost centre, revenue scenarios) is in **[WRITEUP.md](WRITEUP.md)** and **[JUDGE-BRIEF.md](JUDGE-BRIEF.md)**; treat those numbers as stated-assumption models, not forecasts.

## 10. What we do not claim

- Not a live PayPal product or a signed partner; the integration is exercised on the **sandbox**.
- Not production-secure: no auth, no durable store, no rate limiting (see §7).
- Not an insurer: the reserve is demo capital; an insurer/LC partner is required for the instant-claim promise at volume.
- Not full A2A/MCP-remote support: an A2A-style card and a local stdio MCP server only.
- Not a live Shopify/Woo app: payload adapters today.
- Pre-revenue; the 90-day pilot plan and kill criteria are kept in the private strategy package.
