// Vendor Networks: HQ network dashboard API (spec §8). Fixture ids 95941..95959.
//
// World: HQ's org holds B and C (ACTIVE) and R (REMOVED); FB is another org's principal
// with an entity of its own. HQ holds an ACTIVE group contract on A1/A2/A3. POs and
// assignments are setup inserts; everything asserted goes through the HTTP API.

import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import { deleteArcs } from "../helpers/arcGroupSeed.js";
import { seedVendorEntity, seedPerson, seedOrg, addEntity, addMember, cleanupVendorNetworkFixtures } from "../helpers/vendorNetworkSeed.js";

const HQ = 95941;
const B = 95942;
const C = 95943;
const R = 95944; // REMOVED from HQ's org
const MP = 95945; // ENTITY_MEMBER person of B
const FHQ = 95946;
const FB = 95947;
const ORG = 95941;
const F_ORG = 95942;
const BASE = "/api/v1/vendor-network/dashboard";

const { A1, A2, A3 } = IDS.hotels;
const HC_A = IDS.hospitality.A;
const PROC = IDS.departments.proc;
const CREATOR = IDS.users.companyA_admin;

let arcId;
let contractId;
let foreignArcId;
let rfqId; // RFQ at A1: the hotel of every RFQ PO
let mrId; // requisition at A2: the ordering hotel of every call-off

beforeEach(async () => {
  for (const id of [HQ, B, C, R, FHQ, FB]) {
    await seedVendorEntity({ id, companyId: id, name: `VN Dash ${id}`, email: `vn-dash-${id}@example.com` });
  }
  rfqId = (await makeRFQ(db, { createdBy: IDS.users.a1_proc_buyer })).rfq_id;
  mrId = Number(
    (
      await db.one(
        `INSERT INTO tbl_material_requisition (mr_number, title, hospitality_company_id, hotel_id, department_id, status, raised_by)
         VALUES ('MR-VN-DASH-' || floor(random() * 1e9)::text, 'Dash', $1, $2, $3, 'approved', $4) RETURNING id`,
        [HC_A, A2, PROC, CREATOR]
      )
    ).id
  );
  await seedOrg({ id: ORG, principalVendorId: HQ, name: "Dash HQ Network" });
  await addEntity({ orgId: ORG, vendorId: B });
  await addEntity({ orgId: ORG, vendorId: C });
  await addEntity({ orgId: ORG, vendorId: R, status: "REMOVED", withSeat: false });
  await seedPerson({ id: MP, email: "vn-dash-member@example.com", name: "Dash Member" });
  await addMember({ orgId: ORG, personId: MP, entityVendorId: B, role: "ENTITY_MEMBER" });
  await seedOrg({ id: F_ORG, principalVendorId: FHQ, name: "Dash Foreign Network" });
  await addEntity({ orgId: F_ORG, vendorId: FB });
  // Membership periods: linked a month ago; R's period runs past every PO a test creates (tests that need an earlier exit set it).
  await db.none(`UPDATE tbl_vendor_org_entities SET linked_at = now() - interval '30 days' WHERE vendor_id <> ALL($1::int[])`, [[HQ, FHQ]]);
  await db.none(`UPDATE tbl_vendor_org_entities SET removed_at = now() + interval '1 hour' WHERE vendor_id = $1`, [R]);
});

afterEach(async () => {
  await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE po_number LIKE 'VN-DASH-%'`);
  await db.none(`DELETE FROM tbl_material_requisition WHERE id = $1`, [mrId]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = $1`, [rfqId]);
  for (const id of [arcId, foreignArcId].filter(Boolean)) {
    await db.none(`DELETE FROM tbl_arc_hotel_mappings WHERE arc_id = $1`, [id]);
    await deleteArcs([id]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [id]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [id]);
  }
  arcId = contractId = foreignArcId = null;
  await cleanupVendorNetworkFixtures();
});

afterAll(async () => {
  await closeDb();
});

