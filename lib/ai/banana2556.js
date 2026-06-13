// Adapter for Banana2556 (OpenAI-compatible proxy at api.banana2556.com).
//
// Standard /v1/chat/completions endpoint, Bearer auth. The proxy quotes a
// 15 000-char per-call budget on its panel, so we expose that to lib/report
// via the `charBudget` export; report.js will progressively shrink the
// prompt to fit before sending.

const DEFAULT_MODEL = 'claude-sonnet-4-6';
// Fallback chain — tried in order when the previous model errors out.
// Stops at the first successful response. Always starts with the most
// capable model; degrades through the GPT family then the DeepSeek tier.
// Errors that trigger fall-through: 4xx (other than 429), 5xx, parse
// failures, empty responses. 429 does NOT fall through because the
// proxy quota is global ("总请求数限制") — trying the next model would
// just burn the same quota.
//
// Honoured for the unpinned path only: if BANANA2556_MODEL env var or
// opts.model is set, that model is used alone (chain bypassed) so ops
// can pin a specific one for testing or stability.
const MODEL_CHAIN = [
  'claude-sonnet-4-6',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-mini-as',
  'gpt-5.4-nano-as',
  'gpt-5.3-codex',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4-flash-free',
];
// Empirical: the proxy returned 502 "Single message too long" at ~12 k
// chars, so we keep the budget at 10 k for safety. That's still enough
// for the prompt-shrink loop in lib/report.js to land on variant 4
// (2 samples × 80 chars/body) — enough sample text for the AI to pull
// keyword themes from. Lower budgets (e.g. 6 k) force variant 6 which
// wipes new_ads_sample entirely and produces "sample 空" reports.
const PER_CALL_CHAR_BUDGET = 10000;
const BASE_URL = 'https://api.banana2556.com';

// Rate limit: proxy returns 429 after 15 req/minute (failures count too).
// Weekly-report path can fire 16 calls back-to-back (15 per-target theme
// extractions + 1 aggregate), so we pace at 14/60s — one under the cap
// to leave headroom for clock skew between our clock and the proxy's.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CALLS = 14;
const recentCalls = [];

async function awaitRateSlot() {
  const now = Date.now();
  while (recentCalls.length && recentCalls[0] <= now - RATE_LIMIT_WINDOW_MS) {
    recentCalls.shift();
  }
  if (recentCalls.length >= RATE_LIMIT_MAX_CALLS) {
    const sleepMs = recentCalls[0] + RATE_LIMIT_WINDOW_MS - now + 100;
    console.log(`[banana2556] pacing: sleeping ${sleepMs}ms (${recentCalls.length} calls in last 60s)`);
    await new Promise((r) => setTimeout(r, sleepMs));
    return awaitRateSlot();
  }
  recentCalls.push(Date.now());
}

async function postChat(apiKey, body) {
  await awaitRateSlot();
  return fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

// Send one request for one specific model and either return a normalised
// result or throw. 429s get one in-place retry after a full window sleep
// (proxy may have started its window earlier than us, e.g. after a Render
// warm restart wiped recentCalls). All other failures bubble up — the
// caller decides whether to fall through the model chain.
async function chatOnce(apiKey, model, messages, opts) {
  const body = { model, messages };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  console.log(`[banana2556] sending ${JSON.stringify(messages).length} chars (system ${(opts.system || '').length}, model ${model})`);

  let res = await postChat(apiKey, body);

  if (res.status === 429) {
    const peek = await res.clone().text();
    console.warn(`[banana2556] 429 from proxy (${peek.slice(0, 200)}). Sleeping ${RATE_LIMIT_WINDOW_MS}ms then retrying once.`);
    await new Promise((r) => setTimeout(r, RATE_LIMIT_WINDOW_MS));
    recentCalls.length = 0;
    res = await postChat(apiKey, body);
  }

  if (!res.ok) {
    const errBody = await res.text();
    const err = new Error(`Banana2556 ${res.status} on ${model}: ${errBody.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Banana2556 ${model} returned empty response: ` + JSON.stringify(data).slice(0, 500));
  return { text, model, provider: 'banana2556', usage: data.usage || null };
}

async function chat(prompt, opts = {}) {
  const apiKey = process.env.BANANA2556_API_KEY;
  if (!apiKey) throw new Error('BANANA2556_API_KEY env var is not set');

  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });

  // Pin takes precedence over the chain; ops can force a single model
  // via opts.model or the BANANA2556_MODEL env var.
  const pinnedModel = opts.model || process.env.BANANA2556_MODEL;
  const candidates = pinnedModel ? [pinnedModel] : MODEL_CHAIN;

  let lastError = null;
  for (const model of candidates) {
    try {
      return await chatOnce(apiKey, model, messages, opts);
    } catch (err) {
      // 429 is a proxy-global quota cap — re-throw immediately, no point
      // burning candidates on a budget that's already exhausted.
      if (err.status === 429) throw err;
      lastError = err;
      console.warn(`[banana2556] ${model} failed (${err.message.slice(0, 200)}); trying next model in chain.`);
    }
  }

  throw lastError || new Error('Banana2556: no candidate models succeeded');
}

module.exports = { chat, charBudget: PER_CALL_CHAR_BUDGET };
