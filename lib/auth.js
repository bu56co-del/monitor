// Lightweight session-cookie auth for the dashboard.
//
// One shared password (DASHBOARD_PASSWORD env var) gates the dashboard +
// all API endpoints. After a successful POST to /auth/login the server
// hands the browser an HMAC-signed cookie; subsequent requests are
// allowed in via the requireAuth middleware until the cookie expires
// (30 days) or DASHBOARD_PASSWORD changes.
//
// Workflows / scripts bypass the cookie path by passing the existing
// ADMIN_TOKEN (query string ?token= or Authorization: Bearer header) —
// that's how the daily / weekly cron jobs continue to hit /api/trigger,
// /api/scrape-creatives, etc. without a browser session.

const crypto = require('crypto');

const COOKIE_NAME = 'dash_session';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Sign with DASHBOARD_PASSWORD itself so every password rotation
// automatically invalidates outstanding sessions — no separate JWT_SECRET
// needed.
function getSecret() {
  return process.env.DASHBOARD_PASSWORD || '';
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function sign(payload) {
  const secret = getSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
}

function issueSession() {
  const issuedAt = String(Date.now());
  const sig = sign(issuedAt);
  if (!sig) return null;
  return `${issuedAt}.${sig}`;
}

function verifySession(cookieValue) {
  if (!cookieValue) return false;
  const [issuedAt, sig] = cookieValue.split('.');
  if (!issuedAt || !sig) return false;
  const expected = sign(issuedAt);
  if (!expected) return false;
  if (!timingSafeEqual(sig, expected)) return false;
  const ms = parseInt(issuedAt, 10);
  if (Number.isNaN(ms)) return false;
  if (Date.now() - ms > COOKIE_MAX_AGE_MS) return false;
  return true;
}

function parseCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const pair of header.split(/;\s*/)) {
    const [k, ...rest] = pair.split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function hasAdminToken(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return false;
  const provided = req.query.token
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return provided && timingSafeEqual(provided, adminToken);
}

function setSessionCookie(res, value) {
  const maxAgeSec = Math.floor(COOKIE_MAX_AGE_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  );
}

// Express middleware. Allows the request through if any of:
//   1. DASHBOARD_PASSWORD is unset → auth disabled (e.g. local dev).
//   2. Request carries a valid ADMIN_TOKEN (workflows / scripts).
//   3. Request carries a valid session cookie.
// Otherwise: 302 to /login for HTML, 401 JSON for API.
function requireAuth(req, res, next) {
  if (!process.env.DASHBOARD_PASSWORD) return next();
  if (hasAdminToken(req)) return next();
  if (verifySession(parseCookie(req, COOKIE_NAME))) return next();

  if (req.accepts('html')) {
    const next = req.originalUrl && req.originalUrl !== '/' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
    return res.redirect(`/login${next}`);
  }
  res.status(401).json({ error: 'Authentication required' });
}

module.exports = {
  COOKIE_NAME,
  COOKIE_MAX_AGE_MS,
  issueSession,
  verifySession,
  parseCookie,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  hasAdminToken,
  timingSafeEqual,
};
