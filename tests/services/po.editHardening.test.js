// SECURITY — PUT /po/:po_id may only write the fields the edit screen emits,
// and editing a draft must not initiate it unless the editor holds the
// initiate permission.
// ----------------------------------------------------------------------------
// handleUpdatePO treated every `path` as a column of tbl_rfq_purchase_order, so
// any PO editor could write `status`, `finalized_vendor_id`, `company_id`,
// `approval_instance_id`... directly. It also called initiatePurchaseOrder after
// every edit, without the initiate gate, so a creator with no awarding.create
// grant could drive a draft into approval just by saving it.
//
// Fixture users (same as security.poInitiateWriteGate.test.js):
//   a1_proc_buyer  (CREATOR) rfq.read/boq.read only: no initiate permission
//   a1_eng_buyer   (WRITER)  + awarding.create at (A, A1, proc): can initiate

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import { draftPO } from "../../app/controllers/po/purchaseOrderController.js";

const READ_ONLY = IDS.users.a1_proc_commApp; // awarding.read only
const CREATOR = IDS.users.a1_proc_buyer;     // rfq.read/boq.read only, PO.initiated_by
const WRITER = IDS.users.a1_eng_buyer;       // + awarding.create at (A, A1, proc)
const WRONG_HOTEL = IDS.users.multiHotel;    // + awarding.create at (A, A2, proc)
const VENDOR = IDS.users.vendor_alpha;

let VARIANT_ID = 1;
let readOnlyClient, creatorClient, writerClient, wrongHotelClient, vendorClient;
const grantIds = [];

beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT_ID = v.id;

  // acl()/noAcl() branch on user_type; the shared fixtures leave it NULL.
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`,
    [[READ_ONLY, CREATOR, WRITER, WRONG_HOTEL]]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);

  // awarding.create at the PO's OWN hotel...
  grantIds.push(await grantRoleScope(db, {
    userId: WRITER,
    roleId: ROLE_IDS.FINAL_AWARDING_P1,
    companyId: IDS.hospitality.A,
    hotelId: IDS.hotels.A1,
    departmentId: IDS.departments.proc,
  }));
  // ...and awarding.create at a DIFFERENT hotel, for the scoping test.
  grantIds.push(await grantRoleScope(db, {
    userId: WRONG_HOTEL,
    roleId: ROLE_IDS.FINAL_AWARDING_P1,
    companyId: IDS.hospitality.A,
    hotelId: IDS.hotels.A2,
    departmentId: IDS.departments.proc,
  }));

  readOnlyClient = await httpClient(READ_ONLY);
  creatorClient = await httpClient(CREATOR);
  writerClient = await httpClient(WRITER);
  wrongHotelClient = await httpClient(WRONG_HOTEL);
  vendorClient = await httpClient(VENDOR);
});

afterAll(async () => {
  // These rows are global — leaving them would leak into every suite sharing
  // this Jest process (maxWorkers is 1).
  await revokeRoleScopes(db, grantIds);
  await closeDb();
});

const inserted = {
  rfqIds: [], poIds: [], poProductIds: [], rfqProductIds: [], quoteIds: [], instanceIds: [],
};

beforeEach(() => {
  for (const k of Object.keys(inserted)) inserted[k] = [];
});

afterEach(async () => {
  if (inserted.poIds.length) {
    const rows = await db.any(
      `SELECT approval_instance_id FROM tbl_rfq_purchase_order
        WHERE id = ANY($1::int[]) AND approval_instance_id IS NOT NULL`,
      [inserted.poIds]
    );
    inserted.instanceIds.push(...rows.map((r) => r.approval_instance_id));
    const byEntity = await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`,
      [inserted.poIds]
    );
    inserted.instanceIds.push(...byEntity.map((r) => r.id));
  }
  if (inserted.instanceIds.length) {
    const ids = [...new Set(inserted.instanceIds)];
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [ids]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id IN (
          SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [ids]
    );
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [ids]);
    await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE approval_instance_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [ids]);
  }
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_hsn_mapping WHERE po_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_purchase_order_document WHERE purchase_order_id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.poProductIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE id = ANY($1::int[])`, [inserted.poProductIds]);
  }
  if (inserted.poIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type='PO' AND entity_id = ANY($1::int[])`, [inserted.poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [inserted.poIds]);
  }
  if (inserted.quoteIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE quote_id = ANY($1::int[])`, [inserted.quoteIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE id = ANY($1::int[])`, [inserted.quoteIds]);
  }
  if (inserted.rfqProductIds.length) {
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [inserted.rfqProductIds]);
  }
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
  }
});

