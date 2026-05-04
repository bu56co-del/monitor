#!/usr/bin/env node
// Fetch screenshots of all new landing URLs in the current week's digest,
// diff against any baseline already in screenshots/, persist new versions.
//
// Output: writes JSON array of diff records to /tmp/landing-diffs.json
//   [{ target_id, target_name, ad_id, url, sha, diff_pct, baseline_existed }]
//
// Env vars expected:
//   RENDER_URL         (staging or prod base URL)
//   ADMIN_TOKEN        (matches the env var on the Render service)
//
// Run from the repo root so screenshots/ resolves correctly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

const RENDER_URL = (process.env.RENDER_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const OUT_FILE = '/tmp/landing-diffs.json';
const SCREENSHOT_DIR = path.join(process.cwd(), 'screenshots');
const DIFF_THRESHOLD_PCT = 5;
const PIXEL_DIFF_TOLERANCE = 0.1;

if (!RENDER_URL || !ADMIN_TOKEN) {
  console.error('RENDER_URL and ADMIN_TOKEN are required.');
  process.exit(1);
}

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function getDigest() {
  const url = `${RENDER_URL}/api/admin/digest?token=${encodeURIComponent(ADMIN_TOKEN)}`;
  return fetchJson(url);
}

async function getScreenshot(targetUrl) {
  const url = `${RENDER_URL}/api/admin/screenshot?url=${encodeURIComponent(targetUrl)}&token=${encodeURIComponent(ADMIN_TOKEN)}`;
  const out = await fetchJson(url, { method: 'POST' });
  if (!out.base64) throw new Error('screenshot endpoint returned no base64');
  return Buffer.from(out.base64, 'base64');
}

function diffPng(bufA, bufB) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  if (a.width !== b.width || a.height !== b.height) {
    return { diff_pct: 100, reason: 'dimensions changed' };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: PIXEL_DIFF_TOLERANCE,
  });
  const total = a.width * a.height;
  return { diff_pct: (diffPixels / total) * 100 };
}

async function main() {
  console.log('Fetching digest from', RENDER_URL);
  const digest = await getDigest();

  // Collect all new ads with landing URLs across all targets.
  const tasks = [];
  for (const t of digest.targets || []) {
    for (const ad of t.new_ads_sample || []) {
      if (!ad || !ad.link) continue;
      tasks.push({ target_id: t.id, target_name: t.name, ad_id: ad.id, url: ad.link });
    }
  }
  console.log(`Found ${tasks.length} new ads with landing URLs`);

  const diffs = [];
  for (const task of tasks) {
    const sha = sha256(task.url);
    const file = path.join(SCREENSHOT_DIR, `${sha}.png`);
    const baselineExisted = fs.existsSync(file);
    let diffPct = 0;
    let note = '';

    try {
      console.log(`[${diffs.length + 1}/${tasks.length}] ${task.target_name} → ${task.url.slice(0, 80)}`);
      const newBuf = await getScreenshot(task.url);

      if (baselineExisted) {
        const oldBuf = fs.readFileSync(file);
        const result = diffPng(oldBuf, newBuf);
        diffPct = result.diff_pct;
        note = result.reason || '';
      } else {
        note = 'first capture (baseline)';
      }

      fs.writeFileSync(file, newBuf);
      diffs.push({
        target_id: task.target_id,
        target_name: task.target_name,
        ad_id: task.ad_id,
        url: task.url,
        sha,
        diff_pct: Math.round(diffPct * 10) / 10,
        baseline_existed: baselineExisted,
        note,
      });
      console.log(`   ${baselineExisted ? `diff ${diffPct.toFixed(1)}%` : 'baseline saved'}`);
    } catch (err) {
      console.error(`   FAILED: ${err.message}`);
      diffs.push({
        target_id: task.target_id,
        target_name: task.target_name,
        ad_id: task.ad_id,
        url: task.url,
        sha,
        diff_pct: 0,
        baseline_existed: baselineExisted,
        note: 'error: ' + err.message,
      });
    }

    // tiny breathing room between requests
    await new Promise((r) => setTimeout(r, 1500));
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(diffs, null, 2));
  const significant = diffs.filter((d) => d.diff_pct > DIFF_THRESHOLD_PCT);
  console.log(`\nWrote ${diffs.length} records to ${OUT_FILE}`);
  console.log(`${significant.length} landing pages above ${DIFF_THRESHOLD_PCT}% diff threshold`);
}

main().catch((err) => {
  console.error('screenshot-diff failed:', err);
  process.exit(1);
});
