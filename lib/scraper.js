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

module.exports = { adLibraryUrl, launchBrowser, scrapeTarget, extractCount };
