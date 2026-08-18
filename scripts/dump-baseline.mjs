#!/usr/bin/env node
/**
 * Re-baselining: dump a database's schema into migrations/baseline/production_baseline.sql
 * and regenerate migrations/baseline/MANIFEST.txt to match.
 *
 * This exists because the ORIGINAL baseline was produced by a `pg_dump` command
 * typed by hand and pasted into a task brief under .superpowers/sdd/ — a scratch
 * planning directory deleted once that plan finishes. migrations/README.md tells
 * the next person to re-baseline "roughly annually", but gave them no durable
 * source for the exact exclusion list or the psql-meta-command strip. This script
 * IS that durable source: the exclusion list below, the `\restrict` strip, and the
 * production-vs-staging guard all live here in git, not in a directory that gets
 * deleted.
 *
 *   npm run migrate:dump-baseline -- --database hospitality_main
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import pg from "pg";
import dotenv from "dotenv";
import { buildConnection, describeTarget } from "./lib/migrationConfig.mjs";
import { listMigrations, ledgerName } from "./lib/migrationFiles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");
const BASELINE_DIR = join(MIGRATIONS_DIR, "baseline");
const OUT_FILE = join(BASELINE_DIR, "production_baseline.sql");
const MANIFEST_FILE = join(BASELINE_DIR, "MANIFEST.txt");
const LEDGER_TABLE = "pgmigrations";

// Same rule as scripts/migrate.mjs: on a deploy host the environment arrives via
// `docker run --env-file`, so there is no .env to read and dotenv must not
// clobber it. Locally there is.
if (!process.env.HOST && existsSync(join(ROOT, ".env"))) {
  dotenv.config({ path: join(ROOT, ".env") });
}

/**
 * Tables pg_dump must skip entirely. None of these are schema anyone migrates —
 * every one is either a frozen point-in-time snapshot or scratch landing space,
 * and including them would only bloat the artefact with dead weight that grows
 * every re-baseline. Grouped by WHY, not just what they're named, so someone
 * re-baselining without this task's context can tell "yes, still safe to skip"
 * from the comment alone rather than re-deriving it.
 */
const EXCLUDED_TABLES = [
  // Hand-made point-in-time snapshots taken before a risky data rewrite
  // (a department-access rewrite, a policy-deactivation cleanup). They freeze
  // data as it stood on some past date; nothing in migrations/ creates, reads,
  // or expects them to exist.
  "public._migration_dept_access_backup",
  "public._migration_policy_deactivation_backup",
  // Ad-hoc *_backup / *_bkp copies made by hand before a risky UPDATE/DELETE on
  // the live table, then never cleaned up. Same reasoning as above: frozen data,
  // not tracked schema — a name ending in _backup or _bkp is never itself the
  // application's schema, it's someone's insurance policy from one incident.
  "public.tbl_rfq_products_specs_orphan_backup",
  "public.tbl_user_role_scopes_ash1_backup",
  "public.tbl_user_role_scopes_prod04_backup",
  "public.tbl_category_bkp",
  "public.tbl_product_bkp",
  "public.tbl_product_categories_bkp",
  "public.tbl_product_variant_bkp",
  // Staging import scratch space: landing tables for one-off product-catalog /
  // search-index imports. They hold data mid-migration into the real tables,
  // not application schema — nothing in the codebase queries them.
  "public.stg_products",
  "public.product_search_record",
  // The migration ledger itself. Excluded because of WHEN it appeared: the
  // ORIGINAL baseline was dumped from a production database that predated
  // `pgmigrations`, so scripts/migrate-replay.mjs owns the table's DDL (its
  // CREATE_LEDGER) and creates it before seeding MANIFEST.txt. Production now
  // HAS the table, so the next re-baseline would bake node-pg-migrate's own
  // CREATE TABLE into the dump — silently turning CREATE_LEDGER's
  // `IF NOT EXISTS` into a no-op and moving authority for that table's shape
  // from a script in git to a generated artefact nobody reads. Keep the
  // ledger's definition in exactly one place.
  `public.${LEDGER_TABLE}`,
];

