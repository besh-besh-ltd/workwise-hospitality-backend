/**
 * GET /negotiation/rounds/:rfq_id and /rounds/:rfq_id/active-all.
 *
 * 1. getRounds looked up assigned vendors once PER ROUND and vendor status once
 *    PER PRODUCT. Both are now one statement each; the body is snapshotted
 *    against the pre-change code and the statement count must not scale with
 *    rounds or products.
 * 2. SECURITY: getActiveRounds (active-all) had no buyer tenant check — any
 *    authenticated buyer could read another company's live rounds (vendor ids,
 *    targets, vendor approvals) by walking rfq ids. Its sibling getRounds has
 *    gated buyers on userCanReadRfqNegotiation since the P0 IDOR fix; the same
 *    gate now applies here. The vendor path (no-login email token) is
 *    unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { countQueries } from "../helpers/queryCounter.js";
import { seedRichRfq, cleanupRichRfq, normalizeForSnapshot } from "../helpers/perfRichRfq.js";

const BUYER = IDS.users.a1_proc_buyer;
// Holds negotiation.read at A1 / Procurement (role COMM_NEGO_N1).
const NEGOTIATOR = IDS.users.a1_proc_commEval;
const OTHER_TENANT_BUYER = IDS.users.companyB_admin;
const VENDOR = IDS.users.vendor_alpha;

// Whole request, auth included; 3 rounds over 2 products.
//   before: 8 statements / 5 waves (1 vendor read per round + 1 per product)
//   after : 5 statements / 4 waves, constant in rounds and products
const BUDGET = { statements: 5, waves: 4 };

describe("negotiation rounds — batched vendor lookups + active-all tenant gate", () => {
  let made;
  let buyer;
  const typesBefore = {};

  beforeAll(async () => {
    for (const r of await db.any(`SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [[BUYER, NEGOTIATOR, OTHER_TENANT_BUYER, VENDOR]])) {
      typesBefore[r.id] = r.user_type;
    }
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [[BUYER, NEGOTIATOR, OTHER_TENANT_BUYER]]);
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [VENDOR]);
    made = await seedRichRfq({ buyer: BUYER });
    // Make the ACTIVE round live so active-all has something to leak.
    await db.none(`UPDATE tbl_negotiation_rounds SET end_date = '2099-01-01 00:00:00' WHERE rfq_id = $1 AND status = 'ACTIVE'`, [made.rfqId]);
    buyer = await httpClient(NEGOTIATOR);
    await buyer.get(`/api/v1/negotiation/rounds/${made.rfqId}`);
  });

  afterAll(async () => {
    await cleanupRichRfq(made);
    for (const [id, t] of Object.entries(typesBefore)) {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [Number(id), t]);
    }
  });

  it("GET /rounds/:rfq_id returns the same body as before", async () => {
    const res = await buyer.get(`/api/v1/negotiation/rounds/${made.rfqId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(normalizeForSnapshot(res.body, { idKeyed: { vendors: "rfq_product_id" } })).toMatchSnapshot();
  });

  it("GET /rounds/:rfq_id?rfq_product_id= returns the same body as before", async () => {
    const res = await buyer.get(`/api/v1/negotiation/rounds/${made.rfqId}?rfq_product_id=${made.productIds[1]}`);
    expect(res.status).toBe(200);
    expect(normalizeForSnapshot(res.body, { idKeyed: { vendors: "rfq_product_id" } })).toMatchSnapshot();
  });

  it("GET /rounds/:rfq_id stays within budget (no per-round / per-product lookups)", async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await countQueries(() => buyer.get(`/api/v1/negotiation/rounds/${made.rfqId}`)));
    const count = Math.max(...runs.map((r) => r.count));
    const waves = Math.min(...runs.map((r) => r.waves));
    if (process.env.PERF_DUMP) console.log(`[rounds] ${count} statements, waves ${waves}\n${runs[0].statements.map((s) => s.slice(0, 110)).join("\n")}`);
    expect(count).toBeLessThanOrEqual(BUDGET.statements);
    expect(waves).toBeLessThanOrEqual(BUDGET.waves);
  });

  it("active-all: an in-scope buyer still sees the RFQ's active rounds", async () => {
    const res = await buyer.get(`/api/v1/negotiation/rounds/${made.rfqId}/active-all`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("active-all: a buyer from ANOTHER company is refused, and learns nothing", async () => {
    const outsider = await httpClient(OTHER_TENANT_BUYER);
    const res = await outsider.get(`/api/v1/negotiation/rounds/${made.rfqId}/active-all`);
    expect(res.status).toBe(403);
    expect(res.body.status).toBe(0);
    expect(res.body.data).toBeUndefined();
  });

  it("active-all: the sibling getRounds refuses the same outsider (parity)", async () => {
    const outsider = await httpClient(OTHER_TENANT_BUYER);
    const res = await outsider.get(`/api/v1/negotiation/rounds/${made.rfqId}`);
    expect(res.status).toBe(403);
  });

  it("active-all: the vendor path is unchanged (own live rounds only)", async () => {
    const vendor = await httpClient(VENDOR);
    const res = await vendor.get(`/api/v1/negotiation/rounds/${made.rfqId}/active-all`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const r of res.body.data) {
      expect(r).not.toHaveProperty("vendor_ids");
      for (const va of r.vendor_approvals || []) expect(va.vendor_id).toBe(VENDOR);
    }
  });
});
