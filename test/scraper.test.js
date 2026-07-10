const { test } = require('node:test');
const assert = require('node:assert/strict');

// Requiring lib/scraper pulls in puppeteer but does not launch a browser —
// extractCount is a pure function. CI sets PUPPETEER_SKIP_DOWNLOAD so the
// install stays light.
const { extractCount, adLibraryUrl } = require('../lib/scraper');

test('extractCount: English result counts', () => {
  assert.equal(extractCount('~1,234 results'), 1234);
  assert.equal(extractCount('About ~56 results for this page'), 56);
  assert.equal(extractCount('3 ads match your criteria'), 3);
});

test('extractCount: Chinese result counts', () => {
  assert.equal(extractCount('約 120 個結果'), 120);
  assert.equal(extractCount('56個結果'), 56);
  assert.equal(extractCount('約~89項結果'), 89);
});

test('extractCount: empty-state phrases return 0, not an error', () => {
  assert.equal(extractCount('No results found'), 0);
  assert.equal(extractCount('This Page is not currently running any ads'), 0);
  assert.equal(extractCount('沒有結果'), 0);
  assert.equal(extractCount('此專頁目前沒有正在投放的廣告'), 0);
  assert.equal(extractCount('暫無廣告'), 0);
});

test('extractCount: unrecognisable text returns null (scrape failure signal)', () => {
  assert.equal(extractCount(''), null);
  assert.equal(extractCount(null), null);
  assert.equal(extractCount('You must log in to continue.'), null);
  assert.equal(extractCount('Something went wrong'), null);
});

test('extractCount: count patterns win over empty patterns when both present', () => {
  // A page can contain "0 results" style helper text plus a real count —
  // COUNT_PATTERNS are checked first by design.
  assert.equal(extractCount('~12 results. Previously: no results'), 12);
});

test('adLibraryUrl: builds the HK active-ads URL for a page id', () => {
  const url = adLibraryUrl('110379081699089');
  assert.ok(url.startsWith('https://www.facebook.com/ads/library/?'));
  assert.ok(url.includes('view_all_page_id=110379081699089'));
  assert.ok(url.includes('country=HK'));
  assert.ok(url.includes('active_status=active'));
});
