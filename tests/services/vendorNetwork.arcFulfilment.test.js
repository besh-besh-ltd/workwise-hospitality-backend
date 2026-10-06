// Vendor Networks: Group ARC per-hotel fulfilment, the ARC_HOTEL routing subject
// (spec §6.4, §10.9). Pattern B: committed fixtures (vendor ids 95971..95989), removed in
// afterEach. Routing through the HTTP API; call-offs through callOffPoService.releaseForMr
// in a transaction (as mrController does); entity removal through DELETE /entities/:id.
//
// World: an ACTIVE group contract of HQ (lead A1, + A2, A3; two lines). H1 = A2, H2 = A3.
// B, C, D are ACTIVE seated branches of HQ's org. FHQ (another org's principal) holds a
// second contract on the same ARC.
//
// SMTP: nodemailer.createTransport is swapped for a no-op.

import nodemailer from "nodemailer";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { httpClient } from "../helpers/http.js";
import { deleteArcs } from "../helpers/arcGroupSeed.js";
import { grantRoleScope, revokeRoleScopes } from "../helpers/roleScope.js";
import {
  seedVendorEntity,
  seedPerson,
  seedOrg,
  addEntity,
  addMember,
  cleanupVendorNetworkFixtures,
} from "../helpers/vendorNetworkSeed.js";
import { releaseForMr } from "../../app/services/callOffPoService.js";
import arcContractModel from "../../app/models/arc_v2/arcContractModel.js";
import arcHotelModel from "../../app/models/arc_v2/arcHotelModel.js";
import { getSubjectHandler } from "../../app/services/vendorNetwork/routingEngine.js";
import { arcHotelSubjectHandler } from "../../app/services/vendorNetwork/subjects/arcHotelSubject.js";

const HQ = 95971; // principal, the contract vendor
const B = 95972;
const C = 95973;
const D = 95974; // sibling with no assignment
const MP = 95975; // type-11 ENTITY_MEMBER person of B (the contact)
const FHQ = 95976; // another org's principal
const ORG = 95971;
const F_ORG = 95972;
const BASE = "/api/v1/vendor-network";
const ARC_V = "/api/v1/arc-v2";

const { A1, A2, A3 } = IDS.hotels;
const H1 = A2;
const H2 = A3;
const HC_A = IDS.hospitality.A;
const PROC = IDS.departments.proc;
const CREATOR = IDS.users.companyA_admin;

let realTransport;
let creatorBefore;
let VARIANTS;
let arcId;
let contractId;
let foreignContractId;
let lineIds;
const mrIds = [];

beforeAll(async () => {
  realTransport = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail(_mail, cb) {
      const info = { messageId: "<vn-arc>", response: "250 OK" };
      if (typeof cb === "function") cb(null, info);
      return Promise.resolve(info);
    },
    verify: () => Promise.resolve(true),
    close() {},
  });
  VARIANTS = (await db.any(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 2`)).map((r) => r.id);
  creatorBefore = await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [CREATOR]);
  await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [CREATOR]);
});

beforeEach(async () => {
  for (const id of [HQ, B, C, D, FHQ]) {
    await seedVendorEntity({
      id,
      companyId: id,
      name: `VN ARC ${id}`,
      email: `vn-arc-${id}@example.com`,
      gstin: `27AAAAA${id}Z5`,
    });
  }
  await seedOrg({ id: ORG, principalVendorId: HQ, name: "HQ Network" });
  for (const v of [B, C, D]) await addEntity({ orgId: ORG, vendorId: v });
  await seedPerson({ id: MP, email: "vn-arc-member@example.com", name: "Bina Branch" });
  await addMember({ orgId: ORG, personId: MP, entityVendorId: B, role: "ENTITY_MEMBER" });
  await seedOrg({ id: F_ORG, principalVendorId: FHQ, name: "Foreign Network" });
  await groupContract();
});

afterEach(async () => {
  const poIds = (await db.any(`SELECT po_id FROM tbl_arc_callof_po WHERE mr_id = ANY($1::bigint[])`, [mrIds])).map((r) => r.po_id);
  await db.none(`DELETE FROM tbl_arc_callof_po WHERE mr_id = ANY($1::bigint[])`, [mrIds]);
  if (poIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]).catch(() => {});
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
  }
  await db.none(`DELETE FROM tbl_material_requisition_item WHERE mr_id = ANY($1::bigint[])`, [mrIds]);
  await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::bigint[])`, [mrIds]);
  mrIds.length = 0;
  await db.none(`DELETE FROM tbl_arc_amendment WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = $1)`, [arcId]);
  await db.none(`DELETE FROM tbl_arc_hotel_mappings WHERE arc_id = $1`, [arcId]);
  await deleteArcs([arcId]);
  await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
  await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  await cleanupVendorNetworkFixtures();
});

afterAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [
    CREATOR,
    creatorBefore.user_type,
    creatorBefore.status,
  ]);
  nodemailer.createTransport = realTransport;
  await closeDb();
});

async function groupContract() {
  arcId = Number(
    (
      await db.one(
        `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
                              status, is_group, contract_start_at, contract_end_at, created_by)
         VALUES ('ARC-VN-FULFIL-' || floor(random() * 1e9)::text, 'Group linen', $1, $2, $3, $4,
                 'contract_active', true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '300 days', $5)
         RETURNING id`,
        [TEST_CATEGORIES.beverages, HC_A, A1, PROC, CREATOR]
      )
    ).id
  );
  await db.none(`INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id) SELECT $1, h FROM unnest($2::int[]) h`, [
    arcId,
    [A1, A2, A3],
  ]);
  const items = [];
  for (const v of VARIANTS) {
    items.push(
      (await db.one(`INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 1000, 'pcs') RETURNING id`, [arcId, v])).id
    );
  }
  contractId = Number(
    (await db.one(`INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, signed_by_vendor_at) VALUES ($1, $2, 'active', NOW()) RETURNING id`, [arcId, HQ])).id
  );
  lineIds = [];
  for (const itemId of items) {
    const lineId = Number(
      (
        await db.one(
          `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
           VALUES ($1, $2, 90, 5, 1000) RETURNING id`,
          [contractId, itemId]
        )
      ).id
    );
    lineIds.push(lineId);
    await db.none(
      `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty)
       VALUES ($1, $2, 400), ($1, $3, 350), ($1, $4, 250)`,
      [lineId, A1, A2, A3]
    );
  }
  foreignContractId = Number(
    (await db.one(`INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'awaiting_acceptance') RETURNING id`, [arcId, FHQ])).id
  );
}

// --- helpers --------------------------------------------------------------------------

const fulfilling = async (hotelId) =>
  (
    await db.any(
      `SELECT clh.fulfilling_vendor_id FROM tbl_arc_contract_line_hotel clh
         JOIN tbl_arc_contract_line l ON l.id = clh.arc_contract_line_id
        WHERE l.arc_contract_id = $1 AND clh.hotel_id = $2 ORDER BY clh.id`,
      [contractId, hotelId]
    )
  ).map((r) => r.fulfilling_vendor_id);

async function assignHotel(assignee, { hotelId = H1, subjectId = contractId } = {}) {
  const admin = await httpClient(HQ);
  return admin.post(`${BASE}/routing/assign`).send({
    subject_type: "ARC_HOTEL",
    subject_id: subjectId,
    hotel_id: hotelId,
    assignee_vendor_id: assignee,
  });
}

async function accept(vendorId, assignmentId) {
  const client = await httpClient(vendorId);
  return client.post(`${BASE}/routing/${assignmentId}/respond`).send({ decision: "ACCEPT" });
}

async function routeTo(vendorId, hotelId = H1) {
  const res = await assignHotel(vendorId, { hotelId });
  expect(res.status).toBe(201);
  const ok = await accept(vendorId, res.body.data.id);
  expect(ok.status).toBe(200);
  return res.body.data.id;
}

