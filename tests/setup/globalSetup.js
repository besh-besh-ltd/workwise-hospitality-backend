// Jest globalSetup — creates the test database once per `npm test` run.
// Idempotent against orphan DBs from kill-9'd previous runs (the prepare step
// drops & recreates).

import { prepareTestDb } from "./prepareTestDb.js";

export default async function globalSetup() {
  // Belt and suspenders: ensure NODE_ENV=test for everything spawned downstream.
  process.env.NODE_ENV = "test";
  const dbName = await prepareTestDb();
  // Stash the resolved DB name so globalTeardown / db.js can read it.
  process.env.TEST_DB_NAME_RESOLVED = dbName;
}
