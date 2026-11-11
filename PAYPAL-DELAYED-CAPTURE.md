# Delayed merchant receipt — PayPal authorize → capture

The problem: normal PayPal checkout uses `intent=CAPTURE`; capturing pays the merchant immediately. You want the merchant paid only after the buyer confirms.

## Correct PayPal primitive

Use **authorization then delayed capture**:

1. Buyer wins the bid.
2. Server creates a PayPal order with `intent=AUTHORIZE` for the agreed amount.
3. Buyer approves with the PayPal JS SDK.
4. PayPal returns an **authorization ID**. The server does **not** capture.
5. Board status: `payment_authorized` — funds are authorized/held, merchant not paid.
6. Buyer confirms receipt/acceptance on the board (or the merchant marks delivered and a confirmation window expires).
7. Server captures the authorization → merchant is paid.
8. Capture the platform fee as a split/platform fee (partner account) or as a separate fee order.

If the buyer never confirms, the board must have a rule:

- auto-capture after N days, or
- void the authorization and cancel the deal.

Define this before launch; do not leave authorizations open.

## Important constraint

This works cleanly only when the **platform controls the PayPal order and is a PayPal Commerce Platform partner/marketplace**, or when the **merchant's own checkout implements authorize/capture**.

For Model A (pure board, merchant owns checkout):

- bit-settled cannot capture the merchant's authorization.
- The merchant must implement auth/capture in its own PayPal integration.
- The board records `authorized`, `buyer_confirmed`, `captured` states and the 0.5% fee.
- The board never holds funds.

For a managed marketplace:

- Platform creates the order and authorization.
- Platform captures later and pays the merchant.
- Requires partner onboarding, KYC, payee/split configuration, refund/dispute handling.
- This is materially more regulated than a board.

## SDK flow

The same official SDK is used; only the server intent changes:

```text
createOrder  → POST /paypal/authorize-order  → intent=AUTHORIZE
onApprove    → POST /paypal/authorize-confirm → store authorization ID, do NOT capture
buyer confirms → POST /board/posts/:id/confirm-receipt
server       → POST /v2/payments/authorizations/{id}/capture
```

Do not call capture inside `onApprove` if you want delayed merchant receipt.

## What I need from you for this

- Decide Model A (merchant handles auth/capture) or Model B (platform marketplace).
- For Model B: PayPal Commerce Platform partner account, merchant onboarding, payee IDs, client ID/secret, webhook ID.
- Confirm authorization expiry/auto-release and refund policy in the terms.
- For Model A: merchant-side PayPal integration must support authorize/capture.

Current site uses the fee-only PayPal SDK flow, not escrow. It does not hold buyer funds.
