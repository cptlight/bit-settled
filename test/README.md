# Settled — end-to-end API test

`test/e2e.js` is a **zero-dependency** Node script that boots the real server, drives the real HTTP API, and prints `PASS`/`FAIL` per test. It is the executable form of `BUILD-SPEC.md` §8 plus the fault, tamper, shortfall and static-page checks.

## Run

```bash
cd bit-settled
npm test                 # = node test/e2e.js
node test/e2e.js         # same
```

Requires **Node ≥ 20** (global `fetch`, `AbortSignal.timeout`). No `npm install` — there are no dependencies.

Exit code is `0` only if every test passes, `1` otherwise, so it drops straight into CI or a pre-demo check.

To triage one section, filter by test-id prefix — the default run is always the full suite:

```bash
ONLY_TESTS=T4,T5 node test/e2e.js     # v2 only (agents, contracts, protection, demo)
ONLY_TESTS=T22 node test/e2e.js       # one test
```

Skipped tests print `SKIP` and are reported separately in the `RESULT` line.

## What it does

1. Probes `http://127.0.0.1:4173/api/health`. If something answers, it **reuses** that server and leaves it running.
2. Otherwise spawns `node server.js` from `settled/`, waits up to 20 s for `/api/health`, and **kills it on exit**.
3. `POST /api/reset` first, so results never depend on prior state.
4. Runs the suite sequentially (the API is stateful), then resets again at the end so the app is left on seed data for a demo.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `4173` | Port for the server it spawns |
| `BASE_URL` | `http://127.0.0.1:<PORT>` | Test an already-running server instead of spawning |
| `E2E_ALLOW_LIVE` | unset | Set to `1` to keep `AI_API_KEY` / `PAYPAL_LIVE` / PayPal credentials in the spawned server's environment. By default the suite **strips them**, so it always runs on the deterministic SIM + AI-fallback path (otherwise `PAYPAL_LIVE=1` would make orders `pending` and break both v1 and v3 assertions). |

```bash
# against a server you are already running on another port
BASE_URL=http://127.0.0.1:4400 node test/e2e.js

# spawn on a different port
PORT=4400 node test/e2e.js
```

If `server.js` is missing the suite exits `1` with `server.js not found … backend not built yet` — that is expected before the backend lands.

## What is asserted

| Test | Covers |
|---|---|
| T00 | §9 `node --check` parses `server.js` and every `lib/*.js` |
| T01 | `/api/health` → `ok`, `sim`\|`paypal`, 3 merchants |
| T02 | §8.1 merchant list = 3; m1/m2/m3 seed tier, score, fee_bps, cap, reserve, mode, products |
| T03 | §8.2 merchant detail: ledger `{credential, signature, alg:"HS256"}` + events; credential fields, 24 h expiry, 16-hex nonce, sha256 evidence hash |
| T04 | §8.2 `/verify` → `valid:true` and all three `checks` |
| T05 | §8.2 **tampered credential rejected** (score + nested metric mutated) |
| T06–T10 | §9 static pages: `/`, `/store.html`, `/agent.html` → 200 and contain `Settled`; `app.js` references the API (`/api...`); unknown static → 404 |
| T11–T18 | fault shapes: unknown API path, unknown merchant, unknown product, missing body, malformed JSON, unknown order → **404/400/409 with `{error:{code,message}}`** |
| T19–T23 | §8.3–8.5 m1 order: amount 249, fee 0.87 @ 35 bps, instant/5000; fulfill → delivered; double fulfill → 409; claim → refund 249, reserve 12500→12251, `refunded`; double claim → 409 |
| T24 | tier/score/fee/cap/mode recompute is internally consistent after a claim |
| T25–T26 | claim validation: bad reason → 400; `evidence !== true` → 400 and order untouched |
| T27 | §8.6 m3 → escrow / cap 1000; `evidence:false` → 400; valid claim pays 159 |
| T28–T31 | §8.7 `trust/verify`: m1 + min B → true; m3 + min B → false with a reason; default min tier C; unknown merchant → 400/404 |
| T32–T33 | `GET /api/orders` newest-first; `GET /api/events` seq-desc with sha256 hashes |
| T34 | §8.8 reset restores every seed value and empties orders |
| T35 | claim drains the merchant reserve, then the shortfall is paid from the network pool (reserve 900, 6 × 159 claims → 105 + 54) |
| T36 | final cleanup reset (leaves seed state) |

