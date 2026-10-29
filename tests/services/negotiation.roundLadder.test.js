// negotiation.roundLadder.test.js — which round a NEGOTIATION approval is for.
//
// NEGOTIATION approval instances come in two shapes:
//   modern  entity_id = the round id, metadata.round_id = the same round
//   legacy  entity_id = an rfq_product_id, metadata.round_id = the round
// The shared ladder (negotiationModel.negotiationInstanceRoundIdSql) used to
// try entity_id first, as a round id, accepting it when that round is on the
// instance's metadata RFQ. A legacy instance whose rfq_product_id happens to
// EQUAL the id of another round of the same RFQ therefore resolved to that
// other round: the round really awaiting approval showed no approval, and the
// unrelated one showed "Approval needed". It depended on how the id sequences
// had advanced, which is why negotiation.statusTaxonomy's legacy cases failed
// only under some suite orders.
//
// This suite FORCES the collision: the legacy instance's product and a decoy
// round of the same RFQ are created with the same id. Real HTTP against the
// listing (row flag, the "for me" tab and its count) and the detail page's
// approval card, for both shapes.

import { httpClient } from "../helpers/http.js";
import { db } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

const HC_A = IDS.hospitality.A;
const HOTEL_A = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;
const ROLE_NEG_FULL = 8; // Commercial Negotiator: negotiation.{read,create,update,approve}
const POLICY_ID = 64997;

const stamp = (daysFromNow) =>
  new Date(Date.now() + daysFromNow * 86_400_000).toISOString().replace("T", " ").slice(0, 19);

let client;
let negScopeId;
let rfqId;
const RP = {};
const R = {};
const instanceIds = [];
const stepIds = [];

async function addProduct(key, variantId, id = null) {
  const row = await db.one(
    `INSERT INTO tbl_rfq_products
       (${id ? "id, " : ""}rfq_id, comment, datasheet, spec_file, qap_file, product_variant_id, qap, variant)
     VALUES (${id ? "$3, " : ""}$1, '', '0', '', '', $2, '0', $2)
     RETURNING id`,
    id ? [rfqId, variantId, id] : [rfqId, variantId]
  );
  RP[key] = Number(row.id);
}

async function addRound(key, { productKey, status, endDate, id = null }) {
  const row = await db.one(
    `INSERT INTO tbl_negotiation_rounds
       (${id ? "id, " : ""}rfq_id, source_type, source_id, rfq_product_id, round_number, status,
        end_date, vendor_ids, created_by)
     VALUES (${id ? "$7, " : ""}$1, 'RFQ', $1, $2, 1, $3, $4, ARRAY[$5]::int[], $6)
     RETURNING id`,
    id ? [rfqId, RP[productKey], status, endDate, VENDOR, BUYER, id] : [rfqId, RP[productKey], status, endDate, VENDOR, BUYER]
  );
  R[key] = Number(row.id);
}

/** A PENDING NEGOTIATION instance waiting on BUYER. */
async function addPendingApproval({ entityId, roundId, productId }) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        initiated_by, hospitality_company_id, hotel_id, department_id, metadata)
     VALUES ('NEGOTIATION', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [entityId, POLICY_ID, BUYER, HC_A, HOTEL_A, DEPT,
      JSON.stringify({ rfq_id: String(rfqId), rfq_product_id: productId, round_id: roundId })]
  );
  instanceIds.push(Number(inst.id));
  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ALL', 'PENDING') RETURNING id`,
    [inst.id]
  );
  stepIds.push(Number(step.id));
  await db.none(
    `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING')`,
    [step.id, BUYER]
  );
}

