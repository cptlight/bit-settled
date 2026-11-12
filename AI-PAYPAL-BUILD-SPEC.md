# Build spec — real AI + live PayPal sandbox + submission kit (frozen interfaces)

Goal: close the two core hackathon gaps. **AI must be real and core**; **PayPal sandbox must be demonstrated live**. Existing 57 e2e tests must stay green. Zero npm dependencies. Node >=20 (global fetch).

## Env (.env.example)

```
# AI (OpenAI-compatible)
AI_PROVIDER=openai          # openai | none
AI_API_KEY=
AI_MODEL=gpt-4o-mini
AI_BASE_URL=https://api.openai.com/v1
AI_TIMEOUT_MS=8000

# PayPal sandbox
PAYPAL_LIVE=1
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_ENV=sandbox
```

## 1. `lib/ai.js` (new)

Exports:
- `config()` → `{enabled, provider, model, base_url, timeout_ms}` — never the key.
- `available()` → boolean.
- `negotiateBuyer({contract, lastMerchantPrice, round})` → `{used, provider, model, action:'offer'|'accept', price, message, rationale, error?}`.
  - `action:'accept'` only when `lastMerchantPrice` exists and `<= contract.mandate.max`.
  - `price` must be one of the **allowed candidate prices** computed server-side: `[round(list*0.86), round((floor+auto_accept)/2), auto_accept]`; clamp anything else to the nearest candidate. Never exceed `mandate.max`.
  - If no key/API error: deterministic fallback (`used:false`): round 1 → `round(list*0.86)`; round 2 → accept if `lastMerchantPrice <= mandate.max`, else `auto_accept`.
- `explainClaim({order, merchant, reason, evidence})` → `{used, provider, model, recommendation:'approve'|'review'|'deny', confidence:0..1, rationale, error?}`.
  - Fallback: approve for `not_delivered|not_as_described|damaged` with evidence; confidence 0.8; rationale string.
- `reset()` no-op.

LLM call: OpenAI-compatible `POST {base_url}/chat/completions`, `response_format:{type:'json_object'}`, `temperature:0.2`, `max_tokens:300`, abort after `AI_TIMEOUT_MS`. Parse JSON; on any error return fallback with `error`.

## 2. `lib/contract.js` (edit)

Add `async function aiAuto(id)`:
- Get contract; if `accepted` return idempotently; if not open → 409.
- Max 2 buyer moves to keep latency low:
  1. `negotiateBuyer` → `contract.offer(id,{from:'buyer',price,note:message})`.
  2. If countered: `negotiateBuyer` again with `lastMerchantPrice`; if action `accept` → `contract.accept(id,{from:'buyer'})`, else `contract.offer(...)`.
- Attach `contract.ai = {enabled:true, provider, model, used, moves:[{round, action, price, message, rationale}]}`.
- Return `{contract, ai:contract.ai}`.
- Must always end `accepted` on the deterministic path (~$237 for list $249).
- Export `aiAuto`.

## 3. `server.js` (edit)

### New: `GET /api/config`
```
{ mode:'sim'|'live', currency:'USD',
  paypal:{env:'sandbox'|'live', client_id:string|null, configured:boolean},
  ai:{enabled:boolean, provider:'openai'|'none', model:string|null} }
```

### New: `POST /api/contracts/:id/ai-auto`
Body `{}`. Calls `contract.aiAuto(id)`. Returns `{contract, ai}`. Errors mirror `/auto`.

### Edit: `POST /api/orders/:id/claim`
- Accept optional `use_ai:true`; call `ai.explainClaim(...)` **before** mutating the reserve. Attach `ai` to response (`claim.ai` too).
- **Live refund:** if `paypal.isLive()` and order has `capture_id`, call `paypal.refundCapture(capture_id,{amount:refund})`; on failure return 502 `PAYMENT_PROVIDER_ERROR` before mutating. Set `claim.paypal_refund_id` to the real refund id. SIM keeps `SIM-RF-…`.
- If live and no `capture_id` → 409 `ORDER_NOT_CAPTURED`.
- All existing fields/status codes preserved.

### Edit: order create (`POST /api/merchants/:id/orders`)
- Accept optional `simulate:true` → force SIM payment even in live mode (used by "Run full demo").
- In live mode (no simulate): create PayPal order, set `order.status='pending'`, `order.captured_at=null`, `payment.captured=false`; response `payment.approval_url`. SIM unchanged (`paid`).
- Store `order.simulated = true|false`.

