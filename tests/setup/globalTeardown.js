// Jest globalTeardown — drops the test database, even on test failure.

import { dropTestDb } from "./dropTestDb.js";

export default async function globalTeardown() {
  process.env.NODE_ENV = "test";
  try {
    await dropTestDb({ orphans: false });
  } catch (err) {
    // Don't mask test failures with teardown errors. Log and move on; the
    // orphan-cleanup mode of dropTestDb will handle it on the next run.
    console.warn(`[globalTeardown] WARN: ${err.message}`);
  }
}