let seq = 0;
async function po(vendorId, { status = "approved", total = 100, ago = 0, arcContractId = null, callOff = false } = {}) {
  seq += 1;
  return db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id, total_value,
        quote_id, initiated_by, created_at, rfq_id, arc_contract_id, source_mr_id, is_call_off)
     VALUES ($1, $2, $3, ARRAY[]::int[], 1, $4, $5, $4, ARRAY[]::int[], $6, NOW() - make_interval(mins => $7), $8, $9, $10, $11)
     RETURNING id`,
    [IDS.companies.A, `VN-DASH-${seq}`, status, total, vendorId, CREATOR, ago,
     callOff ? null : rfqId, callOff ? arcContractId : null, callOff ? mrId : null, callOff]
  );
}

async function groupContract(vendorId, hotels = [A1, A2, A3]) {
  const id = Number(
    (
      await db.one(
        `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
                              status, is_group, contract_start_at, contract_end_at, created_by)
         VALUES ('ARC-VN-DASH-' || floor(random() * 1e9)::text, 'Dash linen', $1, $2, $3, $4,
                 'contract_active', true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '300 days', $5)
         RETURNING id`,
        [TEST_CATEGORIES.beverages, HC_A, A1, PROC, CREATOR]
      )
    ).id
  );
  await db.none(`INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id) SELECT $1, h FROM unnest($2::int[]) h`, [id, hotels]);
  const variant = (await db.one(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`)).id;
  const itemId = (await db.one(`INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 100, 'pcs') RETURNING id`, [id, variant])).id;
  const cId = Number(
    (await db.one(`INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, signed_by_vendor_at) VALUES ($1, $2, 'active', NOW()) RETURNING id`, [id, vendorId])).id
  );
  const lineId = Number(
    (await db.one(`INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty) VALUES ($1, $2, 90, 5, 100) RETURNING id`, [cId, itemId])).id
  );
  for (const h of hotels) {
    await db.none(`INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty) VALUES ($1, $2, 30)`, [lineId, h]);
  }
  return { arcId: id, contractId: cId, lineId };
}

const assignment = (vendorId, hotelId, status, { actedAgoDays = 0, subject = contractId } = {}) =>
  db.none(
    `INSERT INTO tbl_vendor_routing_assignments (org_id, subject_type, subject_id, hotel_id, assigned_vendor_id, status, acted_at)
     VALUES ($1, 'ARC_HOTEL', $2, $3, $4, $5, NOW() - make_interval(days => $6))`,
    [ORG, subject, hotelId, vendorId, status, actedAgoDays]
  );

describe("GET /dashboard/summary", () => {
  it("counts entities, routing and POs correctly across two entities", async () => {
    ({ arcId, contractId } = await groupContract(HQ));
    await po(B, { status: "approved" });
    await po(B, { status: "sent" });
    await po(B, { status: "completed" });
    await po(C, { status: "pending_approval" });
    await po(R, { status: "approved" }); // removed entity: counted in the PO status totals only
    await po(FB, { status: "approved" }); // another org: never counted
    await assignment(B, A2, "ACCEPTED");
    await assignment(C, A3, "PENDING");
    await assignment(B, A1, "DECLINED");
    await assignment(C, A1, "TIMED_OUT");
    await assignment(C, A1, "DECLINED", { actedAgoDays: 10 });

    const res = await (await httpClient(HQ)).get(`${BASE}/summary`);
    expect(res.status).toBe(200);
    const { entities, routing, pos } = res.body.data;
    expect(entities.map((e) => e.vendor_id)).toEqual([HQ, B, C]);
    const byId = Object.fromEntries(entities.map((e) => [e.vendor_id, e]));
    expect(byId[HQ]).toMatchObject({ relationship: "PRINCIPAL", status: "ACTIVE", seat: null, live_assignments: 0, open_pos: 0 });
    expect(byId[B]).toMatchObject({ name: `VN Dash ${B}`, relationship: "BRANCH", status: "ACTIVE", live_assignments: 1, open_pos: 2 });
    expect(byId[B].seat).toMatchObject({ status: "active" });
    expect(byId[B].seat.end_date).toBeTruthy();
    expect(byId[C]).toMatchObject({ live_assignments: 1, open_pos: 1 });
    expect(routing).toEqual({ unrouted: 1, pending: 1, declined_7d: 1, timed_out_7d: 1 });
    expect(pos.by_status).toEqual({ approved: 2, sent: 1, completed: 1, pending_approval: 1 });
  });

  it("runs a bounded number of queries however many entities the org has", async () => {
    const count = async () => {
      const calls = [];
      const spy = (await import("../../app/config/dbConn.js")).default;
      const orig = spy.any.bind(spy);
      const origOne = spy.one.bind(spy);
      spy.any = (...a) => (calls.push(1), orig(...a));
      spy.one = (...a) => (calls.push(1), origOne(...a));
      try {
        expect((await (await httpClient(HQ)).get(`${BASE}/summary`)).status).toBe(200);
      } finally {
        spy.any = orig;
        spy.one = origOne;
      }
      return calls.length;
    };
    const before = await count();
    expect(before).toBeGreaterThan(3); // the spy sees the queries
    for (let i = 0; i < 4; i++) {
      const id = 95950 + i;
      await seedVendorEntity({ id, companyId: id, name: `VN Dash ${id}`, email: `vn-dash-${id}@example.com` });
      await addEntity({ orgId: ORG, vendorId: id });
      await po(id);
    }
    expect(await count()).toBe(before);
  });

  it("answers 403 to a non-admin member", async () => {
    const res = await (await httpClient(MP)).get(`${BASE}/summary`);
    expect(res.status).toBe(403);
  });
});

