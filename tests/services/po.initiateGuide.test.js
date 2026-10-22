// PO initiate guidance — "who can initiate this draft, and what kind is it?"
// ----------------------------------------------------------------------------
// Client ticket T1: the Commercial Approver (or whoever holds awarding.create)
// has to be guided to the drafted PO. This suite covers the buyer-facing data:
//   - PO detail: can_initiate, initiate_kind, raised_by / approval_initiated_by,
//     sibling_drafts (only for people who can act on them)
//   - GET /po/:id/initiators ordering by how close the person is (scope_breadth)
//   - "Pending for me" no longer lists a PO the vendor already accepted
//   - POST /negotiation/quotes/:id/approve answers with the drafted PO
//   - initiating twice stays idempotent
//
// Rows are seeded into tbl_rfq_purchase_order + tbl_purchase_order_product, the
// same two tables the award flow (draftPurchaseOrder) writes. The approve-quotes
// test goes through the real HTTP endpoint instead of seeding the draft.
//
// Fixture users (grants added at runtime, removed in afterAll):
//   a1_proc_poApp    FINAL_AWARDING_P1 at (A, A1, proc)         department-scoped
//   a1_proc_finance  + FINAL_AWARDING_P1 at (A, A1, any dept)   hotel-scoped
//   a1_proc_techApp  + FINAL_AWARDING_P1 at (A, any hotel)      company-wide
//   a1_proc_commEval + FINAL_AWARDING_P1 at (A, A1, proc, process A_P2)  wrong process
//   a1_proc_commApp  awarding.read only                          can see, cannot initiate
//   a1_proc_buyer    rfq.read only (the draft's creator)         cannot initiate

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  makeRfqVisibleToDashboard, addProductToRfq, makePO, cleanupPurchaseOrders, cleanupRfqs,
} from "../helpers/dashboardSeed.js";
import { createApprovalInstance } from "../../app/models/generalModel.js";

const CREATOR = IDS.users.a1_proc_buyer;
const DEPT_USER = IDS.users.a1_proc_poApp;
const HOTEL_USER = IDS.users.a1_proc_finance;
const COMPANY_USER = IDS.users.a1_proc_techApp;
const WRONG_PROCESS = IDS.users.a1_proc_commEval;
const READER = IDS.users.a1_proc_commApp;
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const ALL_BUYERS = [CREATOR, DEPT_USER, HOTEL_USER, COMPANY_USER, WRONG_PROCESS, READER];

const c = {};            // user id -> client
const grantIds = [];
const userTypeBackup = new Map();
const created = { rfqIds: [], poIds: [], instanceIds: [] };

beforeAll(async () => {
  for (const u of [...ALL_BUYERS, VENDOR_A]) {
    userTypeBackup.set(u, (await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [u])).user_type);
  }
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [ALL_BUYERS]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);

  const grant = async (userId, scope) => grantIds.push(await grantRoleScope(db, {
    userId, roleId: ROLE_IDS.FINAL_AWARDING_P1, companyId: IDS.hospitality.A, ...scope,
  }));
  await grant(HOTEL_USER, { hotelId: IDS.hotels.A1 });
  await grant(COMPANY_USER, {});
  await grant(WRONG_PROCESS, { hotelId: IDS.hotels.A1, departmentId: IDS.departments.proc, processId: IDS.processes.A_P2 });
  // The fixture awarding role carries no rfq.read, which some reads below need.
  for (const u of [HOTEL_USER, COMPANY_USER, WRONG_PROCESS]) {
    grantIds.push(await grantRoleScope(db, {
      userId: u, roleId: ROLE_IDS.TENDER_CREATOR, companyId: IDS.hospitality.A,
    }));
  }

  for (const u of [...ALL_BUYERS, VENDOR_A]) c[u] = await httpClient(u);
});

