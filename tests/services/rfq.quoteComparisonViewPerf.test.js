/**
 * GET /rfq/quote-comparison-view/:id — response equivalence + query budget.
 *
 * getQuoteComparisonView awaited a dozen independent side lookups one after
 * another (categories, approvals, finalizations, rounds, doc counts, tech
 * state, stage actors, …). They are now issued together. Pinned on the same
 * busy RFQ as the lifecycle test (tests/helpers/perfRichRfq.js):
 *
 *   1. EQUIVALENCE — body snapshot written against the pre-change code.
 *   2. BUDGET — statements / serial waves for the whole request.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { countQueries } from "../helpers/queryCounter.js";
import { seedRichRfq, cleanupRichRfq, normalizeForSnapshot } from "../helpers/perfRichRfq.js";

const BUYER = IDS.users.a1_proc_buyer;
const VENDOR_HISTORY = [
  "invited_rfqs", "is_new", "on_time_pct", "orders_done", "po_value",
  "pos_accepted", "quote_pct", "quoted_rfqs", "track_record",
];
// Whole request, auth included. Before: 92 statements / 46 waves locally.
const BUDGET = { statements: 92, waves: 52 };

describe("GET /rfq/quote-comparison-view/:id — equivalence + query budget", () => {
  let made;
  let client;

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    made = await seedRichRfq({ buyer: BUYER });
    client = await httpClient(BUYER);
    // Warm-up: first request pays one-off module/pool initialisation.
    await client.get(`/api/v1/rfq/quote-comparison-view/${made.rfqId}`);
  });

  afterAll(async () => {
    await cleanupRichRfq(made);
    await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [BUYER]);
  });

  it("returns the same body as before the parallelisation", async () => {
    const res = await client.get(`/api/v1/rfq/quote-comparison-view/${made.rfqId}`);
    expect(res.status).toBe(200);
    expect(res.body.rfq).toBeDefined();
    // Vendor track-record stats aggregate over the vendor's whole history,
    // which other suites in the shard can move — masked, not asserted.
    expect(normalizeForSnapshot(res.body, { mask: VENDOR_HISTORY })).toMatchSnapshot();
  });

  it("stays within the statement and serial-wave budget", async () => {
    // Waves are timing-sensitive (a sibling issued a tick late can open its own
    // wave), so take the best of three; the statement count is deterministic.
    const runs = [];
    for (let i = 0; i < 3; i++) {
      runs.push(await countQueries(() => client.get(`/api/v1/rfq/quote-comparison-view/${made.rfqId}`)));
    }
    for (const r of runs) expect(r.result.body.rfq).toBeDefined();
    const count = Math.max(...runs.map((r) => r.count));
    const waves = Math.min(...runs.map((r) => r.waves));
    if (process.env.PERF_DUMP) {
      // eslint-disable-next-line no-console
      console.log(`[qc-view] statements=${count} waves=${waves}\n` +
        runs[0].statements.map((s) => s.slice(0, 140)).join("\n"));
    }
    expect(count).toBeLessThanOrEqual(BUDGET.statements);
    expect(waves).toBeLessThanOrEqual(BUDGET.waves);
  });
});
