// Adapter for Banana2556 (OpenAI-compatible proxy at api.banana2556.com).
//
// Standard /v1/chat/completions endpoint, Bearer auth. The proxy quotes a
// 15 000-char per-call budget on its panel, so we expose that to lib/report
// via the `charBudget` export; report.js will progressively shrink the
// prompt to fit before sending.

const DEFAULT_MODEL = 'claude-haiku-4.5-as';
const PER_CALL_CHAR_BUDGET = 15000;
const BASE_URL = 'https://api.banana2556.com';

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

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

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
