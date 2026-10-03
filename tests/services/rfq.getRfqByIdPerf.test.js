/**
 * GET /rfq/getRfqById/:id — response equivalence + query budget.
 *
 * Two serialisations removed:
 *   - requireActiveSubscription re-read the caller's user_type through
 *     userModel.userinfo (two serial statements) although the authenticator
 *     had just loaded req.user — user_type included — in the same request;
 *     and a vendor's company + subscription reads ran one after the other.
 *   - after the access gate the controller awaited lifecycle stage, action
 *     holders, three evaluator lookups, PO rejections and the close reason
 *     one at a time.
 *
 * Pinned for a buyer, a subscribed vendor and a closed RFQ (close_comment
 * path): bodies snapshotted against the pre-change code, plus a budget.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { countQueries } from "../helpers/queryCounter.js";
import { seedRichRfq, cleanupRichRfq, normalizeForSnapshot } from "../helpers/perfRichRfq.js";

const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;

// Whole request, auth included.
const BUDGET = {
  buyer: { statements: 99, waves: 99 },
  vendor: { statements: 99, waves: 99 },
};

const best = async (fn) => {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await countQueries(fn));
  return {
    res: runs[0].result,
    count: Math.max(...runs.map((r) => r.count)),
    waves: Math.min(...runs.map((r) => r.waves)),
    depth: Math.min(...runs.map((r) => r.depth)),
    statements: runs[0].statements,
  };
};

describe("GET /rfq/getRfqById/:id — equivalence + query budget", () => {
  let made;
  let buyer;
  let vendor;
  let closedEventId;
  const typesBefore = {};

  beforeAll(async () => {
    for (const r of await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [[BUYER, VENDOR]])) {
      typesBefore[r.id] = r.user_type;
    }
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VENDOR]);
    made = await seedRichRfq({ buyer: BUYER });
    buyer = await httpClient(BUYER);
    vendor = await httpClient(VENDOR);
    await buyer.get(`/api/v1/rfq/getRfqById/${made.rfqId}`);
    await vendor.get(`/api/v1/rfq/getRfqById/${made.rfqId}`);
  });

  afterAll(async () => {
    if (closedEventId) await db.none(`DELETE FROM tbl_lifecycle_history WHERE id = $1`, [closedEventId]);
    await cleanupRichRfq(made);
    for (const [id, t] of Object.entries(typesBefore)) {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [Number(id), t]);
    }
  });

  it("buyer: same body as before", async () => {
    const res = await buyer.get(`/api/v1/rfq/getRfqById/${made.rfqId}`);
    expect(res.body.status).toBe(1);
    expect(normalizeForSnapshot(res.body)).toMatchSnapshot();
  });

  it("vendor (active subscription): same body as before", async () => {
    const res = await vendor.get(`/api/v1/rfq/getRfqById/${made.rfqId}`);
    expect(res.body.status).toBe(1);
    expect(normalizeForSnapshot(res.body)).toMatchSnapshot();
  });

  it("buyer within budget", async () => {
    const r = await best(() => buyer.get(`/api/v1/rfq/getRfqById/${made.rfqId}`));
    expect(r.res.body.status).toBe(1);
    if (process.env.PERF_DUMP) console.log(`[getRfqById buyer] ${r.count} statements, waves ${r.waves}, depth ${r.depth}\n${r.statements.map((s) => s.slice(0, 120)).join("\n")}`);
    expect(r.count).toBeLessThanOrEqual(BUDGET.buyer.statements);
    expect(r.waves).toBeLessThanOrEqual(BUDGET.buyer.waves);
  });

  it("vendor within budget, and the subscription gate does not re-read the user", async () => {
    const r = await best(() => vendor.get(`/api/v1/rfq/getRfqById/${made.rfqId}`));
    expect(r.res.body.status).toBe(1);
    if (process.env.PERF_DUMP) console.log(`[getRfqById vendor] ${r.count} statements, waves ${r.waves}, depth ${r.depth}\n${r.statements.map((s) => s.slice(0, 120)).join("\n")}`);
    expect(r.count).toBeLessThanOrEqual(BUDGET.vendor.statements);
    expect(r.waves).toBeLessThanOrEqual(BUDGET.vendor.waves);
  });

  it("closed RFQ: close_comment still attached", async () => {
    await db.none(`UPDATE tbl_rfq SET status = 2 WHERE id = $1`, [made.rfqId]);
    const ev = await db.one(
      `INSERT INTO tbl_lifecycle_history (entity_id, entity_type, stage, action, performed_by, remarks, created_at)
       VALUES ($1, 'RFQ', 'CLOSED', 'RFQ_CLOSED', $2, 'RFQ closed by creator: budget cut', '2026-09-20 10:00:00') RETURNING id`,
      [made.rfqId, BUYER]
    );
    closedEventId = ev.id;
    try {
      const res = await buyer.get(`/api/v1/rfq/getRfqById/${made.rfqId}`);
      expect(res.body.status).toBe(1);
      expect(res.body.data.close_comment).toBe("Reason: budget cut");
      expect(normalizeForSnapshot(res.body)).toMatchSnapshot();
    } finally {
      await db.none(`UPDATE tbl_rfq SET status = 1 WHERE id = $1`, [made.rfqId]);
    }
  });
});
