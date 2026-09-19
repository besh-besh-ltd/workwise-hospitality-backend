// SECURITY — initiating a Purchase Order is a WRITE gated only by a READ grant.
// ----------------------------------------------------------------------------
// A previous pass closed the cross-tenant hole on /po/initiate/:po_id (see
// security.legacyPoScope.test.js): the endpoint had no acl() and no scope check
// at all while mutating state. What it left behind was a subtler defect —
// the surviving gate, purchaseOrderModel.assertPoAccess, is a READ predicate:
//
//     PO_SCOPE_PERMISSIONS = ["awarding.read", "rfq.read", "boq.read"]
//
// Initiating is not a read. It flips draft -> pending_approval, creates the
// approval instance, regenerates the PDF and emails the approvers. So any user
// who could merely SEE a draft PO could drive it into approval by calling the
// endpoint directly. `awarding.create` was enforced in exactly one place: the
// browser (PODetail.js `canWrite = canUpdate || canCreate`), which disables the
// Force Initiate button. A disabled button is not authorization.
//
// The fix is purchaseOrderModel.assertPoInitiateAccess — additive on top of
// assertPoAccess:
//
//     read gate  (unchanged) : awarding.read OR rfq.read OR boq.read  -> 404
//     write gate (new)       : awarding.create OR awarding.update     -> 403
//
// both evaluated against the PO's OWN company x hotel x department x process
// tuple, never the viewer's hotel mappings.
//
// The `create OR update` pair mirrors the UI's `canUpdate || canCreate` exactly,
// so the enabled button and the server can never disagree. tbl_permissions has
// no `awarding.update` row today (only read / create / approve / regenerate),
// which the first test below asserts — so today the effective server gate IS
// `awarding.create`, matching the production permission model.
//
// Fixture users and why each was chosen (permissions asserted in-suite, so this
// stays honest if the seeded role->permission map ever drifts):
//   a1_proc_commApp  role COMM_APPROVER     — awarding.read, NO awarding.create
//                                             => "read-only on the PO's scope"
//   a1_proc_buyer    role TENDER_CREATOR    — rfq.read/boq.read, NO awarding.*
//                                             => the PO's own creator. In
//                                             production the finaliser who
//                                             CREATES the draft usually cannot
//                                             initiate it; creating is not a
//                                             bypass.
//   a1_eng_buyer     + runtime FINAL_AWARDING_P1 at (A, A1, proc)
//                                             => holds awarding.create on the
//                                             PO's own scope. Deliberately NOT
//                                             an approver on A1_P1_PO, so the
//                                             initiator-is-approver step-skip
//                                             path cannot muddy the assertion.
//   multiHotel       + runtime FINAL_AWARDING_P1 at (A, A2, proc)
//                                             => can READ the A1 PO (baseline
//                                             TENDER_CREATOR at A1) but holds
//                                             awarding.create only at hotel A2.
//                                             This is the scoping axis that was
//                                             just fixed on the client; the
//                                             server must not be laxer.
//   vendor_alpha     the finalized vendor    — blocked at the route by noAcl([3]).

