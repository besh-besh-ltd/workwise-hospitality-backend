/**
 * GET /rfq/:rfqId/lifecycle — response equivalence + query budget.
 *
 * Production (SigNoz, Oct 2026): ~65 statements in ~20 serial waves per call,
 * max 254. The cost was structural, not SQL: tbl_rfq read three times, the
 * scope check and the permission lookup awaited one after the other, every
 * approval instance loaded step-by-step (1 + 1 + steps + 1 queries EACH), and
 * the upcoming-actor resolver re-resolving policies, roles and user names per
 * phase and per step.
 *
 * Two contracts are pinned on a deliberately busy RFQ (tests/helpers/
 * perfRichRfq.js — partial award, REMOVED tombstones, a CANCELLED + a PENDING
 * instance per entity type, multiple negotiation rounds, an active delegation):
 *
 *   1. EQUIVALENCE — the body is snapshotted (ids/timestamps tokenised). The
 *      snapshot was written against the pre-optimisation code and must not
 *      change: the batched loaders are a re-plumbing, not a behaviour change.
 *   2. BUDGET — statements and serial waves issued by the app pool for the
 *      whole request (auth included) stay under the new ceiling, so a per-row
 *      loop creeping back in fails here instead of on a p95 graph.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { countQueries } from "../helpers/queryCounter.js";
import { seedRichRfq, cleanupRichRfq, normalizeForSnapshot } from "../helpers/perfRichRfq.js";

const BUYER = IDS.users.a1_proc_buyer;
// Whole request, auth included. Before: 63 statements / 16-19 waves locally.
const BUDGET = { statements: 63, waves: 24 };

describe("GET /rfq/:rfqId/lifecycle — equivalence + query budget", () => {
  let made;
  let client;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    made = await seedRichRfq({ buyer: BUYER });
    client = await httpClient(BUYER);
    // Warm-up: first request pays one-off module/pool initialisation.
    await client.get(`/api/v1/rfq/${made.rfqId}/lifecycle`);
  });

  afterAll(async () => {
    await cleanupRichRfq(made);
    await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [BUYER]);
  });

  it("returns the same body as before the batching refactor", async () => {
    const res = await client.get(`/api/v1/rfq/${made.rfqId}/lifecycle`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(normalizeForSnapshot(res.body)).toMatchSnapshot();
  });

  it("stays within the statement and serial-wave budget", async () => {
    // Waves are timing-sensitive (a sibling issued a tick late can open its own
    // wave), so take the best of three; the statement count is deterministic.
    const runs = [];
    for (let i = 0; i < 3; i++) {
      runs.push(await countQueries(() => client.get(`/api/v1/rfq/${made.rfqId}/lifecycle`)));
    }
    for (const r of runs) expect(r.result.body.status).toBe(1);
    const count = Math.max(...runs.map((r) => r.count));
    const waves = Math.min(...runs.map((r) => r.waves));
    if (process.env.PERF_DUMP) {
      // eslint-disable-next-line no-console
      console.log(`[lifecycle] statements=${count} waves=${waves}\n` +
        runs[0].statements.map((s) => s.slice(0, 140)).join("\n"));
    }
    expect(count).toBeLessThanOrEqual(BUDGET.statements);
    expect(waves).toBeLessThanOrEqual(BUDGET.waves);
  });
});
