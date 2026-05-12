// Provider-agnostic AI client. Routes calls to the configured adapter based
// on the AI_PROVIDER env var (default: gemini). Adapters live in `lib/ai/`
// and expose a single `chat(prompt, opts)` returning `{ text, model,
// provider, usage }`.
//
// Usage:
//   const ai = require('./lib/ai');
//   const out = await ai.chat('Summarise this competitor data: ...');
//   console.log(out.text);

const SUPPORTED = ['gemini', 'claude']; // openai adapter is a later addition

function provider() {
  return (process.env.AI_PROVIDER || 'gemini').toLowerCase();
}

async function chat(prompt, opts = {}) {
  const p = provider();
  if (!SUPPORTED.includes(p)) {
    throw new Error(`Unsupported AI_PROVIDER="${p}". Supported: ${SUPPORTED.join(', ')}`);
  }
  const adapter = require(`./ai/${p}`);
  return adapter.chat(prompt, opts);
}

module.exports = { chat, provider };
