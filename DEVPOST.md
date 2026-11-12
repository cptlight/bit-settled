# bit-settled

**Reputation settles with the payment.**

**PayPal's merchant negotiation desk for the agent economy.** A PayPal-native tool that lets a merchant publish its policy, trust credential and protection terms, then let its merchant agent negotiate with any consumer's personal AI — visible offer/counter/accept, a signed Agent Commerce Contract, PayPal settlement, and a buyer claim paid from the merchant's reserve in about a second. The human trade ritual — trust, haggle, contract, guarantee, refund — at machine speed, with an audit trail.

> **Links (fill before submitting)**
> - Repo: https://github.com/cptlight/bit-settled (Apache-2.0 — see [LICENSE](LICENSE))
> - Demo video (<3 min, YouTube): `VIDEO_URL`
> - Hosted live-sandbox demo: `https://cptlight-bit-settled.hf.space` (Hugging Face Space; live PayPal sandbox + live AI, keys server-side)
> - Run it locally: `node server.js` → `http://127.0.0.1:4173/demo.html`
> - Judge brief: [JUDGE-BRIEF.md](JUDGE-BRIEF.md)

---

## Where it came from

Two things are happening at once.

**Buyers don't trust the checkout.** 51% of shoppers abandon because they doubt the business is legitimate — the #1 reason, ahead of card security (TrustedSite, 2026). 96% are concerned about unfamiliar stores; 94% fear AI-generated fake businesses; 91% fear AI-written fake reviews.

**AI agents can pay, but not trust or be trusted.** Agent checkout is arriving on PayPal's rails (Agent Ready, Store Sync, WebMCP; AP2/ACP/UCP mandates), yet an agent has no portable way to check a merchant, and a buyer has no instant remedy when an agent-originated order goes wrong.

And the cost is already inside PayPal: its FY2025 10-K shows a **$1.34B protection provision / $1.49B realized losses** — a bundled cost centre with no risk-based price and no portable trust signal.

Settled closes that loop: **outcome → signed credential → risk-priced protection → reserve → instant payout → updated outcome.** One object — the Agent Commerce Contract — carries identity, negotiated terms, price and recourse, and it rides the PayPal SDK.

## What it does

Settled turns an order into a signed, insured deal with five parts:

1. **Merchant Trust Credential** — an HMAC-SHA256-signed, portable record built from settled payments, delivery and dispute outcomes. Northwind Audio: tier A, score 91, 94% coverage, $5,000 cap, $12,500 reserve. Verify it with one call: `POST /api/trust/verify`.
2. **Agent Passport** — operator KYB, capabilities, a signed spend mandate (spend limit, expiry, merchant allowlist) and reputation. An unverified agent (RogueBot) is rejected *before* an order exists.
3. **Transparent agent-to-agent negotiation** — Sam's personal AI agent (ProcureBot, $500 mandate) and Northwind's seller agent talk in a visible chat: offer $214 → counter $237 (the seller policy price) → accept $237. The model writes every message; the server fixes the allowed prices, the mandate and the auto-accept, and the judge can see both the conversation and the guardrails. Terms are signed before payment.
4. **Risk-priced protection** — tier A 35 bps / B 90 / C 150 / D decline; caps $5k/$2.5k/$1k; settlement mode instant capture / capture + reserve / escrow. A $237.00 order costs $0.83 to protect, merchant-paid, buyer free.
5. **Merchant console + negotiation index** — the merchant connects PayPal, loads its catalog, sets the **private sell range** and the **public published range** for each item, edits its native agent's name/tone, and publishes. Every listed item appears in a category index that any consumer AI can search by category/budget. The private floor never leaves the server.
6. **Instant recourse** — the buyer (or agent) files a claim with evidence; an AI explainer recommends approve/review/deny and shows its reasoning, then the rule engine pays from the merchant's reserve through the PayPal refund rail. **$237.00 refunded in ~1.2s**, reserve drops to $12,263.00, the merchant's score and tier recompute.

Try the 5-step console at `/demo.html`. It runs end to end with one click and ends with **ALL FIVE AXES 8+**.

## How we built it

**Zero dependencies, Node ≥20, no build step.** `node server.js` serves the static pages and the JSON API from the standard library only (global `fetch`, `crypto`, `http`). No npm packages, so judges can run it offline.

