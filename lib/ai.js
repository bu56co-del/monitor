// Provider-agnostic AI client. Routes calls to the configured adapter based
// on the AI_PROVIDER env var (default: gemini). Adapters live in `lib/ai/`
// and expose a single `chat(prompt, opts)` returning `{ text, model,
// provider, usage }`. An adapter may also export a `charBudget` number so
// callers can pre-size the prompt for proxies with strict per-call limits.
//
// Usage:
//   const ai = require('./lib/ai');
//   const out = await ai.chat('Summarise this competitor data: ...');
//   console.log(out.text);

const SUPPORTED = ['gemini', 'claude', 'banana2556'];

function provider() {
  return (process.env.AI_PROVIDER || 'gemini').toLowerCase();
}

function loadAdapter(name) {
  if (!SUPPORTED.includes(name)) {
    throw new Error(`Unsupported AI provider="${name}". Supported: ${SUPPORTED.join(', ')}`);
  }
  return require(`./ai/${name}`);
}

async function chat(prompt, opts = {}) {
  return loadAdapter(provider()).chat(prompt, opts);
}

async function chatForProvider(name, prompt, opts = {}) {
  return loadAdapter(name).chat(prompt, opts);
}

function getProviderMeta(name) {
  try {
    const adapter = loadAdapter(name);
    return {
      charBudget: typeof adapter.charBudget === 'number' ? adapter.charBudget : Infinity,
    };
  } catch {
    return { charBudget: Infinity };
  }
}

module.exports = { chat, chatForProvider, provider, getProviderMeta };
