'use strict';
/**
 * lib/ai.js — real LLM layer (OpenAI-compatible) with a deterministic fallback.
 *
 * ZERO DEPENDENCIES (global fetch, AbortController).
 *
 * Design rule: the MODEL never decides anything that matters on its own.
 * The server computes the allowed candidate prices, the contract policy
 * validates whatever the model returns, and every failure path degrades to a
 * deterministic decision with `used:false`. The demo therefore works identically
 * with no API key at all.
 *
 * Env: AI_PROVIDER (openai|none), AI_API_KEY, AI_MODEL, AI_BASE_URL, AI_TIMEOUT_MS
 */

const PROVIDER_ENV = (process.env.AI_PROVIDER || '').trim().toLowerCase();
const API_KEY = (process.env.AI_API_KEY || '').trim();
const MODEL = (process.env.AI_MODEL || 'gpt-4o-mini').trim();
const BASE_URL = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) > 0 ? Number(process.env.AI_TIMEOUT_MS) : 8000;

// Infer the provider when only a key is supplied (friendlier for the demo).
const PROVIDER = PROVIDER_ENV ? PROVIDER_ENV : API_KEY ? 'openai' : 'none';

const round = (n) => Math.round(n);

/** Public config — never includes the API key. */
function config() {
  const enabled = available();
  return {
    enabled,
    provider: PROVIDER === 'openai' ? 'openai' : 'none',
    model: enabled ? MODEL : null,
    base_url: BASE_URL,
    timeout_ms: TIMEOUT_MS,
  };
}

function available() {
  return PROVIDER === 'openai' && Boolean(API_KEY);
}

/** reset() is a no-op: there is no per-process AI state to clear. */
function reset() {}

// --- LLM transport ---------------------------------------------------------
/**
 * One OpenAI-compatible chat completion returning parsed JSON.
 * Throws on any transport/shape error so callers can fall back.
 */