**PayPal (sandbox).**
- Orders v2: `POST /v2/checkout/orders` (`intent=CAPTURE`), return the approval URL, `POST /v2/checkout/orders/{id}/capture`, extract the capture id, then finalize the order at the agreed contract price.
- Payments v2: `POST /v2/payments/captures/{id}/refund` on a claim, so the badge, the order and the refund are one flow rather than three integrations.
- OAuth2 client-credentials token cache; clean `502 PAYMENT_PROVIDER_ERROR` without corrupting state when a live call fails.
- Every ID is real when the live rail is on; `SIM-…` IDs otherwise (default).

**AI (core, not decoration).**
- OpenAI-compatible `/chat/completions` with JSON mode, `temperature 0.2`, timeout 8s.
- The buyer agent never invents a price: the server computes the legal candidate set (86% of list, the floor/auto-accept midpoint, the auto-accept price), the model picks one and writes the message/rationale, and the contract policy validates before committing.
- Two AI surfaces: the negotiation transcript (labelled `AI` / `FALLBACK` in the demo) and the claim explainer that reviews evidence and drafts the rationale — with the rule engine keeping the final decision.
- Deterministic fallback when no key/API error (`ai.used: false`), so the demo never dies on stage and judges can run it with no secrets.

**Index + adapter layer (for any personal AI).**
- `GET /api/index/manifest` → categories, totals, feed/search/OpenAPI endpoints.
- `GET /api/index/feed?cursor=` → stable `offer_id`, `published_range`, `negotiate_url`, `updated_at`; opaque cursor, no private range.
- `GET /api/index/openapi.json` (OpenAPI 3.0.3) and `GET /api/agent-manifest` (+ `/.well-known/settled-agent.json`) for any agent runtime.
- Inventory adapters: CSV, JSON, Shopify payload, WooCommerce payload, remote JSON feed; upsert by SKU; `GET /api/adapters` lists ready vs roadmap.
- `market.html` is the human/board view of the same feed; `/merchant.html` is where the merchant configures it.

**Agent-runtime + storefront adapters.**
- MCP stdio server (`mcp/server.js`) with 7 tools: `index_manifest`, `index_feed`, `index_search`, `negotiate_start`, `negotiate_auto`, `order_create`, `claim_open`; config for Claude Desktop/Cursor in `mcp/README.md`.
- A2A-style card at `/.well-known/agent-card.json` and `/api/a2a/agent-card`.
- Drop-in widget (`/settled-widget.js`) + `/embed-demo.html`: one script tag adds “Negotiate with AI” to any storefront that already has PayPal.
- Index ranking `?sort=price|trust|value` uses only the published range — no floor side-channel.

**Trust and settlement engine.**
- HMAC-SHA256 merchant credential + SHA-256 hash-chained event log (tamper-evident, verifiable from the dashboard and the agent API).
- Risk engine derives score → tier → fee bps → cap → payment mode from outcome metrics, not hardcoded values.
- Reserve accounting pays claims from the merchant's reserve (shortfall drawn from a pool), and claim outcomes feed back into the merchant's score.

## What is real vs. simulated

We would rather say this first.

**Real:** the API, risk engine, signed credential, hash chain, agent passport and mandate checks, negotiation policy, protection pricing, reserve accounting, claims, PayPal Orders v2 create/capture and Payments v2 refund code paths, and the e2e suite (`npm test`).

**Live when sandbox credentials are set:** real PayPal **sandbox** order, approval, capture and refund IDs — the manual demo step renders real PayPal Buttons; the video states which take it is (sandbox or labelled SIM).

**Live sandbox verification (Nov 4, 2026):** order `1TD07351F78687411` → capture `05T456380E807962V` (`REFUNDED`) → refund `2KN47117H3971321W` (`COMPLETED`, $249.00), checked directly against the PayPal sandbox API. The AI (`gpt-oss:20b` via Ollama Cloud; local `llama3.2:3b` fallback) negotiated a $249 list to $237 and explained the claim. Details: [LIVE-TEST.md](LIVE-TEST.md).

**Hosted demo:** the public Hugging Face Space runs live PayPal **sandbox** + live AI (keys are server-side secrets); **Run full demo** stays deterministic, while **Live checkout**/step 4 use the real sandbox approval and capture. A local clone with no keys runs in SIM mode — `SIM-…` IDs, no money moves. Fulfillment ("simulate delivery"), KYB, and the $25,000 network pool are demo fixtures, not production systems. **The reserve is demo capital**, not a balance sheet: production is an insurer/LC-backed reserve with per-merchant caps and a backtested loss curve.