/**
 * pg_dump 17 emits `\restrict <token>` / `\unrestrict <token>` psql meta-commands
 * bracketing the dump, meant to stop the file being fed to anything but psql.
 * Stripped here, at generation time, rather than by the reader — that means the
 * file applies through ANY client with no psql involved at all, including the
 * plain `pg` driver scripts/migrate-replay.mjs (Task 7) uses, and
 * tests/setup/prepareTestDb.js:17 stripping them again at read time is then a
 * belt-and-braces no-op rather than the only thing standing between this file
 * and a client that doesn't understand psql meta-commands.
 */
const RESTRICT_LINE_RE = /^\\(?:restrict|unrestrict)[^\n]*\n?/gm;

/**
 * Signals that a dump came from STAGING, not production — the whole reason this
 * script requires an explicit --database with no default. A human doing this by
 * hand a year from now will not remember to eyeball the dump for these; the
 * script must, every time, unconditionally.
 *
 * Sources: the migration-runner adoption audit (2026-08-14) found these columns
 * and this table exist on staging in NO migration file — hand-applied residue
 * from unmerged WIP branches — and therefore must NEVER appear in a baseline
 * meant to describe what production's migrations already cover.
 *
 * TIME-LIMITED — REVISIT WHEN THE STAGING DRIFT REPAIR SHIPS. This list, and
 * tblQuoteItemsHasRealMoney() below, detect staging by the very residue the
 * spec's deferred "Repairing the staging drift" ticket exists to REMOVE — and
 * that ticket names the `real` -> `numeric(15,2)` conversion these two checks
 * split between them as its headline. The day the repair lands, both halves stop
 * matching anything and this guard passes a staging dump silently, with nothing
 * to announce that it stopped working.
 *
 * The durable guard is the pgmigrations cross-check in ledgerIds() /
 * assertLedgerMatchesTree(): a database whose ledger does not match the working
 * tree is refused whatever its columns look like, and staging's ledger will
 * diverge from production's the moment the two are not deployed in lockstep.
 * Treat these markers as a fast, legible second opinion — not the load-bearing
 * check — and delete or replace them when the drift repair merges.
 */
const STAGING_MARKERS = [
  "bypass_arc",
  "is_network_scope",
  "tbl_tender_sendback_history",
  "iteration_number",
  "is_department_scoped",
];

/**
 * tbl_quote_items money columns are the starkest production/staging divergence
 * the audit found: `numeric(15,2)` on production, `real` (float4) on staging.
 * A raw whole-file grep for "real" is USELESS here — tbl_quote_item_history
 * legitimately has `real` money columns on production too (it predates the
 * numeric migration and nothing has backfilled it), so that grep would flag a
 * good production dump as bad. This instead extracts tbl_quote_items's own
 * CREATE TABLE block and inspects only its column lines.
 */
function tblQuoteItemsHasRealMoney(dump) {
  const match = dump.match(/CREATE TABLE public\.tbl_quote_items \([\s\S]*?\n\);/);
  if (!match) return false; // table missing entirely is a different failure, not this check's job
  return match[0]
    .split("\n")
    .some((line) => /^\s*\w+\s+real(\s|,|\))/.test(line));
}

