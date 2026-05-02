// One-shot migration to copy production Redis keys into a namespaced copy.
// Reads `<source>history:<id>` + `<source>errors`, writes to
// `<target>:history:<id>` + `<target>:errors`. Never deletes source keys.
//
// Used by both the CLI (`node scripts/migrate-namespace.js`) and the
// admin HTTP endpoint (`POST /api/admin/migrate`).

const TARGETS = require('./targets');

async function migrateNamespace(redis, { sourceNs = '', targetNs, force = false } = {}) {
  if (!targetNs) throw new Error('targetNs is required');
  if (sourceNs === targetNs) throw new Error('sourceNs and targetNs must differ');

  const srcPrefix = sourceNs ? `${sourceNs}:` : '';
  const dstPrefix = `${targetNs}:`;

  const summary = { copied: [], skipped: [], errors_copied: 0 };

  for (const t of TARGETS) {
    const srcKey = `${srcPrefix}history:${t.id}`;
    const dstKey = `${dstPrefix}history:${t.id}`;

    const data = await redis.get(srcKey);
    if (!data || (Array.isArray(data) && data.length === 0)) {
      summary.skipped.push({ id: t.id, name: t.name, reason: 'no source data' });
      continue;
    }

    if (!force) {
      const existing = await redis.get(dstKey);
      if (existing && Array.isArray(existing) && existing.length > 0) {
        summary.skipped.push({ id: t.id, name: t.name, reason: 'target already has data (use force=1)' });
        continue;
      }
    }

    await redis.set(dstKey, data);
    summary.copied.push({ id: t.id, name: t.name, snapshots: Array.isArray(data) ? data.length : 1 });
  }

  // Errors log
  const errors = await redis.get(`${srcPrefix}errors`);
  if (Array.isArray(errors) && errors.length > 0) {
    if (force || !(await redis.get(`${dstPrefix}errors`))) {
      await redis.set(`${dstPrefix}errors`, errors);
      summary.errors_copied = errors.length;
    }
  }

  return summary;
}

module.exports = { migrateNamespace };
