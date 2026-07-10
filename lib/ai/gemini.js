// Adapter for Google Gemini (Generative Language API).
//
// Uses the REST endpoint with API key in query string — no SDK required, just
// the global `fetch` (Node 18+). Free tier limits: 1500 requests/day,
// 1M-token context window. Default model `gemini-2.0-flash-exp` is fast and
// generous; switch via `opts.model` for heavier work.

const DEFAULT_MODEL = 'gemini-3.1-flash-lite-preview';
// Abort a hung upstream call after this long. The weekly-report prompt with
// maxTokens 4000 completes well inside 2 minutes; anything longer means the
// upstream is stuck and the caller (workflow curl / dashboard button) has
// already given up waiting.
const FETCH_TIMEOUT_MS = 120_000;

async function chat(prompt, opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY env var is not set');

  const model = opts.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
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

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Gemini timed out after ${FETCH_TIMEOUT_MS / 1000}s (model ${model})`);
    }
    throw err;
  }

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
