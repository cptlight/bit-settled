# PayPal SDK production setup — Model A

Confirmed platform fee account: **tt@iamtrillion.com**.

The custom board uses the official **PayPal JS SDK** on `fee.html` to collect the **0.5% platform fee** after a deal closes. The buyer pays the merchant directly; bit-settled does not hold buyer funds.

## What is already live

- Closed deals show **Pay 0.5% fee with PayPal**
- `fee.html` renders PayPal Buttons
- Server creates the fee order with **Orders v2**
- Server captures after PayPal approval
- Sandbox order verified: $120 deal → **$0.60 fee order**

## What I need to switch to live

1. **A PayPal REST app under the `tt@iamtrillion.com` business account**
   - Go to https://developer.paypal.com/dashboard/applications
   - Toggle **Live**
   - Create an app (e.g. `bitsettled fee`)
   - Copy **Client ID** and **Secret**
2. **Allowed domain / return URL**
   - Add `bitsettled.com` as an allowed JavaScript SDK domain if the app asks.
   - Return URL: `https://bitsettled.com/fee.html`
3. **Store credentials only as HF Space secrets**
   - `PAYPAL_CLIENT_ID`
   - `PAYPAL_CLIENT_SECRET`
   - `PAYPAL_ENV=live`
   - `PAYPAL_LIVE=1`
   - `PUBLIC_SITE_URL=https://bitsettled.com`
   - `PUBLIC_BASE_URL=https://cptlight-bit-settled.hf.space`
4. **Currency / country**
   - Confirm USD and the account country.
5. **Business account status**
   - The account must be able to receive payments and have completed PayPal KYC.
6. **Optional webhook**
   - If you want asynchronous capture reconciliation, provide a webhook ID and endpoint; the current flow captures synchronously after approval.

## Do not send secrets in chat

Put them directly in the HF Space settings or a local `.env`. I can verify the configuration and test the fee checkout after they are set.

## Important

- This is a **platform fee** charge, not the product purchase.
- An ordinary merchant checkout cannot automatically skim 0.5%; the fee page is a separate PayPal order to the platform account.
- Automatic per-transaction marketplace fees at the merchant's checkout require **PayPal Commerce Platform partner** onboarding.