describe("NEGOTIATION approval → round resolution", () => {
  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    negScopeId = Number((await db.one(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, NULL) RETURNING id`,
      [BUYER, ROLE_NEG_FULL, HC_A, HOTEL_A]
    )).id);
    client = await httpClient(BUYER);
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'NEGOTIATION', $2, $3, NULL, true, $4, NULL, false, false, 1)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [POLICY_ID, HC_A, HOTEL_A, BUYER]
    );
    const { rfq_id } = await makeRFQ(db, {
      createdBy: BUYER, hospitality: HC_A, hotel: HOTEL_A, department: DEPT, bid_end_date: stamp(-3),
    });
    rfqId = Number(rfq_id);

    // One id, free in BOTH tables: the legacy instance's product, and a decoy
    // round on the same RFQ. Both sequences are moved past it so later inserts
    // never collide with the explicit ids.
    const { x } = await db.one(
      `SELECT GREATEST((SELECT COALESCE(MAX(id), 0) FROM tbl_rfq_products),
                       (SELECT last_value FROM tbl_rfq_products_id_seq),
                       (SELECT COALESCE(MAX(id), 0) FROM tbl_negotiation_rounds),
                       (SELECT last_value FROM tbl_negotiation_rounds_id_seq)) + 1000 AS x`
    );
    const X = Number(x);
    await addProduct("legacy", 1, X);
    await db.one(`SELECT setval('tbl_rfq_products_id_seq', $1)`, [X]);
    await addProduct("decoy", 2);
    await addProduct("modern", 3);

    // The round the legacy instance is for, awaiting approval.
    await addRound("legacy", { productKey: "legacy", status: "PENDING_APPROVAL", endDate: stamp(4) });
    // The decoy: another round of the same RFQ whose id equals the legacy
    // instance's entity_id. Open with vendors, nothing to approve.
    await addRound("decoy", { productKey: "decoy", status: "ACTIVE", endDate: stamp(4), id: X });
    await db.one(`SELECT setval('tbl_negotiation_rounds_id_seq', $1)`, [X]);
    // A modern-shape round awaiting approval.
    await addRound("modern", { productKey: "modern", status: "PENDING_APPROVAL", endDate: stamp(4) });

    expect(RP.legacy).toBe(R.decoy);
    await addPendingApproval({ entityId: RP.legacy, roundId: R.legacy, productId: RP.legacy });
    await addPendingApproval({ entityId: R.modern, roundId: R.modern, productId: RP.modern });
  });

  afterAll(async () => {
    if (stepIds.length) {
      await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id = ANY($1::int[])`, [stepIds]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE id = ANY($1::int[])`, [stepIds]);
    }
    if (instanceIds.length) await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
    if (negScopeId) await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = $1`, [negScopeId]);
    const roundIds = Object.values(R);
    if (roundIds.length) await db.none(`DELETE FROM tbl_negotiation_rounds WHERE id = ANY($1::int[])`, [roundIds]);
    const productIds = Object.values(RP);
    if (productIds.length) await db.none(`DELETE FROM tbl_rfq_products WHERE id = ANY($1::int[])`, [productIds]);
    if (rfqId) await db.none(`DELETE FROM tbl_rfq WHERE id = $1`, [rfqId]);
  });

  const list = async (tab = "all") => {
    const res = await client.post("/api/v1/negotiation/list-view").send({ tab, limit: 100, groupBy: "round" });
    expect(res.status).toBe(200);
    return res.body.data;
  };
  const ours = (rows) => rows.filter((r) => Number(r.rfq_id) === rfqId);
  const rowFor = (rows, key) => rows.find((r) => Number(r.round_id) === R[key]);
  const detailFor = async (key) => {
    const res = await client.get(`/api/v1/negotiation/rounds/${R[key]}/detail`);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  it("flags the round each instance is for, and not the round whose id collides with a product id", async () => {
    const { rows } = await list();
    expect(rowFor(rows, "legacy")).toMatchObject({ action_required: true, action_label: "Approval needed" });
    expect(rowFor(rows, "modern")).toMatchObject({ action_required: true, action_label: "Approval needed" });
    expect(rowFor(rows, "decoy").action_label).not.toBe("Approval needed");
  });

  it("puts exactly those two rounds in the 'for me' tab, and counts them", async () => {
    const forMe = await list("for_me");
    expect(ours(forMe.rows).map((r) => Number(r.round_id)).sort((a, b) => a - b))
      .toEqual([R.legacy, R.modern].sort((a, b) => a - b));
    const all = await list();
    expect(all.tab_counts.for_me).toBe(forMe.rows.length);
  });

  it("shows the approval on each round's detail card, and none on the decoy", async () => {
    for (const key of ["legacy", "modern"]) {
      const detail = await detailFor(key);
      expect({ key, status: detail.approval.status, mine: detail.approval.is_pending_for_me })
        .toEqual({ key, status: "PENDING", mine: true });
    }
    const decoy = await detailFor("decoy");
    expect(decoy.approval.status).toBeNull();
    expect(decoy.approval.is_pending_for_me).toBe(false);
  });
});