function findStagingSignals(dump) {
  const hits = STAGING_MARKERS.filter((marker) => dump.includes(marker));
  if (tblQuoteItemsHasRealMoney(dump)) {
    hits.push("tbl_quote_items has a money column typed real (production is numeric(15,2))");
  }
  return hits;
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument '${token}' — flags must be passed as --name value or --name=value`);
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

function runPgDump(conn) {
  return new Promise((resolve, reject) => {
    const args = [
      "-h", conn.host,
      "-p", String(conn.port),
      "-U", conn.user,
      "-d", conn.database,
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      "--no-comments",
      ...EXCLUDED_TABLES.flatMap((t) => ["--exclude-table", t]),
    ];
    const env = { ...process.env, PGPASSWORD: conn.password };
    const child = spawn("pg_dump", args, { env });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`pg_dump exited ${code}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/**
 * What the WORKING TREE says the migration set is. Same list + same id
 * normalisation scripts/migrate.mjs's `manifest` command uses (via
 * scripts/lib/migrationFiles.mjs).
 *
 * NOT the manifest's source any more — only one half of the cross-check below.
 */
function treeIds() {
  const { migrations, invalid } = listMigrations(MIGRATIONS_DIR);
  if (invalid.length > 0) {
    throw new Error(`invalid migration file(s) in migrations/: ${invalid.join(", ")}`);
  }
  return migrations.map((m) => m.id);
}

/**
 * What the DUMPED DATABASE says it has actually applied.
 *
 * MANIFEST.txt's own header claims its entries are "Migrations already applied
 * in the database that production_baseline.sql was dumped from", and until this
 * function existed that claim was unverified: the manifest was built from
 * listMigrations(), i.e. from whatever happened to be checked out.
 *
 * That is not an exotic failure — it is the NORMAL case. Production applies
 * migrations behind a manual approval, so `main` is routinely AHEAD of
 * production. Re-baseline on such a day and MANIFEST claims migrations the dump
 * does not contain; migrate-replay.mjs then seeds them as already applied, the CI
 * dry-run never replays them, and every later PR replays onto a floor missing
 * that schema. Nothing downstream notices: the replay asserts row COUNT against
 * array length (equal either way), and migrate:verify passes because the
 * over-claimed rows genuinely are in the ledger.
 *
 * Returns BARE ids (no extension) — what node-pg-migrate stores in `name`.
 */
async function ledgerIds(conn) {
  const client = new pg.Client(conn);
  await client.connect();
  try {
    const { rows } = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [
      `public.${LEDGER_TABLE}`,
    ]);
    if (!rows[0].present) {
      throw new Error(
        `refusing: '${conn.database}' has no '${LEDGER_TABLE}' table, so it cannot say which ` +
          "migrations it has applied — and a database with no ledger cannot be baselined FROM. " +
          "Baseline it first (npm run migrate:baseline -- --confirm " +
          `${conn.database}), or point --database at a database that has been.`
      );
    }
    const applied = await client.query(`SELECT name FROM ${LEDGER_TABLE} ORDER BY id`);
    return applied.rows.map((r) => r.name);
  } finally {
    await client.end();
  }
}

function formatSet(label, ids) {
  return ids.length === 0 ? `  ${label}: (none)` : `  ${label}:\n${ids.map((i) => `    ${i}`).join("\n")}`;
}

/**
 * The database is the authority for MANIFEST.txt, but a disagreement with the
 * working tree is never something to resolve silently in either direction:
 * "tree ahead of database" means the checkout carries migrations production has
 * not applied, and "database ahead of tree" means production ran something this
 * checkout does not contain. Both are real conditions with different remedies,
 * and picking a winner automatically would bake one of them into the artefact
 * CI replays onto. Print both sides and stop.
 */
function assertLedgerMatchesTree(applied, tree) {
  const treeBare = tree.map(ledgerName);
  const appliedSet = new Set(applied);
  const treeSet = new Set(treeBare);
  const onlyInDb = applied.filter((n) => !treeSet.has(n));
  const onlyInTree = treeBare.filter((n) => !appliedSet.has(n));
  if (onlyInDb.length === 0 && onlyInTree.length === 0) return;
  throw new Error(
    "refusing: the database's ledger and the working tree disagree about which migrations exist.\n" +
      formatSet(`applied in the database but not in migrations/ (${onlyInDb.length})`, onlyInDb) +
      "\n" +
      formatSet(`in migrations/ but not applied in the database (${onlyInTree.length})`, onlyInTree) +
      "\n  A baseline must describe a database exactly. If migrations/ is ahead, this checkout " +
      "carries work the target has not applied yet — check out the commit it IS on, or apply them. " +
      "If the database is ahead, it ran something this checkout does not have. Neither is safe to " +
      "guess at, so nothing was written."
  );
}