async function chatJson(messages, maxTokens = 300) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`llm ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text);
    const choice = (body && body.choices && body.choices[0]) || {};
    const message = choice.message || {};
    const finish = choice.finish_reason || 'unknown';

    // Reasoning models (e.g. gpt-oss) occasionally spend the whole budget on
    // `reasoning` and return empty `content`. Recover the JSON from either
    // field rather than falling back to the deterministic path mid-demo.
    const fromContent = tryParseJson(message.content);
    if (fromContent) return fromContent;
    const fromReasoning = extractJsonObject(message.reasoning);
    if (fromReasoning) return fromReasoning;
    throw new Error(`llm returned no parseable content (finish_reason=${finish})`);
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a JSON object from a string, or return null. */
function tryParseJson(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return extractJsonObject(value);
  }
}

/** Last-resort: pull the outermost {...} out of prose (reasoning traces). */
function extractJsonObject(value) {
  if (typeof value !== 'string') return null;
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const slice = value.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// --- buyer negotiation -----------------------------------------------------
/** Candidate prices the buyer agent may choose from (computed server-side). */
function candidatePrices(contract) {
  const list = Number(contract.list_price);
  const floor = Number(contract.policy.floor);
  const autoAccept = Number(contract.policy.auto_accept);
  const mandateMax = Number(contract.mandate.max);
  return [round(list * 0.86), round((floor + autoAccept) / 2), autoAccept].filter(
    (p) => Number.isFinite(p) && p > 0 && p <= mandateMax
  );
}

/** Snap an arbitrary model price onto the nearest allowed candidate. */
function clampToCandidates(price, candidates, mandateMax) {
  const allowed = candidates.filter((c) => c <= mandateMax);
  if (!allowed.length) return Math.min(mandateMax, candidates[0] || 0);
  let best = allowed[0];
  let bestDist = Math.abs(Number(price) - best);
  for (const c of allowed) {
    const d = Math.abs(Number(price) - c);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return Math.min(best, mandateMax);
}

function pickMove(contract) {
  const candidates = candidatePrices(contract);
  return candidates;
}

/**
 * Decide the buyer agent's next move.
 *
 * @param {{contract:object, lastMerchantPrice:number|null, round:number}} input
 * @returns {Promise<{used:boolean, provider:string, model:string|null,
 *   action:'offer'|'accept', price:number, message:string, rationale:string, error?:string}>}
 */
async function negotiateBuyer(input = {}) {
  const contract = input.contract || {};
  const lastMerchantPrice =
    input.lastMerchantPrice === undefined || input.lastMerchantPrice === null
      ? null
      : Number(input.lastMerchantPrice);
  const roundNo = Number(input.round) || 1;
  const mandateMax = Number(contract.mandate && contract.mandate.max);
  const candidates = pickMove(contract);

  const canAccept = lastMerchantPrice !== null && lastMerchantPrice <= mandateMax;

  // --- deterministic fallback (also the no-key path) ----------------------
  const fallbackFor = () => {
    if (roundNo >= 2 && canAccept) {
      return {
        action: 'accept',
        price: lastMerchantPrice,
        message: `Accepting the merchant's $${lastMerchantPrice} counter — inside my mandate of $${mandateMax}.`,
        rationale: 'Counter is within mandate; accepting closes the deal at the best standing price.',
      };
    }
    const target = round(Number(contract.list_price) * 0.86);
    const price = clampToCandidates(target, candidates, mandateMax);
    return {
      action: 'offer',
      price,
      message: `Opening at $${price} for ${contract.product_name || 'this item'}.`,
      rationale: 'Deterministic opening bid at 86% of list, inside floor and mandate.',
    };
  };

  if (!available()) {
    const fb = fallbackFor();
    return {
      used: false,
      provider: 'none',
      model: null,
      ...fb,
      error: 'ai_disabled',
    };
  }

  const system =
    'You are an autonomous procurement agent negotiating a purchase price. ' +
    'Reply ONLY with JSON: {"action":"offer"|"accept","price":number,"message":string,"rationale":string}. ' +
    'You may only offer one of the allowed_prices. Never exceed mandate_max. ' +
    'Only use "accept" when last_merchant_price is provided and <= mandate_max.';

  const user = JSON.stringify({
    item: contract.product_name,
    list_price: contract.list_price,
    allowed_prices: candidates,
    mandate_max: mandateMax,
    last_merchant_price: lastMerchantPrice,
    round: roundNo,
    can_accept: canAccept,
  });

  try {
    const out = await chatJson([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], 600);

    const wantsAccept = String(out.action).toLowerCase() === 'accept';
    if (wantsAccept && canAccept) {
      return {
        used: true,
        provider: 'openai',
        model: MODEL,
        action: 'accept',
        price: lastMerchantPrice,
        message: typeof out.message === 'string' ? out.message : `Accepting $${lastMerchantPrice}.`,
        rationale:
          typeof out.rationale === 'string'
            ? out.rationale
            : 'Model accepted the standing merchant counter.',
      };
    }

    // Anything else is an offer; the server snaps the price into policy.
    const price = clampToCandidates(out.price, candidates, mandateMax);
    const proposed = Number(out.price);
    const coerced = !Number.isFinite(proposed) || proposed !== price;
    return {
      used: true,
      provider: 'openai',
      model: MODEL,
      action: 'offer',
      price,
      message:
        typeof out.message === 'string'
          ? out.message
          : `Offering $${price} for ${contract.product_name || 'this item'}.`,
      rationale:
        typeof out.rationale === 'string'
          ? out.rationale
          : 'Model proposed an in-policy offer.',
      ...(coerced ? { error: `price_clamped_to_candidate:${price}` } : {}),
    };
  } catch (err) {
    const fb = fallbackFor();
    return {
      used: false,
      provider: 'openai',
      model: MODEL,
      ...fb,
      error: err && err.message ? err.message : 'llm_error',
    };
  }
}


/**
 * One-call negotiation plan: the buyer agent generates its opening offer and
 * the message it will use to accept the merchant's standing counter. This keeps
 * the AI genuinely in the loop while halving latency versus two sequential
 * model calls (important for local CPU models).
 *
 * @returns {Promise<{used:boolean, provider:string, model:string|null,
 *   opening_price:number, opening_message:string, opening_rationale:string,
 *   accept_message:string, accept_rationale:string, error?:string}>}
 */
