'use strict';
/**
 * lib/moderation.js — reports, hidden posts and an admin audit trail.
 *
 * Data lives in data.state:
 *   moderation_reports  [{id, post_id, reason, status, reporter, created_at, actioned_at}]
 *   moderation_hidden   { [post_id]: {id, hidden_at, reason, post} }
 *   moderation_actions  [{id, action, post_id, reason, actor, created_at}]
 *
 * Admin access requires ADMIN_API_KEY (x-admin-key header). When the env var is
 * unset the whole surface is disabled (404) — no default admin secret ships.
 * The configured key is never echoed in a response or stored in state.
 */

const crypto = require('crypto');
const data = require('./data');
const board = require('./board');

const REPORT_STATUSES = ['open', 'actioned'];

function env(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bad(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function reset() {
  data.state.moderation_reports = [];
  data.state.moderation_actions = [];
  data.state.moderation_hidden = {};
}

function reports() {
  if (!Array.isArray(data.state.moderation_reports)) data.state.moderation_reports = [];
  return data.state.moderation_reports;
}

function actions() {
  if (!Array.isArray(data.state.moderation_actions)) data.state.moderation_actions = [];
  return data.state.moderation_actions;
}

function hidden() {
  if (!plainObject(data.state.moderation_hidden)) data.state.moderation_hidden = {};
  return data.state.moderation_hidden;
}

function isHidden(postId) {
  return Boolean(postId && hidden()[String(postId)]);
}

// --- admin gate ------------------------------------------------------------
function enabled() {
  return Boolean(env('ADMIN_API_KEY'));
}

/** {disabled} | {ok:true} | {ok:false} — constant-time key comparison. */
function adminStatus(req) {
  const configured = env('ADMIN_API_KEY');
  if (!configured) return { disabled: true };
  const provided = text(req && req.headers && req.headers['x-admin-key']);
  if (!provided) return { ok: false };
  const a = Buffer.from(configured, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok };
}

// --- post summaries --------------------------------------------------------
function summary(post, isHiddenPost) {
  if (!post) return null;
  return {
    id: String(post.id),
    title: typeof post.title === 'string' ? post.title : '',
    author: (post.merchant && post.merchant.name) || post.author || null,
    category: post.category || 'General',
    status: post.status || 'open',
    kind: post.kind || 'external',
    hidden: Boolean(isHiddenPost),
  };
}

function postSummary(postId) {
  const id = String(postId);
  const record = hidden()[id];
  const post = board.get(id); // null while hidden (board.get filters moderated posts)
  if (post) return summary(post, false);
  if (record && record.post) return Object.assign({}, record.post, { hidden: true });
  return null;
}

function recordAction(action, postId, reason) {
  const entry = {
    id: 'act_' + data.randHex(8),
    action,
    post_id: String(postId),
    reason: text(reason),
    actor: 'admin',
    created_at: data.nowIso(),
  };
  const store = actions();
  store.unshift(entry);
  if (store.length > 2000) store.splice(2000);
  return entry;
}

// --- reports ---------------------------------------------------------------
function report(postId, reason, account) {
  const id = text(postId);
  if (!id) throw bad(400, 'POST_REQUIRED', 'post_id is required');
  if (isHidden(id)) throw bad(404, 'MODERATED', 'post is hidden by moderation');
  const post = board.get(id);
  if (!post) throw bad(404, 'POST_NOT_FOUND', `no board post '${id}'`);
  const why = text(reason);
  if (!why) throw bad(400, 'REASON_REQUIRED', 'reason is required');
  if (why.length > 500) throw bad(400, 'INVALID_REASON', 'reason must be 500 characters or fewer');
  const entry = {
    id: 'rep_' + data.randHex(8),
    post_id: id,
    reason: why.slice(0, 500),
    status: 'open',
    reporter: {
      account_id: account ? account.id : null,
      role: account ? account.role : null,
      display_name: account ? account.display_name : null,
    },
    created_at: data.nowIso(),
    actioned_at: null,
  };
  const store = reports();
  store.unshift(entry);
  if (store.length > 2000) store.splice(2000);
  return { report: entry };
}

function queue(status) {
  const wanted = status === undefined || status === null || status === '' ? 'open' : String(status);
  const allowed = ['open', 'actioned', 'all', 'hidden'];
  if (!allowed.includes(wanted)) throw bad(400, 'INVALID_STATUS', `status must be one of: ${allowed.join(', ')}`);
  const hiddenCount = Object.keys(hidden()).length;
  const generatedAt = data.nowIso();
  if (wanted === 'hidden') {
    const posts = Object.values(hidden())
      .filter((record) => plainObject(record))
      .map((record) => ({
        ...(record.post || { id: record.id }),
        hidden: true,
        hidden_at: record.hidden_at,
        reason: record.reason || null,
      }))
      .sort((a, b) => String(b.hidden_at || '').localeCompare(String(a.hidden_at || '')));
    return { status: wanted, count: posts.length, hidden_count: hiddenCount, generated_at: generatedAt, reports: [], posts };
  }
  const list = reports()
    .filter((entry) => plainObject(entry))
    .filter((entry) => wanted === 'all' || entry.status === wanted)
    .map((entry) => Object.assign({}, entry, { post: postSummary(entry.post_id) }));
  return { status: wanted, count: list.length, hidden_count: hiddenCount, generated_at: generatedAt, reports: list };
}

// --- hide / restore --------------------------------------------------------
function snapshot(post) {
  const out = summary(post, false);
  return {
    id: out.id,
    title: out.title,
    author: out.author,
    category: out.category,
    status: out.status,
    kind: out.kind,
  };
}

function hide(postId, reason) {
  const id = text(postId);
  if (!id) throw bad(400, 'POST_REQUIRED', 'post_id is required');
  const existing = hidden()[id];
  if (existing) {
    return {
      hidden: true,
      already_hidden: true,
      post: { id, hidden: true },
      action: null,
    };
  }
  const post = board.get(id);
  if (!post) throw bad(404, 'POST_NOT_FOUND', `no board post '${id}'`);
  const record = { id, hidden_at: data.nowIso(), reason: text(reason), post: snapshot(post) };
  hidden()[id] = record;
  const actionedAt = data.nowIso();
  let actioned = 0;
  for (const entry of reports()) {
    if (entry && entry.post_id === id && entry.status === 'open') {
      entry.status = 'actioned';
      entry.actioned_at = actionedAt;
      actioned += 1;
    }
  }
  const action = recordAction('hide', id, reason);
  return {
    hidden: true,
    post: { id, hidden: true },
    action,
    reports_actioned: actioned,
  };
}

function restore(postId) {
  const id = text(postId);
  if (!id) throw bad(400, 'POST_REQUIRED', 'post_id is required');
  if (!isHidden(id)) {
    const post = board.get(id);
    if (!post) throw bad(404, 'POST_NOT_FOUND', `no board post '${id}'`);
    return { hidden: false, already_visible: true, post: { id, hidden: false }, action: null };
  }
  delete hidden()[id];
  const action = recordAction('restore', id);
  return { hidden: false, post: { id, hidden: false }, action };
}

function audit() {
  const list = actions().filter((entry) => plainObject(entry));
  return { count: list.length, actions: list };
}

module.exports = {
  enabled,
  adminStatus,
  reset,
  isHidden,
  report,
  queue,
  hide,
  restore,
  audit,
  // exposed for tests / internal tooling
  reports,
  actions,
  hidden,
};
