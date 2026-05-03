const puppeteer = require('puppeteer');

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

// Patterns that indicate the Ad Library page has loaded with a definite
// answer (count, or "no ads"). Used both for the page wait condition and the
// final text extraction.
const COUNT_PATTERNS = [
  /~?\s*(\d[\d,]*)\s+results?/i,
  /~?\s*(\d[\d,]*)\s+ads?\s+match/i,
  /約\s*~?\s*(\d[\d,]*)\s*(?:個|項)?\s*結果/,
  /(\d[\d,]*)\s*個?結果/,
];

// Phrases that mean "this page has no active ads in the selected country".
// Returning `0` for these is correct — they are NOT scraping failures.
const EMPTY_PATTERNS = [
  /no results/i,
  /0 results/i,
  /no ads to show/i,
  /no ads match/i,
  /not currently running any ads/i,
  /this page is not running ads/i,
  /沒有結果/,
  /沒有(?:廣告|相符的廣告)/,
  /目前沒有(?:正在投放的)?(?:廣告|刊登)/,
  /暫無廣告/,
  /找不到(?:任何)?廣告/,
  /0\s*個?(?:結果|廣告)/,
];

function extractCount(text) {
  if (!text) return null;
  for (const re of COUNT_PATTERNS) {
    const m = text.match(re);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  }
  for (const re of EMPTY_PATTERNS) {
    if (re.test(text)) return 0;
  }
  return null;
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

// Scrape per-ad detail (body text, image, CTA, landing URL, started date)
// from the Ad Library page. Caps at `max` ads to keep memory + runtime
// bounded on Render free tier (512MB). Returns [] on empty-state pages.
// Render a single URL and return a PNG screenshot as a Buffer.
// Capped to a fixed viewport so subsequent diffs stay comparable. Tries to
// dismiss common cookie / privacy banners that would otherwise inflate the
// diff between runs.
async function screenshotUrl(url, { browser, width = 1280, height = 1500 } = {}) {
  const ownBrowser = !browser;
  let b = browser;
  try {
    if (ownBrowser) b = await launchBrowser();
    const page = await b.newPage();
    await page.setViewport({ width, height });
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9,zh-HK;q=0.8,zh;q=0.7',
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Best-effort dismiss of common consent / banner overlays so the
    // screenshot reflects the actual landing content, not a modal.
    await page.evaluate(() => {
      const sels = [
        '#onetrust-close-btn-container button',
        '#onetrust-accept-btn-handler',
        '[aria-label="Close"]',
        '[aria-label="關閉"]',
        '[data-testid="cookie-policy-manage-dialog-accept-button"]',
        'button[title*="Accept"]',
        'button[title*="同意"]',
      ];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) { try { el.click(); } catch {} }
      }
    });
    await new Promise((r) => setTimeout(r, 1500));

    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
    await page.close();
    return buf;
  } finally {
    if (ownBrowser && b) {
      try { await b.close(); } catch { /* ignore */ }
    }
  }
}

