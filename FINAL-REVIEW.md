# Final review — Settled for the PayPal AI Hackathon

*2026-11-04 · one working prototype, one hosted live-sandbox demo, one live-verified PayPal sandbox flow, one submission deadline (Nov 12, 2:00 PM PT).*

---

## 0. Verdict

**Strong submission, with one honest caveat.** The demo is real, the AI is real, the PayPal sandbox capture/refund is real, and the pitch has a clear buyer (the merchant) and a clear distributor (PayPal). The caveat: the current build is a **working prototype**, not yet a packaged merchant plugin — merchant onboarding, a drop-in script and an MCP endpoint are the next 30 days, not today. Say that before a judge does.

**Positioning:** *PayPal's merchant negotiation desk for the agent economy.* PayPal gives merchants the tool; the merchant publishes policy; its merchant agent negotiates with a consumer's personal AI; both sign a contract; PayPal settles; the buyer gets instant recourse.

---

## 1. What exists (evidence a judge can inspect)

| Layer | Evidence |
|---|---|
| **Working demo** | `http://127.0.0.1:4173/demo.html` — 5-step run, scorecard 5/5, live JSON log, agent-to-agent chat; public SIM URL is a temporary tunnel |
| **PayPal live sandbox** | order `1TD07351F78687411` → capture `05T456380E807962V` (`REFUNDED`) → refund `2KN47117H3971321W` (`COMPLETED`, $249); verified via PayPal API — [LIVE-TEST.md](LIVE-TEST.md) |
| **AI** | Ollama Cloud `gpt-oss:20b`; one-call negotiation plan; claim explainer; policy clamps prices; fallback without keys |
| **Trust engine** | HMAC-SHA256 credential, SHA-256 hash-chained event log, risk tiers 35/90/150 bps, reserve accounting, instant claims |
| **Tests** | `npm test` → **85/85**, including PayPal SIM create/capture/refund and AI fallback |
| **Repo** | public Apache-2.0 repo: https://github.com/cptlight/bit-settled |
| **Deployable demo** | Live HF Space: https://cptlight-bit-settled.hf.space/start.html (live PayPal sandbox + live AI; secrets server-side); `Dockerfile`, `render.yaml`, `DEPLOY-HF.md` |
| **Narrative** | [WRITEUP.md](WRITEUP.md), [JUDGE-BRIEF.md](JUDGE-BRIEF.md), [VIDEO-SCRIPT.md](VIDEO-SCRIPT.md), [HACKATHON-PROOF.md](HACKATHON-PROOF.md) |

---

## 2. How PayPal would integrate it

### 2.1 The three install paths

**Path A — PayPal merchant app (the wedge).**
A merchant installs Settled from the PayPal App/Partner directory. PayPal OAuth/Partner Referrals onboards the merchant and returns the merchant ID. Settled hosts the policy console and the merchant agent; the store calls Settled's API at checkout. PayPal keeps the rail and the relationship.

**Path B — PSP / platform partner (distribution).**
A platform or PSP embeds Settled once and exposes it to all its merchants. The platform owns merchant support; Settled owns underwriting/claims; PayPal settles. This is how a judge can see "one integration, thousands of merchants."

**Path C — consumer AI / agent API (demand side).**
Any personal AI connects to Settled's agent API (REST today, MCP/OpenAPI next) and negotiates with any merchant that has Settled. The consumer installs nothing new; the AI carries a signed mandate.

### 2.2 The transaction sequence (what actually happens)

```
Consumer AI                         Settled                         PayPal
     |                                 |                               |
     | 1. agent passport + mandate     |                               |
     |-------------------------------->| verify KYB, signature, limits |
     |                                 |                               |
     | 2. POST /api/contracts          |                               |
     |-------------------------------->| create policy-bound contract  |
     | 3. offer / counter / accept     |                               |
     |<------------------------------->| merchant agent + policy       |
     |                                 |                               |
     | 4. signed Agent Commerce Contract (ACC hash)                    |
     |                                 |                               |
     | 5. POST /api/orders             |                               |
     |    {contract_id, agent_id}      |----------------------------->| Orders v2 create
     |                                 |<-----------------------------| approval URL / order id
     | 6. buyer approves in PayPal     |                               |
     |                                 |----------------------------->| Orders v2 capture
     |                                 |<-----------------------------| capture id
     | 7. protection fee on protected GMV (platform_fees if partner)   |
     |                                 |                               |
     | 8. claim (buyer/agent)          |                               |
     |-------------------------------->| AI review + rule engine       |
     |                                 |----------------------------->| Payments v2 refund
     |                                 |<-----------------------------| refund id
     | 9. reserve update + score update; event hash chain              |
```

### 2.3 PayPal capabilities used / needed

