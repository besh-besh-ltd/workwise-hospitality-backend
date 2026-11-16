/**
 * Applies the migrations in migrations/ that this database hasn't had yet, and
 * records each one in the pgmigrations ledger.
 *
 *   npm run migrate           apply what is pending
 *   npm run migrate:dry-run   list what is pending, change nothing
 *
 * Coolify runs `npm run migrate` as the backend's post-deployment command, in
 * the new container, so a migration merged to qa reaches staging by itself.
 * The new code is therefore live a few seconds before its migration: code must
 * still tolerate the unmigrated database.
 *
 * WHAT IT WILL NOT RUN. scripts/migrate-baseline.json freezes every migration
 * that existed when this runner arrived. Those were applied by hand, and the
 * ledger doesn't reflect them reliably: on staging 18 have no ledger row, some
 * applied and some not. Running them now is not safe, because several change
 * real data out of order and 20261016100000_unique_employee_code refuses to run
 * at all, which would fail every deploy. A list rather than a timestamp cutoff,
 * because PRs here merge out of timestamp order and a cutoff would silently skip
 * one. Never add a new migration to the baseline.
 *
 * WRITING A MIGRATION FOR IT. Files run one at a time, in name order, as a
 * single multi-statement query. A file with no BEGIN/COMMIT is still atomic.
 * The ledger row is written after the file succeeds, so a crash between the two
 * re-runs the file: keep migrations idempotent. CREATE INDEX CONCURRENTLY can't
 * run this way (the file fails with a clear error); apply that one by hand and
 * record it in the ledger.
 *
 * On failure it stops at that file, records nothing for it, runs nothing after
 * it and exits 1. The next deploy retries from the same file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const BASELINE_FILE = path.join(ROOT, 'scripts/migrate-baseline.json');

const LOCK_KEY = 7265765766;
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 1_000;

export function loadBaseline(file = BASELINE_FILE) {
  return new Set(JSON.parse(fs.readFileSync(file, 'utf8')).migrations);
}

/** Migration names (no extension) in run order. Down files are never run. */
export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .map((f) => f.slice(0, -'.sql'.length))
    .sort();
}

export function selectPending(names, baseline, applied) {
  return names.filter((name) => !baseline.has(name) && !applied.has(name));
}

async function readLedger(conn) {
  const { present } = await conn.one(
    `SELECT to_regclass('public.pgmigrations') IS NOT NULL AS present`
  );
  if (!present) return new Set();
  const rows = await conn.any(`SELECT name FROM pgmigrations`);
  return new Set(rows.map((r) => r.name));
}

async function acquireLock(conn, waitMs, retryMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { locked } = await conn.one(`SELECT pg_try_advisory_lock($1) AS locked`, [LOCK_KEY]);
    if (locked) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

/**
 * @returns {Promise<{pending: string[], applied: string[], failed: null|{name: string, message: string}}>}
 *   `failed` is set when a migration failed or another run held the lock.
 */
export async function runMigrations(db, {
  dir = MIGRATIONS_DIR,
  baseline = loadBaseline(),
  dryRun = false,
  log = console.log,
  lockWaitMs = LOCK_WAIT_MS,
  lockRetryMs = LOCK_RETRY_MS,
} = {}) {
  const names = listMigrations(dir);

  // One pinned connection: the advisory lock belongs to the session.
  return db.task(async (conn) => {
    if (dryRun) {
      const pending = selectPending(names, baseline, await readLedger(conn));
      log(`${pending.length} pending migration(s).`);
      pending.forEach((name) => log(`  ${name}`));
      return { pending, applied: [], failed: null };
    }

    if (!(await acquireLock(conn, lockWaitMs, lockRetryMs))) {
      const message = `Another migration run has held the lock for over ${lockWaitMs} ms.`;
      log(`FAILED: ${message}`);
      return { pending: [], applied: [], failed: { name: null, message } };
    }

    try {
      await conn.none(
        `CREATE TABLE IF NOT EXISTS pgmigrations (
           id serial PRIMARY KEY,
           name varchar(255) NOT NULL,
           run_on timestamp NOT NULL
         )`
      );

      // Read under the lock, so a run that just finished isn't repeated.
      const pending = selectPending(names, baseline, await readLedger(conn));
      if (!pending.length) {
        log('Already up to date. 0 pending migrations.');
        return { pending, applied: [], failed: null };
      }

      // The app pool's 2-minute statement_timeout is for requests. A migration
      // sets its own lock_timeout, and a backfill may legitimately run longer.
      await conn.none(`SET statement_timeout = 0`);

      const applied = [];
      for (const name of pending) {
        const sql = fs.readFileSync(path.join(dir, `${name}.sql`), 'utf8');
        const start = Date.now();
        try {
          await conn.query(sql);
        } catch (err) {
          // A file's own BEGIN stays open after an error. Harmless if it isn't.
          await conn.none(`ROLLBACK`).catch(() => {});
          log(`FAILED: ${name}: ${err.message}`);
          log(`Stopped. ${applied.length} applied, ${pending.length - applied.length} still pending.`);
          return { pending, applied, failed: { name, message: err.message } };
        }
        await conn.none(`INSERT INTO pgmigrations (name, run_on) VALUES ($1, now())`, [name]);
        applied.push(name);
        log(`Applied ${name} (${Date.now() - start} ms)`);
      }
      log(`Done. ${applied.length} migration(s) applied.`);
      return { pending, applied, failed: null };
    } finally {
      await conn.none(`RESET statement_timeout`).catch(() => {});
      await conn.any(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]).catch(() => {});
    }
  });
}

async function main() {
  // Imported here so that importing this module (tests) doesn't open a pool.
  const { default: db, pgp } = await import('../app/config/dbConn.js');
  try {
    const { failed } = await runMigrations(db, { dryRun: process.argv.includes('--dry-run') });
    if (failed) process.exitCode = 1;
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    process.exitCode = 1;
  } finally {
    pgp.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
