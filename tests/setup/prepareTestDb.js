// Creates the test database (hospitality_test_<runId>), applies schema.sql,
// then seed_reference.sql and seed_fixtures.sql. Re-syncs identity sequences.
//
// Usage:
//   node tests/setup/prepareTestDb.js          (CLI)
//   import { prepareTestDb } from "./prepareTestDb.js"; await prepareTestDb();
//
// Safety: see envguard.js. NODE_ENV must be 'test'; DB name must match
// ^hospitality_test(_[a-zA-Z0-9_-]+)?$.

import fs from "fs";
import path from "path";
import pg from "pg";
import { getTestDbConfig } from "./envguard.js";
import { seedFixtures } from "../fixtures/index.js";

const RESTRICT_LINE = /^\\(restrict|unrestrict)\b.*$/gm;

// FKs from reference tables that point to tables not in the reference set.
// Dropped before the reference seed loads, re-added after fixtures provide parents.
const REFERENCE_EXTERNAL_FKS = [
  {
    table: "tbl_approval_processes",
    name: "tbl_approval_processes_company_id_fkey",
    def: "FOREIGN KEY (company_id) REFERENCES tbl_company(id)",
  },
  {
    table: "tbl_approval_processes",
    name: "tbl_approval_processes_created_by_fkey",
    def: "FOREIGN KEY (created_by) REFERENCES tbl_users(id)",
  },
  {
    table: "tbl_charge_names",
    name: "tbl_charge_names_created_by_fkey",
    def: "FOREIGN KEY (created_by) REFERENCES tbl_users(id)",
  },
];

