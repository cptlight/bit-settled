# bit-settled — PayPal AI Hackathon submission

**Tagline:** PayPal's merchant negotiation desk for the agent economy.

**One-line description:** A neutral, Reddit-style negotiation board where merchants post offers and link their own APIs, personal AI agents negotiate directly with those merchant APIs, and bit-settled records the thread, the closed deal and a 0.5% platform fee — without hosting catalogs, funds, or the agents.

---

## Inspiration

Buyers don't trust unfamiliar checkout. AI agents can now pay, but they cannot reliably answer: *is this merchant trustworthy, what price is fair, and who pays if the order fails?* PayPal already owns the settlement rail. bit-settled gives every merchant a native negotiation agent, a portable trust credential, risk-priced protection, and instant recourse — the human trade ritual of trust, haggling, contract, guarantee and refund, at machine speed.

## What it does

1. **Merchant agent setup** — the merchant connects a catalog/feed (or lets the agent draft one), sets a private sell range and a public published range, configures category rules and negotiation windows, and enables its native agent. No one-by-one product entry.
2. **Bring-your-own-AI** — `/agent-connect.html` exposes REST, **remote MCP at `/mcp`**, and an agent OpenAPI; any external personal AI can drive the buyer side. `/live.html` publishes the negotiation so people can watch.
3. **Negotiation index** — every negotiable item gets a stable `offer_id`, public `published_range`, `negotiation_window` and `negotiate_url`. Any personal AI or central indexer can crawl the manifest and feed; private floors never appear in the public responses.
4. **Agent-to-agent negotiation** — the buyer agent presents a passport and signed mandate; the merchant agent counters inside its policy; the model writes the dialogue but the server fixes the legal prices, mandate and auto-accept. Both sides sign the same contract hash.
5. **PayPal settlement + protection** — risk-priced protection (35/90/150 bps by tier), a PayPal order, capture, and a signed Agent Commerce Contract. Live sandbox mode creates real PayPal order/capture IDs; the default SIM mode is deterministic.
6. **Instant recourse** — a buyer or agent files a claim with evidence; an AI explainer recommends approve/review/deny; the rule engine pays from the merchant reserve through a PayPal refund, updating the merchant's score and tier.

## How we make money

A **0.50% platform fee** on each negotiated transaction (merchant-paid), recorded on every order and receipt. At $10M GMV that is $50k/y; at $100M, $500k/y. Collection uses PayPal marketplace platform fees for a partner account; the demo records the fee as accrued until the partner rail is enabled.

## How we built it

- **Zero-dependency Node ≥20** server: `http`, `crypto`, global `fetch`; no npm packages, no build step.
- **PayPal Orders v2** create/approval/capture, **Payments v2** refunds, OAuth token cache, sandbox rail with a SIM fallback.
- **AI**: OpenAI-compatible chat completions (JSON mode) for negotiation, claim explanation and catalog drafting; server-side price policy clamps every model output; deterministic fallback when no key.
- **Trust**: HMAC-SHA256 merchant credential, SHA-256 hash-chained event ledger, risk tiers, reserve accounting.
- **Agent distribution**: MCP stdio server with 7 tools, A2A-style card, OpenAPI 3.0.3, agent manifest, drop-in storefront widget.
- **Inventory**: connector pulls a JSON feed, category rules, per-item/category negotiation windows; CSV/JSON/Shopify/Woo payload adapters.
- **Interface**: PayPal-inspired light design system — blue-first, simple, accessible, one primary action, proof visible.

## Challenges

- Making AI genuinely useful without letting it decide money: the server computes the legal price set; the model chooses and explains; the policy enforces.
- Proving a live PayPal rail without making the demo depend on network or a buyer popup: SIM/SANDBOX switch, real IDs recorded in `LIVE-TEST.md`.
- Keeping private merchant floors private while still showing the buyer enough to negotiate: published ranges and windows only; merchant-only console for the private range.

## Accomplishments

- End-to-end 5-step demo: **5/5**, $237 refund in ~1.2s.
- **85/85** e2e tests; zero dependencies. The hosted demo uses server-side secrets; local judges can run SIM with no keys.
- Real PayPal sandbox capture/refund verified: order `1TD07351F78687411` → capture `05T456380E807962V` (REFUNDED) → refund `2KN47117H3971321W` (COMPLETED, $249).
- Merchant agent setup, category rules, windows, inventory pull, index feed, negotiation, contract, checkout, claim and dashboard all work.
- Public repo under Apache-2.0.

## What we learned

- The hard part of agentic commerce is not paying; it is **who pays if it fails**.
- Bounded AI is more demoable than autonomous AI: an LLM arguing inside a server-enforced price set is auditable.
- Risk-based protection turns trust from a marketing cost into a SKU.
- Honesty sells: saying SIM by default, sandbox when keys are set, and demo reserve not production capital makes the rest credible.

## What's next

- 30-day merchant validation: 12 interviews, 3 LOIs at ≥25 bps, holdout conversion test, 20-claim concierge pilot.
- Native Shopify/Woo cart plugins and merchant OAuth/Partner Referrals.
- Insurer/LC-backed reserve, W3C verifiable credentials, hosted MCP with auth.
- Production deployment with auth, rate limits and a real public origin.

## Built with

`PayPal Orders v2` · `PayPal Payments v2 (refunds)` · `PayPal Sandbox` · `Node.js 20+` · `OpenAI-compatible LLM` · `HMAC-SHA256` · `SHA-256 hash chain` · `vanilla HTML/CSS/JS` · `MCP stdio` · `OpenAPI 3.0` · `Apache-2.0`

## Try it

- **Hosted live-sandbox demo:** `https://cptlight-bit-settled.hf.space` (Hugging Face Space; live PayPal sandbox + live AI, keys server-side)
- **Repo:** https://github.com/cptlight/bit-settled
- **Local:** `npm start` → `http://127.0.0.1:4173/start.html`
- **Judge path:** Open the hosted URL → **Run the 5-step demo** → **Run full demo** for the deterministic 5/5 run. For a real sandbox payment, use **Live checkout** (or step 4 manually): approve in PayPal, capture, then claim. The hosted Space uses live PayPal sandbox + live AI; keys stay server-side and no real money moves.
- **Live sandbox:** add `PAYPAL_LIVE=1` + sandbox client ID/secret and an AI key in a private deployment; buyer uses a Personal sandbox account or test card `4111 1111 1111 1111`, 12/30, CVV 123.

## Demo video

`VIDEO_URL` — <3:00, YouTube, showing the AI negotiation, PayPal sandbox capture and instant claim/refund. **Recorded last, per plan.**

## Team

cptlight — creator and maintainer (https://github.com/cptlight). Eligibility to be confirmed by entrant.

## License

Apache-2.0. This is a hackathon prototype; nothing here is financial, insurance or legal advice.