async function scrapeCreatives(pageId, { browser, max = 50 } = {}) {
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

    // Block heavy assets we don't need (images we keep — we want the URL,
    // not the bytes; videos / fonts we drop).
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'media' || type === 'font') return req.abort();
      req.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for either an ad card (Library ID marker) or an empty-state phrase.
    let hasAds = false;
    try {
      await page.waitForFunction(
        () => {
          const t = document.body && document.body.innerText;
          if (!t) return false;
          return /Library ID|資料庫編號|識別碼/.test(t)
            || /no\s+ads|沒有(?:廣告|結果|相符)|目前沒有|暫無廣告|找不到/i.test(t);
        },
        { timeout: 45000 },
      );
      const text = await page.evaluate(() => document.body.innerText);
      hasAds = /Library ID|資料庫編號|識別碼/.test(text);
    } catch {
      // give up — likely empty
    }

    if (!hasAds) {
      await page.close();
      return { ads: [], url, tookMs: Date.now() - startedAt };
    }

    // Scroll to load up to `max` ads. Counts "Library ID" markers as a
    // proxy for loaded-ad count.
    let lastSeen = 0;
    for (let i = 0; i < 8; i++) {
      const seen = await page.evaluate(() => {
        const m = document.body.innerText.match(/Library ID|資料庫編號|識別碼/g);
        return m ? m.length : 0;
      });
      if (seen >= max) break;
      if (seen === lastSeen && i > 1) break; // no new ads after a scroll
      lastSeen = seen;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 2500));
    }

    // Extract per-ad data. We anchor on text containing "Library ID:"
    // (or zh equivalents), then walk up to a card-sized container and
    // pull body text, image src, CTA button text, and an outbound link.
    const ads = await page.evaluate((maxAds) => {
      const idRe = /(?:Library ID|資料庫編號|識別碼)[:：\s]*?(\d{6,})/;
      const allEls = Array.from(document.querySelectorAll('div, span'));
      const idEls = allEls.filter((el) => idRe.test(el.textContent || ''));
      const seen = new Set();
      const out = [];

      for (const idEl of idEls) {
        const m = (idEl.textContent || '').match(idRe);
        if (!m) continue;
        const adId = m[1];
        if (seen.has(adId)) continue;

        // Walk up looking for a card-ish ancestor (has an image OR has
        // multiple anchor tags). Bound the walk to avoid grabbing the body.
        let card = idEl;
        for (let i = 0; i < 12; i++) {
          if (!card.parentElement) break;
          card = card.parentElement;
          const links = card.querySelectorAll('a').length;
          const imgs = card.querySelectorAll('img').length;
          if ((links >= 1 && imgs >= 1) || links >= 2) break;
        }
        if (!card) continue;

        const body = (card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
        const img = (() => {
          const i = card.querySelector('img');
          return i && i.src ? i.src : null;
        })();
        const link = (() => {
          const anchors = Array.from(card.querySelectorAll('a'));
          for (const a of anchors) {
            const href = a.href || '';
            if (!href) continue;
            if (/facebook\.com\/ads\/library/.test(href)) continue; // skip internal links
            if (/facebook\.com\//.test(href) && !href.includes('l.facebook.com')) continue;
            // Prefer outbound links; FB wraps via l.facebook.com — strip when possible
            if (href.includes('l.facebook.com')) {
              try {
                const u = new URL(href);
                const real = u.searchParams.get('u');
                if (real) return real;
              } catch { /* fall through */ }
            }
            return href;
          }
          return null;
        })();
        const cta = (() => {
          const btns = Array.from(card.querySelectorAll('a, [role="button"]'));
          for (const el of btns) {
            const t = (el.innerText || '').trim();
            if (t && t.length < 24 && !/Library ID|See ad details|查看廣告/i.test(t)) return t;
          }
          return null;
        })();
        const startedMatch = (card.innerText || '').match(
          /(?:Started running on|開始放送日期|開始投放於)\s*([^\n]+)/i,
        );
        const started = startedMatch ? startedMatch[1].trim().slice(0, 80) : null;

        out.push({ id: adId, body, img, link, cta, started });
        seen.add(adId);
        if (out.length >= maxAds) break;
      }
      return out;
    }, max);

    await page.close();
    return { ads, url, tookMs: Date.now() - startedAt };
  } finally {
    if (ownBrowser && b) {
      try { await b.close(); } catch { /* ignore */ }
    }
  }
}

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

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return req.abort();
      req.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait until the page text matches a count pattern OR an explicit empty-
    // state phrase. If neither shows up before the timeout, fall through and
    // do one final extraction below — pages with no ads sometimes render an
    // empty state that doesn't trip the wait predicate.
    try {
      await page.waitForFunction(
        () => {
          const t = document.body && document.body.innerText;
          if (!t) return false;
          return (
            /~?\s*\d[\d,]*\s+(?:results?|ads?\s+match)/i.test(t) ||
            /個?結果/.test(t) ||
            /no\s+ads|沒有(?:廣告|結果|相符)|目前沒有|暫無廣告|找不到/i.test(t)
          );
        },
        { timeout: 45000 },
      );
    } catch (waitErr) {
      // swallow — extractCount on the current text may still produce a valid
      // 0 for empty-state pages. Real failures will surface below.
    }

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
  scrapeCreatives,
  screenshotUrl,
  extractCount,
};
