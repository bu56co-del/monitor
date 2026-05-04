// Weekly competitor-intelligence report.
//
// Aggregates per-target creative snapshots, computes new vs removed ads
// (this week vs last week), shrinks the data into a model-sized digest, then
// asks the configured AI provider to narrate it. The endpoint returns the
// raw stats AND the AI prose so the email step can render whichever it
// wants.

const TARGETS = require('./targets');
const ai = require('./ai');
const storage = require('./storage');

// Page ID we treat as "us" for gap-analysis prompts. HKMPM (original).
const SELF_PAGE_ID = '110379081699089';

function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function previousIsoWeek(week) {
  const m = week.match(/^(\d{4})-W(\d{1,2})$/);
  if (!m) return null;
  const year = +m[1];
  const num = +m[2];
  // Reconstruct an arbitrary date in that ISO week, subtract 7 days, recompute.
  const ref = new Date(Date.UTC(year, 0, 4));
  ref.setUTCDate(ref.getUTCDate() + (num - 1) * 7);
  ref.setUTCDate(ref.getUTCDate() - 7);
  return isoWeek(ref);
}

// Trim ad body for AI prompt — keep enough context, not enough to blow tokens.
function trimAd(ad) {
  return {
    id: ad.id,
    body: (ad.body || '').replace(/\s+/g, ' ').slice(0, 240),
    cta: ad.cta || null,
    link: ad.link || null,
    started: ad.started || null,
  };
}

// Find the snapshot whose date is on or before `targetDate` — used for
// stable N-day baselines that don't fall over if a snapshot got skipped.
function findRowOnOrBefore(rows, targetDate) {
  let candidate = null;
  for (const row of rows) {
    if (row.date <= targetDate) candidate = row;
    else break;
  }
  return candidate;
}

function subtractDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function deltaFromHistory(history, days) {
  if (!Array.isArray(history) || history.length === 0) return { now: null, then: null, delta: null, pct: null };
  const sorted = [...history].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const latest = sorted[sorted.length - 1];
  const baseline = findRowOnOrBefore(sorted.slice(0, -1), subtractDays(latest.date, days));
  if (!baseline) return { now: latest.count, then: null, delta: null, pct: null };
  const delta = latest.count - baseline.count;
  const pct = baseline.count === 0 ? null : Math.round((delta / baseline.count) * 1000) / 10;
  return { now: latest.count, then: baseline.count, delta, pct };
}

async function buildDigest({ thisWeek, lastWeek } = {}) {
  const tw = thisWeek || isoWeek();
  const lw = lastWeek || previousIsoWeek(tw);

  const perTarget = [];
  for (const t of TARGETS) {
    const [creatives, thisIds, lastIds, history] = await Promise.all([
      storage.getCreatives(t.id),
      storage.getWeeklySnapshot(t.id, tw),
      storage.getWeeklySnapshot(t.id, lw),
      storage.getHistory(t.id),
    ]);
    const thisSet = new Set(thisIds);
    const lastSet = new Set(lastIds);
    const newIds = [...thisSet].filter((x) => !lastSet.has(x));
    const removedIds = [...lastSet].filter((x) => !thisSet.has(x));

    const newAds = newIds.map((id) => creatives[id]).filter(Boolean).map(trimAd);
    const d1 = deltaFromHistory(history, 1);
    const d7 = deltaFromHistory(history, 7);

    perTarget.push({
      id: t.id,
      name: t.name,
      // Source 1: FB-reported total (the page header "X results"). This
      // is the user-visible truth and what dashboard 1D / 7D columns use.
      count_now: d1.now,
      delta_1d: d1.delta,
      pct_1d: d1.pct,
      delta_7d: d7.delta,
      pct_7d: d7.pct,
      // Source 2: ad_id set diff between consecutive weekly creative
      // captures. Captures rotation regardless of whether the total
      // moved — e.g. a target can swap 5 creatives with 0 net count
      // change. Subject to scrape coverage (see ads_scraped vs count_now).
      ads_scraped: thisIds.length,
      new_ad_ids: newIds.length,
      removed_ad_ids: removedIds.length,
      // Cap to 5 so a noisy target doesn't dominate the prompt.
      new_ads_sample: newAds.slice(0, 5),
    });
  }
  return { this_week: tw, last_week: lw, targets: perTarget };
}

const SYSTEM_PROMPT = [
  '你係一個專業嘅 competitive intelligence 分析師，幫一間香港痛症/醫療 clinic 分析 Facebook 廣告對手活動。',
  '你嘅讀者係 HKMPM 嘅 marketing 主管，每週收一份簡短 email report。',
  '只可以引用 DATA 入面實際出現嘅數字 — 唔好作數據、唔好作對手名。',
  '用繁體中文書面語回覆。',
].join(' ');