async function planNegotiation(input = {}) {
  const contract = input.contract || {};
  const candidates = pickMove(contract);
  const mandateMax = Number(contract.mandate && contract.mandate.max);
  const list = Number(contract.list_price);
  const openingFallback = clampToCandidates(round(list * 0.86), candidates, mandateMax);


  // The merchant's counter price is POLICY, never model output. The model only
  // writes the words around it, so it can never move money.
  const counterPrice = Number(contract.policy && contract.policy.auto_accept);

  const merchantCounterMessageFallback = `I can meet you at $${counterPrice} — that's the best I can do within my published policy.`;
  const merchantCounterRationaleFallback =
    'Published seller policy fixes the auto-accept price; the merchant agent cannot move below it.';

  // POLICY: the buyer agent always OPENS with its anchor — the lowest in-policy
  // price strictly below the seller's auto-accept. Left unconstrained, a model
  // will often open at the auto-accept price to close fast, which skips the
  // counter round and turns the demo into a one-shot purchase. Anchoring is a
  // negotiating rule (like max_rounds), not a number the model gets to pick.
  const anchorCandidates = candidates.filter((c) => c < counterPrice);
  const openingPool = anchorCandidates.length ? anchorCandidates : candidates;

  const fallback = () => ({
    used: false,
    provider: 'none',
    model: null,
    opening_price: openingFallback,
    opening_message: `Opening at $${openingFallback} for ${contract.product_name || 'this item'}.`,
    // Deliberately avoids naming any private reservation price.
    opening_rationale: 'Deterministic opening bid at 86% of list, inside the buyer mandate.',
    merchant_counter_price: counterPrice,
    merchant_counter_message: merchantCounterMessageFallback,
    merchant_counter_rationale: merchantCounterRationaleFallback,
    accept_message: 'The merchant counter is inside my mandate; accepting the standing price.',
    accept_rationale: 'Standing merchant price is within the signed spend mandate.',
    error: 'ai_disabled',
  });

  if (!available()) return fallback();

  const system =
    'You are two agents negotiating one purchase. ' +
    'Reply ONLY with JSON: {"opening_price":number,"opening_message":string,"opening_rationale":string,' +
    '"merchant_counter_message":string,"merchant_counter_rationale":string,' +
    '"accept_message":string,"accept_rationale":string}. ' +
    'opening_price must be the LOWEST allowed price below merchant_counter_price (always anchor low; ' +
    'you never open at the seller ask). ' +
    'merchant_counter_price is FIXED by the seller published policy — never change it and never invent one; ' +
    'merchant_counter_message and merchant_counter_rationale are the seller agent\u2019s words about that fixed price. ' +
    'Never state or imply any price below merchant_counter_price. ' +
    'accept_message/accept_rationale are what the buyer agent says when accepting that counter. ' +
    'Keep every message under 25 words and every rationale under 20 words — terse, human, in-character.';
  const user = JSON.stringify({
    item: contract.product_name,
    list_price: list,
    allowed_prices: candidates,
    mandate_max: mandateMax,
    merchant_counter_price: counterPrice,
  });

  try {
    const out = await chatJson([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], 1200);
    const opening = clampToCandidates(out.opening_price, openingPool, mandateMax);
    const proposed = Number(out.opening_price);
    const coerced = !Number.isFinite(proposed) || proposed !== opening;
    const text = (v, fb) => (typeof v === 'string' && v.trim() ? v : fb);
    return {
      used: true,
      provider: 'openai',
      model: MODEL,
      opening_price: opening,
      opening_message: text(out.opening_message, `Opening at $${opening}.`),
      opening_rationale: text(out.opening_rationale, 'Model proposed an in-policy opening.'),
      // Price is always ours; only the prose can come from the model.
      merchant_counter_price: counterPrice,
      merchant_counter_message: text(out.merchant_counter_message, merchantCounterMessageFallback),
      merchant_counter_rationale: text(out.merchant_counter_rationale, merchantCounterRationaleFallback),
      accept_message: text(out.accept_message, 'Accepting the merchant counter.'),
      accept_rationale: text(out.accept_rationale, 'Counter is within the signed mandate.'),
      ...(coerced ? { error: `price_clamped_to_candidate:${opening}` } : {}),
    };
  } catch (err) {
    return { ...fallback(), provider: 'openai', model: MODEL, error: err && err.message ? err.message : 'llm_error' };
  }
}

