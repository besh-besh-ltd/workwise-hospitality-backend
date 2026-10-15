// Builds the LOCAL Vendor Networks E2E database (hospitality_test_<E2E_RUN_ID>,
// default hospitality_test_e2e) with the test harness's own prepare step:
// schema.sql + seed_reference.sql + pendingMigrations.json + the test fixtures,
// against the HOST in .env.test (local Postgres).
//
// Why a wrapper and not `TEST_RUN_ID=e2e npm run test:setup`: the harness loads
// .env.test with `override: true`, so the TEST_RUN_ID in .env.test (e.g. `vnet`)
// silently wins over the one on the command line, and the prepare step would
// DROP and rebuild this worktree's TEST database instead. This wrapper re-applies
// the run id after every dotenv load, so the harness computes the e2e name.
//
//   node scripts/vendor_networks/e2e_prepare_db.mjs            -> hospitality_test_e2e
//   E2E_RUN_ID=e2e2 node scripts/vendor_networks/e2e_prepare_db.mjs
//
// The harness's own guards still apply (NODE_ENV=test, name ^hospitality_test_…).
// It DROPS AND RECREATES the target database: re-run the seed afterwards.

import dotenv from "dotenv";

const runId = process.env.E2E_RUN_ID || "e2e";
if (!/^[a-zA-Z0-9_]+$/.test(runId)) {
  console.error(`ABORT: E2E_RUN_ID '${runId}' must be [a-zA-Z0-9_]+`);
  process.exit(2);
}
process.env.NODE_ENV = "test";

// dotenv is CommonJS: every importer shares this one exports object.
const loadEnv = dotenv.config.bind(dotenv);
dotenv.config = (opts) => {
  const result = loadEnv(opts);
  process.env.TEST_RUN_ID = runId;
  process.env.NODE_ENV = "test";
  return result;
};

const { getTestDbConfig } = await import("../../tests/setup/envguard.js");
const cfg = getTestDbConfig();
if (!["localhost", "127.0.0.1", "::1"].includes(cfg.host)) {
  console.error(`ABORT: .env.test HOST must be local, got '${cfg.host}'`);
  process.exit(2);
}
if (cfg.dbName !== `hospitality_test_${runId}`) {
  console.error(`ABORT: harness resolved '${cfg.dbName}', expected hospitality_test_${runId}`);
  process.exit(2);
}

const { prepareTestDb } = await import("../../tests/setup/prepareTestDb.js");
await prepareTestDb();