function buildPrompt(digest, selfId, landingDiffs) {
  const me = digest.targets.find((t) => t.id === selfId);
  const competitors = digest.targets.filter((t) => t.id !== selfId);

  const significantDiffs = (landingDiffs || []).filter((d) => d && d.diff_pct > 5);
  const diffsBlock = significantDiffs.length
    ? `Landing page changes (diff > 5%):\n${significantDiffs.map((d) => `- ${d.target_name || ''} (${d.url}): ${d.diff_pct.toFixed(1)}% pixel change`).join('\n')}`
    : 'Landing page changes: 全部對手 landing page 上週改動 < 5%';

  return `
DATA (this_week=${digest.this_week}, last_week=${digest.last_week}):

我方 HKMPM:
${JSON.stringify(me)}

對手 (12 個):
${competitors.map((c) => JSON.stringify(c)).join('\n')}

${diffsBlock}

================================================================
數據定義（嚴格按字面意思用，唔可以混淆）：

【總廣告數 — Source 1：FB Ad Library 嘅 page header】
- count_now: 今日 FB 顯示嘅總廣告數（最準確）
- delta_1d / pct_1d: count_now 同一日前比（headline daily change）
- delta_7d / pct_7d: count_now 同 7 日前比

【廣告 rotation — Source 2：我哋每週爬到嘅 ad_id set diff】
- ads_scraped: 我哋今週成功爬到嘅 ad card 數量（理論上 ≤ count_now，
  因為 FB lazy load 可能未完全爬晒，但會 try 爬齊）
- new_ad_ids: 今週爬到但上週冇嘅 ad ID 數（廣告新出現）
- removed_ad_ids: 上週爬到但今週冇嘅 ad ID 數（廣告落畫）
- new_ads_sample: 抽樣最多 5 個新 ad 嘅 body text（睇對手 message）

⚠️ 兩個 Source 講緊唔同嘅嘢：
- Source 1 講「對手而家有幾多 ad，比之前多咗定少咗幾多」
- Source 2 講「對手換咗幾多 creative」
- 兩個獨立，可以同時報告（例如：「總數 -10 但 rotation +5/-15」）

================================================================
寫一份 HTML 週報（純 fragment，無 <html>/<body> tag）：

<h3>📊 整體市場概覽</h3>
3-4 bullet points 講上週整體變化。引用真實 delta_1d / delta_7d 數字。
標出邊個對手 count_now 變化最大、邊個 ad rotation 最頻繁。

<h3>🏢 對手逐個分析</h3>
對 12 個對手每個寫一個 <h4> + ul 分析（每段 40-80 字）：

<h4>對手名 — 總數 count_now 個 ad</h4>
<ul>
  <li><strong>📊 總廣告數變化（FB header）</strong>: 1日 delta_1d (pct_1d%), 7日 delta_7d (pct_7d%)。如果 delta = null 就寫「baseline 唔夠長，未夠資料計」</li>
  <li><strong>🔄 Creative rotation（我哋抽樣）</strong>: 新出現 new_ad_ids 個，落畫 removed_ad_ids 個。如果 rotation 同總數變化唔一致（e.g. 總數 -10 但 rotation +1/-11），明確指出「對手換 creative + 減量」「凈換 creative」之類</li>
  <li><strong>💬 Message theme</strong>: 從 new_ads_sample 嘅 body text 抽 1-2 個 keyword / 訴求 pattern。Sample 空就寫「上週冇捕捉到新 creative」</li>
</ul>

⚠️ 一定要寫足 12 個對手（DATA 入面除咗 HKMPM）。
⚠️ 兩個數字嚟源**唔好混淆**：「總廣告數變化」係 FB 真實總數變化；「Creative rotation」係 ad ID 換班數量。

<h3>📉 HKMPM 嘅 gap</h3>
對比對手 new_ads_sample 嘅 themes，講 1-2 個 HKMPM 冇 emphasize 但對手主打嘅 topic。

<h3>🖼️ Landing page 改動</h3>
${significantDiffs.length ? '列出 >5% 嘅 landing change + 推測策略' : '上週對手 landing page 大致穩定（diff < 5%）'}

<h3>💡 建議</h3>
1-2 條 actionable suggestion，要係 specific 唔好 generic（例如「考慮加『失眠』keyword」）。

格式要求：
- <strong> 嚟強調數字
- 中文、繁體、書面語為主，可以間中夾粵語口語令文章活
- 嚴禁作數字（只可以用 DATA 入面實際出現嘅）
- 嚴禁作對手 brand 行為（只可以根據 sample body text 推斷）
`.trim();
}

async function generateReport(opts = {}) {
  const digest = await buildDigest(opts);
  const prompt = buildPrompt(digest, SELF_PAGE_ID, opts.landingDiffs || []);

  const aiOut = await ai.chat(prompt, {
    system: SYSTEM_PROMPT,
    maxTokens: 4000,
    temperature: 0.4,
  });

  // Aggregate stats — driven by daily count history (the true total) plus
  // ad-rotation counts as a secondary signal.
  const stats = digest.targets.reduce(
    (acc, t) => {
      acc.targets += 1;
      acc.new_ad_ids_total += t.new_ad_ids || 0;
      acc.removed_ad_ids_total += t.removed_ad_ids || 0;
      if ((t.delta_1d ?? 0) > 0 && (t.delta_1d ?? 0) > acc.biggest_gain.delta) {
        acc.biggest_gain = { name: t.name, delta: t.delta_1d };
      }
      if ((t.delta_1d ?? 0) < 0 && (t.delta_1d ?? 0) < acc.biggest_drop.delta) {
        acc.biggest_drop = { name: t.name, delta: t.delta_1d };
      }
      return acc;
    },
    {
      targets: 0,
      new_ad_ids_total: 0,
      removed_ad_ids_total: 0,
      biggest_gain: { name: '—', delta: 0 },
      biggest_drop: { name: '—', delta: 0 },
    },
  );

  const result = {
    week: digest.this_week,
    prev_week: digest.last_week,
    stats,
    digest,
    landing_diffs: opts.landingDiffs || [],
    ai: { provider: aiOut.provider, model: aiOut.model, usage: aiOut.usage },
    html: aiOut.text,
    generated_at: new Date().toISOString(),
  };

  // Cache for the public dashboard so it doesn't burn Gemini quota on
  // every page load.
  try {
    await storage.saveLatestWeeklyReport(result);
  } catch (err) {
    console.warn('[report] saveLatestWeeklyReport failed:', err.message);
  }

  return result;
}

module.exports = { generateReport, buildDigest, isoWeek, previousIsoWeek };
