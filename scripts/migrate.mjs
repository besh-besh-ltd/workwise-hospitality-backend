#!/usr/bin/env node
/**
 * The single entry point for database migrations.
 *
 * Wraps node-pg-migrate's programmatic API rather than shelling out to its CLI,
 * for two reasons. First, this repo's env vars are HOST / DATABASE_USERNAME /
 * DATABASE_NAME, not DATABASE_URL, so a connection has to be assembled either
 * way. Second, node-pg-migrate ships no `status` command, and the production
 * approval gate is worth little if the reviewer cannot see what they are
 * approving before they approve it.
 *
 *   npm run migrate:status
 *   npm run migrate:up
 *   npm run migrate:down -- --count 1
 *   npm run migrate:verify
 *   npm run migrate:baseline -- --confirm hospitality_main
 *   npm run migrate:manifest
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import pg from "pg";
import dotenv from "dotenv";
import { runner } from "node-pg-migrate";
import { buildConnection, describeTarget } from "./lib/migrationConfig.mjs";
import { listMigrations, ledgerName } from "./lib/migrationFiles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");
const MIGRATIONS_TABLE = "pgmigrations";

// On a deploy host the environment arrives via `docker run --env-file`, so there
// is no .env to read and dotenv must not clobber it. Locally there is.
if (!process.env.HOST && existsSync(join(ROOT, ".env"))) {
  dotenv.config({ path: join(ROOT, ".env") });
}

function parseArgs(argv) {
  const [command = "status", ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") ? true : rest[++i];
  }
  return { command, flags };
}

function runnerOptions(client, overrides) {
  return {
    dbClient: client,
    dir: MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    // Each migration commits independently. With the default `true`, all pending
    // migrations share one transaction — which would make "add an enum label in
    // one migration, use it in the next" impossible, and would turn a
    // three-migration deploy into an all-or-nothing three-way rollback.
    singleTransaction: false,
    // Refuses a migration whose timestamp predates one already applied — the
    // two-PRs-merged-out-of-order case.
    checkOrder: true,
    // staging and production are two databases on one RDS instance. Queue rather
    // than fail if the lock turns out to be instance-scoped.
    advisoryLockMode: "wait",
    // Pairs NAME.up.sql with NAME.down.sql; ledger id normalises to NAME.sql.
    migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
    // Consider ONLY .sql files. Without this, node-pg-migrate scans every entry in
    // the directory and throws `Cannot determine numeric prefix for "<name>"` on the
    // first one that is not a migration — a stray shell script is enough to break
    // every deploy. Its default ignore is `^\..*` (dotfiles only), which covers
    // .DS_Store but not `run_notification_catchup.sh`.
    //
    // The deeper reason is agreement: `status` counts pending work through our own
    // listMigrations(), which already looks at .sql alone. If the runner's scan saw a
    // different set, `status` would report "0 pending" while `up` threw — the two
    // halves of one CLI disagreeing about what exists.
    //
    // The library anchors this itself as `^<pattern>$` (dist/legacy/migration.js), so
    // it reads: any name that does not end in .sql.
    ignorePattern: "(?!.*\\.sql$).*",
    verbose: true,
    ...overrides,
  };
}

async function ledgerNames(client) {
  const { rows } = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [
    `public.${MIGRATIONS_TABLE}`,
  ]);
  if (!rows[0].present) return null;
  const applied = await client.query(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`);
  return applied.rows.map((r) => r.name);
}

async function computeStatus(client) {
  const { migrations, invalid } = listMigrations(MIGRATIONS_DIR);
  if (invalid.length > 0) {
    throw new Error(
      `migrations/ contains ${invalid.length} file(s) that are not valid migrations: ${invalid.join(", ")}`
    );
  }
  const applied = await ledgerNames(client);
  const appliedSet = new Set(applied ?? []);
  const pending = migrations.filter((m) => !appliedSet.has(ledgerName(m.id)));
  return { migrations, applied, pending };
}

const commands = {
  async status(client, conn) {
    const { migrations, applied, pending } = await computeStatus(client);
    console.log(`Target : ${describeTarget(conn)}`);
    console.log(`Ledger : ${MIGRATIONS_TABLE}${applied === null ? " (does not exist yet)" : ""}`);
    console.log(`Files  : ${migrations.length}   Applied: ${applied?.length ?? 0}   Pending: ${pending.length}`);
    if (pending.length > 0) {
      console.log("\nPending:");
      for (const m of pending) console.log(`  ${m.id}${m.down ? "" : "   (no down migration)"}`);
    }
    // Machine-readable for the CD plan job. Keep this line's format stable.
    console.log(`\nPENDING_COUNT=${pending.length}`);
  },

  async up(client, conn) {
    const { pending } = await computeStatus(client);
    console.log(`Target : ${describeTarget(conn)}`);
    if (pending.length === 0) {
      console.log("Nothing to apply.");
      return;
    }
    console.log(`Applying ${pending.length} migration(s)...`);
    await runner(runnerOptions(client, { direction: "up", count: Infinity }));
    console.log(`\nApplied ${pending.length} migration(s).`);
  },

  async down(client, conn, flags) {
    const count = Number(flags.count ?? 1);
    if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a positive integer");
    console.log(`Target : ${describeTarget(conn)}`);
    console.log(`Reverting ${count} migration(s)...`);
    await runner(runnerOptions(client, { direction: "down", count }));
  },

  async verify(client, conn) {
    const { pending } = await computeStatus(client);
    console.log(`Target : ${describeTarget(conn)}   Pending: ${pending.length}`);
    if (pending.length > 0) {
      for (const m of pending) console.error(`  unapplied: ${m.id}`);
      throw new Error(`${pending.length} migration(s) are not applied`);
    }
    console.log("OK: database is up to date.");
  },

  async baseline(client, conn, flags) {
    // The only command that writes ledger rows for migrations it did not run.
    // Requiring the database name to be typed back makes "wrong terminal" a
    // typo rather than an incident.
    if (flags.confirm !== conn.database) {
      throw new Error(
        `refusing to baseline: pass --confirm ${conn.database} to confirm the target ` +
          `(got ${flags.confirm === undefined ? "nothing" : `'${flags.confirm}'`})`
      );
    }
    const { pending } = await computeStatus(client);
    console.log(`Target : ${describeTarget(conn)}`);
    console.log(`Marking ${pending.length} migration(s) as applied WITHOUT running them.`);
    await runner(runnerOptions(client, { direction: "up", count: Infinity, fake: true }));
    const after = await ledgerNames(client);
    console.log(`\nLedger now holds ${after.length} row(s).`);
  },

  async manifest() {
    const { migrations, invalid } = listMigrations(MIGRATIONS_DIR);
    if (invalid.length > 0) throw new Error(`invalid migration file(s): ${invalid.join(", ")}`);
    for (const m of migrations) console.log(m.id);
  },
};

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const run = commands[command];
  if (!run) {
    console.error(`Unknown command '${command}'. Expected one of: ${Object.keys(commands).join(", ")}`);
    process.exit(2);
  }

  if (command === "manifest") {
    await run();
    return;
  }

  const conn = buildConnection();
  const client = new pg.Client(conn);
  await client.connect();
  try {
    await run(client, conn, flags);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`\nABORT: ${err.message}`);
  process.exit(1);
});
