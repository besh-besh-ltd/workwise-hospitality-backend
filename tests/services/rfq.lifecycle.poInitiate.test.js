// RFQ lifecycle — "who can initiate this PO, and what kind of draft is it?"
// ----------------------------------------------------------------------------
// Client ticket T1: a Commercial Approver (or anyone allowed to initiate) has to
// be guided to the drafted PO. The lifecycle PO phase now says, per PO, what
// kind of draft it is (complete / split / partial) and whether the viewer is
// the person who has to initiate it, and the PO stage is OPEN (reachable) on a
// partial award even though the RFQ is still in Negotiation & Award.
//
// Rows are seeded straight into tbl_rfq_purchase_order + tbl_purchase_order_product,
// the same two tables the real award flow (draftPurchaseOrder) writes, because
// the lifecycle only reads them. The approve-quotes path itself is exercised
// over HTTP in po.initiateGuide.test.js.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  makeRfqVisibleToDashboard, addProductToRfq, makePO, cleanupPurchaseOrders, cleanupRfqs,
} from "../helpers/dashboardSeed.js";

const BUYER = IDS.users.a1_proc_buyer;        // RFQ creator: rfq.read only, cannot initiate
const INITIATOR = IDS.users.a1_proc_poApp;    // FINAL_AWARDING_P1 at (A, A1, proc): can initiate
const READER = IDS.users.a1_proc_commApp;    // awarding.read, no awarding.create: sees the PO stage, cannot initiate
const HOTEL_USER = IDS.users.a1_proc_finance;     // + FINAL_AWARDING_P1 at (A, A1)
const COMPANY_USER = IDS.users.a1_proc_techApp;   // + FINAL_AWARDING_P1 at (A)
const WRONG_PROCESS = IDS.users.a1_proc_commEval; // + FINAL_AWARDING_P1 for process A_P2 only
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;

const rfqIds = [];
const poIds = [];
const extra = {};
let readerClient, initiatorClient, vendorClient;
const userTypeBackup = new Map();   // id -> {user_type, status}
const grantIds = [];

beforeAll(async () => {
  // acl([2, 8]) on the lifecycle route branches on user_type; fixtures leave it NULL.
  for (const u of [BUYER, INITIATOR, READER, HOTEL_USER, COMPANY_USER, WRONG_PROCESS, VENDOR_A]) {
    userTypeBackup.set(u, await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [u]));
  }
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [[BUYER, INITIATOR, READER, HOTEL_USER, COMPANY_USER, WRONG_PROCESS]]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);
  // The lifecycle itself is gated on rfq.read; the fixture's awarding role has
  // none, so add the RFQ-reading role a real initiator also holds.
  grantIds.push(await grantRoleScope(db, {
    userId: INITIATOR, roleId: ROLE_IDS.TENDER_CREATOR,
    companyId: IDS.hospitality.A, hotelId: IDS.hotels.A1, departmentId: IDS.departments.proc,
  }));
  const award = (userId, scope) => grantRoleScope(db, { userId, roleId: ROLE_IDS.FINAL_AWARDING_P1, companyId: IDS.hospitality.A, ...scope });
  grantIds.push(await award(HOTEL_USER, { hotelId: IDS.hotels.A1 }));
  grantIds.push(await award(COMPANY_USER, {}));
  grantIds.push(await award(WRONG_PROCESS, { hotelId: IDS.hotels.A1, departmentId: IDS.departments.proc, processId: IDS.processes.A_P2 }));
  for (const u of [HOTEL_USER, COMPANY_USER, WRONG_PROCESS]) {
    grantIds.push(await grantRoleScope(db, { userId: u, roleId: ROLE_IDS.TENDER_CREATOR, companyId: IDS.hospitality.A }));
    extra[u] = await httpClient(u);
  }
  readerClient = await httpClient(READER);
  initiatorClient = await httpClient(INITIATOR);
  vendorClient = await httpClient(VENDOR_A);
});