// --- claim explanation -----------------------------------------------------
const APPROVABLE = new Set(['not_delivered', 'not_as_described', 'damaged']);
const RECOMMENDATIONS = new Set(['approve', 'review', 'deny']);

/**
 * Advise on a claim. The rule engine remains the final authority; this only
 * produces an explanation a human/judge can read.
 *
 * @param {{order:object, merchant:object, reason:string, evidence:boolean}} input
 * @returns {Promise<{used:boolean, provider:string, model:string|null,
 *   recommendation:'approve'|'review'|'deny', confidence:number, rationale:string, error?:string}>}
 */
async function explainClaim(input = {}) {
  const order = input.order || {};
  const merchant = input.merchant || {};
  const reason = input.reason;
  const evidence = input.evidence === true;

  const fallback = () => {
    const recommend = APPROVABLE.has(reason) && evidence ? 'approve' : 'review';
    return {
      recommendation: recommend,
      confidence: recommend === 'approve' ? 0.8 : 0.45,
      rationale:
        recommend === 'approve'
          ? `Reason "${reason}" with evidence is covered by the merchant's protection policy; approved for instant settlement.`
          : `Reason "${reason}" with evidence=${evidence} does not cleanly match policy; routing to manual review.`,
    };
  };

  if (!available()) {
    const fb = fallback();
    return { used: false, provider: 'none', model: null, ...fb };
  }

  const system =
    'You are a claims adjudication assistant for a buyer-protection product. ' +
    'Reply ONLY with JSON: {"recommendation":"approve"|"review"|"deny","confidence":number,"rationale":string}. ' +
    'confidence is 0..1. Base the decision on the stated reason, evidence flag, ' +
    'purchase amount, and the merchant reputation provided.';

  const user = JSON.stringify({
    reason,
    evidence,
    order_amount: order.amount,
    product: order.product_name,
    merchant: {
      id: merchant.id,
      tier: merchant.tier,
      score: merchant.score,
      reserve: merchant.reserve,
      mode: merchant.mode,
    },
  });

  try {
    const out = await chatJson([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], 600);
    const rec = String(out.recommendation || '').toLowerCase();
    const recommendation = RECOMMENDATIONS.has(rec) ? rec : 'review';
    let confidence = Number(out.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.5;
    confidence = Math.min(1, Math.max(0, confidence));
    return {
      used: true,
      provider: 'openai',
      model: MODEL,
      recommendation,
      confidence: Math.round(confidence * 100) / 100,
      rationale:
        typeof out.rationale === 'string' && out.rationale
          ? out.rationale
          : 'Model returned no rationale.',
    };
  } catch (err) {
    const fb = fallback();
    return {
      used: false,
      provider: 'openai',
      model: MODEL,
      ...fb,
      error: err && err.message ? err.message : 'llm_error',
    };
  }
}

// --- catalog drafting (agent-assisted merchant setup) ----------------------
const DRAFT_MIN = 1;
const DRAFT_MAX = 8;
const DRAFT_NAME_MAX = 120;
const DRAFT_DESCRIPTION_MAX = 400;
const DRAFT_PRICE_MIN = 1;
const DRAFT_PRICE_MAX = 100000;

/** Deterministic per-category item templates used by the no-AI fallback. */
const DRAFT_TEMPLATES = {
  audio: {
    items: ['Studio monitor headphones', 'Wireless earbuds', 'Portable speaker', 'USB condenser microphone',
      'Turntable cartridge', 'Soundbar', 'DAC amplifier', 'Replacement ear pads'],
    prices: [129, 89, 59, 149, 39, 199, 79, 29],
  },
  light: {
    items: ['Arc floor lamp', 'Dimmable desk lamp', 'Pendant light', 'Smart bulb pack',
      'Rope light kit', 'Task light', 'LED strip', 'Outdoor lantern'],
    prices: [119, 69, 45, 39, 25, 79, 35, 55],
  },
  gadget: {
    items: ['USB-C hub', 'Smart tracker', 'Mechanical keyboard', 'Portable charger',
      'Action camera', 'E-reader sleeve', 'Desk dock', 'Travel adapter'],
    prices: [79, 59, 49, 29, 99, 39, 149, 45],
  },
  general: {
    items: ['Everyday tote', 'Desk organizer', 'Ceramic mug', 'Notebook set',
      'Travel pouch', 'Insulated bottle', 'Cable tidy kit', 'Gift card holder'],
    prices: [45, 29, 19, 24, 35, 39, 15, 12],
  },
};

function draftTemplateFor(merchant, categories) {
  const hay = `${(categories || []).join(' ')} ${merchant.category || ''} ${merchant.name || ''}`.toLowerCase();
  if (/audio|head|sound|music|speaker|hifi/.test(hay)) return DRAFT_TEMPLATES.audio;
  if (/light|lamp|lumen|home|decor|furnitur/.test(hay)) return DRAFT_TEMPLATES.light;
  if (/gadget|tech|electronic|projector|drone|accessor/.test(hay)) return DRAFT_TEMPLATES.gadget;
  return DRAFT_TEMPLATES.general;
}

function shortBrand(merchant) {
  const name = typeof merchant.name === 'string' ? merchant.name.trim() : '';
  if (!name) return '';
  return name.split(/\s+/)[0];
}

/** Deterministic products so the demo works with no API key at all. */
function fallbackDraftProducts({ merchant, count, categories }) {
  const template = draftTemplateFor(merchant || {}, categories);
  const brand = shortBrand(merchant || {});
  const category = (categories && categories[0]) || merchant.category || 'Uncategorised';
  const n = Math.min(count, template.items.length);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const label = template.items[i];
    out.push({
      name: brand ? `${brand} ${label}` : label,
      price: template.prices[i],
      category,
      description: `Drafted from the merchant brief; sample ${category.toLowerCase()} item.`,
    });
  }
  return out;
}

