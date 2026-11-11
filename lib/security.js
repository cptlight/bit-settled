'use strict';
/**
 * lib/security.js — production-hardening helpers.
 *
 * - Security response headers (nosniff, referrer, permissions, HSTS on https,
 *   frame policy with an embed allow-list).
 * - In-memory fixed-window rate limiter for auth/write endpoints (never reads).
 * - 64KB request-body cap constant.
 * - scrypt password hashing (never plaintext) and hashed, revocable sessions.
 *
 * Sessions are random 32-byte tokens returned once; only their sha256 hash is
 * kept in data.state.auth_sessions. No secret is written outside data.state.
 */

const crypto = require('crypto');
const data = require('./data');

const MAX_BODY_BYTES = 64 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_DEFAULT = 60;
const RATE_WINDOW_MS = 60 * 1000;
const SCRYPT_KEYLEN = 64;

const buckets = new Map();

function env(name, fallback) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function publicUrl() {
  return (env('PUBLIC_SITE_URL', '') || env('PUBLIC_BASE_URL', '')).replace(/\/+$/, '');
}

function isHttps() {
  return /^https:\/\//i.test(publicUrl());
}

/** Embeddable pages are allowed to be iframed; everything else is SAMEORIGIN. */
function isEmbedPath(pathname) {
  if (env('EMBED_ALLOWED', '') === '1') return true;
  const p = String(pathname || '');
  return p === '/embed-demo.html' || p === '/settled-widget.js' || p.startsWith('/embed/') || p.startsWith('/widget/');
}

function headersFor(pathname) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
  if (isHttps()) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  if (isEmbedPath(pathname)) {
    headers['Content-Security-Policy'] = 'frame-ancestors *';
  } else {
    headers['X-Frame-Options'] = 'SAMEORIGIN';
  }
  return headers;
}

/** Apply hardening headers to every response (call once, early). */
function applyHeaders(res, pathname) {
  for (const [name, value] of Object.entries(headersFor(pathname))) {
    res.setHeader(name, value);
  }
}

// --- rate limiting ---------------------------------------------------------
function clientIp(req) {
  if (env('TRUST_PROXY', '') === '1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function limitPerMin() {
  const configured = Number(process.env.RATE_LIMIT_PER_MIN);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : RATE_LIMIT_DEFAULT;
}

function pruneBuckets(now) {
  if (buckets.size < 2000) return;
  for (const [key, bucket] of buckets) {
    if (!bucket || now >= bucket.resetAt) buckets.delete(key);
  }
}

/**
 * Fixed-window limiter keyed by category + IP + account.
 * Reads are never passed through this function.
 * @returns {{limited:boolean, remaining?:number, retryAfter?:number}}
 */
function rateLimit(req, category, accountId) {
  const limit = limitPerMin();
  const key = `${category}|${clientIp(req)}|${accountId || '-'}`;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    buckets.set(key, bucket);
    pruneBuckets(now);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { limited: true, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)), limit };
  }
  return { limited: false, remaining: limit - bucket.count, limit };
}

function resetRateLimits() {
  buckets.clear();
}

// --- passwords -------------------------------------------------------------
function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw Object.assign(new Error('password must be 8-200 characters'), { status: 400, code: 'INVALID_PASSWORD' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { alg: 'scrypt', salt, hash, created_at: data.nowIso() };
}

function verifyPassword(password, stored) {
  if (!stored || stored.alg !== 'scrypt' || typeof stored.salt !== 'string' || typeof stored.hash !== 'string') return false;
  try {
    const actual = crypto.scryptSync(String(password), stored.salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(stored.hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --- sessions --------------------------------------------------------------
function sessionStore() {
  if (!Array.isArray(data.state.auth_sessions)) data.state.auth_sessions = [];
  return data.state.auth_sessions;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function publicSession(session) {
  return {
    id: session.id,
    account_id: session.account_id,
    created_at: session.created_at,
    expires_at: session.expires_at,
  };
}

/** Issue a session token (raw token returned once, hash persisted). */
function createSession(accountId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const session = {
    id: 'sess_' + data.randHex(8),
    account_id: accountId,
    token_hash: tokenHash(token),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    revoked_at: null,
  };
  const store = sessionStore();
  store.unshift(session);
  if (store.length > 5000) store.splice(5000);
  return { token, session: publicSession(session) };
}

function verifySession(token) {
  if (typeof token !== 'string' || !token) return null;
  const hash = tokenHash(token);
  const now = Date.now();
  const session = sessionStore().find((entry) =>
    entry && entry.token_hash === hash && !entry.revoked_at && Date.parse(entry.expires_at) > now
  );
  return session ? { session: publicSession(session), account_id: session.account_id } : null;
}

function revokeSession(token) {
  if (typeof token !== 'string' || !token) return false;
  const hash = tokenHash(token);
  const session = sessionStore().find((entry) => entry && entry.token_hash === hash && !entry.revoked_at);
  if (!session) return false;
  session.revoked_at = new Date().toISOString();
  return true;
}

function revokeAccountSessions(accountId) {
  let count = 0;
  const revokedAt = new Date().toISOString();
  for (const session of sessionStore()) {
    if (session && session.account_id === accountId && !session.revoked_at) {
      session.revoked_at = revokedAt;
      count += 1;
    }
  }
  return count;
}

function resetSessions() {
  data.state.auth_sessions = [];
}

module.exports = {
  MAX_BODY_BYTES,
  SESSION_TTL_MS,
  applyHeaders,
  headersFor,
  isEmbedPath,
  isHttps,
  rateLimit,
  resetRateLimits,
  limitPerMin,
  hashPassword,
  verifyPassword,
  createSession,
  verifySession,
  revokeSession,
  revokeAccountSessions,
  resetSessions,
};