afterAll(async () => {
  await revokeRoleScopes(db, grantIds);
  await db.none(`DELETE FROM tbl_approval_instances WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]);
  await cleanupPurchaseOrders(db, poIds);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1)`, [rfqIds]);
  await cleanupRfqs(db, rfqIds);
  for (const [u, b] of userTypeBackup) await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [u, b.user_type, b.status]);
  await closeDb();
});

/**
 * An RFQ with `productCount` products and the given POs. Each PO is
 * { vendor, status, products: [indexes into the RFQ's products] }.
 */
async function seed({ productCount, pos }) {
  return db.tx(async (t) => {
    const { rfq_id } = await makeRfqVisibleToDashboard(t, {
      createdBy: BUYER, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      department: IDS.departments.proc, status: 1, is_published: 1, title: "initiate guide",
    });
    rfqIds.push(rfq_id);
    const products = [];
    for (let i = 0; i < productCount; i++) products.push((await addProductToRfq(t, rfq_id)).rfq_product_id);
    const created = [];
    for (const po of pos) {
      const first = products[po.products[0]];
      const { po_id } = await makePO(t, {
        rfq_id, rfq_product_id: first, status: po.status ?? "draft",
        company_id: IDS.companies.A, vendor_user_id: po.vendor, initiated_by: BUYER,
      });
      for (const idx of po.products.slice(1)) {
        await t.none(
          `INSERT INTO tbl_purchase_order_product
             (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
           VALUES ($1, $2, 0, 1, 'units', 100, 100)`,
          [po_id, products[idx]]
        );
      }
      poIds.push(po_id);
      created.push(po_id);
    }
    return { rfq_id, po_ids: created };
  });
}

