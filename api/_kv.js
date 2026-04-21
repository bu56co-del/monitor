const { Redis } = require('@upstash/redis');

const KV_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

function getKv() {
  if (!KV_URL || !KV_TOKEN) {
    const err = new Error('KV not configured: missing UPSTASH_REDIS_REST_URL / TOKEN env vars');
    err.stage = 'config';
    throw err;
  }
  return new Redis({ url: KV_URL, token: KV_TOKEN });
}

function isKvConfigured() {
  return Boolean(KV_URL && KV_TOKEN);
}

// History per target lives at `history:<page_id>`.
function historyKey(pageId) {
  return `history:${pageId}`;
}

async function getHistory(kv, pageId) {
  let history = (await kv.get(historyKey(pageId))) ?? [];
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch { history = []; }
  }
  if (!Array.isArray(history)) history = [];
  return history;
}

async function upsertHistory(kv, pageId, row) {
  const history = await getHistory(kv, pageId);
  const updated = history
    .filter((r) => r.date !== row.date)
    .concat(row)
    .sort((a, b) => a.date.localeCompare(b.date));
  await kv.set(historyKey(pageId), updated);
  return updated;
}

const ERRORS_KEY = 'errors';
const ERROR_RETENTION = 100;

async function logError(kv, entry) {
  let errors = (await kv.get(ERRORS_KEY)) ?? [];
  if (typeof errors === 'string') {
    try { errors = JSON.parse(errors); } catch { errors = []; }
  }
  if (!Array.isArray(errors)) errors = [];
  errors.unshift({ ts: new Date().toISOString(), ...entry });
  if (errors.length > ERROR_RETENTION) errors.length = ERROR_RETENTION;
  await kv.set(ERRORS_KEY, errors);
}

async function getErrors(kv) {
  let errors = (await kv.get(ERRORS_KEY)) ?? [];
  if (typeof errors === 'string') {
    try { errors = JSON.parse(errors); } catch { errors = []; }
  }
  return Array.isArray(errors) ? errors : [];
}

module.exports = {
  getKv,
  isKvConfigured,
  getHistory,
  upsertHistory,
  logError,
  getErrors,
};