import {
  describe, it, expect, afterAll, beforeAll, beforeEach, afterEach,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";

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

let PO_NO = 8_400_000;
const nextPoNo = () => `INITGATE-PO-${++PO_NO}`;

/** A draft PO at an explicit scope, hanging off a published RFQ. */
async function makeDraftPo({
  hotel = IDS.hotels.A1,
  department = IDS.departments.proc,
  process = IDS.processes.A_P1,
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

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, VENDOR]
  );
  inserted.quoteIds.push(quote.id);

  const quoteItem = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
        comment, delivery_period, quantity, variant)
     VALUES ($1, $2, $3, $4, 100, 1000, '', '7', '1', 0) RETURNING id`,
    [rfq_id, rfq_no, quote.id, VARIANT_ID]
  );

  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'draft', $4, 1, 100, $5, 1000, $6, $7,
             (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'),
             (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'))
     RETURNING id`,
    [rfq_id, IDS.companies.A, nextPoNo(), [product.id], VENDOR, [quoteItem.id], CREATOR]
  );
  inserted.poIds.push(po.id);

  const pop = await db.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
     VALUES ($1, $2, $3, 1, 'NOS', 100, 1000) RETURNING id`,
    [po.id, product.id, quoteItem.id]
  );
  inserted.poProductIds.push(pop.id);

  return { rfq_id, po_id: po.id };
}

/**
 * The assertion that actually matters on a refusal: nothing was written. A
 * status code alone would still pass if the handler 403'd *after* creating the
 * approval instance or uploading the PDF.
 */
async function expectNothingHappened(po_id) {
  const po = await db.one(
    `SELECT status, approval_instance_id, po_pdf_url
       FROM tbl_rfq_purchase_order WHERE id = $1`,
    [po_id]
  );
  expect(po.status).toBe("draft");
  expect(po.approval_instance_id).toBeNull();
  expect(po.po_pdf_url).toBeNull();

  const instances = await db.one(
    `SELECT COUNT(*)::int AS c FROM tbl_approval_instances
      WHERE entity_type = 'PO' AND entity_id = $1`,
    [po_id]
  );
  expect(instances.c).toBe(0);

  const docs = await db.one(
    `SELECT COUNT(*)::int AS c FROM tbl_purchase_order_document WHERE purchase_order_id = $1`,
    [po_id]
  );
  expect(docs.c).toBe(0);
}

const actionsOf = (userId) => db.any(
  `SELECT DISTINCT p.resource::text || '.' || p.action::text AS perm
     FROM tbl_user_role_scopes urs
     JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
     JOIN tbl_permissions p       ON p.id = rp.permission_id
    WHERE urs.user_id = $1 AND urs.company_id = $2`,
  [userId, IDS.hospitality.A]
).then((rows) => rows.map((r) => r.perm));

// ===========================================================================
// 0. The premises this suite rests on. If any of these drift, the tests below
//    would still pass while testing something else entirely.
// ===========================================================================
describe("premises: the seeded permission model", () => {
  it("there is no awarding.update permission, so the server's create-OR-update gate is effectively awarding.create", async () => {
    // The OR exists to mirror PODetail.js's `canWrite = canUpdate || canCreate`
    // so the server can never be stricter than the enabled button. Today it is
    // inert, which is exactly why it is safe.
    const row = await db.oneOrNone(
      `SELECT id FROM tbl_permissions WHERE resource::text = 'awarding' AND action::text = 'update'`
    );
    expect(row).toBeNull();
  });

  it("the read-only user holds awarding.read and NOT awarding.create", async () => {
    const perms = await actionsOf(READ_ONLY);
    expect(perms).toContain("awarding.read");
    expect(perms).not.toContain("awarding.create");
  });

  it("the PO's creator can read it but holds no awarding write grant", async () => {
    const perms = await actionsOf(CREATOR);
    expect(perms.some((p) => ["awarding.read", "rfq.read", "boq.read"].includes(p))).toBe(true);
    expect(perms).not.toContain("awarding.create");
  });

  it("the writer holds awarding.create", async () => {
    const perms = await actionsOf(WRITER);
    expect(perms).toContain("awarding.create");
  });
});

// ===========================================================================
// 1. Read grant is not a write grant
// ===========================================================================
describe("SECURITY: /po/initiate/:po_id requires a write grant, not just read", () => {
  it("a user with only awarding.read on the PO's scope is refused 403 and initiates nothing", async () => {
    const { po_id } = await makeDraftPo();

    // Premise: they really can SEE this PO — so a 404 here would be the wrong
    // refusal, and a 200 would be the bug.
    const visible = await readOnlyClient.get(`/api/v1/po/${po_id}`);
    expect(visible.status).toBe(200);

    const res = await readOnlyClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe("PO_WRITE_PERMISSION_REQUIRED");
    await expectNothingHappened(po_id);
  });

  it("the GET binding carries the same gate as POST (the deployed frontend still calls GET)", async () => {
    const { po_id } = await makeDraftPo();
    const res = await readOnlyClient.get(`/api/v1/po/initiate/${po_id}`);
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe("PO_WRITE_PERMISSION_REQUIRED");
    await expectNothingHappened(po_id);
  });

  it("the PO's own creator is refused too — creating the draft is not a write grant on it", async () => {
    const { po_id } = await makeDraftPo();
    const owns = await db.one(`SELECT initiated_by FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
    expect(owns.initiated_by).toBe(CREATOR);

    const res = await creatorClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe("PO_WRITE_PERMISSION_REQUIRED");
    await expectNothingHappened(po_id);
  });

  it("a vendor is still refused at the route layer", async () => {
    const { po_id } = await makeDraftPo();
    const res = await vendorClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(res.status).toBe(403);
    await expectNothingHappened(po_id);
  });

  it("an out-of-scope caller still gets 404, not the new 403 — existence is not leaked", async () => {
    // The write gate must not downgrade the read gate's refusal: 403 confirms
    // the PO exists, and companyB's admin has no business learning that.
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [IDS.users.companyB_admin]);
    const foreign = await httpClient(IDS.users.companyB_admin);
    const { po_id } = await makeDraftPo();

    const res = await foreign.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(res.status).toBe(404);
    expect(res.body?.code).toBe("PO_NOT_FOUND_OR_OUT_OF_SCOPE");
    await expectNothingHappened(po_id);
  });
});