const lifecycle = async (client, rfq_id) => {
  const res = await client.get(`/api/v1/rfq/${rfq_id}/lifecycle`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe(1);
  const stage = res.body.data.stages.find((s) => s.key === "purchase-order");
  return { data: res.body.data, stage, phase: stage.phase, pos: stage.phase.purchase_orders || [] };
};

describe("RFQ lifecycle — PO initiate guidance", () => {
  it("classifies complete, split and partial drafts", async () => {
    const complete = await seed({ productCount: 2, pos: [{ vendor: VENDOR_A, products: [0, 1] }] });
    const split = await seed({
      productCount: 2,
      pos: [{ vendor: VENDOR_A, products: [0] }, { vendor: VENDOR_B, products: [1] }],
    });
    const partial = await seed({ productCount: 3, pos: [{ vendor: VENDOR_A, products: [0] }] });

    const c = (await lifecycle(initiatorClient, complete.rfq_id)).pos[0];
    expect(c).toMatchObject({
      initiate_kind: "complete", rfq_product_count: 2, po_product_count: 2,
      products_on_other_pos: 0, products_unawarded: 0,
    });

    const s = (await lifecycle(initiatorClient, split.rfq_id)).pos;
    expect(s).toHaveLength(2);
    for (const po of s) {
      expect(po).toMatchObject({
        initiate_kind: "split", rfq_product_count: 2, po_product_count: 1,
        products_on_other_pos: 1, products_unawarded: 0,
      });
    }

    const p = (await lifecycle(initiatorClient, partial.rfq_id)).pos[0];
    expect(p).toMatchObject({
      initiate_kind: "partial", rfq_product_count: 3, po_product_count: 1,
      products_on_other_pos: 0, products_unawarded: 2,
    });
  });

  it("does not count a rejected sibling PO as covering its products", async () => {
    const { rfq_id } = await seed({
      productCount: 2,
      pos: [
        { vendor: VENDOR_A, products: [0] },
        { vendor: VENDOR_B, products: [1], status: "rejected_by_vendor" },
      ],
    });
    const draft = (await lifecycle(initiatorClient, rfq_id)).pos.find((p) => p.status === "draft");
    expect(draft).toMatchObject({ initiate_kind: "partial", products_on_other_pos: 0, products_unawarded: 1 });
  });

  it("gives non-drafts no initiate_kind and no awaiting-me flag", async () => {
    const { rfq_id } = await seed({
      productCount: 1, pos: [{ vendor: VENDOR_A, products: [0], status: "pending_approval" }],
    });
    const po = (await lifecycle(initiatorClient, rfq_id)).pos[0];
    expect(po.initiate_kind).toBeNull();
    expect(po.initiate_awaiting_me).toBe(false);
  });

  it("flags only the people who may initiate as awaited, and keeps initiator PII out", async () => {
    const { rfq_id } = await seed({ productCount: 1, pos: [{ vendor: VENDOR_A, products: [0] }] });

    const asInitiator = await lifecycle(initiatorClient, rfq_id);
    expect(asInitiator.phase.can_initiate).toBe(true);
    expect(asInitiator.pos[0].initiate_awaiting_me).toBe(true);

    const asReader = await lifecycle(readerClient, rfq_id);
    expect(asReader.phase.can_initiate).toBe(false);
    expect(asReader.pos[0].initiate_awaiting_me).toBe(false);
    expect(asReader.pos[0].initiate_kind).toBe("complete");   // the kind is not secret; the duty is not theirs

    // No initiator list (names / emails / phones) rides on the lifecycle.
    const raw = JSON.stringify(asReader.data);
    expect(raw).not.toMatch(/"initiators"/);
    expect(raw).not.toMatch(/"mobile"/);
  });

  it("names who raised the draft and who initiated it, separately", async () => {
    const { rfq_id, po_ids } = await seed({ productCount: 1, pos: [{ vendor: VENDOR_A, products: [0] }] });
    const [po_id] = po_ids;

    let po = (await lifecycle(initiatorClient, rfq_id)).pos[0];
    expect(po.initiated_by).toMatchObject({ user_id: BUYER });       // existing field, unchanged
    expect(po.raised_by).toMatchObject({ id: BUYER });
    expect(po.approval_initiated_by).toBeNull();                     // never initiated

    // Two instances (a send-back re-initiate): the LATEST one names the initiator.
    const policy = IDS.policies.A1_P1_PO;
    const mk = (by) => db.one(
      `INSERT INTO tbl_approval_instances
         (entity_type, entity_id, approval_policy_id, status, hospitality_company_id, hotel_id, initiated_by, metadata)
       VALUES ('PO', $1, $2, 'CANCELLED', $3, $4, $5, jsonb_build_object('rfq_id', $6::int)) RETURNING id`,
      [po_id, policy, IDS.hospitality.A, IDS.hotels.A1, by, rfq_id]);
    await mk(BUYER);
    await mk(INITIATOR);

    po = (await lifecycle(initiatorClient, rfq_id)).pos[0];
    expect(po.approval_initiated_by).toMatchObject({ id: INITIATOR });
    expect(po.approval_initiated_by.at).toBeTruthy();
    expect(po.initiated_by).toMatchObject({ user_id: BUYER });       // creator still the creator
  });

  it("opens the PO stage when a partial award has a draft, without changing default_stage", async () => {
    const { rfq_id } = await seed({ productCount: 3, pos: [{ vendor: VENDOR_A, products: [0] }] });
    const { data, stage, phase } = await lifecycle(initiatorClient, rfq_id);

    // The RFQ is still negotiating the other two products, so the PO phase is
    // upcoming, and yet the draft must be reachable.
    expect(phase.status).toBe("upcoming");
    expect(stage.state).toBe("open");
    expect(stage.reason).toBe("partial_award");
    expect(stage.draft_count).toBe(1);

    // 'open' never wins the landing page: default_stage still points at the live stage.
    const live = data.stages.find((s) => s.state === "active");
    expect(live?.key).toBeDefined();
    expect(data.default_stage).toBe(live.key);
    expect(data.default_stage).not.toBe("purchase-order");
  });

  it("reports can_initiate for company-wide, hotel-scoped and department-scoped holders, and not for a wrong-process one", async () => {
    // makeRFQ defaults to a real process (A_P1), so the wrong-process user fails
    // on a genuine mismatch (A_P2 vs A_P1), not on a NULL.
    const { rfq_id } = await seed({ productCount: 1, pos: [{ vendor: VENDOR_A, products: [0] }] });
    expect((await db.one(`SELECT process_id FROM tbl_rfq WHERE id = $1`, [rfq_id])).process_id).toBe(IDS.processes.A_P1);

    expect((await lifecycle(extra[COMPANY_USER], rfq_id)).phase.can_initiate).toBe(true);
    expect((await lifecycle(extra[HOTEL_USER], rfq_id)).phase.can_initiate).toBe(true);
    expect((await lifecycle(initiatorClient, rfq_id)).phase.can_initiate).toBe(true);   // department-scoped
    const wrong = await lifecycle(extra[WRONG_PROCESS], rfq_id);
    expect(wrong.phase.can_initiate).toBe(false);
    expect(wrong.pos[0].initiate_awaiting_me).toBe(false);
  });

  it("keeps the PO stage locked when the only POs are rejected or cancelled", async () => {
    const { rfq_id } = await seed({ productCount: 2, pos: [{ vendor: VENDOR_A, products: [0], status: "cancelled" }] });
    const { stage, phase } = await lifecycle(initiatorClient, rfq_id);
    expect(phase.status).toBe("upcoming");
    expect(stage.state).toBe("locked");
    expect(stage.reason).toBe("not_started");
    expect(stage.draft_count).toBeUndefined();
  });

  it("opens the PO stage for one dead PO plus one live draft", async () => {
    const { rfq_id } = await seed({
      productCount: 3,
      pos: [{ vendor: VENDOR_A, products: [0], status: "cancelled" }, { vendor: VENDOR_B, products: [1] }],
    });
    const { stage } = await lifecycle(initiatorClient, rfq_id);
    expect(stage.state).toBe("open");
    expect(stage.reason).toBe("partial_award");
    expect(stage.draft_count).toBe(1);
  });

  it("does not tell a caller who cannot read the PO stage that a PO exists", async () => {
    const { rfq_id } = await seed({ productCount: 3, pos: [{ vendor: VENDOR_A, products: [0] }] });
    // The RFQ creator holds rfq.read only: the stage is redacted for them.
    const res = await (await httpClient(BUYER)).get(`/api/v1/rfq/${rfq_id}/lifecycle`);
    const stage = res.body.data.stages.find((s) => s.key === "purchase-order");
    expect(stage.can_read).toBe(false);
    expect(stage.state).toBe("locked");
    expect(stage.reason).toBe("not_started");
    expect(stage.draft_count).toBeUndefined();
    expect(stage.phase.purchase_orders).toBeUndefined();
  });

  it("leaves the PO stage locked while no PO exists", async () => {
    const { rfq_id } = await seed({ productCount: 1, pos: [] });
    const { stage } = await lifecycle(initiatorClient, rfq_id);
    expect(stage.state).toBe("locked");
    expect(stage.draft_count).toBeUndefined();
  });

  it("names the holders 'PO initiator' (not the lower-cased plural)", async () => {
    // The only PO was rejected by the vendor, so the RFQ sits in PO_VENDOR_REJECTED
    // and the PO phase names the people who must raise the replacement.
    const { rfq_id } = await seed({ productCount: 1, pos: [{ vendor: VENDOR_A, products: [0], status: "rejected_by_vendor" }] });
    const { phase, data } = await lifecycle(initiatorClient, rfq_id);
    expect(phase.status).toBe("current");
    expect(phase.action_holders.label).toBe("PO initiator");
    expect(data.action.label).toBe("You are a PO initiator for this RFQ");
  });

  it("never serves a vendor the lifecycle (so none of this reaches them)", async () => {
    const { rfq_id } = await seed({ productCount: 1, pos: [{ vendor: VENDOR_A, products: [0] }] });
    const res = await vendorClient.get(`/api/v1/rfq/${rfq_id}/lifecycle`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/initiate_kind|can_initiate/);
  });
});