/** Coerce a model price ("$129.00", 129, "129") to a rounded number. */
function draftPrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** Validate one drafted product; returns null when unusable. */
function sanitizeDraftProduct(raw, fallbackCategory) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, DRAFT_NAME_MAX) : '';
  if (!name) return null;
  const price = round(draftPrice(raw.price));
  if (!Number.isFinite(price) || price < DRAFT_PRICE_MIN || price > DRAFT_PRICE_MAX) return null;
  let category = typeof raw.category === 'string' ? raw.category.trim().slice(0, 60) : '';
  if (!category) category = fallbackCategory || 'Uncategorised';
  const description = typeof raw.description === 'string'
    ? raw.description.trim().slice(0, DRAFT_DESCRIPTION_MAX)
    : '';
  return { name, price, category, description };
}

/**
 * Draft a small product catalog from a plain-language brief.
 *
 * One model call; the server validates every field and never trusts the model
 * for critical data. Falls back to a deterministic 3-item catalog (or `count`
 * items, capped at 8) when the AI is unavailable or returns nothing usable.
 * The prompt carries only PUBLIC merchant context — never the private range.
 *
 * @param {{merchant?:object, brief?:string, count?:number, categories?:string[]}} input
 * @returns {Promise<{used:boolean, provider:string, model:string|null,
 *   products:Array<{name:string,price:number,category:string,description:string}>,
 *   error?:string}>}
 */
async function draftCatalog(input = {}) {
  const merchant = input.merchant && typeof input.merchant === 'object' ? input.merchant : {};
  const brief = typeof input.brief === 'string' ? input.brief.trim() : '';
  const requested = Number(input.count);
  const count = Number.isFinite(requested)
    ? Math.min(DRAFT_MAX, Math.max(DRAFT_MIN, Math.floor(requested)))
    : 3;
  const categories = Array.isArray(input.categories)
    ? input.categories.filter((c) => typeof c === 'string' && c.trim()).slice(0, 20)
    : [];
  const fallbackCategory = categories[0] || merchant.category || 'Uncategorised';

  const fallback = (error) => ({
    used: false,
    provider: available() ? 'openai' : 'none',
    model: available() ? MODEL : null,
    count,
    products: fallbackDraftProducts({ merchant, count, categories }),
    error,
  });

  if (!available()) return fallback('ai_disabled');

  // PUBLIC context only: id/name/domain/category. Never reserve/sell_min/etc.
  const system =
    'You are a merchant operations assistant that drafts a starter product catalog. ' +
    'Reply ONLY with JSON: {"products":[{"name":string,"price":number,"category":string,"description":string}]}. ' +
    `Return exactly ${count} product(s). Prices are positive USD numbers. ` +
    'Use short, concrete product names and one-sentence descriptions. ' +
    'Never include private pricing policy (reservation floors, auto-accept prices, publish minimums).';
  const user = JSON.stringify({
    merchant: {
      id: merchant.id || null,
      name: merchant.name || null,
      domain: merchant.domain || null,
      category: merchant.category || null,
    },
    brief: brief.slice(0, 1000),
    count,
    categories,
  });

  try {
    const out = await chatJson([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], Math.max(700, count * 180));

    const rawList = Array.isArray(out.products)
      ? out.products
      : Array.isArray(out.items)
        ? out.items
        : null;
    if (!rawList) throw new Error('llm returned no products array');

    const products = [];
    for (const raw of rawList) {
      const product = sanitizeDraftProduct(raw, fallbackCategory);
      if (product) products.push(product);
      if (products.length >= count) break;
    }
    if (!products.length) throw new Error('llm returned no valid products');
    return {
      used: true,
      provider: 'openai',
      model: MODEL,
      count: products.length,
      products,
    };
  } catch (err) {
    return fallback(err && err.message ? err.message : 'llm_error');
  }
}