// ===========================================================================
// 2. The write grant is scoped to the PO's own hotel
// ===========================================================================
describe("SECURITY: the write grant is evaluated at the PO's hotel, not the viewer's", () => {
  it("awarding.create at a DIFFERENT hotel does not authorize this PO", async () => {
    const { po_id } = await makeDraftPo({ hotel: IDS.hotels.A1 });

    // Premise: this user CAN read the A1 PO (baseline rfq.read at A1), so the
    // only thing left to refuse them on is the hotel of their create grant.
    const visible = await wrongHotelClient.get(`/api/v1/po/${po_id}`);
    expect(visible.status).toBe(200);

    const res = await wrongHotelClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(res.status).toBe(403);
    expect(res.body?.code).toBe("PO_WRITE_PERMISSION_REQUIRED");
    await expectNothingHappened(po_id);
  });

  it("the same user, the same grant, a PO at THEIR hotel: the write gate passes", async () => {
    // The control for the test above — without it, a 403 could just as well
    // mean "this user can never initiate anything".
    const { po_id } = await makeDraftPo({ hotel: IDS.hotels.A2 });

    const res = await wrongHotelClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
    expect(res.body?.code).not.toBe("PO_WRITE_PERMISSION_REQUIRED");
    // Hotel A2 has no PO approval policy fixture, so initiation itself fails
    // downstream — after the gate, which is the whole point.
    expect(res.body?.message || "").toMatch(/approval policy/i);
  });
});

// ===========================================================================
// 3. The happy path still works — the gate is additive, not a wall
// ===========================================================================
describe("a user with awarding.create on the PO's scope can still initiate", () => {
  it("initiate moves the PO to pending_approval and creates a PENDING approval instance", async () => {
    const { po_id } = await makeDraftPo();

    const res = await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(res.status).toBe(200);
    expect(res.body?.status).toBe(1);
    expect(res.body?.data?.approval_required).toBe(true);
    expect(res.body?.data?.approval_instance_id).toBeTruthy();

    const after = await db.one(
      `SELECT status, approval_instance_id FROM tbl_rfq_purchase_order WHERE id = $1`,
      [po_id]
    );
    expect(after.status).toBe("pending_approval");
    expect(after.approval_instance_id).toBe(res.body.data.approval_instance_id);

    const inst = await db.one(
      `SELECT entity_type, entity_id, approval_policy_id, status
         FROM tbl_approval_instances WHERE id = $1`,
      [res.body.data.approval_instance_id]
    );
    expect(inst.entity_type).toBe("PO");
    expect(inst.entity_id).toBe(po_id);
    expect(inst.approval_policy_id).toBe(IDS.policies.A1_P1_PO);
    expect(inst.status).toBe("PENDING");
  });
});

