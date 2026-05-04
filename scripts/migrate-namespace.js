#!/usr/bin/env node
// CLI: copy production keys to a namespaced copy in the same Upstash DB.
//
// Usage:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
//   SOURCE_NAMESPACE="" \
//   TARGET_NAMESPACE=staging \
//   node scripts/migrate-namespace.js [--force]

const { Redis } = require('@upstash/redis');
const { migrateNamespace } = require('../lib/migrate');

async function main() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required.');
    process.exit(1);
  }

  const sourceNs = process.env.SOURCE_NAMESPACE || '';
  const targetNs = process.env.TARGET_NAMESPACE;
  if (!targetNs) {
    console.error('TARGET_NAMESPACE is required (e.g. staging).');
    process.exit(1);
  }

  const force = process.argv.includes('--force');

  const redis = new Redis({ url, token });

  console.log(`Migrating: ${sourceNs ? `"${sourceNs}"` : '(production / no prefix)'} → "${targetNs}" ${force ? '[FORCE]' : ''}`);
  const summary = await migrateNamespace(redis, { sourceNs, targetNs, force });

  console.log(`\n✓ Copied: ${summary.copied.length}`);
  for (const r of summary.copied) console.log(`    ${r.name} (${r.id}): ${r.snapshots} snapshots`);
  console.log(`\n- Skipped: ${summary.skipped.length}`);
  for (const r of summary.skipped) console.log(`    ${r.name} (${r.id}): ${r.reason}`);
  console.log(`\n  Errors copied: ${summary.errors_copied}`);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