/**
 * Interpret a plain-language buyer instruction into a product + budget.
 * The model only chooses among PUBLIC catalog items; the server validates the
 * product and clamps the budget to the published/list range.
 */
async function interpretInstruction(input = {}) {
  const instruction = typeof input.instruction === 'string' ? input.instruction.trim().slice(0, 400) : '';
  const products = Array.isArray(input.products) ? input.products : [];
  const buyerName = input.buyer_name || 'your agent';
  const fallback = (error) => {
    const lower = instruction.toLowerCase();
    const match = products.find((p) => lower.includes(String(p.name || '').toLowerCase().slice(0, 18)));
    const selected = match || products[0] || null;
    const money = instruction.match(/(?:under|below|max|budget|up to|around|about)\s*\$?\s*(\d+)/i);
    const defaultBudget = selected ? Math.max(1, Math.round(Number(selected.price) * 0.95)) : 100;
    const budget = money ? Number(money[1]) : defaultBudget;
    return {
      used: false,
      provider: available() ? 'openai' : 'none',
      model: available() ? MODEL : null,
      product_id: selected ? selected.id : null,
      budget,
      reply: `I’ll try to get ${selected ? selected.name : 'the item'} for you, inside the merchant’s published policy.`,
      error,
    };
  };
  if (!instruction) throw new Error('instruction is required');
  if (!products.length) throw new Error('no public products available');
  if (!available()) return fallback('ai_disabled');

  const publicProducts = products.slice(0, 30).map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    list_price: p.price,
    published_range: p.published_range || null,
  }));
  const system = 'You are a personal shopping agent. Read the buyer instruction and choose exactly one product from the PUBLIC catalog. ' +
    'Reply ONLY with JSON: {"product_id":string,"budget":number,"reply":string}. ' +
    'budget is the maximum the buyer will pay, in USD; use the number the buyer says, otherwise a sensible price at or below list. ' +
    'reply is one short sentence in the buyer’s voice. Never invent a product id and never mention private policy.';
  const user = JSON.stringify({ buyer_name: buyerName, instruction, products: publicProducts });
  try {
    const out = await chatJson([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], 320);
    const id = typeof out.product_id === 'string' ? out.product_id : '';
    const selected = products.find((p) => p.id === id) || products.find((p) => id && p.name === id);
    if (!selected) throw new Error('model returned an unknown product_id');
    const list = Number(selected.price) || 0;
    const pub = selected.published_range || {};
    const min = Number(pub.min) || Math.round(list * 0.82);
    const budget = Math.max(min, Math.min(list, Math.round(Number(out.budget) || list)));
    return {
      used: true,
      provider: 'openai',
      model: MODEL,
      product_id: selected.id,
      budget,
      reply: typeof out.reply === 'string' && out.reply.trim() ? out.reply.trim().slice(0, 240) : fallback().reply,
    };
  } catch (err) {
    return fallback(err && err.message ? err.message : 'llm_error');
  }
}

module.exports = {
  config,
  planNegotiation,
  available,
  negotiateBuyer,
  explainClaim,
  draftCatalog,
  interpretInstruction,
  reset,
  candidatePrices,
  clampToCandidates,
};
