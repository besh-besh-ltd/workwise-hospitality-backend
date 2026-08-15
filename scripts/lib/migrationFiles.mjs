/**
 * Enumerating and naming migration files.
 *
 * Both scripts/migrate.mjs and scripts/check-migrations.mjs read the migrations
 * directory, and they must agree byte-for-byte on what counts as a migration and
 * what its ledger id is. If they disagree, the CI gate passes files the runner
 * then silently ignores — which is the exact failure mode that let
 * run_pending_migrations.sh drift two migrations behind the directory.
 *
 * The id normalisation (NAME.up.sql -> NAME.sql) reproduces what node-pg-migrate's
 * 'sql' loader stores in the ledger. It is reimplemented rather than imported
 * because check-migrations.mjs runs in a ~10s fail-fast job with no database and
 * must not pull the runner in.
 */
import { readdirSync } from "node:fs";

/** YYYYMMDDHHMMSS_lower_snake_slug.(up|down).sql — nothing else is a migration. */
export const FILENAME_RE = /^(\d{14})_([a-z0-9]+(?:_[a-z0-9]+)*)\.(up|down)\.sql$/;

/**
 * "Is this name in scope for the migration gates at all?" — deliberately CASE-
 * INSENSITIVE, and deliberately the one expression everything routes through.
 *
 * Case matters because macOS and Windows filesystems are case-insensitive: a
 * `git mv` typo, or an editor that helpfully upper-cases an extension, produces
 * `migrations/Foo.SQL`. With a case-SENSITIVE `.endsWith(".sql")` that file is
 * invisible to every gate here AND to `migrate:status` (which reports 0 pending,
 * green) AND to node-pg-migrate — whose `ignorePattern` in scripts/migrate.mjs is
 * likewise case-sensitive, so it ignores the file too. Measured, not assumed: a
 * `migrations/Foo.SQL` placed in the tree produced a clean `status` and a clean
 * `up` against a scratch database.
 *
 * A silently-ignored file in migrations/ is precisely the drift that
 * run_pending_migrations.sh died of — a migration nobody runs and nothing
 * notices. Matching case-insensitively makes such a file *visible*: it fails
 * gate 1 with a naming error at review time, and listMigrations() reports it as
 * invalid so migrate.mjs refuses to guess. Loud beats silent.
 */
const SQL_EXT_RE = /\.sql$/i;

/**
 * True for a directory-relative path naming a .sql file directly inside
 * migrations/, not nested in a subdirectory.
 *
 * Lives here, beside listMigrations(), because the two must describe the same
 * set of files. listMigrations() reads the runner's view with a NON-recursive
 * readdirSync(dir), so anything git reports one level deeper — e.g. the
 * migrations/baseline/ snapshot dump — is invisible to the runner and must be
 * invisible to the gates too, or gates fire on files node-pg-migrate never
 * touches. scripts/check-migrations.mjs imports this rather than restating it:
 * a second copy is a second thing to forget to update.
 */
export function isTopLevelSql(strippedPath) {
  return SQL_EXT_RE.test(strippedPath) && !strippedPath.includes("/");
}

export function parseMigrationFilename(filename) {
  const match = FILENAME_RE.exec(filename);
  if (!match) return null;
  const [, timestamp, slug, direction] = match;
  return { filename, timestamp, slug, direction, id: `${timestamp}_${slug}.sql` };
}

export function listMigrations(dir) {
  const invalid = [];
  const byId = new Map();

  // Case-insensitive on purpose — see SQL_EXT_RE. `Foo.SQL` must land in
  // `invalid` (where migrate.mjs turns it into a hard error naming the file)
  // rather than being dropped on the floor by this filter.
  for (const filename of readdirSync(dir).filter((f) => SQL_EXT_RE.test(f)).sort()) {
    const parsed = parseMigrationFilename(filename);
    if (!parsed) {
      invalid.push(filename);
      continue;
    }
    const entry = byId.get(parsed.id) ?? {
      id: parsed.id,
      timestamp: parsed.timestamp,
      slug: parsed.slug,
      up: null,
      down: null,
    };
    entry[parsed.direction] = filename;
    byId.set(parsed.id, entry);
  }

  // Ids are `<14 digits>_<slug>.sql`, so lexicographic order is chronological.
  const migrations = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { migrations, invalid };
}

/**
 * The string node-pg-migrate stores in pgmigrations.name for a given id.
 *
 * The 'sql' loader pairs NAME.up.sql with NAME.down.sql under the internal id
 * NAME.sql — but the string that reaches the `name` column is the BARE id, with
 * no extension. Measured, not assumed: Task 1's spike ran the real runner against
 * a real database and read it back with
 * `SELECT name, length(name) FROM pgmigrations`, getting '20260101000000_first'
 * at length 20. The runner's own log confirms it:
 *   INSERT INTO "public"."pgmigrations" (name, run_on) VALUES ('20260101000000_first', NOW());
 *
 * scripts/migrate.mjs (which decides what is pending) and
 * scripts/migrate-replay.mjs (which seeds the baselined rows) both route through
 * this one function, so they cannot disagree about the format. If they ever did,
 * CI would seed 55 rows the runner does not recognise, re-apply all 55 on top of
 * a database that already has them, and still pass — every one of those
 * migrations is idempotent, so a full re-apply is indistinguishable from a no-op.
 */
export function ledgerName(id) {
  return id.replace(/\.sql$/, "");
}
