const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const ERRORS_PATH = path.join(DATA_DIR, 'errors.json');
const ERROR_CAP = 100;

// Optional STORAGE_NAMESPACE env var lets a staging environment share the same
// Upstash database as production without colliding on keys. Production leaves
// it unset → keys stay as `history:<id>` / `errors` (back-compat). Staging sets
// e.g. STORAGE_NAMESPACE=staging → keys become `staging:history:<id>`.
function nsKey(key) {
  const ns = process.env.STORAGE_NAMESPACE;
  return ns ? `${ns}:${key}` : key;
}

// If UPSTASH_REDIS_REST_URL is set (i.e. we're on Render or similar) use
// Redis; otherwise fall back to local JSON files so `npm start` on a laptop
// still works unchanged.
let _redis;
function getRedis() {
  if (_redis !== undefined) return _redis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    _redis = null;
    return null;
  }
  const { Redis } = require('@upstash/redis');
  _redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  return _redis;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function insertSortedByDate(list, row) {
  const idx = list.findIndex((r) => r.date === row.date);
  if (idx >= 0) list[idx] = row;
  else list.push(row);
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return list;
}

async function getHistory(pageId) {
  const redis = getRedis();
  if (redis) {
    const arr = await redis.get(nsKey(`history:${pageId}`));
    return Array.isArray(arr) ? arr : [];
  }
  const all = readJson(HISTORY_PATH, {});
  return Array.isArray(all[pageId]) ? all[pageId] : [];
}

async function upsertHistory(pageId, row) {
  const redis = getRedis();
  if (redis) {
    const existing = await redis.get(nsKey(`history:${pageId}`));
    const list = Array.isArray(existing) ? [...existing] : [];
    insertSortedByDate(list, row);
    await redis.set(nsKey(`history:${pageId}`), list);
    return;
  }
  const all = readJson(HISTORY_PATH, {});
  const list = Array.isArray(all[pageId]) ? all[pageId] : [];
  insertSortedByDate(list, row);
  all[pageId] = list;
  writeJsonAtomic(HISTORY_PATH, all);
}

async function getErrors() {
  const redis = getRedis();
  if (redis) {
    const arr = await redis.get(nsKey('errors'));
    return Array.isArray(arr) ? arr : [];
  }
  const arr = readJson(ERRORS_PATH, []);
  return Array.isArray(arr) ? arr : [];
}

async function logError(entry) {
  const record = { ts: new Date().toISOString(), ...entry };
  try {
    const redis = getRedis();
    if (redis) {
      const existing = await redis.get(nsKey('errors'));
      const list = Array.isArray(existing) ? [record, ...existing] : [record];
      await redis.set(nsKey('errors'), list.slice(0, ERROR_CAP));
      return;
    }
    const arr = readJson(ERRORS_PATH, []);
    const list = Array.isArray(arr) ? arr : [];
    list.unshift(record);
    writeJsonAtomic(ERRORS_PATH, list.slice(0, ERROR_CAP));
  } catch (err) {
    console.error('[storage] logError failed:', err.message);
  }
}

module.exports = {
  getHistory,
  upsertHistory,
  getErrors,
  logError,
};
