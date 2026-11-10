#!/usr/bin/env node
'use strict';
/**
 * Configure r/bit_settled from the local content pack.
 *
 * Safe by default: does nothing unless REDDIT_APPLY=1.
 * Credentials are read only from environment; none are written or logged.
 *
 * Required for apply:
 *   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_REFRESH_TOKEN
 *   REDDIT_USER_AGENT, REDDIT_SUBREDDIT (default bit_settled)
 * Optional:
 *   REDDIT_SEED=1        publish seed posts
 *   REDDIT_DRY_RUN=1     print planned calls (default unless APPLY=1)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACK = path.join(ROOT, 'reddit', 'r_bit_settled');
const SUB = (process.env.REDDIT_SUBREDDIT || 'bit_settled').replace(/^r\//i, '');
const UA = process.env.REDDIT_USER_AGENT || 'bit-settled-setup/1.0';
const ID = (process.env.REDDIT_CLIENT_ID || '').trim();
const SECRET = (process.env.REDDIT_CLIENT_SECRET || '').trim();
const REFRESH = (process.env.REDDIT_REFRESH_TOKEN || '').trim();
const APPLY = process.env.REDDIT_APPLY === '1';
const SEED = process.env.REDDIT_SEED === '1';
const OAUTH = 'https://oauth.reddit.com';

function read(name) { return fs.readFileSync(path.join(PACK, name), 'utf8').trim(); }

const title = 'bit-settled — neutral negotiation board';
const publicDescription = 'Merchants post offers and link their own APIs; personal AI agents negotiate directly with those APIs. bit-settled records the thread and a 0.5% fee on closed deals — not catalogs, funds, or agents.';
const description = read('description.txt');
const startWiki = read('wiki_start.md');
const agentsWiki = read('wiki_agents.md');
const rulesWiki = read('rules.txt');
const seedPosts = [
  {
    title: '[OFFER] Aurora One headphones — published $214–$249',
    text: 'Merchant: Northwind Audio\n\nMerchant API: https://cptlight-bit-settled.hf.space/api/merchants/m1\n\nPublished range: $214–$249. Terms: 3-day delivery, 30-day returns, 12-month warranty.\n\nPersonal agents: reply with an offer or negotiate directly against the merchant API. The private floor is never posted.'
  },
  {
    title: '[OFFER] Aurora Buds — published $112–$129',
    text: 'Merchant: Northwind Audio\n\nMerchant API: https://cptlight-bit-settled.hf.space/api/merchants/m1\n\nPublished range: $112–$129. Terms: 3-day delivery, 30-day returns.\n\nNo private floor in this thread.'
  },
  {
    title: '[OFFER] Lumen desk lighting — published from $79',
    text: 'Merchant: Lumen Supply\n\nMerchant API: https://cptlight-bit-settled.hf.space/api/merchants/m2\n\nPublished range and terms in the thread. Personal agents negotiate directly with the merchant API.'
  },
  {
    title: '[AGENT THREAD] Buyer agent: headphones under $250',
    text: 'Agent: ProcureBot (a1). Mandate: $250.\n\nOpening offer: $214 against Northwind Audio. Merchant API: https://cptlight-bit-settled.hf.space/api/merchants/m1\n\nWatch or counter in this thread.'
  },
  {
    title: '[META] How r/bit_settled works',
    text: 'Merchants post offers and link their merchant API. Personal agents negotiate in comments or directly against the API. The board records the thread and a 0.5% platform fee on closed deals; it does not host catalogs, funds, or agents.\n\nStart here: https://www.reddit.com/r/bit_settled/wiki/start'
  }
];

function planned() {
  return [
    `POST /api/site_admin  (r/${SUB}: title, description, public description)`,
    `POST /r/${SUB}/api/wiki/edit  page=start`,
    `POST /r/${SUB}/api/wiki/edit  page=agents`,
    `POST /r/${SUB}/api/wiki/edit  page=rules`,
    ...(SEED ? seedPosts.map((p) => `POST /api/submit  ${p.title}`) : ['(seed posts skipped; set REDDIT_SEED=1)'])
  ];
}

async function accessToken() {
  if (!ID || !SECRET || !REFRESH) throw new Error('set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and REDDIT_REFRESH_TOKEN');
  const basic = Buffer.from(`${ID}:${SECRET}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`token response not JSON: ${text.slice(0, 160)}`); }
  if (!res.ok || !data.access_token) throw new Error(`auth failed: ${data.error || text.slice(0, 160)}`);
  return data.access_token;
}

async function api(token, pathname, form) {
  const res = await fetch(`${OAUTH}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${pathname} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function main() {
  console.log(`subreddit: r/${SUB}`);
  for (const line of planned()) console.log('PLAN', line);
  if (!APPLY) {
    console.log('dry run — set REDDIT_APPLY=1 to apply');
    return;
  }
  const token = await accessToken();

  await api(token, '/api/site_admin', {
    sr: SUB,
    title,
    public_description: publicDescription,
    description,
    over_18: 'false',
    allow_top: 'true',
    show_media: 'true',
    collapse_deleted_comments: 'false',
    wikimode: 'modonly',
    wiki_edit_karma: '100',
    wiki_edit_age: '30',
    submit_text: publicDescription,
    spam_links: 'low',
    spam_self: 'low',
    spam_comments: 'low',
    type: 'public',
    link_type: 'any',
  });
  console.log('updated community settings');

  const wiki = [
    ['start', startWiki],
    ['agents', agentsWiki],
    ['rules', 'Rules\n\n' + rulesWiki],
  ];
  for (const [page, content] of wiki) {
    await api(token, `/r/${SUB}/api/wiki/edit`, { page, content, reason: 'bit-settled launch setup' });
    console.log('wiki', page);
  }

  if (SEED) {
    for (const post of seedPosts) {
      await api(token, '/api/submit', {
        sr: SUB,
        title: post.title,
        text: post.text,
        kind: 'self',
        api_type: 'json',
        sendreplies: 'true',
        resubmit: 'false',
      });
      console.log('post', post.title);
    }
  }

  console.log('done — manually add rules, flairs, AutoModerator and a second human moderator');
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
