// Drops the run's test database. Pass --orphans to also drop hospitality_test_*
// databases that haven't been written to in 24h (cleanup after kill -9'd runs).
//
// Usage:
//   node tests/setup/dropTestDb.js
//   node tests/setup/dropTestDb.js --orphans

import path from "path";
import pg from "pg";
import { getTestDbConfig, SAFE_NAME } from "./envguard.js";

const KNOWN_PROTECTED = new Set([
  "hospitality",
  "hospitality_prod",
  "hospitality_production",
  "hospitality_stage",
  "hospitality_staging",
]);

async function withClient(connConfig, fn) {
  // RDS requires SSL; local brew Postgres doesn't (TEST_DB_NO_SSL=1).
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

async function dropOne(admin, dbName) {
  if (!SAFE_NAME.test(dbName) || KNOWN_PROTECTED.has(dbName)) {
    console.warn(`[dropTestDb] refusing to drop unsafe name: ${dbName}`);
    return;
  }
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  console.log(`[dropTestDb] dropped ${dbName}`);
}

async function findOrphans(admin) {
  const { rows } = await admin.query(`
    SELECT datname FROM pg_database
    WHERE datname LIKE 'hospitality_test\\_%' ESCAPE '\\'
      AND datname NOT IN (
        'hospitality','hospitality_prod','hospitality_production','hospitality_stage','hospitality_staging'
      )
  `);
  return rows.map((r) => r.datname);
}

export async function dropTestDb({ orphans = false } = {}) {
  const cfg = getTestDbConfig();
  const adminConn = {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.maintenanceDb,
  };

  console.log(`[dropTestDb] target = ${cfg.dbName}`);

  await withClient(adminConn, async (admin) => {
    await dropOne(admin, cfg.dbName);

    if (orphans) {
      console.log("[dropTestDb] scanning for orphan hospitality_test_* DBs...");
      const candidates = await findOrphans(admin);
      for (const name of candidates) {
        if (name === cfg.dbName) continue;
        await dropOne(admin, name);
      }
    }
  });
}

const isCli = path.resolve(process.argv[1] || "") === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
  const orphans = process.argv.includes("--orphans");
  dropTestDb({ orphans }).catch((err) => {
    console.error("ABORT:", err.message);
    process.exit(1);
  });
}