afterEach(async () => {
  const instIds = [...created.instanceIds];
  if (created.poIds.length) {
    const rows = await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [created.poIds]);
    instIds.push(...rows.map((r) => r.id));
  }
  if (instIds.length) {
    await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
         (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instIds]);
  }
  if (created.rfqIds.length) {
    const pos = await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    created.poIds.push(...pos.map((p) => p.id));
  }
  if (created.poIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_document WHERE purchase_order_id = ANY($1::int[])`, [created.poIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [created.poIds]);
    await cleanupPurchaseOrders(db, created.poIds);
  }
  if (created.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await cleanupRfqs(db, created.rfqIds);
  }
  created.rfqIds = []; created.poIds = []; created.instanceIds = [];
});

afterAll(async () => {
  await revokeRoleScopes(db, grantIds);
  for (const [u, t] of userTypeBackup) await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u, t]);
  await closeDb();
});

/** RFQ at (A, A1, proc, A_P1) with `productCount` products and POs [{vendor, products, status, agoDays}]. */
async function seed({ productCount = 1, pos = [{ vendor: VENDOR_A, products: [0] }] } = {}) {
  return db.tx(async (t) => {
    const { rfq_id } = await makeRfqVisibleToDashboard(t, {
      createdBy: CREATOR, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      department: IDS.departments.proc, status: 1, is_published: 1, title: "initiate guide",
    });
    created.rfqIds.push(rfq_id);
    const products = [];
    for (let i = 0; i < productCount; i++) products.push((await addProductToRfq(t, rfq_id)).rfq_product_id);
    const po_ids = [];
    for (const po of pos) {
      const { po_id } = await makePO(t, {
        rfq_id, rfq_product_id: products[po.products[0]], status: po.status ?? "draft",
        company_id: IDS.companies.A, vendor_user_id: po.vendor, initiated_by: CREATOR,
        created_ago_days: po.agoDays ?? 0,
      });
      for (const idx of po.products.slice(1)) {
        await t.none(
          `INSERT INTO tbl_purchase_order_product
             (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
           VALUES ($1, $2, 0, 1, 'units', 100, 100)`, [po_id, products[idx]]);
      }
      po_ids.push(po_id);
      created.poIds.push(po_id);
    }
    return { rfq_id, po_ids, products };
  });
}

const detail = async (user, po_id) => {
  const res = await c[user].get(`/api/v1/po/detail/${po_id}`);
  expect(res.status).toBe(200);
  return res.body.data;
};

describe("PO detail — can_initiate", () => {
  it("matches the initiate gate for company-wide, hotel-scoped, department-scoped and wrong-process users", async () => {
    const { po_ids: [po_id] } = await seed();

    const expectations = [
      [COMPANY_USER, true],
      [HOTEL_USER, true],
      [DEPT_USER, true],
      [WRONG_PROCESS, false],   // awarding.create, but only on another process
      [READER, false],          // can see the PO, holds no write grant
    ];
    for (const [user, expected] of expectations) {
      const d = await detail(user, po_id);
      // The flag is the gate's own answer: it must never promise what the gate refuses.
      expect({ user, can_initiate: d.can_initiate }).toEqual({ user, can_initiate: expected });
      if (!expected) {
        const gate = await c[user].post(`/api/v1/po/initiate/${po_id}`).send({});
        expect([403, 404]).toContain(gate.status);
      }
    }
  });

  it("is absent for the vendor's own view of the PO", async () => {
    const { po_ids: [po_id] } = await seed();
    const res = await c[VENDOR_A].get(`/api/v1/po/vendor/detail/${po_id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty("can_initiate");
    expect(res.body.data).not.toHaveProperty("sibling_drafts");
    expect(res.body.data).not.toHaveProperty("initiate_kind");
  });
});

