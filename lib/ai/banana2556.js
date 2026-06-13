// Adapter for Banana2556 (OpenAI-compatible proxy at api.banana2556.com).
//
// Standard /v1/chat/completions endpoint, Bearer auth. The proxy quotes a
// 15 000-char per-call budget on its panel, so we expose that to lib/report
// via the `charBudget` export; report.js will progressively shrink the
// prompt to fit before sending.

const DEFAULT_MODEL = 'claude-sonnet-4-6';
// Supported models exposed by the Banana2556 proxy (as of 2026-06):
//   - claude-sonnet-4-6        ← current default
//   - gpt-5.4
//   - deepseek-v4-flash
//   - deepseek-v4-pro
//   - deepseek-v4-flash-free   (free tier, slower)
// Override per-deploy via the BANANA2556_MODEL env var.
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

async function chat(prompt, opts = {}) {
  const apiKey = process.env.BANANA2556_API_KEY;
  if (!apiKey) throw new Error('BANANA2556_API_KEY env var is not set');

  const model = opts.model || process.env.BANANA2556_MODEL || DEFAULT_MODEL;

  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });

  const body = { model, messages };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  console.log(`[banana2556] sending ${prompt.length} chars (system ${(opts.system || '').length}, model ${model})`);

  let res = await postChat(apiKey, body);

  // One retry on 429 — covers the case where the proxy's window started
  // earlier than ours (e.g. server restart wipes recentCalls). Sleep one
  // full window then reset and retry.
  if (res.status === 429) {
    const peek = await res.clone().text();
    console.warn(`[banana2556] 429 from proxy (${peek.slice(0, 200)}). Sleeping ${RATE_LIMIT_WINDOW_MS}ms then retrying once.`);
    await new Promise((r) => setTimeout(r, RATE_LIMIT_WINDOW_MS));
    recentCalls.length = 0;
    res = await postChat(apiKey, body);
  }

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Banana2556 ${res.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Banana2556 returned empty response: ' + JSON.stringify(data).slice(0, 500));
  return {
    text,
    model,
    provider: 'banana2556',
    usage: data.usage || null,
  };
}

module.exports = { chat, charBudget: PER_CALL_CHAR_BUDGET };