85 tests (37 base + 20 v2 + 6 v3 + 6 v4 + 5 v5 + 4 v6 + 4 v7 + 3 v8), ~12–19 s against a warm server. Last verified green: **85/85, exit 0** on a freshly spawned server (`PORT=4400 node test/e2e.js`) — the server is killed on exit and leaves no listener.

## v2 coverage — HACKATHON-DEMO-SPEC (agents, contracts, protection, demo)

| Test | Covers |
|---|---|
| T40 | `GET /api/agents` → 3 agents with operator/kyb/capabilities/limits/reputation; a1 valid (ProcureBot, max $500, score 92), a3 invalid |
| T41 | `POST /api/agents/verify` a1 → `verified:true` and all six checks (passport, mandate, limits, merchant, category, kyb) true, `reasons:[]`, passport envelope `HS256` |
| T42 | `POST /api/agents/verify` a3 → `verified:false`, non-empty reasons citing kyb/mandate/violations, `checks.kyb:false` |
| T43 | `GET /api/agents/:id/passport` → credential fields (incl. `sig`), envelope `signature`, `HS256`; tamper probe (tampered score/limits + original signature) must not verify **when the endpoint accepts a caller-supplied credential** |
| T44 | `POST /api/contracts` → `ctr_<hex>`, `open`, `list_price 249`, `policy.floor≈204`, `policy.auto_accept≈237`, `max_discount_pct 18`, mandate/terms present, empty transcript |
| T45 | `POST /api/contracts/:id/auto` → `accepted`, `agreed_price` ≈ 95% of list and within [floor, list], 64-hex `hash`, ≥2 signatures referencing a1+m1, transcript ≥2, rounds advanced |
| T46 | offers: price `0` / negative → 400; invalid `from` → 400 (error envelope each time) |
| T47 | buyer offer above `mandate.max` → 400/409 error envelope |
| T48 | rounds exceed `max_rounds` → contract `expired`, `rounds > max_rounds`, later offers → 400/409 |
| T49 | `POST /api/protection/quote` m1 $249 → `fee_bps 35`, `fee 0.87`, `cap 5000`, `mode instant`, non-empty `coverage` |
| T50 | order with `contract_id`+a1 → amount = `agreed_price`, `acc{contract_id,hash(64hex),transcript_hash,terms,buyer_agent_id}`, status paid |
| T51 | order with a3 → **403 `AGENT_NOT_VERIFIED`** |
| T52 | regression: order without contract/agent → $249, paid, no `acc` required |
| T53 | claim on the negotiated order → refund = agreed price, `paypal_refund_id` `SIM-RF-<hex>`, `sla_ms 1200`, `actor buyer`, reserve decreases by the refund, order refunded |
| T54 | second claim on the same order → 409 |
| T55 | `GET /api/claims?merchant=m1` → `{claims:[...]}` newest-first and contains the claim |
| T56 | `/demo.html` → 200, contains `Settled`, `Run full demo`, `all five`; `/demo.js` → 200 and calls `/api` |
| T57 | full demo flow steps 1–5 via API → signed credential, a1 verified, contract accepted, order at agreed price with ACC hash, claim refunded; final contract state `accepted` |
| T58 | reset clears contracts + claims, keeps the 3 agents, unknown contract → 404 |
| T59 | cleanup: final reset leaves seed state |

## v3 coverage — AI-PAYPAL-BUILD-SPEC (AI negotiation, AI claims, PayPal SIM rails)

