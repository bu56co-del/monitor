// Adapter for Anthropic Claude (Messages API).
//
// Uses the REST endpoint with x-api-key header — no SDK required, just
// the global `fetch` (Node 18+). Anthropic has broader geographic
// availability than Gemini, so this is a useful fallback when Gemini
// rejects with "User location is not supported".

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

async function chat(prompt, opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var is not set');

  const model = opts.model || process.env.CLAUDE_MODEL || DEFAULT_MODEL;
  const body = {
    model,
    max_tokens: opts.maxTokens || 4096,
    messages: [{ role: 'user', content: prompt }],
  };
  if (opts.system) body.system = opts.system;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude ${res.status}: ${errBody.slice(0, 500)}`);
  }

  const data = await res.json();
  // Claude returns content as an array of blocks; the first text block is
  // typically what we want.
  const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('Claude returned empty response: ' + JSON.stringify(data).slice(0, 500));
  return {
    text,
    model,
    provider: 'claude',
    usage: data.usage || null,
  };
}

module.exports = { chat };
