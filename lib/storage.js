const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const ERRORS_PATH = path.join(DATA_DIR, 'errors.json');
const ERROR_CAP = 100;

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

function getAllHistory() {
  return readJson(HISTORY_PATH, {});
}

function getHistory(pageId) {
  const all = getAllHistory();
  return Array.isArray(all[pageId]) ? all[pageId] : [];
}

// Upsert by date. rows stay sorted ascending.
function upsertHistory(pageId, row) {
  const all = getAllHistory();
  const list = Array.isArray(all[pageId]) ? all[pageId] : [];
  const idx = list.findIndex((r) => r.date === row.date);
  if (idx >= 0) list[idx] = row;
  else list.push(row);
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  all[pageId] = list;
  writeJsonAtomic(HISTORY_PATH, all);
}

function getErrors() {
  const arr = readJson(ERRORS_PATH, []);
  return Array.isArray(arr) ? arr : [];
}

function logError(entry) {
  const arr = getErrors();
  arr.unshift({ ts: new Date().toISOString(), ...entry });
  const trimmed = arr.slice(0, ERROR_CAP);
  writeJsonAtomic(ERRORS_PATH, trimmed);
}

module.exports = {
  getAllHistory,
  getHistory,
  upsertHistory,
  getErrors,
  logError,
};