async function withClient(connConfig, fn) {
  // RDS requires SSL; local brew Postgres doesn't. TEST_DB_NO_SSL=1 (see
  // .env.test) flips the mode for the local-Postgres path.
  const ssl =
    process.env.TEST_DB_NO_SSL === "1" ? false : { rejectUnauthorized: false };
  const client = new pg.Client({ ...connConfig, ssl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function readSql(file) {
  const raw = fs.readFileSync(file, "utf8");
  // pg_dump 17.x emits \restrict / \unrestrict markers that node-postgres doesn't
  // understand. Strip them — they're metadata, not data.
  return raw.replace(RESTRICT_LINE, "");
}

async function applyFile(client, file, label) {
  if (!fs.existsSync(file)) return false;
  const sql = readSql(file);
  if (sql.trim().length === 0) return false;
  await client.query(sql);
  console.log(`[prepareTestDb] applied ${label} (${path.basename(file)})`);
  return true;
}

async function dropExternalFks(client) {
  for (const fk of REFERENCE_EXTERNAL_FKS) {
    await client.query(`ALTER TABLE ${fk.table} DROP CONSTRAINT IF EXISTS ${fk.name}`);
  }
}

async function readdExternalFks(client) {
  for (const fk of REFERENCE_EXTERNAL_FKS) {
    try {
      // NOT VALID skips re-validating existing rows — fine for test DB.
      await client.query(
        `ALTER TABLE ${fk.table} ADD CONSTRAINT ${fk.name} ${fk.def} NOT VALID`
      );
    } catch (err) {
      // Non-fatal: dangling parent IDs in fixtures would block this. Tests that
      // care about FK enforcement should use a fully-fixtured DB.
      console.warn(
        `[prepareTestDb] WARN: could not re-add ${fk.name}: ${err.message}`
      );
    }
  }
}

async function resyncSequences(client) {
  // Generate setval() statements for every column whose default is nextval(...).
  const { rows } = await client.query(`
    SELECT format(
      'SELECT setval(pg_get_serial_sequence(%L, %L), GREATEST(coalesce(max(%I),1), 1)) FROM %I',
      quote_ident(table_schema)||'.'||quote_ident(table_name),
      column_name,
      column_name,
      table_name
    ) AS stmt
    FROM information_schema.columns
    WHERE table_schema='public'
      AND column_default LIKE 'nextval(%'
      AND data_type IN ('integer','bigint')
  `);
  for (const { stmt } of rows) {
    try {
      await client.query(stmt);
    } catch {
      // Best-effort. Some tables may have NULL ids in fixtures (shouldn't, but harmless).
    }
  }
}

async function sanityCheck(client) {
  const { rows } = await client.query(`
    SELECT
      (SELECT count(*)::int FROM tbl_roles)             AS roles,
      (SELECT count(*)::int FROM tbl_permissions)       AS permissions,
      (SELECT count(*)::int FROM tbl_role_permissions)  AS role_permissions,
      (SELECT count(*)::int FROM tbl_approval_processes) AS approval_processes,
      (SELECT count(*)::int FROM tbl_category)          AS category
  `);
  const c = rows[0];
  const expectations = {
    roles: 21,
    permissions: 31,
    role_permissions: 138,
    approval_processes: 3,
    category: 188,
  };
  const failures = Object.entries(expectations)
    .filter(([k, min]) => c[k] < min)
    .map(([k, min]) => `${k}=${c[k]} (>=${min})`);
  if (failures.length) {
    throw new Error(
      `reference seed sanity check failed: ${failures.join(", ")}`
    );
  }
}

// Identifies pg-/network-level errors where the connection died between
// dispatch and reply — retrying the whole prepare flow is safe because each
// retry starts from `DROP DATABASE … WITH (FORCE)`, which always succeeds.
function isTransientConnectError(err) {
  if (!err) return false;
  const msg = String(err.message || "");
  return (
    err.code === "ECONNRESET" ||
    err.code === "ETIMEDOUT" ||
    err.code === "57P01" || // admin_shutdown
    /Connection terminated/i.test(msg) ||
    /Client has encountered a connection error/i.test(msg) ||
    /read ECONNRESET/i.test(msg) ||
    /write EPIPE/i.test(msg)
  );
}

/**
 * Applies migrations that have landed in migrations/ but are not yet in the
 * schema snapshot.
 *
 * schema.sql is a pg_dump of staging, so until a migration is applied there
 * and snapshotStaging.js is re-run, the test database is built from a schema
 * the code no longer targets. The resulting failure reads as "relation does
 * not exist", which sends you looking for a missing migration rather than a
 * stale snapshot.
 *
 * tests/setup/pendingMigrations.json bridges that window. Migrations are
 * applied in listed order and the list is emptied in whatever commit
 * refreshes the snapshot.
 */
async function applyPendingMigrations(client, setupDir) {
  const manifestFile = path.join(setupDir, "pendingMigrations.json");
  if (!fs.existsSync(manifestFile)) return;

  const { migrations = [] } = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (migrations.length === 0) return;

  const backendRoot = path.resolve(setupDir, "..", "..");
  for (const rel of migrations) {
    const file = path.join(backendRoot, rel);
    if (!fs.existsSync(file)) {
      throw new Error(
        `pendingMigrations.json lists ${rel}, which does not exist. ` +
          `Remove it from the list, or restore the file.`
      );
    }
    await client.query(readSql(file));
    await client.query("SET search_path = public, pg_catalog");
    console.log(`[prepareTestDb] applied pending migration ${path.basename(rel)}`);
  }
}

async function prepareTestDbOnce() {
  const cfg = getTestDbConfig();
  const adminConn = {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.maintenanceDb,
  };
  const targetConn = { ...adminConn, database: cfg.dbName };

  const schemaFile = path.join(cfg.setupDir, "schema.sql");
  const referenceFile = path.join(cfg.setupDir, "seed_reference.sql");

  if (!fs.existsSync(schemaFile)) {
    throw new Error(`missing ${schemaFile} — run snapshotStaging.js first`);
  }
  if (!fs.existsSync(referenceFile)) {
    throw new Error(`missing ${referenceFile} — run snapshotStaging.js first`);
  }

  console.log(`[prepareTestDb] target = ${cfg.dbName}`);

  await withClient(adminConn, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${cfg.dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${cfg.dbName}"`);
  });
  console.log(`[prepareTestDb] created ${cfg.dbName}`);

  await withClient(targetConn, async (client) => {
    await applyFile(client, schemaFile, "schema");
    // schema.sql sets search_path = '' — reset so subsequent statements in this
    // session can resolve unqualified table names like 'tbl_approval_processes'.
    await client.query("SET search_path = public, pg_catalog");

    await applyPendingMigrations(client, cfg.setupDir);

    await dropExternalFks(client);
    await applyFile(client, referenceFile, "seed_reference");
    // Reference seed dump also sets search_path = '' at its top.
    await client.query("SET search_path = public, pg_catalog");

    // Fixtures are an orchestrated JS module (tests/fixtures/index.js) that
    // inserts the production-shaped test population (companies, hotels, users,
    // role-scopes, processes, policies, vendors, subscriptions, ...).
    try {
      await seedFixtures(client);
      console.log("[prepareTestDb] applied fixtures");
      await client.query("SET search_path = public, pg_catalog");
      await readdExternalFks(client);
    } catch (err) {
      console.warn(
        `[prepareTestDb] WARN: fixture seed failed — FKs left dropped on test DB. (${err.message})`
      );
      throw err;
    }

    await resyncSequences(client);
    console.log("[prepareTestDb] resynced sequences");

    await sanityCheck(client);
  });

  console.log(`READY ${cfg.dbName}`);
  return cfg.dbName;
}

// Public entry: retries up to 3 times on transient RDS connection drops. The
// staging RDS occasionally drops idle TLS sockets when CI hits it back-to-back;
// without this retry, the entire test run aborts before a single suite starts.
export async function prepareTestDb() {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await prepareTestDbOnce();
    } catch (err) {
      lastErr = err;
      if (!isTransientConnectError(err) || attempt === MAX_ATTEMPTS) throw err;
      const delayMs = 500 * attempt;
      console.warn(
        `[prepareTestDb] transient ${err.code || "disconnect"} on attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${delayMs} ms`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

const isCli = path.resolve(process.argv[1] || "") === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
  prepareTestDb().catch((err) => {
    console.error("ABORT:", err.message);
    process.exit(1);
  });
}