| Test | Covers |
|---|---|
| T60 | `GET /api/config` → `mode` sim\|live, `currency:USD`, `paypal{env,client_id,configured}` (configured ⇔ client_id present), `ai{enabled,provider,model}`; a spawned server (no key) reports `ai.enabled:false` |
| T61 | create contract + `POST /contracts/:id/ai-auto` → `accepted`, `ai.used:false` on the no-key fallback, 1–2 buyer moves each `offer`/`accept` with a price inside [floor, list], `agreed_price` in range, 64-hex `hash`, `contract.ai` attached; second call is idempotent |
| T62 | `POST /orders/:id/claim {use_ai:true}` → `ai.recommendation ∈ approve\|review\|deny`, `confidence 0..1`, non-empty `rationale`, boolean `used`; refund still paid, reserve drops by the refund, order `refunded`, second claim 409 |
| T63 | PayPal SIM lifecycle: `/api/paypal/create-order` → `SIM-…`; `/capture` → `COMPLETED` + order `paid` + `capture_id`; `/refund` → `SIM-RF-…`; **merchant reserve untouched** by PayPal routes |
| T64 | order with `simulate:true` → `paid` immediately, `simulated:true`, `SIM-…` payment id; a plain SIM-mode order stays `simulated:false` |
| T65 | regression/markers: `/demo.html` + `/demo.js` 200 and carry `AI agents`, `PayPal`, the AI badge; `demo.js` calls `/api/config` and `ai-auto`; final reset restores seed |

## v4 coverage — MERCHANT-BUILD-SPEC (catalog, negotiation index, merchant pages)

| Test | Covers |
|---|---|
| T66 | `GET /api/categories` → `{categories:[{id,name,count,min,max}], total}`; every index item's category appears; `sum(count) === indexed item count`; `total` = category count or item count |
| T67 | `GET /api/index` → items with `merchant/product/published_range/terms/protection/negotiate_url`; `negotiate_url` points at `/negotiate.html?...&product=…`; `total === items.length`; **no `sell_min` / `sell_max` / `auto_accept` keys anywhere** in `/api/index`, `/api/categories`, `/api/merchants`, `/api/merchants/m1` |
| T68 | filters: `category` (all results match), `q=aurora` (name/merchant substring), `budget=150` (published min ≤ budget), `merchant=m1`; `filters` echoed |
| T69 | `PATCH /api/merchants/m1/catalog/p1` → `publish_min:220` persists, **index reflects** it; `publish_min < sell_min` and `auto_accept > sell_max` → 400; contract policy picks up patched `sell_min/auto_accept` (200/230); p1 restored to 204/237 |
| T70 | p1 contract `list 249 / floor 204 / auto_accept 237`; `PATCH p2 {negotiable:false}` → p2 vanishes from `/api/index`; contract on p2 → **409 `PRODUCT_NOT_NEGOTIABLE`**; restore → p2 negotiable again |
| T71 | `/merchant.html` ("Merchant agent setup" + catalog), `/market.html` ("The negotiation index"), `/negotiate.html` (negotiation + agent + pay) → 200 with markers; final reset restores 5 index items and p1 204/237 |

## v5 coverage — INDEX-FEED-SPEC / ADAPTER-SPEC (feed, manifests, adapters, import)

| Test | Covers |
|---|---|
| T72 | `GET /api/adapters` → `settled-adapters/1.0`; inventory (csv/json/shopify/woocommerce/feed, all `ready`), agents (rest `ready`, mcp/a2a `roadmap`), checkout (hosted + paypal-button `ready`, shopify-plugin + woocommerce-plugin `roadmap`); every entry `{id,name,mode,status}` |
| T73 | `GET /api/index/manifest` (`settled-index/1.0`, ISO `generated_at`, `totals` matching `/api/index`, categories, endpoint URLs) + `GET /api/index/feed?limit=2` pagination: follows cursors to `next_cursor:null`, union equals the seed offers exactly once (no dupes/skips), every item has `offer_id` (= `merchant:product`), `published_range`, `updated_at`, `negotiate_url`; category/merchant filters; **no `sell_min`/`sell_max`/`auto_accept` in manifest, any feed page, or OpenAPI** |
| T74 | `GET /api/agent-manifest` (`settled-agent/1.0`, endpoints, 7 tools incl. `index.manifest`/`negotiate.start`/`claim.open`), same document at `/.well-known/settled-agent.json` (served as JSON), and `GET /api/index/openapi.json` (3.0.x, info, the 7 documented paths incl. `/api/contracts/{id}/ai-auto` and `/api/orders/{id}/claim`) |
| T75 | imports: CSV (incl. a quoted name with a comma), JSON, Shopify payload (`variants[].price`, `product_type`, `body_html`), WooCommerce payload (`categories[].name`); imported products appear in the merchant catalog **and** `/api/index`; upsert by `sku` updates price without duplicating; unknown adapter → 400; no-data import → 400 or a 200 that imports nothing; **reset wipes imported inventory** back to the 2+5 seed |
| T76 | `/market.html` has the "For indexers" panel + manifest/feed references; `/merchant.html` has "Import catalog" + CSV/Shopify/Woo options; final reset restores 5 index items |