function assertNoDuplicates(label, ids) {
  if (new Set(ids).size === ids.length) return;
  const seen = new Set();
  const dupes = [...new Set(ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
  throw new Error(
    `refusing: ${label} contains duplicate migration id(s): ${dupes.join(", ")}. ` +
      "migrate-replay.mjs seeds one ledger row per line, so a duplicate would make the replay's " +
      "row-count assertion pass against a ledger that misrepresents what ran."
  );
}

/**
 * Header text stays close to what migrations/baseline/MANIFEST.txt already
 * carries so a re-baseline diffs only where the migration set actually changed.
 * The last line is corrected: `migrate:manifest` prints the WORKING TREE's ids,
 * which is precisely the thing this file must not be generated from.
 *
 * Ids are written WITH the `.sql` suffix, which is the format
 * scripts/migrate-replay.mjs expects and maps back through ledgerName().
 * The ledger stores them bare; do not "simplify" by writing bare ids here
 * without changing that reader too.
 */
function manifestContent(conn, applied) {
  const date = new Date().toISOString().slice(0, 10);
  const header = [
    "# Migrations already applied in the database that production_baseline.sql was dumped from.",
    `# Source: ${conn.database}, ${date}.`,
    "#",
    "# Read from that database's pgmigrations ledger, NOT from the migrations/",
    "# directory — main is routinely ahead of production, and a manifest built from",
    "# the checkout would claim migrations the dump does not contain.",
    "#",
    "# CI seeds these into pgmigrations before replaying a PR's migrations, so the",
    "# replay applies exactly what production is missing — no more, no less.",
    "# Regenerate with 'npm run migrate:dump-baseline -- --database <name>'.",
  ];
  return [...header, ...applied.map((name) => `${name}.sql`)].join("\n") + "\n";
}

/**
 * Temp-file + rename, matching production_baseline.sql's write above. The two
 * files are one artefact: a half-written MANIFEST beside a complete dump would
 * make CI replay onto a floor that never existed.
 */
function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  // No default, ever. hospitality_main and hospitality_stage live on the same
  // RDS host — the entire point of this artefact is that it comes from
  // production, and a default here is exactly the kind of thing that gets
  // silently wrong a year from now when someone copies an old command.
  if (typeof flags.database !== "string" || flags.database.length === 0) {
    throw new Error(
      "refusing: --database <name> is required with no default. " +
        "hospitality_main and hospitality_stage are two databases on the SAME RDS " +
        "instance — an unspecified target risks dumping staging's schema (which the " +
        "2026-08-14 audit found has 20 columns and a whole table hand-applied outside " +
        "every migration) and committing it as if it were production's. " +
        "Pass --database hospitality_main explicitly."
    );
  }

  const conn = buildConnection();
  conn.database = flags.database;

  // Asked BEFORE pg_dump runs: both of these can refuse, and refusing after a
  // multi-second dump of a production database is wasted work on a shared
  // instance. Neither writes anything.
  const applied = await ledgerIds(conn);
  assertNoDuplicates(`${conn.database}'s ${LEDGER_TABLE} ledger`, applied);
  const tree = treeIds();
  assertNoDuplicates("the migrations/ directory", tree);
  assertLedgerMatchesTree(applied, tree);
  console.log(`Ledger  : ${applied.length} migration(s) applied in ${conn.database}, matching migrations/.`);

  console.log(`Dumping schema-only from ${describeTarget(conn)} (read-only pg_dump)...`);
  const rawDump = await runPgDump(conn);
  const dump = rawDump.replace(RESTRICT_LINE_RE, "");

  const tmpFile = `${OUT_FILE}.tmp`;
  // Written to a temp path FIRST and only moved into place after the staging
  // guard below passes. That way a bad dump never touches the committed
  // production_baseline.sql at all — not "written then deleted on error", which
  // would leave a window (a killed process, a full disk) where the real
  // artefact could end up clobbered or half-written.
  writeFileSync(tmpFile, dump);

  const signals = findStagingSignals(dump);
  if (signals.length > 0) {
    unlinkSync(tmpFile);
    throw new Error(
      `refusing: dump of '${conn.database}' looks like STAGING, not production. ` +
        `Found: ${signals.join("; ")}. ` +
        "migrations/baseline/production_baseline.sql was left untouched. " +
        "Did you mean --database hospitality_main?"
    );
  }

  const tableCount = (dump.match(/^CREATE (UNLOGGED )?TABLE /gm) || []).length;
  // Counts newline characters, matching `wc -l` — NOT dump.split("\n").length,
  // which over-counts by one whenever the file ends with a trailing newline
  // (the split produces a final empty element that isn't a line).
  const lineCount = (dump.match(/\n/g) || []).length;
  console.log(`production_baseline.sql: ${lineCount} lines, ${tableCount} CREATE TABLE statement(s) (incl. UNLOGGED).`);

  renameSync(tmpFile, OUT_FILE);

  writeAtomic(MANIFEST_FILE, manifestContent(conn, applied));
  const manifestIdCount = readFileSync(MANIFEST_FILE, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#")).length;
  console.log(`MANIFEST.txt: ${manifestIdCount} migration id(s), from ${conn.database}'s ledger.`);

  console.log(`\nWrote ${OUT_FILE}\nWrote ${MANIFEST_FILE}`);
}

main().catch((err) => {
  console.error(`\nABORT: ${err.message}`);
  process.exit(1);
});