| Capability | Use in Settled | Status |
|---|---|---|
| **Orders v2** | create / capture at the agreed contract price; ACC hash in `custom_id` / `invoice_id` | built, live-tested |
| **Payments v2 refunds** | claim payout from the merchant reserve | built, live-tested |
| **Webhooks** | capture/refund/dispute events feed the trust credential | adapter path; production work |
| **Agent Ready / AP2 / ACP / UCP** | consumer agent authorization and mandate | mapped; demo uses a signed mandate |
| **Commerce Platform partner** | merchant onboarding + `platform_fees` | partner-gated; ledger/invoice fallback now |
| **Invoicing / NET terms** | B2B/agent purchases | mapped, not in demo |
| **MCP / Agent Toolkit** | expose `negotiate`, `verify`, `claim` as agent tools | roadmap; REST is the current surface |

**Simple install story for a judge:** merchant adds one script tag / app install and sets three policy fields; consumer AI adds one endpoint (or MCP server) and presents a mandate. No new checkout, no custody, no card data.

---

## 3. How a judge vets it

Typical rubric: **technical implementation, design, potential impact, innovation, presentation** (plus PayPal + AI use).

| Criterion | What the judge looks for | Our evidence | Gap to close before submit |
|---|---|---|---|
| **Problem / impact** | Real, quantified, urgent | 51% legitimacy abandonment; $1.34B protection provision/$1.49B losses; agent trust gap | Keep numbers in the first 20s |
| **Innovation** | Not a badge/wrapper; new category | Three-leg loop: buyer-initiated instant claim + portable credential + fee moves with it; prior-art audit | Say "6/10 combinatorial" honestly; show the loop |
| **Technical execution** | Working, not mock; code quality; error handling | 85/85 tests; live sandbox IDs; hash chain; fallback; Docker/Render | Record the live take; show real IDs |
| **PayPal use** | Meaningful, not decorative | Orders v2 create/capture, Payments v2 refund, webhooks/Agent Ready mapping | Public demo is SIM; the video must show live sandbox |
| **AI use** | Core, not a chatbot veneer | Model writes offer/counter/accept + claim rationale; server clamps prices; visible agent-to-agent chat | Keep `AI` badge visible; explain policy guardrails |
| **Business model** | Who pays, unit economics, path | Merchant bps on protected GMV; platform license; agent API; pilot plan | One slide/one sentence; don't overclaim forecasts |
| **Design / demo** | Clear, polished, reproducible | 5-step console; chat; policy strip; reset; fallback | Rehearse 3:45; record 2:55 |
| **Feasibility** | Can it ship? compliance? | No custody; insurer/LC partner; caps; counsel workstream | State the partner path explicitly |
| **Honesty** | Doesn't claim what isn't built | LIVE-TEST vs SIM; demo pool caveat; pre-revenue | Say it before Q&A |

**Red flags a judge will probe:** "Is this just Signifyd/badge?", "Where's the PayPal call?", "Is the AI doing anything?", "Who pays?", "New merchant has no history", "What if PayPal builds it?", "Is the reserve real money?" — answers in [HACKATHON-PROOF.md §6](HACKATHON-PROOF.md).

---

## 4. How to pitch and sell it

### The 15-second hook
> *"PayPal can already let an AI agent pay. It can't let a merchant negotiate with that agent — or trust it. Settled is the negotiation desk PayPal gives every merchant for the agent economy: personal AI meets merchant agent, in the open, with a contract and a refund if it fails."*

### The 30-second version
> *"Half of shoppers abandon because they're not sure a store is real. PayPal spends $1.3B a year on protection with no risk-based price. And personal AIs are about to shop for consumers. Settled is the merchant-side tool: publish your policy, let your agent negotiate with any consumer's AI, sign the contract, price the protection, pay the claim in seconds — all on PayPal."*

### The 4-minute arc
1. **0:00** Hook + Maya (Head of Risk).
2. **0:25** Problem: 51%, $1.3B, agent gap.
3. **0:45** Step 1–2: trust credential + agent passport.
4. **1:10** Step 3: **agent-to-agent chat** — $214 → $237 → accepted; policy strip.
5. **1:45** Step 4: protection 35 bps + PayPal sandbox capture.
6. **2:15** Step 5: AI claim review + instant refund.
7. **2:35** Business: merchant bps, platform license, agent API; $1.3B cost centre → SKU.
8. **3:10** Moat + close: *"Reputation settles with the payment."*

### Who to sell to, in order
1. **PayPal** — distribution, rail, data, protection cost centre. Partner/acquire.
2. **Platforms/PSPs** — one integration, thousands of merchants; they don't want to be the insurer.
3. **Enterprise merchants** (high-AOV, trust-deficit) — the pilot buyer; CFO/VP Payments, CMO co-sponsor.
4. **Consumer AI platforms** — distribution of demand; mandate + trust API.

### Pricing / land
- 1–3% bps on **protected GMV** (merchant pays; buyer free).
- Platform license ($250k–$1M) for PSPs.
- Agent API per-verify + bps.
- Land: 90-day pilot with 1 platform + 3–5 merchants; success = conversion lift ≥5%, claim cost <50% of chargeback, 3/12 LOIs ≥25 bps.