/** A draft PO at an explicit scope, hanging off a published RFQ. */
async function makeDraftPo({
  hotel = IDS.hotels.A1,
  department = IDS.departments.proc,
  process = IDS.processes.A_P1,
  initiatedBy = CREATOR,
} = {}) {
  // Naive-IST wall clock: bid_end_date is compared through the Postgres
  // session timezone, which is UTC in CI and Asia/Kolkata locally.
  const oneDayAgo = await db.one(
    `SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 day',
                    'YYYY-MM-DD HH24:MI:SS') AS ts`
  );
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: CREATOR,
    status: 1,
    is_published: 1,
    bid_end_date: oneDayAgo.ts,
    hospitality: IDS.hospitality.A,
    hotel,
    department,
    process,
  });
  inserted.rfqIds.push(rfq_id);

  const product = await db.one(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, 'Spec text', '', '', '', '', $2, 0)
     RETURNING id`,
    [rfq_id, VARIANT_ID]
  );
  inserted.rfqProductIds.push(product.id);

  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, $2, $3, 0)`,
    [rfq_id, VARIANT_ID, VENDOR]
  );

  // Priced like a real quote: tax on the line plus a document-level global
  // charge, so edits run against a PO with charges_meta and global_charges.
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, is_regret, global_charges)
     VALUES ($1, $2, $3, $3, 1, 0, $4::jsonb) RETURNING id`,
    [rfq_id, rfq_no, VENDOR,
     JSON.stringify([{ name: "Transportation", tax: 5, tax_mode: "percentage", amount: 5, amount_mode: "percentage" }])]
  );
  inserted.quoteIds.push(quote.id);

  const quoteItem = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
        package_price, tax, freight_price, comment, delivery_period, quantity,
        variant, tax_mode, other_charges)
     VALUES ($1, $2, $3, $4, 100, 1180, 0, 18, 0, '', '7', '10', 0, 'percentage', '[]'::jsonb)
     RETURNING id`,
    [rfq_id, rfq_no, quote.id, VARIANT_ID]
  );

  // The production award path (what rfqController.finalize calls per line).
  const drafted = await db.tx((t) => draftPO({
    rfq_id,
    project_id: null,
    quote_item_id: quoteItem.id,
    existing_po_id: null,
    selected_hierarchy: null,
    product_info: {
      rfq_product_id: product.id,
      quantity: 10,
      unit: "NOS",
      unit_price: 100,
      charges_meta: { tax: 18, tax_mode: "percentage", other_charges: [] },
      finalized_vendor_id: VENDOR,
    },
  }, { id: initiatedBy, company_id: IDS.companies.A }, t));
  const po = { id: drafted.po_id };
  inserted.poIds.push(po.id);

  const pop = await db.one(
    `SELECT id FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po.id]);
  inserted.poProductIds.push(pop.id);

  return { rfq_id, po_id: po.id, rfq_product_id: product.id };
}


const putEdit = (client, po_id, changes) =>
  client.put(`/api/v1/po/${po_id}`).send({ changes });

const poRow = (po_id) => db.one(`SELECT * FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
const instancesOf = (po_id) => db.any(
  `SELECT id, status, current_step FROM tbl_approval_instances
    WHERE entity_type = 'PO' AND entity_id = $1 ORDER BY id`, [po_id]);

describe("PUT /po/:po_id refuses fields the edit screen never sends", () => {
  it("refuses to write status through PUT /po/:id", async () => {
    const { po_id } = await makeDraftPo();
    const res = await putEdit(creatorClient, po_id, [{ path: "status", newValue: "acceptance_pending" }]);
    expect(res.status).toBe(400);
    expect(res.body?.code).toBe("PO_FIELD_NOT_EDITABLE");
    expect(res.body?.field).toBe("status");
    expect((await poRow(po_id)).status).toBe("draft");
  });

  it("refuses finalized_vendor_id, company_id, approval_instance_id and an unknown column", async () => {
    const { po_id, rfq_product_id } = await makeDraftPo();
    const lineBefore = await db.one(
      `SELECT * FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po_id]);
    for (const [path, newValue] of [
      ["finalized_vendor_id", IDS.users.a1_proc_buyer],
      ["company_id", IDS.companies.B],
      ["approval_instance_id", 1],
      ["no_such_column", "x"],
      ["initiated_by", WRITER],
      [`product[${rfq_product_id}].rfq_product_id`, 5],
      [`product[${rfq_product_id}].purchase_order_id`, 1],
      [`product[${rfq_product_id}].charges_meta.evil`, 1],
    ]) {
      const before = await poRow(po_id);
      const res = await putEdit(creatorClient, po_id, [{ path, newValue }]);
      expect({ path, status: res.status, code: res.body?.code }).toEqual({ path, status: 400, code: "PO_FIELD_NOT_EDITABLE" });
      expect(await poRow(po_id)).toEqual(before);
      const lineAfter = await db.one(
        `SELECT * FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po_id]);
      expect(lineAfter).toEqual(lineBefore);
    }
  });

  it("refuses the whole request when one change is bad and applies none of it", async () => {
    const { po_id } = await makeDraftPo();
    const res = await putEdit(creatorClient, po_id, [
      { path: "terms_and_conditions", newValue: "partial?" },
      { path: "status", newValue: "approved" },
    ]);
    expect(res.status).toBe(400);
    const row = await poRow(po_id);
    expect(row.status).toBe("draft");
    expect(row.terms_and_conditions).not.toBe("partial?");
  });

  it("still saves every field the UI edits", async () => {
    const { po_id, rfq_product_id } = await makeDraftPo();
    const p = `product[${rfq_product_id}]`;
    const res = await putEdit(creatorClient, po_id, [
      { path: "po_number", newValue: "EDITHARD-RENAMED" },
      { path: "gstin", newValue: "29ABCDE1234F1Z5" },
      { path: "terms_and_conditions", newValue: "Net 30" },
      { path: `${p}.quantity`, newValue: 4 },
      { path: `${p}.unit`, newValue: "KG" },
      { path: `${p}.unit_price`, newValue: 50 },
      { path: `${p}.charges_meta.freight_price`, newValue: 10 },
      { path: `${p}.charges_meta.freight_mode`, newValue: "absolute" },
      { path: `${p}.charges_meta.package_price`, newValue: 2 },
      { path: `${p}.charges_meta.package_mode`, newValue: "percentage" },
      { path: `${p}.charges_meta.tax`, newValue: 12 },
      { path: `${p}.charges_meta.tax_mode`, newValue: "percentage" },
      { path: `hsn_codes[${rfq_product_id}].code`, newValue: "9403" },
    ]);
    expect(res.status).toBe(200);

    const po = await poRow(po_id);
    expect(po.po_number).toBe("EDITHARD-RENAMED");
    expect(po.gstin).toBe("29ABCDE1234F1Z5");
    expect(po.terms_and_conditions).toBe("Net 30");
    const line = await db.one(
      `SELECT quantity, unit, unit_price, charges_meta FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po_id]);
    expect(Number(line.quantity)).toBe(4);
    expect(line.unit).toBe("KG");
    expect(Number(line.unit_price)).toBe(50);
    expect(line.charges_meta).toMatchObject({
      freight_price: 10, freight_mode: "absolute", package_price: 2,
      package_mode: "percentage", tax: 12, tax_mode: "percentage",
    });
    const hsn = await db.one(
      `SELECT hsn_code FROM tbl_purchase_order_hsn_mapping WHERE po_id = $1 AND rfq_item_id = $2`, [po_id, rfq_product_id]);
    expect(hsn.hsn_code).toBe("9403");
  });

  it("still lets the UI remove a line", async () => {
    const { po_id, rfq_product_id } = await makeDraftPo();
    const res = await putEdit(creatorClient, po_id, [{ path: `product[${rfq_product_id}].removed`, newValue: true }]);
    expect(res.status).toBe(200);
    const left = await db.one(
      `SELECT COUNT(*)::int AS c FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po_id]);
    expect(left.c).toBe(0);
  });
});