## v6 coverage — DEPLOYABILITY-SPEC (MCP, A2A card, ranking, widget)

| Test | Covers |
|---|---|
| T77 | **MCP stdio**: spawns `node mcp/server.js` with `SETTLED_BASE_URL` pointed at the test server; `initialize` → `protocolVersion 2024-11-05`, `capabilities.tools`, `serverInfo.name "settled"`; `notifications/initialized` gets no reply; `tools/list` → **35 tools** including `index_manifest`, `negotiate_start`, `board_list`, `offer_create`, `bid_post`, `escrow_confirm`, `network_nodes`, `network_boards`, `demo_seed` each with `inputSchema`; `tools/call index_manifest` → `content[0].text` parses to a `settled-index/1.0` manifest, `isError:false`; unknown tool → `isError:true`; MCP stdout contains JSON-RPC lines only; child killed in `finally` |
| T78 | A2A-style card at **both** `/.well-known/agent-card.json` and `/api/a2a/agent-card`: `protocolVersion 0.2.0`, name `Settled`, description, capabilities, default input/output modes `application/json`, ≥3 skills (`negotiate`/`verify`/`claim`) with tags; both paths serve byte-identical JSON; no private ranges |
| T79 | `/api/index?sort=trust\|price\|value`: `ranking{sort,basis}` metadata; trust ordering is exactly `m1,m1,m2,m2,m3` (merchant score desc, price tie-break); price ascending; value ordered by `(price − published_min)/price` desc using **published** values only; no private ranges in any sort response; `/api/index/feed` ordering unchanged across sort queries |
| T80 | `/embed-demo.html` → 200 with the `settled-widget.js` install snippet, `data-merchant`/`data-product`, a PayPal surface and a "what (just) happened" explainer panel (the current copy reads *What just happened?*); `/settled-widget.js` → 200 JS that reads both data attributes, builds `/negotiate.html?merchant=…&product=…`, names no private-range keys and loads no external js/css |

## v7 coverage — INVENTORY-AUTOMATION-SPEC (connector, category rules, windows)

