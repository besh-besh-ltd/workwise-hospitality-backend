#!/usr/bin/env node
/**
 * Rebuilds a throwaway database into the shape production is in, so a PR's
 * migrations can be applied to it and observed.
 *
 * This is the dry run. Printing the SQL a migration would run proves nothing —
 * the interesting failures are "that column already exists", "that FK has no
 * parent", "that backfill violates a NOT NULL". Only an apply finds those, and
 * only an apply against production's actual shape finds the ones that matter.
 *
 * Guard: refuses any database whose name is not migration_replay[_suffix], and
 * refuses to run against SSL (i.e. against RDS). Both mistakes are otherwise
 * one typo away from dropping a real database.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildConnection, describeTarget } from "./lib/migrationConfig.mjs";
import { ledgerName } from "./lib/migrationFiles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "migrations", "baseline", "production_baseline.sql");
const MANIFEST = join(ROOT, "migrations", "baseline", "MANIFEST.txt");
const MIGRATIONS_TABLE = "pgmigrations";
const SAFE_NAME = /^migration_replay(_[a-zA-Z0-9_]+)?$/;

// node-pg-migrate's own DDL for its ledger. Reproduced because the baseline is
// dumped from a database that predates the ledger, so CI has to create it.
const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS public.${MIGRATIONS_TABLE} (
    id     serial PRIMARY KEY,
    name   varchar(255) NOT NULL,
    run_on timestamp    NOT NULL
  )`;

function manifestIds() {
  return readFileSync(MANIFEST, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    // Routed through the same seam migrate.mjs uses to decide what is pending.
    // If these two ever disagreed, CI would replay migrations production already
    // has — and pass, because they are all idempotent.
    .map(ledgerName);
}

async function withClient(conn, fn) {
  const client = new pg.Client(conn);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function main() {
  const conn = buildConnection();

  if (!SAFE_NAME.test(conn.database)) {
    throw new Error(
      `refusing to drop '${conn.database}': the replay target must match ${SAFE_NAME}. ` +
        "This script drops its target database."
    );
  }
  if (conn.ssl !== false) {
    throw new Error(
      "refusing to run with SSL enabled: the replay target is a local/CI Postgres. " +
        "Set TEST_DB_NO_SSL=1, and check you are not pointed at RDS."
    );
  }

  const maintenance = { ...conn, database: process.env.REPLAY_MAINTENANCE_DB || "postgres" };
  console.log(`Replay target : ${describeTarget(conn)}`);

  await withClient(maintenance, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${conn.database}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${conn.database}"`);
  });
  console.log(`Recreated ${conn.database}`);

  await withClient(conn, async (client) => {
    await client.query(readFileSync(BASELINE, "utf8"));
    // The dump sets search_path = '' at its top; reset it so the unqualified
    // statements below resolve. Same reason as tests/setup/prepareTestDb.js:193.
    await client.query("SET search_path = public, pg_catalog");
    console.log("Applied production_baseline.sql");

    const ids = manifestIds();
    await client.query(CREATE_LEDGER);
    await client.query(
      `INSERT INTO ${MIGRATIONS_TABLE} (name, run_on) SELECT unnest($1::text[]), now()`,
      [ids]
    );

    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${MIGRATIONS_TABLE}`);
    if (rows[0].n !== ids.length) {
      throw new Error(`ledger holds ${rows[0].n} rows, expected ${ids.length} from the manifest`);
    }
    console.log(`Seeded ${ids.length} baselined migration(s) into ${MIGRATIONS_TABLE}`);
  });

  console.log("\nReady. Run `npm run migrate:up` against the same env to replay.");
}

main().catch((err) => {
  console.error(`\nABORT: ${err.message}`);
  process.exit(1);
});