### Objection → answer
| Objection | Answer |
|---|---|
| "It's a badge" | Outcome-signed, portable, priced, pays a buyer-initiated claim. A badge is paid certification. |
| "Signifyd already does this" | Merchant-side indemnity vs buyer-facing portable credential + instant buyer claim + agent API. |
| "Buyer protection is free" | We sell the merchant's loss cap, conversion and claims ops — not the buyer's free remedy. |
| "Who pays?" | Merchant bps only on protected GMV; pilot platform-subsidised; platform license/agent API. |
| "New merchant has no history" | Escrow tier C + bond + third-party attestation; trust ramp, not fake history. |
| "PayPal will build it" | Partner or acquire; the layer is neutral and portable; PayPal's data makes it stronger. |
| "Is the reserve real?" | Merchant reserve/LC/insurer; no custody; demo pool is illustrative; production caps + loss curve. |

---

## 5. Hosting the demo (private until submission)

### What is running now
- **Hosted live-sandbox demo:** https://cptlight-bit-settled.hf.space/start.html — PayPal sandbox + live AI; keys are Space secrets; no real money. **Run full demo** stays deterministic; use **Live checkout** or step 4 for real sandbox approval/capture.
- **Local live instance** on `:4173` with PayPal sandbox + Ollama Cloud (private).

### Recommended submission host — Render
1. Render → New → **Blueprint** → connect `cptlight/bit-settled` → `render.yaml` creates `settled-demo` (free).
2. Keep the public service **SIM only**: `PAYPAL_LIVE=0`, `AI_PROVIDER=none`.
3. Open the URL repeatedly during testing; do **not** link it publicly until the submission is ready.
4. For a private live test, duplicate the service and add keys in the Render dashboard (never in `render.yaml`).
5. Free tier sleeps; first load ~20s. Put the URL in the Devpost submission only at submit time.

### Docker (judge/self-host)
```bash
docker build -t settled-demo .
docker run --rm -p 8080:8080 settled-demo
```
With keys: `docker run --rm -p 8080:8080 --env-file .env settled-demo`.

### Judge test matrix
- Fresh browser, no keys → `/demo.html` → Reset → Run full demo → 5/5.
- Step 3: 3 agent bubbles, policy strip, signed hash.
- Step 4: SIM payment id; step 5: refund + AI claim review.
- `/` dashboard and `/agent.html` load.
- `npm test` 85/85.
- Optional: their own sandbox keys → live capture/refund.

### Privacy rules
- Do **not** put the tunnel or Render URL in the public repo, README, or Devpost until you are ready to submit.
- Never commit `.env`; rotate any key that appears in a screenshot/video.
- Public demo = SIM; video = live sandbox IDs.

---

## 6. Gaps and the 7 days to submission

| Priority | Gap | Fix | Owner |
|---|---|---|---|
| **P0** | Video not recorded | 2:55 take per [VIDEO-SCRIPT.md](VIDEO-SCRIPT.md); step 3 chat + live PayPal capture/refund; upload public YouTube | You |
| **P0** | `VIDEO_URL_HERE` empty | Fill after upload; submit on Devpost | You |
| **P1** | Merchant install is a hosted-checkout prototype, not a native cart plugin | `/integrate.html`, `/embed-demo.html`, OpenAPI, agent manifest and MCP stdio are built; native Shopify/Woo cart plugins remain roadmap | Build |
| **P1** | Persistent host | HF Space is live; keepalive workflow runs every 6h. Render remains an alternative | Done |
| **P2** | No real merchant OAuth/Partner Referral | Document the production path; don't claim it in the demo | Docs |
| **P2** | MCP stdio exists, hosted MCP auth/remote deployment does not | Document stdio usage now; add hosted MCP auth after the hackathon | Build |
| **P2** | Insurance/underwriting partner | One term sheet target; demo pool caveat | BD |

**Critical path:** record → upload → fill Devpost → submit early. Do not add features after T-24h.

---

## 7. Final checklist

- [ ] Public SIM URL tested from another network; **not** published yet.
- [ ] Render service created; `PAYPAL_LIVE=0`; URL kept private.
- [ ] Live instance tested: real sandbox capture/refund; AI `gpt-oss:20b`.
- [ ] Video ≤3:00 recorded; shows step 3 chat, PayPal capture, claim/refund; public YouTube.
- [ ] Devpost text + repo + video links; `VIDEO_URL_HERE` filled.
- [ ] `npm test` 85/85; clean seed before recording.
- [ ] Honest boundary stated: SIM public; live sandbox in video; demo pool not production capital.
- [ ] Submit before **Nov 12, 2026, 2:00 PM PT**.

**One line to remember:** *PayPal gives every merchant a negotiation desk for the agent economy — and reputation settles with the payment.*