describe("editing a draft initiates it only when the editor can initiate", () => {
  it("does not initiate a draft when the editor cannot initiate", async () => {
    const { po_id } = await makeDraftPo({ initiatedBy: CREATOR });
    const res = await putEdit(creatorClient, po_id, [{ path: "terms_and_conditions", newValue: "Net 45" }]);
    expect(res.status).toBe(200);

    const po = await poRow(po_id);
    expect(po.terms_and_conditions).toBe("Net 45");
    expect(po.status).toBe("draft");
    expect(po.approval_instance_id).toBeNull();
    expect(await instancesOf(po_id)).toHaveLength(0);
  });

  it("initiates a draft when the editor can initiate", async () => {
    const { po_id } = await makeDraftPo({ initiatedBy: WRITER });
    const res = await putEdit(writerClient, po_id, [{ path: "terms_and_conditions", newValue: "Net 15" }]);
    expect(res.status).toBe(200);

    expect((await poRow(po_id)).status).toBe("pending_approval");
    expect(await instancesOf(po_id)).toHaveLength(1);
  });

  it("restarts approval at step 1 when a pending PO is edited", async () => {
    const { po_id } = await makeDraftPo({ initiatedBy: WRITER });
    const init = await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(init.status).toBe(200);
    const [first] = await instancesOf(po_id);
    expect(first.status).toBe("PENDING");

    const res = await putEdit(writerClient, po_id, [{ path: "terms_and_conditions", newValue: "Net 60" }]);
    expect(res.status).toBe(200);

    const all = await instancesOf(po_id);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ id: first.id, status: "CANCELLED" });
    expect(all[1].status).toBe("PENDING");
    const firstStep = await db.one(
      `SELECT MIN(step_order)::int AS s FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`,
      [IDS.policies.A1_P1_PO]).catch(() => null);
    if (firstStep?.s != null) expect(all[1].current_step).toBe(firstStep.s);
    else expect(all[1].current_step).toBe(first.current_step);
    expect((await poRow(po_id)).approval_instance_id).toBe(all[1].id);
  });
});