| Test | Covers |
|---|---|
| T81 | **connector pull.** `GET /api/merchants/m2/connector` → `{connector, due_at, categories}` with `adapter/url/interval_seconds/enabled/last_sync_at/last_status/last_error/last_counts`; unknown merchant → 404. `PUT` rejects a non-http(s) URL, interval `<60` / `>86400` and an unknown adapter (400 error envelope). Valid `feed` config persists. **Spawns a tiny local HTTP JSON-feed server inside the test**: `POST /catalog/sync` imports 2 products (visible in the merchant catalog and `/api/index`), sets `last_status:"ok"`, ISO `last_sync_at` and `last_counts.imported`; a second mutable response updates 1 by `sku` (price+name) and imports 1 more with no duplicate. A 500 feed is recorded as `last_status:"error"` + `last_error` while `/api/health` stays 200. |
| T82 | **category rules.** `GET /rules` → `{rules, categories}` with the seed `Audio` rule. `PUT /rules/:category` rejects 6 invalid shapes (sell_min ≥ auto_accept, sell_min < 0.5, auto_accept > 1, publish_min < sell_min, max_discount > 50, non-ISO window) with 400 envelopes. Valid `Audio` rule saves/echoes (`{rule, rules}`) and persists. `POST /rules/apply` re-derives p1/p2 `sell_min/auto_accept/publish_min` from price × 80/90/85 % (listed/negotiable preserved). A **new product and a JSON import in `Audio` inherit the rule**, not the global fallback. |
| T83 | **negotiation windows.** Open p1 present in `/api/index` + `/api/index/feed`; PATCH `{window:{to:past}}` closes it → gone from both, `POST /api/contracts` → **409 `NEGOTIATION_WINDOW_CLOSED`**; PATCH `{to:future}` reopens → indexed, feed `negotiation_window.to` matches, contract opens. A future `from` is not yet open. **Product window overrides the category rule**: with the Audio category window closed, a product-level open window keeps p1 listed/negotiable while p2 stays excluded; clearing the product window (`window:null`) falls back to the closed category window. |
| T84 | **UI + privacy.** `/merchant.html` + `/merchant.js`: "Inventory source", "Category rules", "Pull now", connector/rules/sync wiring, "Apply to existing", window from/to + product window-override field, Shopify/Woo roadmap. `/market.html` + `/market.js`: consumes `negotiation_window` and renders "Open until"/"Opens" labels; both UI scripts pass `node --check`. No `sell_min`/`sell_max`/`auto_accept` in market assets or `/api/index`, `/api/index/feed`, `/api/index/manifest`, `/api/categories`; every feed item exposes a public `negotiation_window`. |

## v8 coverage — AGENT-SETUP-SPEC (agent autoconfigure + agent-drafted catalog)

| Test | Covers |
|---|---|
| T85 | **autoconfigure.** Gives `Audio` a non-default (80/90/85/20) policy and adds a product in a new `Accessories` category that has **no rule**. `POST /agent/autoconfigure` → `{merchant_id, categories, updated, skipped, rules, products, ai}`: `categories` includes `Audio` + `Accessories`, a default 82/95/86/18 always-open rule is created for `Accessories`, the existing `Audio` policy is preserved, the new rule is applied to the item, `ai.used:false` (no network), `skipped:0`. A second call is **idempotent** — same `updated`/`skipped`, identical `rules`, identical product ranges. |
| T86 | **agent catalog.** No AI key (the suite strips it) → deterministic fallback `POST /agent/catalog` creates exactly **3** products with `ai.used:false`, adds them to the merchant catalog and to `/api/index`; every created product inherits its category rule (sell/publish/auto percentages + max discount). Empty, whitespace-only and missing `brief` → **400** `{error:{code,message}}`; `count:2` is honoured; `count:99` is either clamped to ≤8 or rejected 400 (never >8); no private range appears in `/api/index`. |
| T87 | **agent-setup UI.** `/merchant.html` + `/merchant.js` carry: "Agent setup", "Auto-configure", "Add with agent", "Describe what you sell", `/agent/autoconfigure` + `/agent/catalog` wiring, the agent-reads-catalog/applies-category-rules note, and the "Northwind Seller Agent … policy configured" status line; the manual **"Add product"** section is **gone** while Inventory source / Category rules / Import catalog / Agent settings remain; `node --check` passes. The demo-console **Merchant agent setup** strip is reported when present and its marker consistency is asserted; it is not failed when absent (no demo-console owner in this batch). |

## Reading a failure

```
FAIL  T22  §8.5 claim → refund 249, reserve 12500→12251, order refunded  — claim.refund: expected 249 (±0.005), got 0
      evidence: {"claim_series":[{"refund":0,"from_reserve":0,...}]}
```

Every failure prints the assertion that broke and either the exact response body (truncated to 1.2 KB) or the last HTTP response with status and content type. Nothing is swallowed. Transport errors say so explicitly (`network/transport error — is the server up?`).

## Known contract ambiguities the suite resolves conservatively