**Not claimed:** the live insurance/underwriting product, regulatory sign-off, or traction. Settled is pre-revenue; the 30-day plan is pre-registered tests (12 merchant interviews, 3/12 LOIs at ≥25 bps, a holdout conversion test, a 20-claim concierge pilot, one insurer term sheet).

## Challenges

- **Making the AI real without letting it move money.** The model can write the negotiation, but the numbers must be provable. We solved it by inverting control: server computes the legal prices, the model selects and explains, the policy enforces, and a deterministic path guarantees the same accepted price every time.
- **Living on the edge of "already exists."** Trust scores, guarantees, badges and buyer protection all exist. Our prior-art audit is honest about it: the novelty is the closed loop and the settlement seat, not the vocabulary. That discipline shaped the demo (we show the refund and the recompute, not a badge).
- **The locked-in sandbox demo.** A live PayPal approval redirect is one flaky Wi-Fi away from a dead stage. We built a SIM/SANDBOX switch: the recorded take shows real sandbox IDs; the fallback runs the identical flow offline.
- **Pricing a guarantee without a balance sheet.** Instant payouts need capital. We kept the demo on a merchant-reserve abstraction with explicit caps, and wrote down the partner path (insurer/LC) instead of pretending it exists.
- **Zero dependencies, no framework.** Every route, signature and hash-chain step is hand-rolled on Node built-ins — more code to get right, but nothing to install and nothing to break on the judge's machine.

## Accomplishments

- A complete 5-step demo that runs in one click, with a live JSON request/response log and a scorecard that maps each step to the problem it fixes.
- AI negotiation that is genuinely constrained: same accepted price on the deterministic path, model-generated transcript when a key is present, no scenario where the model can exceed the mandate.
- Real PayPal sandbox money path in the same app as the SIM fallback, with clean failures.
- A working refund in ~1.2s that updates reserve, score and tier in the same screen — the moment the pitch turns on.
- The full e2e suite passing locally with zero external dependencies: **85/85 assertions** covering trust, passport, contract, AI fallback, claim AI and the PayPal SIM create/capture/refund path.

## What we learned

- **The hard part of agentic commerce isn't paying — it's the answer to "who pays if it fails?"** Stripe/AP2/Agent Ready all solve authorization; almost nobody solves recourse.
- **AI is most valuable where it's bounded.** An LLM that argues inside a server-enforced price set is demoable, auditable and safe; an LLM that *decides the price* is a liability.
- **The risk price is the product.** Once protection has a per-order price derived from outcomes, trust stops being a marketing cost and becomes a SKU.
- **Honesty is a feature in a hackathon.** Saying "SIM by default, sandbox in the video, demo pool not capital" before judges ask makes the rest credible.

## What's next

1. **30-day validation:** 12 merchant interviews; 3/12 LOIs at ≥25 bps; holdout conversion test (≥5% relative lift on unfamiliar buyers); 20-claim concierge pilot with an insurer/LC partner.
2. **Agent rails:** wire the passport/mandate to PayPal's agentic surfaces (Agent Ready / Agent Toolkit MCP) and publish the credential as a verifiable-credential format (W3C VC) instead of HMAC.
3. **Production money path:** insurer/LC-backed reserve, per-merchant aggregate caps, backtested loss curves; exchange SIM for sandbox in CI.
4. **Distribution:** ship as a platform/PSP trust API first (one integration, many merchants) — the merchant app is the wedge, not the end state.

## Built with

`PayPal Orders v2` · `PayPal Payments v2 (refunds)` · `PayPal Sandbox` · `PayPal Agent Ready / AP2` (mandate model, roadmap wiring) · `Node.js 20` (zero dependencies; `http`, `crypto`, `fetch`) · `OpenAI-compatible LLM` (JSON mode, configurable model/base URL) · `HMAC-SHA256` · `SHA-256 hash chain` · `vanilla HTML/CSS/JS` (no build step, no external assets)

## Try it (60 seconds)

```bash
cd bit-settled
node server.js                    # http://127.0.0.1:4173
open http://127.0.0.1:4173/demo.html
```

Click **Reset**, then **Run full demo**. With no `.env`, everything is SIM and deterministic. Add sandbox credentials (see [.env.example](.env.example)) to show real PayPal orders, captures and refunds; add an AI key to see the model-generated negotiation transcript. The manual step renders real **PayPal Buttons** (live rail); **Run full demo** stays on SIM so it never blocks on a popup.

## License

Apache-2.0 — [LICENSE](LICENSE). "Settled" is a hackathon prototype; nothing here is financial, insurance or legal advice.
