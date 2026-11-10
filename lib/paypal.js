'use strict';
/**
 * lib/paypal.js — optional live PayPal adapter, with a simulation fallback.
 * ZERO DEPENDENCIES (global fetch, node:https not needed).
 *
 * Sim mode is the demo path (default). Live mode activates only when
 * PAYPAL_LIVE=1 AND both credentials are present; every failure is surfaced as
 * a clean error the caller turns into a 502, never as corrupted state.
 *
 * Env:
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET
 *   PAYPAL_ENV=sandbox|live   (default sandbox)
 *   PAYPAL_LIVE=1             (enable live calls)
 */

const SIM = 'sim';
const LIVE = 'paypal';

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const ENV = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
const WANT_LIVE = process.env.PAYPAL_LIVE === '1';

const BASE =
  ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

/** 'paypal' when fully configured, otherwise 'sim'. */
function mode() {
  return WANT_LIVE && CLIENT_ID && CLIENT_SECRET ? LIVE : SIM;
}

function isLive() {
  return mode() === LIVE;
}

// --- sim -------------------------------------------------------------------
function simCreateOrder({ amount }) {
  return {
    id: 'SIM-' + require('crypto').randomBytes(8).toString('hex'),
    approval_url: null,
    simulated: true,
    amount,
  };
}

function simCaptureOrder(id) {
  return {
    id,
    status: 'COMPLETED',
    simulated: true,
  };
}

function simRefundCapture(captureId, { amount } = {}) {
  return {
    id: 'SIM-RF-' + require('crypto').randomBytes(8).toString('hex'),
    status: 'COMPLETED',
    simulated: true,
    capture_id: captureId,
    ...(amount === undefined || amount === null
      ? {}
      : { amount: { value: Number(amount).toFixed(2) } }),
  };
}

// --- live ------------------------------------------------------------------
let tokenCache = { token: null, expires_at: 0 };

async function accessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expires_at - 60_000 > now) return tokenCache.token;

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, 'utf8').toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`paypal oauth ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text);
  tokenCache = {
    token: json.access_token,
    expires_at: now + (Number(json.expires_in) || 3000) * 1000,
  };
  return tokenCache.token;
}

async function api(pathname, { method = 'GET', body } = {}) {
  const token = await accessToken();
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json && json.message ? json.message : text.slice(0, 300);
    const err = new Error(`paypal ${method} ${pathname} ${res.status}: ${detail}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

/**
 * Create an order for the agreed amount.
 * @returns {Promise<{id:string, approval_url:string|null}>}
 */
async function createOrder({ amount, currency = 'USD', returnUrl, platformFee, platformFeeBps } = {}) {
  if (!isLive()) return simCreateOrder({ amount, currency });

  const amountValue = Number(amount).toFixed(2);
  const purchaseUnit = {
    description: 'Settled protected purchase',
    amount: { currency_code: currency, value: amountValue },
  };
  // PayPal marketplace platform fee. This only succeeds for a partner/marketplace
  // account with a payee configured; otherwise the fee is recorded as accrued.
  if (
    Number(platformFee) > 0 &&
    process.env.PAYPAL_PLATFORM_FEES === '1' &&
    process.env.PAYPAL_PLATFORM_FEE_PAYEE
  ) {
    purchaseUnit.payment_instruction = {
      platform_fees: [
        {
          amount: { currency_code: currency, value: Number(platformFee).toFixed(2) },
          payee: { email_address: process.env.PAYPAL_PLATFORM_FEE_PAYEE },
        },
      ],
    };
  }
  const payload = {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit],
  };
  if (returnUrl) {
    payload.application_context = {
      brand_name: 'Settled',
      user_action: 'PAY_NOW',
      return_url: returnUrl,
      cancel_url: returnUrl,
    };
  }

  const order = await api('/v2/checkout/orders', { method: 'POST', body: payload });
  const link = (order && order.links ? order.links : []).find(
    (l) => l.rel === 'approve' || l.rel === 'payer-action'
  );
  return { id: order.id, approval_url: link ? link.href : null, status: order.status };
}

/** Capture a previously approved order. */
async function captureOrder(id) {
  if (!isLive()) return simCaptureOrder(id);
  return api(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
    method: 'POST',
    body: {},
  });
}

/**
 * Refund a captured payment (full when `amount` is omitted).
 * SIM returns a `SIM-RF-…` id so the demo path never needs credentials.
 * @returns {Promise<{id:string,status:string}>}
 */
async function refundCapture(captureId, { amount, currency = 'USD' } = {}) {
  if (!isLive()) return simRefundCapture(captureId, { amount });

  const payload =
    amount === undefined || amount === null
      ? {}
      : { amount: { currency_code: currency, value: Number(amount).toFixed(2) } };
  return api(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: 'POST',
    body: payload,
  });
}

/**
 * Fetch a PayPal order by id (live only; SIM returns null).
 * @returns {Promise<object|null>}
 */
async function getOrder(id) {
  if (!isLive()) return null;
  return api(`/v2/checkout/orders/${encodeURIComponent(id)}`);
}

/** Redacted config snapshot for /api/health and README diagnostics. */
function info() {
  return {
    mode: mode(),
    env: ENV,
    configured: Boolean(CLIENT_ID && CLIENT_SECRET),
    base: isLive() ? BASE : null,
  };
}

module.exports = {
  SIM,
  LIVE,
  mode,
  isLive,
  createOrder,
  captureOrder,
  refundCapture,
  getOrder,
  info,
};