/** An approved MR at `hotelId` for 10 of each line, released in a transaction. */
async function releaseCallOff(hotelId) {
  const mrId = Number(
    (
      await db.one(
        `INSERT INTO tbl_material_requisition (mr_number, title, hospitality_company_id, hotel_id, department_id, status, raised_by)
         VALUES ('MR-VN-' || floor(random() * 1e12)::text, 'Linen', $1, $2, $3, 'approved', $4) RETURNING id`,
        [HC_A, hotelId, PROC, CREATOR]
      )
    ).id
  );
  mrIds.push(mrId);
  for (let i = 0; i < lineIds.length; i += 1) {
    await db.none(
      `INSERT INTO tbl_material_requisition_item (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id)
       VALUES ($1, $2, 10, 'pcs', $3, $4)`,
      [mrId, VARIANTS[i], contractId, lineIds[i]]
    );
  }
  const released = await db.tx((t) => releaseForMr(mrId, t));
  expect(released).toHaveLength(1);
  return released[0].po;
}

const notices = (userId) =>
  db.any(
    `SELECT * FROM tbl_notifications
      WHERE recipient_user_id = $1 AND type = 'CONTRACT_FULFILMENT_ASSIGNED'
        AND additional_data->>'arc_id' = $2
      ORDER BY id`,
    [userId, String(arcId)]
  );

// --- tests ----------------------------------------------------------------------------

describe("ARC_HOTEL subject registration", () => {
  it("is registered with the engine", () => {
    expect(getSubjectHandler("ARC_HOTEL")).toBe(arcHotelSubjectHandler);
  });
});

describe("assigning and accepting a hotel", () => {
  it("routes H1 to B: PENDING first, then every H1 line is B's on accept; H2 and the lead are untouched", async () => {
    const res = await assignHotel(B);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "PENDING", subject_type: "ARC_HOTEL", hotel_id: H1, assigned_vendor_id: B });
    expect(await fulfilling(H1)).toEqual([null, null]);

    const ok = await accept(B, res.body.data.id);
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe("ACCEPTED");
    expect(await fulfilling(H1)).toEqual([B, B]);
    expect(await fulfilling(H2)).toEqual([null, null]);
    expect(await fulfilling(A1)).toEqual([null, null]);
  });

  it("tells the ARC creator who now supplies H1, with GSTIN and the entity's contact", async () => {
    await routeTo(B);
    const [n] = await notices(CREATOR);
    expect(n).toBeDefined();
    expect(n.additional_data).toMatchObject({
      hotel_id: H1,
      fulfilling_vendor_id: B,
      entity_name: `VN ARC ${B}`,
      gstin: `27AAAAA${B}Z5`,
      contact_name: "Bina Branch",
      contact_email: "vn-arc-member@example.com",
    });
    // The principal is told too, on its own contract page.
    const [p] = await notices(HQ);
    expect(p.action_url || p.additional_data).toBeTruthy();
  });

  it("tells requisition staff at H1, never staff who order only for another hotel", async () => {
    const H1_STAFF = IDS.users.a1_eng_buyer;
    const H2_STAFF = IDS.users.a1_proc_techEval;
    const MR_ROLE = 95981; // test-only role carrying mr.create
    await db.none(`INSERT INTO tbl_roles (id, title, description, created_by) VALUES ($1, 'MR raiser (vn test)', 'mr.create', NULL)`, [MR_ROLE]);
    await db.none(
      `INSERT INTO tbl_role_permissions (role_id, permission_id)
       SELECT $1, p.id FROM tbl_permissions p WHERE p.resource::text = 'mr' AND p.action = 'create'`,
      [MR_ROLE]
    );
    const scopes = [
      await grantRoleScope(db, { userId: H1_STAFF, roleId: MR_ROLE, companyId: HC_A, hotelId: H1, departmentId: PROC }),
      await grantRoleScope(db, { userId: H2_STAFF, roleId: MR_ROLE, companyId: HC_A, hotelId: H2, departmentId: PROC }),
    ];
    try {
      await routeTo(B);
      expect(await notices(H1_STAFF)).toHaveLength(1);
      expect(await notices(H2_STAFF)).toHaveLength(0);
    } finally {
      await revokeRoleScopes(db, scopes);
      await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [MR_ROLE]);
      await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [MR_ROLE]);
    }
  });

  it("refuses a hotel the contract does not cover (400) and another vendor's contract (404)", async () => {
    const notCovered = await assignHotel(B, { hotelId: IDS.hotels.B1 });
    expect(notCovered.status).toBe(400);
    expect(notCovered.body.status).toBe(0);
    const foreign = await assignHotel(B, { subjectId: foreignContractId });
    expect(foreign.status).toBe(404);
    const noHotel = await (await httpClient(HQ))
      .post(`${BASE}/routing/assign`)
      .send({ subject_type: "ARC_HOTEL", subject_id: contractId, assignee_vendor_id: B });
    expect(noHotel.status).toBe(400);
  });

  it("refuses a hotel whose ordering is paused (409)", async () => {
    await db.none(
      `UPDATE tbl_arc_contract_line_hotel SET is_suspended = true WHERE hotel_id = $1 AND arc_contract_line_id = ANY($2::bigint[])`,
      [H1, lineIds]
    );
    const res = await assignHotel(B);
    expect(res.status).toBe(409);
  });

  it("lists every covered hotel without a live row in the admin's routing queue", async () => {
    await routeTo(B);
    const admin = await httpClient(HQ);
    const res = await admin.get(`${BASE}/routing/queue`);
    expect(res.status).toBe(200);
    const mine = res.body.data.unrouted.filter((u) => u.subject_type === "ARC_HOTEL" && u.subject_id === contractId);
    expect(mine.map((u) => u.hotel_id).sort()).toEqual([A1, H2].sort());
    expect(mine[0]).toMatchObject({ category_id: TEST_CATEGORIES.beverages });
    expect(res.body.data.unrouted.some((u) => u.subject_id === foreignContractId)).toBe(false);
  });
});

