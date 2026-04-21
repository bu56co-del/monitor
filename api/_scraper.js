const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function adLibraryUrl(pageId, country = 'HK') {
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country,
    is_targeted_country: 'false',
    media_type: 'all',
    search_type: 'page',
    view_all_page_id: pageId,
    'sort_data[direction]': 'desc',
    'sort_data[mode]': 'total_impressions',
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

function safeLs(dir) {
  try {
    return fs.readdirSync(dir).map((f) => {
      try {
        const st = fs.statSync(path.join(dir, f));
        return `${f}${st.isDirectory() ? '/' : ''}(${st.size})`;
      } catch {
        return f;
      }
    });
  } catch (e) {
    return [`ERR: ${e.code || e.message}`];
  }
}

function chromiumDiagnostics() {
  const pkgBin = 'node_modules/@sparticuz/chromium/bin';
  const candidates = [
    pkgBin,
    path.join(process.cwd(), pkgBin),
    path.join('/var/task', pkgBin),
  ];
  const resolved = {};
  for (const p of candidates) resolved[p] = safeLs(p);
  return { cwd: process.cwd(), bin: resolved, tmp: safeLs('/tmp') };
}

// @sparticuz/chromium picks al2 vs al2023 by sniffing /etc/os-release. On
// Vercel's Fluid Compute runtime that sniff comes up empty so NEITHER OS
// tarball gets inflated and chromium then fails to dlopen libnss3. Force
// the extraction ourselves (idempotent — skips if the libs already exist).
async function ensureOsLibsExtracted() {
  if (fs.existsSync('/tmp/libnss3.so')) return;

  let lambdafs;
  try {
    lambdafs = require('@sparticuz/lambdafs');
  } catch (e) {
    throw new Error(`Cannot require @sparticuz/lambdafs: ${e.message}`);
  }

  const pkgRoot = path.dirname(require.resolve('@sparticuz/chromium/package.json'));
  const tarballs = ['al2023.tar.br', 'al2.tar.br']
    .map((n) => path.join(pkgRoot, 'bin', n))
    .filter((p) => fs.existsSync(p));

  for (const tarball of tarballs) {
    await lambdafs.inflate(tarball);
    if (fs.existsSync('/tmp/libnss3.so')) break;
  }

  if (!fs.existsSync('/tmp/libnss3.so')) {
    throw new Error('Manual inflate did not produce /tmp/libnss3.so');
  }

  const parts = (process.env.LD_LIBRARY_PATH || '').split(':').filter(Boolean);
  if (!parts.includes('/tmp')) {
    process.env.LD_LIBRARY_PATH = ['/tmp', ...parts].join(':');
  }
}

async function launchBrowser() {
  try {
    await ensureOsLibsExtracted();
    return await puppeteer.launch({
      args: [...chromium.args, '--hide-scrollbars', '--disable-web-security'],
      defaultViewport: { width: 1280, height: 900 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
  } catch (err) {
    const diag = chromiumDiagnostics();
    err.message = `${err.message} | diag=${JSON.stringify(diag)}`;
    throw err;
  }
}

// Extracts "~N results" (or variants) from rendered page text.
function extractCount(text) {
  if (!text) return null;

  // Common patterns across FB locales
  const patterns = [
    /~?\s*(\d[\d,]*)\s+results?/i,
    /~?\s*(\d[\d,]*)\s+ads?\s+match/i,
    /約\s*~?\s*(\d[\d,]*)\s*(?:個|項)?\s*結果/,
    /(\d[\d,]*)\s*個?結果/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  }

  // "No results" signals
  if (/no results|0 results|沒有結果|0\s*個?結果/i.test(text)) return 0;

  return null;
}

// Scrape a single target. Returns { count, url, tookMs }.
// Throws on any failure (caller decides whether to retry / log).
async function scrapeTarget(pageId, { browser } = {}) {
  const startedAt = Date.now();
  const url = adLibraryUrl(pageId);
  const ownBrowser = !browser;
  let b = browser;
  try {
    if (ownBrowser) b = await launchBrowser();
    const page = await b.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9,zh-HK;q=0.8,zh;q=0.7',
    });

    // Block heavy resources we don't need (speeds up + reduces bandwidth).
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        return req.abort();
      }
      req.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for either a results count or explicit no-results signal.
    await page.waitForFunction(
      () => {
        const t = document.body && document.body.innerText;
        if (!t) return false;
        return (
          /~?\s*\d[\d,]*\s+results?/i.test(t) ||
          /no results|沒有結果/i.test(t) ||
          /個?結果/.test(t)
        );
      },
      { timeout: 30000 },
    );

    const text = await page.evaluate(() => document.body.innerText);
    const count = extractCount(text);
    if (count === null) {
      const snippet = text.slice(0, 400).replace(/\s+/g, ' ');
      throw new Error(`Count pattern not found. Snippet: "${snippet}"`);
    }

    await page.close();
    return { count, url, tookMs: Date.now() - startedAt };
  } finally {
    if (ownBrowser && b) {
      try { await b.close(); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  adLibraryUrl,
  launchBrowser,
  scrapeTarget,
  extractCount,
};