describe("a pending PO that is edited is resubmitted by its original initiator", () => {
  const initiatedByOf = async (po_id) => (await db.any(
    `SELECT id, status, initiated_by FROM tbl_approval_instances
      WHERE entity_type = 'PO' AND entity_id = $1 ORDER BY id`, [po_id]));

  it("attributes the new instance to the original initiator and records the editor on the cancelled action", async () => {
    // WRITER initiated it; CREATOR (no initiate permission) owns the PO and edits it.
    const { po_id } = await makeDraftPo({ initiatedBy: CREATOR });
    const init = await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(init.status).toBe(200);

    const res = await putEdit(creatorClient, po_id, [{ path: "terms_and_conditions", newValue: "Net 90" }]);
    expect(res.status).toBe(200);

    const [oldInst, newInst] = await initiatedByOf(po_id);
    expect(oldInst.status).toBe("CANCELLED");
    expect(oldInst.initiated_by).toBe(WRITER);
    expect(newInst.status).toBe("PENDING");
    expect(newInst.initiated_by).toBe(WRITER); // not the editor
    expect((await poRow(po_id)).status).toBe("pending_approval");

    const act = await db.one(
      `SELECT approver_user_id, comment FROM tbl_approval_actions
        WHERE approval_instance_id = $1 AND action = 'CANCELLED'`, [oldInst.id]);
    expect(act.approver_user_id).toBe(CREATOR);
    expect(act.comment).toMatch(/^\[CANCELLED\] PO edited by .+, re-initiating approval$/);
  });

  it("falls back when the original initiator is inactive: a non-initiator editor leaves the PO a draft", async () => {
    const { po_id } = await makeDraftPo({ initiatedBy: CREATOR });
    expect((await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({})).status).toBe(200);
    await db.none(`UPDATE tbl_users SET status = 0 WHERE id = $1`, [WRITER]);
    try {
      const res = await putEdit(creatorClient, po_id, [{ path: "terms_and_conditions", newValue: "Net 91" }]);
      expect(res.status).toBe(200);
    } finally {
      await db.none(`UPDATE tbl_users SET status = 1 WHERE id = $1`, [WRITER]);
    }
    const insts = await initiatedByOf(po_id);
    expect(insts.map((i) => i.status)).toEqual(["CANCELLED"]);
    const po = await poRow(po_id);
    expect(po.status).toBe("draft");
    expect(po.approval_instance_id).toBeNull();
  });

  it("falls back when the original initiator is inactive: an editor who can initiate restarts it as themselves", async () => {
    const { po_id } = await makeDraftPo({ initiatedBy: WRITER });
    // Another permitted person initiated; here we simulate by initiating as WRITER,
    // then deactivating the instance's initiator to someone else inactive.
    expect((await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({})).status).toBe(200);
    await db.none(`UPDATE tbl_approval_instances SET initiated_by = $1
                    WHERE entity_type = 'PO' AND entity_id = $2`, [IDS.users.inactive, po_id]);

    const res = await putEdit(writerClient, po_id, [{ path: "terms_and_conditions", newValue: "Net 92" }]);
    expect(res.status).toBe(200);
    const insts = await initiatedByOf(po_id);
    expect(insts).toHaveLength(2);
    expect(insts[1]).toMatchObject({ status: "PENDING", initiated_by: WRITER });
  });
});