describe("call-offs follow the accepted fulfilment", () => {
  it("issues H1's call-off to B and H2's to the principal", async () => {
    await routeTo(B);
    const h1 = await releaseCallOff(H1);
    expect(h1.finalized_vendor_id).toBe(B);
    const h2 = await releaseCallOff(H2);
    expect(h2.finalized_vendor_id).toBe(HQ);
  });

  it("reassigning H1 to C supersedes B once C accepts; B's earlier PO keeps B", async () => {
    const first = await routeTo(B);
    const poB = await releaseCallOff(H1);

    const second = await assignHotel(C);
    expect(second.status).toBe(201);
    // While C has not accepted, B still fulfils.
    expect(await fulfilling(H1)).toEqual([B, B]);
    expect((await accept(C, second.body.data.id)).status).toBe(200);

    const statuses = await db.any(`SELECT id, status FROM tbl_vendor_routing_assignments WHERE id = ANY($1::int[]) ORDER BY id`, [
      [first, second.body.data.id],
    ]);
    expect(statuses.map((r) => r.status)).toEqual(["SUPERSEDED", "ACCEPTED"]);
    expect(await fulfilling(H1)).toEqual([C, C]);
    expect((await db.one(`SELECT finalized_vendor_id FROM tbl_rfq_purchase_order WHERE id = $1`, [poB.id])).finalized_vendor_id).toBe(B);
    // Supersede is not a reset: the buyer heard about B, then C, and never "back to HQ".
    const told = (await notices(CREATOR)).map((n) => n.additional_data.fulfilling_vendor_id);
    expect(told).toEqual([B, C]);

    expect((await releaseCallOff(H1)).finalized_vendor_id).toBe(C);
  });

  it("removing C revokes its assignment, hands H1 back to the principal and tells the buyer", async () => {
    const id = await routeTo(C);
    const admin = await httpClient(HQ);
    const res = await admin.delete(`${BASE}/entities/${C}`);
    expect(res.status).toBe(200);
    expect((await db.one(`SELECT status FROM tbl_vendor_routing_assignments WHERE id = $1`, [id])).status).toBe("REVOKED");
    expect(await fulfilling(H1)).toEqual([null, null]);
    const told = (await notices(CREATOR)).map((n) => n.additional_data.fulfilling_vendor_id);
    expect(told).toEqual([C, HQ]);
    expect((await releaseCallOff(H1)).finalized_vendor_id).toBe(HQ);
  });

  it("an admin revoke of an ACCEPTED row also resets H1; declining a PENDING one changes nothing", async () => {
    const pending = await assignHotel(D);
    const dClient = await httpClient(D);
    const declined = await dClient
      .post(`${BASE}/routing/${pending.body.data.id}/respond`)
      .send({ decision: "DECLINE", reason: "NO_STOCK" });
    expect(declined.status).toBe(200);
    expect(await fulfilling(H1)).toEqual([null, null]);
    expect(await notices(CREATOR)).toHaveLength(0);

    const id = await routeTo(B);
    const admin = await httpClient(HQ);
    expect((await admin.post(`${BASE}/routing/${id}/revoke`)).status).toBe(200);
    expect(await fulfilling(H1)).toEqual([null, null]);
  });
});