describe("PO detail — kind of draft and who is who", () => {
  it("reports the draft kind, keeps initiated_by numeric, and adds raised_by / approval_initiated_by", async () => {
    const { po_ids: [a, b] } = await seed({
      productCount: 3,
      pos: [{ vendor: VENDOR_A, products: [0] }, { vendor: VENDOR_B, products: [1] }],
    });
    const d = await detail(DEPT_USER, a);

    expect(d.initiate_kind).toBe("partial");        // product 3 is still unawarded
    expect(d.initiated_by).toBe(CREATOR);           // unchanged: the draft's creator id
    expect(d.raised_by).toMatchObject({ id: CREATOR });
    expect(d.approval_initiated_by).toBeNull();

    // After someone presses Initiate, the latest approval instance names them.
    const res = await c[DEPT_USER].post(`/api/v1/po/initiate/${b}`).send({});
    expect(res.status).toBe(200);
    const after = await detail(DEPT_USER, b);
    expect(after.approval_initiated_by).toMatchObject({ id: DEPT_USER });
    expect(after.approval_initiated_by.at).toBeTruthy();
    expect(after.initiated_by).toBe(CREATOR);
    expect(after.initiate_kind).toBeNull();         // no longer a draft
  });
});

describe("PO detail — sibling_drafts", () => {
  it("lists the other drafts of the RFQ, oldest first, to someone who can initiate", async () => {
    const { po_ids: [target, older, newest] } = await seed({
      productCount: 3,
      pos: [
        { vendor: VENDOR_A, products: [0], agoDays: 1 },
        { vendor: VENDOR_B, products: [1], agoDays: 5 },
        { vendor: VENDOR_B, products: [2], agoDays: 0 },
      ],
    });
    const d = await detail(DEPT_USER, target);
    expect(d.sibling_drafts.map((s) => s.id)).toEqual([older, newest]);
    expect(d.sibling_drafts[0]).toEqual(expect.objectContaining({
      id: older, po_number: expect.any(String), total_value: expect.any(Number),
    }));
    expect(Object.keys(d.sibling_drafts[0]).sort())
      .toEqual(["created_at", "id", "po_number", "total_value", "vendor_name"]);
  });

  it("hides sibling_drafts from users who cannot initiate", async () => {
    const { po_ids: [target] } = await seed({
      productCount: 2,
      pos: [{ vendor: VENDOR_A, products: [0] }, { vendor: VENDOR_B, products: [1] }],
    });
    expect((await detail(DEPT_USER, target)).sibling_drafts).toHaveLength(1);
    for (const u of [READER, WRONG_PROCESS]) {
      const d = await detail(u, target);
      expect(d.can_initiate).toBe(false);
      expect(d.sibling_drafts).toEqual([]);
    }
  });
});

describe("GET /po/:id/initiators — nearest first", () => {
  it("lists hotel-local initiators before group-wide ones", async () => {
    const { po_ids: [po_id] } = await seed();
    const res = await c[CREATOR].get(`/api/v1/po/${po_id}/initiators`);
    expect(res.status).toBe(200);
    const items = res.body.data.initiators;

    const by = Object.fromEntries(items.map((i) => [i.user_id, i]));
    // 0 = department-scoped, 1 = hotel-scoped, 2 = company-wide
    expect(by[DEPT_USER].scope_breadth).toBe(0);
    expect(by[HOTEL_USER].scope_breadth).toBe(1);
    expect(by[COMPANY_USER].scope_breadth).toBe(2);
    expect(by[WRONG_PROCESS]).toBeUndefined();      // cannot initiate this PO, so not offered

    const order = items.map((i) => i.user_id);
    expect(order.indexOf(DEPT_USER)).toBeLessThan(order.indexOf(HOTEL_USER));
    expect(order.indexOf(HOTEL_USER)).toBeLessThan(order.indexOf(COMPANY_USER));

    // Whole list is sorted by breadth, then name.
    const keys = items.map((i) => [i.scope_breadth, String(i.name || "").toLowerCase()]);
    const sorted = [...keys].sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]));
    expect(keys).toEqual(sorted);
  });
});

describe("Pending for me", () => {
  it("no longer lists vendor-accepted POs", async () => {
    const { po_ids: [draft, accepted] } = await seed({
      productCount: 2,
      pos: [{ vendor: VENDOR_A, products: [0] }, { vendor: VENDOR_B, products: [1], status: "approved" }],
    });
    const res = await c[DEPT_USER].get("/api/v1/po/list?status=action-required");
    expect(res.status).toBe(200);
    const ids = (res.body.data || []).map((r) => r.id);
    expect(ids).toContain(draft);
    expect(ids).not.toContain(accepted);
  });
});

