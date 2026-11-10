#!/usr/bin/env node
'use strict';
/**
 * Post the bit-settled launch text to a subreddit through Reddit OAuth.
 *
 * Required env:
 *   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET
 *   REDDIT_USERNAME + REDDIT_PASSWORD  (or REDDIT_REFRESH_TOKEN)
 *   REDDIT_SUBREDDIT, REDDIT_TITLE
 * Optional:
 *   REDDIT_BODY_FILE (default REDDIT-LAUNCH-BODY.txt or inline fallback)
 *   REDDIT_USER_AGENT, REDDIT_DRY_RUN=1
 *
 * Never commit credentials. The script prints no secrets.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const UA = process.env.REDDIT_USER_AGENT || 'bit-settled-launch/1.0';
const ID = (process.env.REDDIT_CLIENT_ID || '').trim();
const SECRET = (process.env.REDDIT_CLIENT_SECRET || '').trim();
const USER = (process.env.REDDIT_USERNAME || '').trim();
const PASS = process.env.REDDIT_PASSWORD || '';
const REFRESH = (process.env.REDDIT_REFRESH_TOKEN || '').trim();
const SUB = (process.env.REDDIT_SUBREDDIT || '').trim().replace(/^r\//i, '');
const TITLE = (process.env.REDDIT_TITLE || '').trim();
const DRY = process.env.REDDIT_DRY_RUN === '1';

function fail(message) { console.error('ERROR:', message); process.exit(1); }
if (!ID || !SECRET) fail('set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET');
if (!SUB || !TITLE) fail('set REDDIT_SUBREDDIT and REDDIT_TITLE');
if (!REFRESH && (!USER || !PASS)) fail('set REDDIT_REFRESH_TOKEN, or REDDIT_USERNAME + REDDIT_PASSWORD');

let body = '';
const bodyFile = process.env.REDDIT_BODY_FILE || path.join(ROOT, 'REDDIT-LAUNCH-BODY.txt');
if (fs.existsSync(bodyFile)) body = fs.readFileSync(bodyFile, 'utf8').trim();
if (!body) {
  body = [
    '**bit-settled — PayPal\'s merchant negotiation desk for the agent economy**',
    '',
    'A merchant publishes a catalog and policy; its native agent negotiates with any personal AI; both sign a contract; PayPal sandbox settles; a claim is refunded from the merchant reserve.',
    '',
    '- Board: https://cptlight-bit-settled.hf.space/board.html',
    '- Live rooms: https://cptlight-bit-settled.hf.space/live.html',
    '- Connect your AI: https://cptlight-bit-settled.hf.space/agent-connect.html',
    '- Remote MCP: https://cptlight-bit-settled.hf.space/mcp',
    '',
    'Public sandbox, no real money. External agents can drive the buyer side via REST, OpenAPI or MCP. Apache-2.0 hackathon prototype.',
    '',
    'Repo: https://github.com/cptlight/bit-settled'
  ].join('\n');
}

async function getToken() {
  const basic = Buffer.from(`${ID}:${SECRET}`).toString('base64');
  const form = new URLSearchParams();
  if (REFRESH) {
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', REFRESH);
  } else {
    form.set('grant_type', 'password');
    form.set('username', USER);
    form.set('password', PASS);
  }
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: form,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { fail(`token response was not JSON: ${text.slice(0, 200)}`); }
  if (!res.ok || !data.access_token) fail(`Reddit auth failed: ${data.error || text.slice(0, 200)}`);
  return data.access_token;
}

async function main() {
  console.log(`subreddit: r/${SUB}`);
  console.log(`title: ${TITLE}`);
  console.log(`body: ${body.length} chars`);
  if (DRY) { console.log('dry run: not submitting'); return; }

  const token = await getToken();
  const form = new URLSearchParams({
    api_type: 'json',
    kind: 'self',
    sr: SUB,
    title: TITLE,
    text: body,
    resubmit: 'false',
    sendreplies: 'true',
  });
  const res = await fetch('https://oauth.reddit.com/api/submit', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: form,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { fail(`submit response was not JSON: ${text.slice(0, 300)}`); }
  const errors = data && data.json && data.json.errors;
  if (!res.ok || (errors && errors.length)) fail(`submit failed: ${JSON.stringify(errors || data).slice(0, 500)}`);
  const url = data && data.json && data.json.data && data.json.data.url;
  console.log('posted:', url || '(Reddit returned no URL)');
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