// ── Two defects found next door to this gate ────────────────────────────────
//
// Both surfaced while working client feedback item 10 ("the system should
// guide the Commercial Approver on how to initiate a draft PO"). Neither is a
// permission hole; both are the gate disagreeing with what the user is told.

describe("initiating a PO that has already been initiated", () => {
  it("reports that nothing happened, instead of a second success", async () => {
    // purchaseOrderModel returns { already_initiated: true } and does nothing,
    // but the controller answered `status: 1, "Purchase order has been
    // initiated"` regardless — so a double-click, or a PO that auto-initiate
    // already claimed, looked like a fresh success. The frontend toasts that
    // message verbatim.
    const { po_id } = await makeDraftPo();

    const first = await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(first.status).toBe(200);
    expect(first.body?.data?.already_initiated).toBeFalsy();

    const second = await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({});

    expect(second.status).toBe(200);
    expect(second.body?.data?.already_initiated).toBe(true);
    expect(second.body?.message).toMatch(/already/i);
  });

  it("does not create a second approval instance for it", async () => {
    const { po_id } = await makeDraftPo();

    await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({});

    const { cnt } = await db.one(
      `SELECT COUNT(*)::int AS cnt FROM tbl_approval_instances
        WHERE entity_type = 'PO' AND entity_id = $1`,
      [po_id]
    );
    expect(cnt).toBe(1);
  });
});

describe("the Action Required list agrees with the initiate gate", () => {
  // poDashboardModel decided whether to put initiatable POs in a user's
  // Action Required bucket with ONE boolean — "does this user hold
  // awarding.create anywhere in this company" — while assertPoInitiateAccess
  // evaluates the grant against the PO's OWN hotel and department. So a user
  // granted at hotel A2 was shown A1's drafts and then 403'd on the click.

  it("does not offer a draft PO to a user whose awarding.create is at another hotel", async () => {
    const { po_id } = await makeDraftPo({ hotel: IDS.hotels.A1 });

    const res = await wrongHotelClient.get("/api/v1/po/list?status=action-required");

    expect(res.status).toBe(200);
    expect((res.body.data || []).map((r) => r.id)).not.toContain(po_id);
  });

  it("and does not count it either — the tab badge must match the tab", async () => {
    const { po_id } = await makeDraftPo({ hotel: IDS.hotels.A1 });

    const before = await wrongHotelClient.get("/api/v1/po/list?status=action-required");
    const countedIds = (before.body.data || []).map((r) => r.id);
    expect(countedIds).not.toContain(po_id);
    // the badge is computed by a separate query, so assert it independently
    expect(before.body.status_counts.action_required).toBe(countedIds.length);
  });

  it("still offers it to the user whose grant IS at the PO's hotel", async () => {
    // The guard against over-correcting: the fix must not empty the bucket.
    const { po_id } = await makeDraftPo({ hotel: IDS.hotels.A1 });

    const res = await writerClient.get("/api/v1/po/list?status=action-required");

    expect(res.status).toBe(200);
    expect((res.body.data || []).map((r) => r.id)).toContain(po_id);
    expect(res.body.status_counts.action_required).toBeGreaterThanOrEqual(1);
  });

  it("anyone listed in Action Required as an initiator can actually initiate it", async () => {
    // The property that ties the two predicates together: whatever the list
    // offers, the endpoint must accept.
    const { po_id } = await makeDraftPo({ hotel: IDS.hotels.A1 });

    const res = await writerClient.get("/api/v1/po/list?status=action-required");
    const offered = (res.body.data || []).find((r) => r.id === po_id);
    expect(offered).toBeDefined();

    const act = await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    expect(act.status).toBe(200);
  });

  it("keeps offering a PO the user is the pending approver on, grant or no grant", async () => {
    // The approver half of the clause must be untouched by the scope fix.
    const { po_id } = await makeDraftPo({ hotel: IDS.hotels.A1 });
    await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({});

    const inst = await db.one(
      `SELECT approval_instance_id AS id FROM tbl_rfq_purchase_order WHERE id = $1`,
      [po_id]
    );
    const approver = await db.oneOrNone(
      `SELECT sa.approver_user_id AS uid
         FROM tbl_approval_step_approvers sa
         JOIN tbl_approval_instance_steps st ON st.id = sa.approval_instance_step_id
        WHERE st.approval_instance_id = $1 AND sa.status = 'PENDING'
        LIMIT 1`,
      [inst.id]
    );
    if (!approver) return; // policy resolved to nobody in this fixture

    const client = await httpClient(approver.uid);
    const res = await client.get("/api/v1/po/list?status=action-required");
    expect((res.body.data || []).map((r) => r.id)).toContain(po_id);
  });
});

