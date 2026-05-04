// Adapter for Google Gemini (Generative Language API).
//
// Uses the REST endpoint with API key in query string — no SDK required, just
// the global `fetch` (Node 18+). Free tier limits: 1500 requests/day,
// 1M-token context window. Default model `gemini-2.0-flash-exp` is fast and
// generous; switch via `opts.model` for heavier work.

const DEFAULT_MODEL = 'gemini-2.0-flash';

async function chat(prompt, opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY env var is not set');

  const model = opts.model || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
  };
  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] };
  }
  if (opts.temperature !== undefined || opts.maxTokens !== undefined) {
    body.generationConfig = {};
    if (opts.temperature !== undefined) body.generationConfig.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) body.generationConfig.maxOutputTokens = opts.maxTokens;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini ${res.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response: ' + JSON.stringify(data).slice(0, 500));
  return {
    text,
    model,
    provider: 'gemini',
    usage: data.usageMetadata || null,
  };
}

module.exports = { chat };