describe("GET /dashboard/pos", () => {
  it("lists active and removed entities' POs and the principal's own, never another org's", async () => {
    ({ arcId, contractId } = await groupContract(HQ));
    const own = await po(HQ, { status: "approved", total: 500, ago: 1, arcContractId: contractId, callOff: true });
    const b1 = await po(B, { ago: 5 });
    const r1 = await po(R, { status: "completed", ago: 9 });
    await po(FB);

    const res = await (await httpClient(HQ)).get(`${BASE}/pos`);
    expect(res.status).toBe(200);
    const { items, total, page, page_size } = res.body.data;
    expect(items.map((i) => i.id)).toEqual([own.id, b1.id, r1.id]);
    expect(total).toBe(3);
    expect([page, page_size]).toEqual([1, 25]);
    expect(items[0]).toMatchObject({
      entity_vendor_id: HQ,
      entity_name: `VN Dash ${HQ}`,
      hotel_name: "Hotel A-2",
      status: "approved",
      amount: 500,
      is_call_off: true,
    });
    expect(items[0].po_number).toMatch(/^VN-DASH-/);
    expect(items[0].created_at).toBeTruthy();
    expect(items[2]).toMatchObject({ entity_vendor_id: R, status: "completed", is_call_off: false });
  });

  it("filters by entity and status; a foreign or unknown entity is 404", async () => {
    const b1 = await po(B, { status: "approved" });
    await po(B, { status: "sent" });
    await po(C);
    const admin = await httpClient(HQ);
    const byEntity = await admin.get(`${BASE}/pos?entity_vendor_id=${B}`);
    expect(byEntity.body.data.items).toHaveLength(2);
    expect(byEntity.body.data.items.every((i) => i.entity_vendor_id === B)).toBe(true);
    const byStatus = await admin.get(`${BASE}/pos?entity_vendor_id=${B}&status=approved`);
    expect(byStatus.body.data.items.map((i) => i.id)).toEqual([b1.id]);

    expect((await admin.get(`${BASE}/pos?entity_vendor_id=${FB}`)).status).toBe(404);
    expect((await admin.get(`${BASE}/pos?entity_vendor_id=${FHQ}`)).status).toBe(404);
    expect((await admin.get(`${BASE}/pos?entity_vendor_id=99999999`)).status).toBe(404);
    expect((await admin.get(`${BASE}/pos?entity_vendor_id=abc`)).status).toBe(400);
  });

  it("still lists a removed entity's POs when filtered to it", async () => {
    const r1 = await po(R, { status: "completed" });
    const res = await (await httpClient(HQ)).get(`${BASE}/pos?entity_vendor_id=${R}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i) => i.id)).toEqual([r1.id]);
  });

  it("clamps page_size 500 to 100, and pages newest first with id as the tie-break", async () => {
    for (let i = 0; i < 105; i++) await po(B, { ago: 0 });
    const admin = await httpClient(HQ);
    const big = await admin.get(`${BASE}/pos?page_size=500`);
    expect(big.status).toBe(200);
    expect(big.body.data.page_size).toBe(100);
    expect(big.body.data.items).toHaveLength(100);
    expect(big.body.data.total).toBe(105);
    const ids = big.body.data.items.map((i) => i.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const p2 = await admin.get(`${BASE}/pos?page_size=100&page=2`);
    expect(p2.body.data.items).toHaveLength(5);
    expect(Math.max(...p2.body.data.items.map((i) => i.id))).toBeLessThan(Math.min(...ids));
  });

  it("answers 403 to a non-admin member", async () => {
    expect((await (await httpClient(MP)).get(`${BASE}/pos`)).status).toBe(403);
  });
});

describe("membership periods bound the POs an org sees", () => {
  const ids = async (client, query = "") => (await client.get(`${BASE}/pos${query}`)).body.data.items.map((i) => i.id);

  it("a PO from before the branch was linked is not in the org list; one after is", async () => {
    await db.none(`UPDATE tbl_vendor_org_entities SET linked_at = now() - interval '1 hour' WHERE vendor_id = $1`, [C]);
    const before = await po(C, { ago: 120 });
    const after = await po(C, { ago: 30 });
    const admin = await httpClient(HQ);
    expect(await ids(admin)).toEqual([after.id]);
    expect(before.id).toBeDefined();
    const summary = (await admin.get(`${BASE}/summary`)).body.data;
    expect(summary.pos.by_status).toEqual({ approved: 1 });
    expect(summary.entities.find((e) => e.vendor_id === C).open_pos).toBe(1);
  });

  it("a vendor moved from one org to another: new POs show only in the new org, old ones keep their history", async () => {
    const X = 95953;
    await seedVendorEntity({ id: X, companyId: X, name: `VN Dash ${X}`, email: `vn-dash-${X}@example.com` });
    await addEntity({ orgId: ORG, vendorId: X, status: "REMOVED", withSeat: false });
    await db.none(
      `UPDATE tbl_vendor_org_entities SET linked_at = now() - interval '30 days', removed_at = now() - interval '2 days'
        WHERE org_id = $1 AND vendor_id = $2`,
      [ORG, X]
    );
    await addEntity({ orgId: F_ORG, vendorId: X });
    await db.none(`UPDATE tbl_vendor_org_entities SET linked_at = now() - interval '2 days' WHERE org_id = $1 AND vendor_id = $2`, [F_ORG, X]);
    const old = await po(X, { ago: 3 * 1440 }); // inside the first membership (history, kept)
    const moved = await po(X, { ago: 1440 }); // after the move

    const hq = await httpClient(HQ);
    const fhq = await httpClient(FHQ);
    expect(await ids(hq)).toEqual([old.id]);
    expect(await ids(fhq)).toEqual([moved.id]);
    expect(await ids(hq, `&entity_vendor_id=${X}`.replace("&", "?"))).toEqual([old.id]);
    expect((await hq.get(`${BASE}/summary`)).body.data.pos.by_status).toEqual({ approved: 1 });
    expect((await fhq.get(`${BASE}/summary`)).body.data.pos.by_status).toEqual({ approved: 1 });
  });

  it("a PO inside the period is still listed after the entity is removed; one after removal is not", async () => {
    const inside = await po(R, { ago: 60 });
    await db.none(`UPDATE tbl_vendor_org_entities SET removed_at = now() - interval '10 minutes' WHERE vendor_id = $1`, [R]);
    await po(R, { ago: 5 });
    expect(await ids(await httpClient(HQ))).toEqual([inside.id]);
  });
});

describe("GET /dashboard/contracts", () => {
  it("shows the principal's contracts with the effective supplier per hotel", async () => {
    ({ arcId, contractId } = await groupContract(HQ));
    const foreign = await groupContract(FHQ);
    foreignArcId = foreign.arcId;
    // B fulfils A2 (ACCEPTED, ACTIVE entity); R fulfils A3 but was removed: the principal supplies A3.
    await db.none(
      `UPDATE tbl_arc_contract_line_hotel SET fulfilling_vendor_id = CASE hotel_id WHEN $2 THEN $3::int ELSE $4::int END
        WHERE arc_contract_line_id IN (SELECT id FROM tbl_arc_contract_line WHERE arc_contract_id = $1) AND hotel_id IN ($2, $5)`,
      [contractId, A2, B, R, A3]
    );
    await assignment(B, A2, "ACCEPTED");
    await assignment(C, A1, "DECLINED");

    const res = await (await httpClient(HQ)).get(`${BASE}/contracts`);
    expect(res.status).toBe(200);
    const { items, total } = res.body.data;
    expect(total).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ contract_id: contractId, arc_id: arcId, status: "active", is_group: true });
    const byHotel = Object.fromEntries(items[0].hotels.map((h) => [h.hotel_id, h]));
    expect(byHotel[A1]).toMatchObject({ fulfilling_vendor_id: HQ, fulfilling_name: `VN Dash ${HQ}`, assignment_status: "DECLINED" });
    expect(byHotel[A2]).toMatchObject({ fulfilling_vendor_id: B, fulfilling_name: `VN Dash ${B}`, assignment_status: "ACCEPTED" });
    expect(byHotel[A3]).toMatchObject({ fulfilling_vendor_id: HQ, assignment_status: null });
    expect(byHotel[A1].hotel_name).toEqual(expect.any(String));
  });

  it("answers 403 to a non-admin member", async () => {
    expect((await (await httpClient(MP)).get(`${BASE}/contracts`)).status).toBe(403);
  });
});