- **Verify-with-body was not in §5.** "Tampered credential fails" is untestable through a no-body verify endpoint, so T05 supplies `{credential, signature}` to `POST /api/merchants/:id/verify` (and falls back to `/api/trust/verify`). The backend supports this — `valid:false, checks.signature:false` — so the test is green. Keep that optional-body support; it is an extension, not a break (§1 permits additions).
- **Money types.** Amounts/percentages may be JSON numbers or `"249.00"` strings; the suite normalises both, so it never fails on formatting.
- **`fulfill` status string.** §8.4 says "delivered"; T20 accepts `delivered` or `fulfilled`.
- **`payment.mode` vs `protection.mode`.** `protection.mode` is asserted (`instant`/`reserve`/`escrow`); `payment.mode` is only checked for presence.
- **Unknown merchant / unknown product codes.** §5 documents the 400/404/409 classes but not which applies where; the suite accepts 400 or 404 for those lookups (the backend currently returns 404 `PRODUCT_NOT_FOUND` / `MERCHANT_NOT_FOUND`).
- **Order creation status code.** `POST /api/merchants/:id/orders` returns **201**; the suite accepts 200 or 201.
- **`evidence` vs `reason` check order.** Both are 400s; T25 supplies a valid reason with a bad reason-only case and T26 a valid reason with `evidence:false`, so either check order passes.
- **`network_pool` has no read endpoint**, so T35 asserts the shortfall per claim (`paid_from_pool`) and the accounting identity rather than a pool balance.
- **Fee rounding.** `159 × 150/10000 = 2.385`; `Math.round` → 2.39 but `toFixed(2)` → 2.38. T27 accepts both.

### v2 (HACKATHON-DEMO-SPEC) ambiguities the suite resolves conservatively

- **Passport `sig`.** §1 lists `sig` inside the passport credential while §2 returns `{credential, signature, alg}`. T43 requires **both**: the envelope signature *and* `credential.sig` (a portable credential must carry its own signature).
- **Tamper verification.** T43 posts a mutated credential plus the original signature to `POST /api/agents/verify`. The backend accepts a caller-supplied `{credential, signature}` and returns `verified:false`; if a build ignores the body, the test still passes but reports `tamper NOT exercised` in the detail — do not lose that behaviour, it is the demo's assurance claim.
- **`/auto` price is under-specified.** §2's scripted path is written as `~$237.00?` in the demo narrative; the implementation returns `round(249 × 0.95) = 237`. T45 asserts `agreed_price` is inside `[floor, list]` and within ±$2.5 of 95%.
- **Offer above mandate** returns 400 `MANDATE_EXCEEDED`; the task allowed 400 or 409.
- **Round expiry** lands on the 5th offer (`rounds 5 > max_rounds 4`), per §2's "> max_rounds"; later offers return 409 `CONTRACT_NOT_OPEN`.
- **Order status code** for contract/agent orders is 200 (not 201); accepted. A **claim refund equals the agreed price**, not the list price.
- **`/demo.js` is a separate file** that `demo.html` loads with `<script src="demo.js">`; T56 requires it to exist and call `/api`.

### v3 (AI-PAYPAL-BUILD-SPEC) ambiguities the suite resolves conservatively

- **`ai` placement.** §3 says the claim response carries `ai` "(`claim.ai` too)"; T62 accepts either `response.ai` or `response.claim.ai`.
- **Capture status.** §4 returns `{mode, capture, order}` but the task says "capture returns status COMPLETED"; T63 accepts `capture.status` or a top-level `status`, case-insensitively.
- **Refund amount/status.** `/api/paypal/refund` amount is asserted only when present (a full refund should equal the order amount); status is asserted only if returned.
- **`ai.moves` count.** §2 allows at most 2 buyer moves and §6 says "2 moves"; the task says "≥1". T61 asserts 1–2.
- **Live mode.** With `PAYPAL_LIVE=1` the SIM assertions cannot run (they would hit the real API), so T63 reports `skipped SIM assertions` instead of failing; run the suite without live credentials (the default) for the green path.
- **`configured` semantics.** T60 requires `paypal.configured === Boolean(client_id)` — a config flag that disagrees with the presence of a client id is a bug, not a variant.
- **API helper vs literal path.** `demo.js` calls `S.api('/config')` and `S.api('/contracts/:id/ai-auto')` — the shared `Settled` helper prefixes `API_BASE = '/api'` (see `app.js`). T65 therefore accepts either the literal `/api/...` path **or** the helper form; matching raw literals only would be a false negative. T09 applies the same rule to `app.js`.
- **`AI agents` / `PayPal` markers** are checked across `demo.html` + `demo.js` combined, since the badge label can live in either file (§5 allows additive DOM).