// ── Sending a rejected PO back to the person who can amend it ───────────────
//
// Client feedback item 7. The reject screen has always PROMISED this —
// PODetail.js: "will be rejected and returned to the initiator" — and nothing
// did it. Production carries 46 rejected PO approvals and exactly ONE PO that
// was ever resubmitted; the rest simply stopped.
//
// Two different people are involved and the code conflated them:
//   tbl_approval_instances.initiated_by  — whoever pressed Initiate
//   tbl_rfq_purchase_order.initiated_by  — whoever created the draft, and the
//                                          ONLY person handleUpdatePO lets
//                                          edit it
// The generic approval-outcome notice goes to the first. The person who has to
// act is the second.

const notificationsFor = (userId, type) => db.any(
  `SELECT type, title, message, action_url, additional_data
     FROM tbl_notifications
    WHERE recipient_user_id = $1 AND type = $2
    ORDER BY id DESC`,
  [userId, type]
);

/** Initiate, then reject as whoever the policy put on the current step. */
async function initiateThenReject(po_id, comment = "Rates do not match the negotiated sheet") {
  await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({});
  const inst = await db.one(
    `SELECT approval_instance_id AS id FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
  const approver = await db.oneOrNone(
    `SELECT sa.approver_user_id AS uid
       FROM tbl_approval_step_approvers sa
       JOIN tbl_approval_instance_steps st ON st.id = sa.approval_instance_step_id
      WHERE st.approval_instance_id = $1 AND sa.status = 'PENDING'
      LIMIT 1`, [inst.id]);
  if (!approver) return null;
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [approver.uid]);
  const client = await httpClient(approver.uid);
  // `remarks` is the key this endpoint reads and the key the browser sends
  // (PODetail.decide → handlePOApproval({ decision, type, remarks })). The
  // generic /approval/action endpoint calls the same field `comment`.
  const res = await client.post(`/api/v1/po/approve/${po_id}`).send({ decision: "rejected", remarks: comment });
  return { res, approverId: approver.uid };
}

describe("a rejected PO goes back to whoever can amend it", () => {
  beforeEach(async () => {
    await db.none(`DELETE FROM tbl_notifications WHERE type = 'po_sent_back'`);
  });

  it("notifies the PO's own originator, not only the approval's initiator", async () => {
    const { po_id } = await makeDraftPo();
    const out = await initiateThenReject(po_id);
    if (!out) return; // no approver resolved in this fixture

    expect(out.res.status).toBe(200);

    // CREATOR is tbl_rfq_purchase_order.initiated_by (see makeDraftPo) and is
    // the only person handleUpdatePO authorises to edit it.
    const notes = await notificationsFor(CREATOR, "po_sent_back");
    expect(notes.length).toBe(1);
  });

  it("tells them to amend and resubmit, and carries the reason", async () => {
    const { po_id } = await makeDraftPo();
    const out = await initiateThenReject(po_id, "Freight is double the quote");
    if (!out) return;

    const [note] = await notificationsFor(CREATOR, "po_sent_back");
    expect(`${note.title} ${note.message}`).toMatch(/amend/i);
    expect(note.message).toMatch(/Freight is double the quote/);
  });

  it("deep-links to the purchase order, with a relative in-app url", async () => {
    const { po_id } = await makeDraftPo();
    const out = await initiateThenReject(po_id);
    if (!out) return;

    const [note] = await notificationsFor(CREATOR, "po_sent_back");
    expect(note.action_url).toMatch(/purchase-order/);
    // rule 1 of notificationLinks: an in-app row stays relative so it resolves
    // on local, staging and production alike.
    expect(note.action_url.startsWith("http")).toBe(false);
  });

  it("does not notify the originator when they are the one who rejected it", async () => {
    // They already know; a "sent back to you" from yourself is noise.
    const { po_id } = await makeDraftPo();
    await writerClient.post(`/api/v1/po/initiate/${po_id}`).send({});
    const inst = await db.one(
      `SELECT approval_instance_id AS id FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
    // Put the PO's own originator on the pending step, then have them reject.
    await db.none(
      `UPDATE tbl_approval_step_approvers SET approver_user_id = $2
        WHERE approval_instance_step_id IN (
          SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1)
          AND status = 'PENDING'`, [inst.id, CREATOR]);
    const client = await httpClient(CREATOR);
    await client.post(`/api/v1/po/approve/${po_id}`).send({ decision: "rejected", comment: "mine" });

    expect(await notificationsFor(CREATOR, "po_sent_back")).toHaveLength(0);
  });

  it("still marks the PO rejected — the send-back is additive", async () => {
    const { po_id } = await makeDraftPo();
    const out = await initiateThenReject(po_id);
    if (!out) return;

    const po = await db.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
    expect(po.status).toBe("rejected");
  });
});

