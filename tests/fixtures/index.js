// Fixture orchestrator. Called by prepareTestDb.js after schema + seed_reference
// have been applied. Inserts the production-shaped test population in dependency
// order so each section's parent rows exist before child rows reference them.
//
// IMPORTANT: this is the "ambient population" that survives across tests.
// Per-test data (specific RFQs, quotes, POs, approval instances for a given
// scenario) belongs in factories under tests/factories/, not here.

import { IDS } from "./ids.js";
import { seedNetwork } from "./network.js";
import { seedUsers } from "./users.js";
import { seedProcesses } from "./processes.js";
import { seedPolicies } from "./policies.js";
import { seedVendors } from "./vendors.js";

/**
 * Run all fixture sections inside one big transaction. If any section fails,
 * the whole seed rolls back — no half-populated test DB.
 *
 * `pgClient` is a node-postgres Client (already connected to the test DB).
 * We wrap it so the section helpers can use a tx-like .none() interface.
 */
export async function seedFixtures(pgClient) {
  const tx = makeTxAdapter(pgClient);

  await pgClient.query("BEGIN");
  try {
    await seedNetwork(tx);
    await seedUsers(tx);
    await seedProcesses(tx);
    await seedPolicies(tx);
    await seedVendors(tx);
    await pgClient.query("COMMIT");
  } catch (err) {
    await pgClient.query("ROLLBACK");
    throw err;
  }
}

// Adapter: maps the pg-promise-style .none(sql, params) interface that the
// section files use onto a plain pg.Client. Keeps the section files portable
// across pg-promise (used by app + tests/setup/db.js) and raw pg (used by
// prepareTestDb.js's bootstrap path).
function makeTxAdapter(client) {
  return {
    async none(sql, params = []) {
      await client.query(sql, params);
    },
    async one(sql, params = []) {
      const r = await client.query(sql, params);
      if (r.rowCount !== 1) {
        throw new Error(`expected exactly 1 row, got ${r.rowCount}`);
      }
      return r.rows[0];
    },
    async oneOrNone(sql, params = []) {
      const r = await client.query(sql, params);
      return r.rows[0] ?? null;
    },
    async any(sql, params = []) {
      const r = await client.query(sql, params);
      return r.rows;
    },
  };
}

export { IDS };