### Delegate PayPal routes
Early in the router: `if (url.pathname.startsWith('/api/paypal/') && paypalFlow.handle(req,res,url)) return;`
(Only if `lib/paypal-flow.js` exports `handle`.)

## 4. `lib/paypal.js` (edit) + `lib/paypal-flow.js` (new)

`lib/paypal.js` add:
- `refundCapture(captureId,{amount,currency='USD'}={})` → live `POST /v2/payments/captures/{id}/refund` body `{amount:{currency_code,value}}`; sim `{id:'SIM-RF-'+hex,status:'COMPLETED',simulated:true}`.
- `getOrder(id)` live only.
- Export.

`lib/paypal-flow.js` exports `handle(req,res,url)` and `create/capture/refund` functions:
- `POST /api/paypal/create-order` `{order_id}` (internal order id): if order has `payment_id` return it; else `paypal.createOrder({amount})`, store `order.payment_id`, return `{mode, paypal_order_id, approval_url, status}`.
- `POST /api/paypal/capture` `{order_id, paypal_order_id?}`: call `paypal.captureOrder(paypal_order_id || order.payment_id)`; on success set `order.status='paid'`, `order.captured_at`, `order.capture_id` (from capture.purchase_units[0].payments.captures[0].id or `capture.id`), append `payment_captured` event; return `{mode, capture, order}`.
- `POST /api/paypal/refund` `{order_id, amount?}`: require `order.capture_id`; call `paypal.refundCapture`; return `{mode, refund_id, status, amount}`.
- SIM returns `SIM-…` ids and null approval_url. Live errors → 502 `PAYMENT_PROVIDER_ERROR`.
- Must not mutate reserve; claim owns that.

## 5. Frontend (`public/demo.html` + `public/demo.js`)

- On load `GET /api/config`; set badges: `AI: <model>` or `AI: fallback`; `SIM` or `PAYPAL SANDBOX`.
- **Step 3:** "AI agents" checkbox (checked when `config.ai.enabled`). When checked call `/api/contracts/:id/ai-auto`, render transcript entries with `ai` message/rationale + badge `AI`/`FALLBACK`. Unchecked uses `/auto`.
- **Step 4:** if `config.mode==='live'` and `paypal.client_id`, render a PayPal Buttons container (load `https://www.paypal.com/sdk/js?client-id=...&currency=USD` dynamically): `createOrder` → `POST /api/paypal/create-order`; `onApprove` → `POST /api/paypal/capture`; show real capture id. Else SIM button. "Run full demo" passes `simulate:true` so it stays deterministic; the manual "Pay with PayPal" button uses the live rail.
- **Step 5:** claim body `{use_ai:true}`; show `ai.recommendation`, confidence, rationale, and the refund id.
- No external assets except the PayPal SDK script when live.
- Keep current layout/IDs; additive DOM is fine.

## 6. Tests (`test/e2e.js`)

Append:
- T60 `/api/config` shape (mode, ai, paypal).
- T61 `ai-auto` fallback: accepted, `ai.used===false`, agreed price in [floor, list], 2 moves.
- T62 claim with `use_ai:true`: `ai.recommendation` in approve/review/deny, refund still paid.
- T63 PayPal SIM: create-order → `SIM-…`; capture → status COMPLETED + order paid + `capture_id`; refund → `SIM-RF-…`.
- T64 order `simulate:true` in any mode → paid immediately.
- T65 existing claim on uncaptured live order? Skip unless `PAYPAL_LIVE=1`; assert 409 shape via a forced-live mock is out of scope.
- Existing 57 unchanged.

## 7. Submission kit (no code)

`LICENSE` (Apache-2.0), `.env.example`, `.gitignore`, Devpost text and a <3:00 video (kept in the private submission package), README section "Hackathon submission / AI / PayPal sandbox". `git init` + initial commit (no remote push).

## Acceptance
- `node --check` all changed JS.
- `npm test` ≥ 62/62.
- `curl /api/config`, `/api/contracts` + `ai-auto`, order + claim `use_ai`, PayPal SIM create/capture/refund all green.
- `/demo.html` renders, Run full demo 5/5, no console errors.