describe("the fulfilment member's view of the contract", () => {
  it("B sees only H1, with H1's own quantities, and viewer_role", async () => {
    await routeTo(B);
    await releaseCallOff(H2); // the principal's call-off at another hotel
    const own = await releaseCallOff(H1);
    const client = await httpClient(B);
    const res = await client.get(`${ARC_V}/vendor/contracts/${contractId}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.viewer_role).toBe("fulfilment_member");
    expect(d.hotels.map((h) => h.hotel_id)).toEqual([H1]);
    expect(d.lines).toHaveLength(2);
    for (const line of d.lines) {
      expect(line.hotels.map((h) => h.hotel_id)).toEqual([H1]);
      expect(Number(line.committed_qty)).toBe(350);
      expect(Number(line.consumed_qty)).toBe(10);
    }
    expect(d.callOffs.map((c) => c.po_id)).toEqual([own.id, own.id]);
    expect(d.amendments).toEqual([]);
    expect(d.clarifications).toEqual([]);
    expect(d.contract.document_s3_url).toBeNull();
    expect(d.arc.hotel_name).toBeNull(); // the lead hotel (A1) is not B's
    expect(d.arc).not.toHaveProperty("lead_hotel_id");
  });

  it("the principal's response is unchanged (no viewer_role, every hotel)", async () => {
    await routeTo(B);
    const res = await (await httpClient(HQ)).get(`${ARC_V}/vendor/contracts/${contractId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty("viewer_role");
    expect(res.body.data.hotels.map((h) => h.hotel_id).sort()).toEqual([A1, A2, A3].sort());
  });

  it("B may not sign, decline, clarify or amend; a sibling and a superseded member see nothing", async () => {
    await routeTo(B);
    const b = await httpClient(B);
    expect((await b.post(`${ARC_V}/vendor/contracts/${contractId}/otp/request`).send({})).status).toBe(403);
    expect((await b.post(`${ARC_V}/vendor/contracts/${contractId}/otp/verify`).send({ code: "123456" })).status).toBe(403);
    expect((await b.post(`${ARC_V}/vendor/contracts/${contractId}/decline`).send({ reason: "x" })).status).toBe(403);
    expect(
      (
        await b.post(`${ARC_V}/vendor/contracts/${contractId}/clarification`).send({
          items: [{ arc_contract_line_id: lineIds[0], field: "base_price", comment: "too low" }],
        })
      ).status
    ).toBe(403);
    expect(
      (
        await b.post(`${ARC_V}/amendments/request`).send({
          arc_contract_id: contractId,
          amendment_type: "price",
          amendment_from: new Date().toISOString().slice(0, 10),
          amendment_to: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
          reason: "costs",
          payload: { arc_contract_line_id: lineIds[0], new_rate: 95 },
        })
      ).status
    ).toBe(403);
    expect((await db.one(`SELECT status FROM tbl_arc_contract WHERE id = $1`, [contractId])).status).toBe("active");

    const d = await httpClient(D);
    expect((await d.get(`${ARC_V}/vendor/contracts/${contractId}`)).status).toBe(403);

    const c = await assignHotel(C);
    await accept(C, c.body.data.id);
    expect((await b.get(`${ARC_V}/vendor/contracts/${contractId}`)).status).toBe(403);
  });

  it("lists the contract for B as a fulfilment contract, with H1 figures only, and once for HQ", async () => {
    await routeTo(B);
    await releaseCallOff(H2);
    await releaseCallOff(H1);
    const b = await (await httpClient(B)).get(`${ARC_V}/vendor/active`);
    expect(b.status).toBe(200);
    const row = b.body.data.contracts.find((r) => Number(r.id) === contractId);
    expect(row).toMatchObject({ viewer_role: "fulfilment_member", hotel_id: H1, call_off_count: 2 });
    expect(row.fulfilment_hotel_ids).toEqual([H1]);
    expect(Number(row.committed_value)).toBe(90 * 350 * 2);
    expect(row.document_s3_url).toBeNull();

    const hq = await (await httpClient(HQ)).get(`${ARC_V}/vendor/active`);
    const rows = hq.body.data.contracts.filter((r) => Number(r.id) === contractId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("viewer_role");
  });

  it("B's vendor PO list and detail show its call-off, and B can accept it", async () => {
    await routeTo(B);
    const po = await releaseCallOff(H1);
    const b = await httpClient(B);
    const list = await b.post(`/api/v1/po/vendor/list-view`).send({ tab: "all", page: 1, limit: 50 });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body.data)).toContain(`"${po.po_number}"`);
    const detail = await b.get(`/api/v1/po/vendor/detail/${po.id}`);
    expect(detail.status).toBe(200);
    expect((await (await httpClient(D)).get(`/api/v1/po/vendor/detail/${po.id}`)).status).not.toBe(200);

    const acc = await b.post(`/api/v1/po/accept/${po.id}`).send({});
    expect(acc.status).toBe(200);
    expect((await db.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id = $1`, [po.id])).status).toBe("approved");
  });
});

describe("network operate gate on the ARC negotiation quote", () => {
  it("a SUSPENDED member entity is refused before the controller runs", async () => {
    await db.none(`UPDATE tbl_vendor_org_entities SET status = 'SUSPENDED' WHERE org_id = $1 AND vendor_id = $2`, [ORG, D]);
    const d = await httpClient(D);
    const res = await d.post(`${ARC_V}/vendor/negotiation/rounds/999999999/quote`).send({});
    expect(res.status).toBe(403);
  });
});

describe("fix round 1", () => {
  it("refuses a single-hotel (non-group) contract with GROUP_ARC_ONLY", async () => {
    await db.none(`UPDATE tbl_arc SET is_group = false WHERE id = $1`, [arcId]);
    const res = await assignHotel(B);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      status: 0,
      reason: "GROUP_ARC_ONLY",
      message: "Fulfilment routing is available for group rate contracts only",
    });
  });

  it("an accepted member sees nothing in pending-acceptance; the principal still does", async () => {
    await routeTo(B);
    await db.none(`UPDATE tbl_arc_contract SET status = 'awaiting_acceptance', signed_by_vendor_at = NULL WHERE id = $1`, [contractId]);
    const b = await (await httpClient(B)).get(`${ARC_V}/vendor/pending-acceptance`);
    expect(b.status).toBe(200);
    expect(b.body.data.contracts.some((r) => Number(r.id) === contractId)).toBe(false);
    const hq = await (await httpClient(HQ)).get(`${ARC_V}/vendor/pending-acceptance`);
    expect(hq.body.data.contracts.filter((r) => Number(r.id) === contractId)).toHaveLength(1);
  });

  it("the member's dashboard value rollups leave fulfilment contracts out", async () => {
    await routeTo(B);
    const res = await (await httpClient(B)).get(`${ARC_V}/vendor/dashboard`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals.awarded_value).toBe(0);
    expect(res.body.data.spend_by_category).toEqual([]);
    expect(res.body.data.spend_by_bu).toEqual([]);
    const hq = await (await httpClient(HQ)).get(`${ARC_V}/vendor/dashboard`);
    expect(hq.body.data.totals.awarded_value).toBe(90 * 1000 * 2);
  });

  it("the member may not request, verify or decline the principal's addendum OTP", async () => {
    await routeTo(B);
    const am = await db.one(
      `INSERT INTO tbl_arc_amendment (arc_contract_id, amendment_type, amendment_from, status, reason, requested_by)
       VALUES ($1, 'term', CURRENT_DATE, 'approved', 'terms', $2) RETURNING id`,
      [contractId, HQ]
    );
    const doc = await db.one(
      `INSERT INTO tbl_arc_amendment_document (arc_amendment_id, arc_contract_id, addendum_number)
       VALUES ($1, $2, 1) RETURNING id`,
      [am.id, contractId]
    );
    const b = await httpClient(B);
    expect((await b.post(`${ARC_V}/vendor/addendums/${doc.id}/otp/request`).send({})).status).toBe(403);
    expect((await b.post(`${ARC_V}/vendor/addendums/${doc.id}/otp/verify`).send({ code: "123456" })).status).toBe(403);
    expect((await b.post(`${ARC_V}/vendor/addendums/${doc.id}/decline`).send({ reason: "no" })).status).toBe(403);
    expect((await db.one(`SELECT status FROM tbl_arc_amendment_document WHERE id = $1`, [doc.id])).status).toBe("awaiting_signature");
  });

  it("a regenerated contract line's new H1 row inherits the accepted member", async () => {
    await routeTo(B);
    const variant = (await db.one(`SELECT id FROM tbl_product_variant WHERE id <> ALL($1::int[]) ORDER BY id LIMIT 1`, [VARIANTS])).id;
    const item = await db.one(`INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 100, 'pcs') RETURNING id`, [arcId, variant]);
    const fresh = await db.tx(async (t) => {
      const line = await arcContractModel.addLine(contractId, { arc_item_id: item.id, unit_rate: 50, committed_qty: 100 }, t);
      await arcHotelModel.syncContractLineHotels(line.id, [{ hotel_id: H1, allocated_qty: 60 }, { hotel_id: H2, allocated_qty: 40 }], t);
      return Number(line.id);
    });
    const rows = await db.any(
      `SELECT hotel_id, fulfilling_vendor_id FROM tbl_arc_contract_line_hotel WHERE arc_contract_line_id = $1 ORDER BY hotel_id`,
      [fresh]
    );
    expect(rows).toEqual([
      { hotel_id: H1, fulfilling_vendor_id: B },
      { hotel_id: H2, fulfilling_vendor_id: null },
    ]);
  });

  it("a call-off never reaches a member suspended before its revoke ran", async () => {
    await routeTo(B);
    // The entity status write alone, as committed before the after-commit revoke.
    await db.none(`UPDATE tbl_vendor_org_entities SET status = 'SUSPENDED' WHERE org_id = $1 AND vendor_id = $2`, [ORG, B]);
    expect(await fulfilling(H1)).toEqual([B, B]);
    expect((await releaseCallOff(H1)).finalized_vendor_id).toBe(HQ);
  });

  it("the member's lines carry its hotel's rate override and no amendment fields", async () => {
    await routeTo(B);
    await db.none(
      `UPDATE tbl_arc_contract_line_hotel SET unit_rate_override = 80 WHERE hotel_id = $1 AND arc_contract_line_id = $2`,
      [H1, lineIds[0]]
    );
    const res = await (await httpClient(B)).get(`${ARC_V}/vendor/contracts/${contractId}`);
    expect(res.status).toBe(200);
    const [first, second] = res.body.data.lines;
    expect(Number(first.effective_unit_rate)).toBe(80);
    expect(first.hotels[0]).toMatchObject({ hotel_id: H1, unit_rate_override: 80, effective_unit_rate: 80 });
    expect(Number(second.effective_unit_rate)).toBe(90);
    for (const line of res.body.data.lines) {
      for (const f of ["amendment_id", "amendment_type", "amendment_effective_from", "amendment_effective_to"]) {
        expect(line).not.toHaveProperty(f);
      }
    }
  });

  it("the member view is refused on a declined contract", async () => {
    await routeTo(B);
    await db.none(`UPDATE tbl_arc_contract SET status = 'declined' WHERE id = $1`, [contractId]);
    expect((await (await httpClient(B)).get(`${ARC_V}/vendor/contracts/${contractId}`)).status).toBe(403);
  });

  it("suspending B through the entity API resets H1, tells the buyer and closes B's view", async () => {
    const id = await routeTo(B);
    const res = await (await httpClient(HQ)).patch(`${BASE}/entities/${B}`).send({ status: "SUSPENDED" });
    expect(res.status).toBe(200);
    const row = await db.one(`SELECT status FROM tbl_vendor_routing_assignments WHERE id = $1`, [id]);
    expect(row.status).toBe("REVOKED");
    expect(await fulfilling(H1)).toEqual([null, null]);
    expect((await notices(CREATOR)).map((n) => n.additional_data.fulfilling_vendor_id)).toEqual([B, HQ]);
    expect((await (await httpClient(B)).get(`${ARC_V}/vendor/contracts/${contractId}`)).status).toBe(403);
  });
});
