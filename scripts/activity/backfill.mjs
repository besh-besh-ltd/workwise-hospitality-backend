#!/usr/bin/env node
/**
 * Projects existing history into the company activity trail.
 *
 * The trail starts empty, but the system has been recording fragments of what
 * happened since go-live on 2026-02-17 — in seven different tables, in seven
 * different shapes, none of them readable side by side. This gathers them into
 * one feed so an admin's first visit is not an empty page.
 *
 * Reconstructed rows are flagged `is_reconstructed` and carry where they came
 * from. That matters: some sources have a trustworthy actor and some do not,
 * and a feed that presented an inferred actor as a recorded one would be worse
 * than one that admitted the gap.
 *
 * Every source is one INSERT ... SELECT rather than a read-modify-write loop.
 * There are around 46,000 rows to project; pulling them through Node to push
 * them back would be slow for no benefit, and the scope resolution is a join
 * either way.
 *
 * Re-running is free. uq_activity_backfill_source makes identity deterministic
 * from (source_table, source_id), so ON CONFLICT DO NOTHING means a second run
 * adds nothing and an interrupted run can simply be restarted.
 *
 * Usage:
 *   node scripts/activity/backfill.mjs --dry-run
 *   node scripts/activity/backfill.mjs --only=lifecycle,approvals
 *   node scripts/activity/backfill.mjs
 */
import 'dotenv/config';
import pgp from 'pg-promise';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').replace('--only=', '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const pg = pgp();
const db = pg({
  host: process.env.HOST,
  port: Number(process.env.DATABASE_PORT || 5432),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  ssl: process.env.TEST_DB_NO_SSL === '1' ? false : { rejectUnauthorized: false },
});

import { SOURCES } from '../../app/services/activity/backfillSources.js';

const run = async () => {
  const selected = ONLY.length ? SOURCES.filter((s) => ONLY.includes(s.name)) : SOURCES;
  if (!selected.length) {
    console.error(`No sources matched --only=${ONLY.join(',')}`);
    console.error(`Available: ${SOURCES.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`Database : ${process.env.DATABASE_NAME}`);
  console.log(`Mode     : ${DRY_RUN ? 'DRY RUN (nothing will be written)' : 'WRITE'}`);
  console.log(`Sources  : ${selected.map((s) => s.name).join(', ')}\n`);

  const before = await db.one('SELECT count(*)::int AS n FROM tbl_activity_events');
  let projected = 0;

  for (const source of selected) {
    const available = await db.one(
      `SELECT count(*)::int AS n FROM ${source.table}`
    );

    if (DRY_RUN) {
      // Counting through the same joins the insert uses is the only honest
      // estimate: rows whose company cannot be resolved are skipped, and a
      // raw table count would overstate every source.
      const estimate = await db.one(
        `SELECT count(*)::int AS n FROM (${source.sql
          .replace(/INSERT INTO[\s\S]*?SELECT/, 'SELECT 1 AS probe,')
          .replace(/ON CONFLICT DO NOTHING\s*$/, '')}) probe`
      ).catch(() => ({ n: null }));
      console.log(
        `  ${source.name.padEnd(18)} ${String(available.n).padStart(7)} rows available` +
          (estimate.n == null ? '' : ` → ~${estimate.n} projectable`)
      );
      continue;
    }

    const started = Date.now();
    const result = await db.result(source.sql);
    projected += result.rowCount;
    console.log(
      `  ${source.name.padEnd(18)} ${String(available.n).padStart(7)} rows available` +
        ` → ${String(result.rowCount).padStart(7)} written` +
        ` (${Math.round((Date.now() - started) / 1000)}s)`
    );
  }

  if (!DRY_RUN) {
    const after = await db.one('SELECT count(*)::int AS n FROM tbl_activity_events');
    const span = await db.oneOrNone(
      `SELECT min(occurred_at) AS from_at, max(occurred_at) AS to_at
         FROM tbl_activity_events WHERE is_reconstructed`
    );
    console.log(`\nTrail: ${before.n} → ${after.n} rows (+${projected})`);
    if (span?.from_at) console.log(`History now spans ${span.from_at} → ${span.to_at}`);
  }

  await pg.end();
};

run().catch(async (err) => {
  console.error('\nBackfill failed:', err.message);
  await pg.end();
  process.exit(1);
});
