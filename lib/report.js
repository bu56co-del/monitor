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

async function buildDigest({ thisWeek, lastWeek } = {}) {
  const tw = thisWeek || isoWeek();
  const lw = lastWeek || previousIsoWeek(tw);

  const perTarget = [];
  for (const t of TARGETS) {
    const [creatives, thisIds, lastIds] = await Promise.all([
      storage.getCreatives(t.id),
      storage.getWeeklySnapshot(t.id, tw),
      storage.getWeeklySnapshot(t.id, lw),
    ]);
    const thisSet = new Set(thisIds);
    const lastSet = new Set(lastIds);
    const newIds = [...thisSet].filter((x) => !lastSet.has(x));
    const removedIds = [...lastSet].filter((x) => !thisSet.has(x));

    const newAds = newIds.map((id) => creatives[id]).filter(Boolean).map(trimAd);
    perTarget.push({
      id: t.id,
      name: t.name,
      ads_this_week: thisIds.length,
      ads_last_week: lastIds.length,
      new_count: newIds.length,
      removed_count: removedIds.length,
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

function buildPrompt(digest, selfId) {
  const me = digest.targets.find((t) => t.id === selfId);
  const competitors = digest.targets.filter((t) => t.id !== selfId);

  return `
DATA (this_week=${digest.this_week}, last_week=${digest.last_week}):
我方 (HKMPM): ${JSON.stringify(me)}

對手 (12 個):
${competitors.map((c) => `- ${JSON.stringify(c)}`).join('\n')}

請寫一份 HTML 格式嘅週報（無 <html>/<body> tag，直接 fragment），200-400 字，包含：

<h3>📊 上週競爭對手活動概覽</h3>
3-5 bullet points：邊個對手新增最多廣告？整體市場活躍度？
（只可以引用 DATA 入面有嘅 new_count / removed_count 數字）

<h3>🎯 對手主打 message themes</h3>
睇對手嘅 new_ads_sample，總結 2-3 個共通 keyword / pattern。

<h3>📉 HKMPM 嘅 gap</h3>
對手有講而 HKMPM 冇 emphasize 嘅 keyword / topic。如果 me.new_ads_sample 係空，講「HKMPM 上週冇出新 ad」。

<h3>💡 建議</h3>
1-2 條 actionable suggestion。

Format: 每段用 <ul><li>...</li></ul>。<strong> 用嚟強調。簡潔，唔好 generic。
`.trim();
}

async function generateReport(opts = {}) {
  const digest = await buildDigest(opts);
  const prompt = buildPrompt(digest, SELF_PAGE_ID);

  const aiOut = await ai.chat(prompt, {
    system: SYSTEM_PROMPT,
    maxTokens: 1500,
    temperature: 0.4,
  });

  // Aggregate stats for the email subject + plain-text fallback.
  const stats = digest.targets.reduce(
    (acc, t) => {
      acc.targets += 1;
      acc.new_total += t.new_count;
      acc.removed_total += t.removed_count;
      if (t.new_count > acc.most_new.count) {
        acc.most_new = { name: t.name, count: t.new_count };
      }
      return acc;
    },
    { targets: 0, new_total: 0, removed_total: 0, most_new: { name: '—', count: 0 } },
  );

  return {
    week: digest.this_week,
    prev_week: digest.last_week,
    stats,
    digest,
    ai: { provider: aiOut.provider, model: aiOut.model, usage: aiOut.usage },
    html: aiOut.text,
  };
}

module.exports = { generateReport, buildDigest, isoWeek, previousIsoWeek };