describe("initiating a draft that a colleague already initiated", () => {
  it("honours already_initiated when a sibling initiated first", async () => {
    const { po_ids: [po_id] } = await seed();

    const first = await c[DEPT_USER].post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(first.status).toBe(200);
    expect(first.body.data.already_initiated).toBeFalsy();

    const second = await c[COMPANY_USER].post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(second.status).toBe(200);
    expect(second.body.data.already_initiated).toBe(true);

    const { n } = await db.one(
      `SELECT count(*)::int AS n FROM tbl_approval_instances WHERE entity_type = 'PO' AND entity_id = $1`, [po_id]);
    expect(n).toBe(1);
  });
});

describe("POST /negotiation/quotes/:rfq_product_id/approve", () => {
  it("approveQuotes returns the drafted PO", async () => {
    // Staged the way rfqController.finalize leaves it (see
    // negotiationQuote.approveCharges.test.js): a PENDING NEGOTIATION_QUOTE
    // approval whose metadata carries the PO payload. The final approver then
    // approves over real HTTP, which drafts the PO.
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, department_id, process_id, is_tender, title)
       VALUES ((SELECT COALESCE(MAX(rfq_no), 8000000) + 1 FROM tbl_rfq), '<p>e2e</p>', '', 'b@a', 'A1', '+91', $1,
               'Mumbai', 1, 1, $2, $2, NOW(), $3, $4, $5, $6, 0, 'approveQuotes drafted_pos')
       RETURNING id, rfq_no`,
      [oneDayAgo, CREATOR, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1]
    );
    created.rfqIds.push(rfq.id);
    const prod = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`, [rfq.id]);
    // A second product nobody has awarded yet, so this is a partial draft.
    await db.none(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 1)`, [rfq.id]);
    await db.none(`INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, 1, $2, 0)`, [rfq.id, VENDOR_A]);
    const quote = await db.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
       VALUES ($1, $2, $3, $3, 1, NOW()) RETURNING id`, [rfq.id, rfq.rfq_no, VENDOR_A]);
    const qi = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, package_price, tax,
          freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
       VALUES ($1, $2, $3, 1, 500, 25000, 0, 0, 0, 0, '', '15', '50', 'absolute', '[]'::jsonb) RETURNING id`,
      [rfq.id, rfq.rfq_no, quote.id]);

    const approval = await createApprovalInstance({
      entity_type: "NEGOTIATION_QUOTE", entity_id: prod.id,
      hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1, department_id: null,
      process_id: IDS.processes.A_P1, initiated_by: CREATOR,
      metadata: {
        rfq_id: rfq.id, rfq_number: rfq.rfq_no, rfq_product_id: prod.id, is_tender: 0,
        product_variant_id: 1, variant: 0, vendor_id: VENDOR_A, quote_id: qi.id, quote_item_id: qi.id,
        po_payload: {
          rfq_id: rfq.id, rfq_no: rfq.rfq_no, product_variant_id: 1, vendor_id: VENDOR_A,
          quote_id: qi.id, quote_item_id: qi.id, variant: 0, route_type: "PO", project_id: null,
          total_value: 25000,
          product_info: {
            rfq_product_id: prod.id, quantity: 50, unit: "pcs", unit_price: 500,
            charges_meta: { tax: 0, tax_mode: "absolute" }, finalized_vendor_id: VENDOR_A,
          },
        },
        po_user: { id: CREATOR, company_id: IDS.companies.A },
      },
    });
    created.instanceIds.push(approval.instance.id);
    expect(approval.instance.status).toBe("PENDING");

    // Commercial Approver holds awarding.read only: the response must say so.
    const res = await c[READER].post(`/api/v1/negotiation/quotes/${prod.id}/approve`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.fully_approved).toBe(true);
    expect(res.body.data.drafted_pos).toHaveLength(1);

    const po = await db.one(`SELECT id, po_number, status FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.id]);
    expect(res.body.data.drafted_pos[0]).toEqual({
      id: po.id, po_number: po.po_number, initiate_kind: "partial", can_initiate: false,
    });
    expect(po.status).toBe("draft");
  });
});