### v4 (MERCHANT-BUILD-SPEC) ambiguities the suite resolves conservatively

- **Index page filename.** The spec text says the negotiation index lives at `/index.html`, but `index.html` is the existing dashboard; the lead corrected it to **`/market.html`**. T71 tests `/market.html`.
- **`categories.total`** is under-specified (category count vs item count). T66 accepts either and separately asserts `sum(count) === index items`, which is the property that actually matters.
- **Category labels** come from the server (the real backend uses `Lighting`, not the spec example's `Home`); T68 filters with the category returned by the API rather than a hardcoded string.
- **PATCH 400 code** is not frozen; T69 asserts the documented 400 status + `{error:{code,message}}` shape, not a specific code string (`INVALID_NEGOTIATION` on the current build).
- **Merchant catalog may expose the full `negotiation` block** (private floor/ceiling) — §Data-model explicitly allows this for the prototype, so T67 only scans *public* endpoints (`/api/index`, `/api/categories`, `/api/merchants`, `/api/merchants/:id`), never `/api/merchants/:id/catalog`.
- **`negotiable:false` also hides an item from the index** (§API: categories/index derive from listed+negotiable products); T70 asserts that as well as the 409.

### v5 (INDEX-FEED-SPEC / ADAPTER-SPEC) ambiguities the suite resolves conservatively

- **Cursors are opaque.** T73 never parses `next_cursor`; it passes the value straight back to the server and asserts the observable contract (every offer exactly once, final `null`). Any cursor encoding is acceptable.
- **`next_cursor` on an empty page.** The suite fails if a page returns zero items while claiming a non-null cursor (that would stall a crawler).
- **Feed paging is exercised with `limit=2`** against 5 seed offers, so pagination is genuinely multi-page; the loop is capped at 20 pages to avoid an infinite crawl on a bug.
- **Import with no `data`** is not specified. T75 accepts a clean 400 *or* a 200 with `imported:0, updated:0` — it only rejects a 5xx or phantom products.
- **Upsert semantics** are asserted by behaviour (`sku` match updates price, no duplicate row) rather than by exact `imported`/`updated` counters, since those can legitimately differ per adapter.
- **OpenAPI path parameters** may be named anything (`{id}`, `{orderId}`); T74 matches the parameterised paths with a regex, not literal strings.
- **`/.well-known/settled-agent.json`** is served outside `/api`, so it is checked for a JSON content type as well as shape.
- **Reset must clear imported products**, not just orders/claims/contracts; T75/T76 assert the index returns to exactly 5 seed offers afterwards (this caught a real state-leak class of bug in mock testing).

### v6 (DEPLOYABILITY-SPEC) ambiguities the suite resolves conservatively

- **MCP is a child process, not HTTP.** T77 matches responses by JSON-RPC `id` (never by line order), tolerates notifications with no reply, caps each wait at 20 s, and kills the child in `finally` so a failure cannot leave a stray `node mcp/server.js`.
- **MCP `SETTLED_BASE_URL`** is passed explicitly and pointed at the suite's own server (the spawned `PORT=4400` one, or `BASE_URL` when reusing) — not left to the 4173 default.
- **Unknown MCP tool** must come back as `result.isError:true` per §1; a bare JSON-RPC error is reported as a mismatch rather than silently accepted.
- **A2A card equality.** §2 documents one card for two paths; T78 requires the two responses to be identical, so a divergent copy of the card fails.
- **`value` ranking** is asserted against the computed published discount (non-increasing), not a hardcoded item order, so tie ordering stays free. `trust` **is** pinned to the seed order because §3 fixes merchant-score desc + price.
- **Feed stability** is asserted by comparing `offer_id` sequences before and after sort queries — ranking must never leak into feed pagination order.
- **Widget asset purity** is asserted (`no external js/css loads`) and the widget source is scanned for private-range keys; the embed page must contain the install snippet, not just link to it.

### v7 (INVENTORY-AUTOMATION-SPEC) ambiguities the suite resolves conservatively

- **The remote feed is a real local HTTP server.** T81 starts `node:http` on an ephemeral `127.0.0.1` port and points the connector at it, so the pull adapter's real `fetch`/timeout path is exercised without an external dependency. The server is closed in `finally`, even on failure.
- **`PUT` return shape is not frozen** (`{connector}` vs the bare connector); T81 reads `body.connector || body`. `GET`/`POST sync` shapes are frozen by §1 and asserted strictly.
- **Sync counters** are read as `sync.counts || sync` because the spec defines both `connector.last_counts` and the `sync` result. Import/update behaviour is additionally asserted by product state (price/name/upsert-by-sku), not counters alone.
- **A failing adapter pull** is accepted as either a non-2xx error envelope or a 200 carrying sync error info; in both cases the connector must end `last_status:"error"` with a non-empty `last_error` and the server must stay healthy.
- **Rule percentage rounding.** `apply` may round to whole currency units; T82 compares against `price × pct` with a ±1 unit tolerance while still asserting the ordering invariants.
- **`window:{from:null,to:null}` and `window:null`** are equivalent "inherit/always-open" values; T82 accepts a stored rule window as `null` or `{from,to}`.
- **PATCH `{window:null}`** means "drop the item override and inherit the category window" (used by T83 to prove the fallback), while `{window:{from,to}}` sets an explicit item override.
- **`negotiation_window` exposure is asserted on every feed item** (may be `null` for an unbounded window), and index items are checked through the feed's field instead of pinning an extra key on `/api/index` beyond §3.
- **Merchant-page markers are matched across `.html` + `.js` combined**, since a panel title can live in either file; the market page is likewise scanned as a pair. Private-range keys are only forbidden in *market* assets — the merchant console legitimately edits them.

### v8 (AGENT-SETUP-SPEC) ambiguities the suite resolves conservatively

- **Autoconfigure needs a category without a rule to prove the "ensure" step.** T85 creates an `Accessories` product first, then asserts the call *creates* the default rule and applies it — a no-op implementation that only re-applies existing rules fails the test.
- **`categories` shape is not frozen** (strings vs `{id,name}`); T85 normalises both before comparing.
- **`updated` semantics are "products applied", not "rules created"**; T85 asserts it counts the applied products (`≥3`) and that the re-run returns the same number. The implementation may expose an extra `configured` (rules added this call) field — extras are ignored.
- **Idempotency is behavioural.** T85 compares the second call's rules, counters and derived product ranges rather than an HTTP cache header; the AI is never involved (`ai.used:false` even with a key configured).
- **Agent-catalog count cap** is unspecified between clamp and reject: T86 accepts a 200 with `created ≤ 8` *or* a 400 error envelope for `count:99`, but rejects any response that creates more than 8 products.
- **`created` may be a number or an array**; T86 reads either. The fallback is asserted to be **exactly 3** by default (the spec's deterministic fallback), with `ai.used:false` on a server without an AI key.
- **Inheritance is checked against the rule actually in force** for each drafted product's category (category rule, else the global 82/95/86/18 fallback), within ±1 currency unit for rounding.
- **The manual "Add product" removal is a UI-only assertion** (`no /\badd product\b/` in `merchant.html` + `merchant.js`): the `POST /catalog` API intentionally remains, so only the page's one-by-one form must disappear.
- **Demo-console strip is soft** in this batch: the spec asks for it, but no demo-console task owns it, so T87 reports presence/absence and only fails on an inconsistent half-implementation (autoconfigure wiring without the "Merchant agent setup" marker).

If the backend or spec changes, update the assertion and the corresponding row above; keep the `Tnn` ids stable so a failing demo check maps to a known behaviour.