describe("an edit racing an initiate", () => {
  it("ends with exactly one PENDING approval instance, referenced by the PO", async () => {
    const { po_id } = await makeDraftPo({ initiatedBy: WRITER });
    const [edit, init] = await Promise.all([
      putEdit(writerClient, po_id, [{ path: "terms_and_conditions", newValue: "race" }]),
      writerClient.post(`/api/v1/po/initiate/${po_id}`).send({}),
    ]);
    expect(edit.status).toBe(200);
    expect(init.status).toBe(200);

    const pending = (await instancesOf(po_id)).filter((i) => i.status === "PENDING");
    expect(pending).toHaveLength(1);
    const po = await poRow(po_id);
    expect(po.status).toBe("pending_approval");
    expect(po.approval_instance_id).toBe(pending[0].id);
  });
});

describe("the initiate gate and the initiator list agree", () => {
  it("gate and initiator list agree", async () => {
    // Three users, three scope shapes. For each: GET /po/initiate/:id is 403
    // exactly when /po/:id/initiators says can_initiate = false.
    //   company-wide : READ_ONLY + FINAL_AWARDING_P1 at the whole company
    //   hotel-scoped : WRITER (A1) on a PO at A1
    //   wrong-process: CREATOR + FINAL_AWARDING_P1 scoped to process A_P2, on an A_P1 PO
    const extra = [];
    try {
      extra.push(await grantRoleScope(db, {
        userId: READ_ONLY, roleId: ROLE_IDS.FINAL_AWARDING_P1, companyId: IDS.hospitality.A,
      }));
      extra.push(await grantRoleScope(db, {
        userId: CREATOR, roleId: ROLE_IDS.FINAL_AWARDING_P1, companyId: IDS.hospitality.A,
        hotelId: IDS.hotels.A1, departmentId: IDS.departments.proc, processId: IDS.processes.A_P2,
      }));
      const cases = [
        ["company-wide", await httpClient(READ_ONLY), true],
        ["hotel-scoped", writerClient, true],
        ["wrong-process", await httpClient(CREATOR), false],
      ];
      for (const [label, client, expected] of cases) {
        const { po_id } = await makeDraftPo();
        const list = await client.get(`/api/v1/po/${po_id}/initiators`);
        expect({ label, status: list.status }).toEqual({ label, status: 200 });
        const gate = await client.get(`/api/v1/po/initiate/${po_id}`);
        expect({ label, can: list.body.data.can_initiate, gate403: gate.status === 403 })
          .toEqual({ label, can: expected, gate403: !expected });
      }
    } finally {
      await revokeRoleScopes(db, extra);
    }
  });
});