describe("PUT /po/:po_id refuses a purchase order that has moved on", () => {
  // handleUpdatePO had NO status check at all: it authorised the creator (or a
  // legacy hierarchy member) and then applied the changes, so an `approved` or
  // `sent` PO — one a vendor may already be acting on — was editable through
  // the same door. Found while wiring item 7; it is a defect in its own right.

  const editQty = (client, po_id, rfqProductId) =>
    client.put(`/api/v1/po/${po_id}`).send({
      changes: [{ path: `product[${rfqProductId}].quantity`, newValue: 9 }],
    });

  it("allows an edit while the PO is still a draft", async () => {
    const { po_id } = await makeDraftPo();
    const row = await db.one(
      `SELECT rfq_product_id FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po_id]);

    const res = await editQty(creatorClient, po_id, row.rfq_product_id);
    expect(res.status).toBe(200);
  });

  it("allows an edit after rejection — that is the whole point of sending it back", async () => {
    const { po_id } = await makeDraftPo();
    const row = await db.one(
      `SELECT rfq_product_id FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po_id]);
    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'rejected' WHERE id = $1`, [po_id]);

    const res = await editQty(creatorClient, po_id, row.rfq_product_id);
    expect(res.status).toBe(200);
  });

  it("still allows an edit while the PO sits with approvers", async () => {
    // Not an oversight: production PO 440 was edited in exactly this state and
    // po.globalChargeRecompute.test.js pins the arithmetic for it. Whether an
    // approver may be shown one thing and asked to approve another is a
    // product decision, and a separate one from this batch.
    const { po_id } = await makeDraftPo();
    const row = await db.one(
      `SELECT rfq_product_id FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po_id]);
    await db.none(`UPDATE tbl_rfq_purchase_order SET status = 'pending_approval' WHERE id = $1`, [po_id]);

    const res = await editQty(creatorClient, po_id, row.rfq_product_id);
    expect(res.status).toBe(200);
  });

  for (const status of ["approved", "acceptance_pending", "sent", "completed"]) {
    it(`refuses an edit once the PO is ${status}`, async () => {
      const { po_id } = await makeDraftPo();
      const row = await db.one(
        `SELECT rfq_product_id FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po_id]);
      await db.none(`UPDATE tbl_rfq_purchase_order SET status = $2 WHERE id = $1`, [po_id, status]);

      const res = await editQty(creatorClient, po_id, row.rfq_product_id);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body?.message || "").toMatch(/no longer be edited/i);

      const after = await db.one(
        `SELECT quantity FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po_id]);
      expect(Number(after.quantity)).toBe(1);
    });
  }
});
