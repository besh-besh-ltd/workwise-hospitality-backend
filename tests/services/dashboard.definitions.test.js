// The shared definitions (dashboardMetrics) as each card uses them:
//   bid open / closed at exact IST time, real (non-regret) quotes, live
//   negotiation rounds, rejected POs awaiting re-award, stage turnaround, and
//   Smart Insights' link contract.
//
// Deltas against a baseline read, so the shared seed DB can't skew them.

import { describe, it, expect, afterAll, beforeEach, afterEach } from "@jest/globals";
import moment from "moment-timezone";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  makeRfqVisibleToDashboard,
  cleanupRfqs,
  addProductToRfq,
  makePO,
  cleanupPurchaseOrders,
  insertVendorQuote,
  makeApprovalInstanceWithApprover,
  cleanupApprovalInstances,
} from "../helpers/dashboardSeed.js";

afterAll(async () => {
  await closeDb();
});

const BUYER = IDS.users.a1_proc_buyer;
const WIDE = { start_date: "2020-01-01", end_date: "2999-01-01" };
const ist = (ms) => moment.tz("Asia/Kolkata").add(ms, "ms").format("YYYY-MM-DD HH:mm:ss");
const H = 3600_000;

const seeded = { rfqIds: [], poIds: [], approvals: [] };
beforeEach(() => {
  seeded.rfqIds = [];
  seeded.poIds = [];
  seeded.approvals = [];
});
afterEach(async () => {
  for (const [type, id] of seeded.approvals) await cleanupApprovalInstances(db, type, [id]);
  await cleanupPurchaseOrders(db, seeded.poIds);
  if (seeded.rfqIds.length) {
    await db.none(`DELETE FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1)`, [seeded.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1)`, [seeded.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [seeded.rfqIds]);
  }
  await cleanupRfqs(db, seeded.rfqIds);
});

async function get(path, query = {}, user = BUYER) {
  const client = await httpClient(user);
  const res = await client.get(`/api/v1/dashboard-v2/${path}`).query({ hotel_ids: String(IDS.hotels.A1), ...WIDE, ...query });
  expect(res.status).toBe(200);
  expect(res.body?.status).toBe(1);
  return res.body.data;
}

async function rfq(extra = {}) {
  const { rfq_id } = await makeRfqVisibleToDashboard(db, {
    createdBy: BUYER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
    is_published: 1, status: 1, title: "Definitions RFQ", ...extra,
  });
  seeded.rfqIds.push(rfq_id);
  return rfq_id;
}

describe("bid window (exact IST time)", () => {
  it("Snapshot: a published RFQ whose bid has passed is in progress, not active", async () => {
    const b = await get("procurement-snapshot");
    await rfq({ bid_end_date: ist(-2 * H) });
    await rfq({ bid_end_date: ist(+2 * H) });
    const a = await get("procurement-snapshot");
    expect(a.active_rfqs - b.active_rfqs).toBe(1);
    expect(a.in_progress_rfqs - b.in_progress_rfqs).toBe(1);
  });

  it("Action Centre ending-soon: excludes a bid that closed an hour ago, includes one closing in 71h, excludes 73h", async () => {
    const b = await get("action-center");
    await rfq({ bid_end_date: ist(-1 * H) });
    await rfq({ bid_end_date: ist(71 * H) });
    await rfq({ bid_end_date: ist(73 * H) });
    const a = await get("action-center");
    expect(a.rfqs_ending_soon - b.rfqs_ending_soon).toBe(1);
  });

  it("No-response: a bid that closed an hour ago is expired (same calendar day)", async () => {
    const id = await rfq({ bid_end_date: ist(-1 * H) });
    const d = await get("no-response");
    expect(d.expired.map((r) => r.id)).toContain(id);
    expect(d.active.map((r) => r.id)).not.toContain(id);
  });
});

describe("a regret is a response but not an offer", () => {
  it("a regret-only RFQ past its bid is 'ended without quotes' in the banner AND the no-response list", async () => {
    const b = await get("buyer-status-banner");
    const id = await rfq({ bid_end_date: ist(-2 * H) });
    const qid = await insertVendorQuote(db, { rfq_id: id, vendor_user_id: IDS.users.vendor_alpha });
    await db.none(`UPDATE tbl_quotes SET is_regret = 1 WHERE id = $1`, [qid]);
    const a = await get("buyer-status-banner");
    const nr = await get("no-response");
    expect(a.counts.closed_no_quotes - b.counts.closed_no_quotes).toBe(1);
    const row = nr.expired.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row.regret_count).toBe(1);
  });
});

describe("quotes ready to compare (banner)", () => {
  it("needs a closed bid; an ENDED round is not live, an ACTIVE one is", async () => {
    const b = await get("buyer-status-banner");
    const open = await rfq({ bid_end_date: ist(+5 * H) });
    await insertVendorQuote(db, { rfq_id: open, vendor_user_id: IDS.users.vendor_alpha });
    const ended = await rfq({ bid_end_date: ist(-5 * H) });
    await insertVendorQuote(db, { rfq_id: ended, vendor_user_id: IDS.users.vendor_alpha });
    await db.none(
      `INSERT INTO tbl_negotiation_rounds (rfq_id, round_number, end_date, status, created_by, created_at)
       VALUES ($1, 1, now() - interval '1 day', 'ENDED', $2, now())`,
      [ended, BUYER]
    );
    const live = await rfq({ bid_end_date: ist(-5 * H) });
    await insertVendorQuote(db, { rfq_id: live, vendor_user_id: IDS.users.vendor_alpha });
    await db.none(
      `INSERT INTO tbl_negotiation_rounds (rfq_id, round_number, end_date, status, created_by, created_at)
       VALUES ($1, 1, now() + interval '1 day', 'ACTIVE', $2, now())`,
      [live, BUYER]
    );
    const a = await get("buyer-status-banner");
    // Only `ended` is ready: `open` still has a sealed bid window, `live` is negotiating.
    expect(a.counts.quote_compare_ready - b.counts.quote_compare_ready).toBe(1);
  });
});

describe("rejected POs awaiting re-award", () => {
  it("counts POs (not lines), splits vendor vs internal rejections, and the list equals the tiles", async () => {
    const b = await get("action-center");
    const id = await rfq();
    const p1 = await addProductToRfq(db, id);
    const p2 = await addProductToRfq(db, id);
    const { po_id: vendorRejected, pop_id } = await makePO(db, {
      rfq_id: id, rfq_product_id: p1.rfq_product_id, vendor_user_id: IDS.users.vendor_alpha,
      company_id: IDS.companies.A, status: "rejected_by_vendor", unit_price: 100,
    });
    // A second line on the same PO — must not double-count the PO.
    await db.none(
      `INSERT INTO tbl_purchase_order_product (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
       VALUES ($1, $2, 0, 1, 'units', 50, 50)`,
      [vendorRejected, p2.rfq_product_id]
    );
    const { po_id: internal } = await makePO(db, {
      rfq_id: id, rfq_product_id: p1.rfq_product_id, vendor_user_id: IDS.users.vendor_beta,
      company_id: IDS.companies.A, status: "rejected", unit_price: 70,
    });
    seeded.poIds.push(vendorRejected, internal);
    expect(pop_id).toBeTruthy();

    const a = await get("action-center");
    expect(a.rejected_vendors - b.rejected_vendors).toBe(1);
    expect(a.rejected_in_approval - b.rejected_in_approval).toBe(1);

    const list = await get("rejected-pos");
    const mine = list.filter((r) => r.rfq_id === id);
    expect(mine).toHaveLength(2);
    const vr = mine.find((r) => r.po_id === vendorRejected);
    expect(vr.rejection_source).toBe("vendor");
    expect(vr.po_value).toBeCloseTo(150, 2);
    expect(list.length).toBe(a.rejected_vendors + a.rejected_in_approval);

    // A live replacement PO for every line clears it from the queue.
    const { po_id: replacement } = await makePO(db, {
      rfq_id: id, rfq_product_id: p1.rfq_product_id, vendor_user_id: IDS.users.vendor_beta,
      company_id: IDS.companies.A, status: "approved",
    });
    seeded.poIds.push(replacement);
    await db.none(
      `INSERT INTO tbl_purchase_order_product (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
       VALUES ($1, $2, 0, 1, 'units', 50, 50)`,
      [replacement, p2.rfq_product_id]
    );
    const c = await get("action-center");
    expect(c.rejected_vendors - b.rejected_vendors).toBe(0);
    expect(c.rejected_in_approval - b.rejected_in_approval).toBe(0);
  });
});

describe("stage turnaround (workflow-efficiency)", () => {
  it("reports median / P90 / n over APPROVED approvals only; n counts distinct RFQs", async () => {
    const approver = IDS.users.a1_proc_poApp;
    const b = await get("workflow-efficiency");
    const stageOf = (d) => d.stages.find((s) => s.stage_name === "po_approval") || { rfq_count: 0, samples: 0 };

    const id = await rfq();
    const { rfq_product_id } = await addProductToRfq(db, id);
    const hours = [2, 4, 30];
    for (const h of hours) {
      const { po_id } = await makePO(db, {
        rfq_id: id, rfq_product_id, vendor_user_id: IDS.users.vendor_alpha,
        company_id: IDS.companies.A, status: "approved",
      });
      seeded.poIds.push(po_id);
      await makeApprovalInstanceWithApprover(db, {
        entity_type: "PO", entity_id: po_id, approver_user_id: approver, policy_id: IDS.policies.A1_P1_PO,
        hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
        instance_status: "APPROVED", approver_status: "APPROVED", created_ago_hours: h + 1, acted_ago_hours: 1,
      });
      seeded.approvals.push(["PO", po_id]);
    }
    // A CANCELLED approval is not a turnaround.
    const { po_id: cancelled } = await makePO(db, {
      rfq_id: id, rfq_product_id, vendor_user_id: IDS.users.vendor_alpha, company_id: IDS.companies.A, status: "cancelled",
    });
    seeded.poIds.push(cancelled);
    const inst = await makeApprovalInstanceWithApprover(db, {
      entity_type: "PO", entity_id: cancelled, approver_user_id: approver, policy_id: IDS.policies.A1_P1_PO,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, created_ago_hours: 500,
    });
    await db.none(`UPDATE tbl_approval_instances SET status = 'CANCELLED', completed_at = now() WHERE id = $1`, [inst.instance_id]);
    seeded.approvals.push(["PO", cancelled]);

    // An approval decided within a minute was not waited on: instant_count,
    // not a sample.
    const { po_id: instantPo } = await makePO(db, {
      rfq_id: id, rfq_product_id, vendor_user_id: IDS.users.vendor_alpha, company_id: IDS.companies.A, status: "approved",
    });
    seeded.poIds.push(instantPo);
    const instant = await makeApprovalInstanceWithApprover(db, {
      entity_type: "PO", entity_id: instantPo, approver_user_id: approver, policy_id: IDS.policies.A1_P1_PO,
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, instance_status: "APPROVED", approver_status: "APPROVED",
    });
    await db.none(`UPDATE tbl_approval_instances SET completed_at = created_at + interval '20 seconds' WHERE id = $1`, [instant.instance_id]);
    seeded.approvals.push(["PO", instantPo]);

    const a = await get("workflow-efficiency");
    const sb = stageOf(b);
    const sa = stageOf(a);
    expect(sa.rfq_count - sb.rfq_count).toBe(1);
    expect(sa.samples - sb.samples).toBe(3);
    expect(sa.instant_count - (sb.instant_count || 0)).toBe(1);
    if (sb.samples === 0) {
      expect(sa.median_hours).toBeCloseTo(4, 0);
      expect(sa.p90_hours).toBeLessThanOrEqual(30);
    }
    a.stages.forEach((s) => {
      expect(s.median_hours).toBeGreaterThanOrEqual(0);
      expect(s.p90_hours).toBeGreaterThanOrEqual(s.median_hours);
    });
  });
});

describe("Smart Insights link contract", () => {
  const ACTION_TYPES = ["rfqList", "poList", "reports", "rfqDetail", "poDetail"];

  it("emits action {type, params} from the allow-list and never a URL", async () => {
    const d = await get("smart-insights");
    for (const ins of d.insights) {
      expect(ins).not.toHaveProperty("action_url");
      expect(ACTION_TYPES).toContain(ins.action.type);
      expect(typeof ins.action.params).toBe("object");
      expect(ins.description).not.toMatch(/<[a-z/]/i);
    }
  });

  it("a vendor whose only 'wins' are ₹0 regret lines is never the best-pricing vendor", async () => {
    const id = await rfq();
    const { product_variant_id } = await addProductToRfq(db, id);
    const rfqNo = (await db.one(`SELECT rfq_no FROM tbl_rfq WHERE id = $1`, [id])).rfq_no;
    const quote = async (vendor, price) => {
      const qid = await insertVendorQuote(db, { rfq_id: id, vendor_user_id: vendor });
      await db.none(
        `INSERT INTO tbl_quote_items (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, comment, delivery_period, quantity, variant)
         VALUES ($1, $2, $3, $4, $5, $5, '', '', '1', 1)`,
        [id, rfqNo, qid, product_variant_id, price]
      );
    };
    await quote(IDS.users.vendor_alpha, 0);   // regret line
    await quote(IDS.users.vendor_beta, 500);  // real offer
    await quote(IDS.users.vendor_gamma ?? IDS.users.vendor_alpha, 650);
    const d = await get("smart-insights", { start_date: moment.tz("Asia/Kolkata").format("YYYY-MM-DD"), end_date: moment.tz("Asia/Kolkata").format("YYYY-MM-DD") });
    const vendorInsight = d.insights.find((i) => i.type === "vendor_optimization");
    if (vendorInsight) {
      const alpha = await db.one(
        `SELECT COALESCE(NULLIF(TRIM(c.company_name), ''), u.name) AS n FROM tbl_users u LEFT JOIN tbl_company c ON c.id = u.company_id WHERE u.id = $1`,
        [IDS.users.vendor_alpha]
      );
      expect(vendorInsight.title.startsWith(alpha.n)).toBe(false);
    }
  });
});
