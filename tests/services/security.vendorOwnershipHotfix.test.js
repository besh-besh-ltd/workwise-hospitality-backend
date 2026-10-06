// Ownership checks on four vendor-facing write paths (P1, 2026-10-06).
//
// Every one of these took the target from the request and never asked whose it
// was, so any logged-in vendor could act on another vendor's data:
//
//   1. POST /arc-v2/amendments/request   - raised an amendment on ANY contract id
//   2. POST /users/add-spoc              - body.vendor_id decided whose SPOC list grew
//   3. /users/*-buyer-vendor-location, /users/map-spoc-location
//                                        - company_id from the body, no check on the
//                                          location/SPOC row being updated, deleted or mapped
//   4. POST /rfq/clarification/raise     - any vendor could freeze quoting on any RFQ
//
// The rules these tests pin:
//   - A foreign id is a visible 403 (never silently rewritten) and nothing changes.
//   - The owner keeps working (positive case beside every negative one).
//   - Internal-console callers (jwtAdm, `is_internal_admin`) keep their old
//     behaviour on the shared location / SPOC-map handlers, mounted under
//     /admin/vendor/*.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";
import { loginAsInternalStaff, stampAdmin } from "../helpers/auth.js";
import { buildTestApp } from "../setup/app.js";
import request from "supertest";
import { makeRFQ } from "../factories/rfq.js";
import { attachVendorToRfqProduct } from "../factories/techEval.js";
import { ensureArcApprovable } from "../helpers/arcApproverPerms.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";

const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
// Fixtures already list alpha and beta as company A's preferred vendors, so the
// buyer relationship tests use gamma, which no buyer company is related to.
const VENDOR_G = IDS.users.vendor_gamma;
const BUYER = IDS.users.a1_proc_buyer;
const APPROVER = IDS.users.a1_proc_techApp;
const STAFF = IDS.users.superAdmin;
const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;
const POLICY_ID = 64902; // outside the fixtures' 60001..60099 range and the amendment flow suite's 64901
const PRODUCT_VARIANT = 1;

// Fixture users leave user_type NULL; these paths branch on it.
const PERSONAS = { [VENDOR_A]: 3, [VENDOR_B]: 3, [VENDOR_G]: 3, [BUYER]: 2, [APPROVER]: 2 };
let originalUserTypes = [];
let staffOriginalType;
let companyA;
let companyB;
let companyBuyer;
let companyG;

beforeAll(async () => {
  originalUserTypes = await db.any(
    `SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`,
    [Object.keys(PERSONAS).map(Number)]
  );
  for (const [id, userType] of Object.entries(PERSONAS)) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [Number(id), userType]);
  }
  staffOriginalType = await stampAdmin(STAFF, 1);
  companyA = (await db.one(`SELECT company_id FROM tbl_users WHERE id = $1`, [VENDOR_A])).company_id;
  companyB = (await db.one(`SELECT company_id FROM tbl_users WHERE id = $1`, [VENDOR_B])).company_id;
  companyG = (await db.one(`SELECT company_id FROM tbl_users WHERE id = $1`, [VENDOR_G])).company_id;
  companyBuyer = (await db.one(`SELECT company_id FROM tbl_users WHERE id = $1`, [BUYER])).company_id;
  expect(companyA).not.toBe(companyB);
});

afterAll(async () => {
  for (const { id, user_type } of originalUserTypes) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [id, user_type]);
  }
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [STAFF, staffOriginalType]);
  await closeDb();
});

// ---------------------------------------------------------------------------
// 1. ARC amendment request
// ---------------------------------------------------------------------------
describe("POST /arc-v2/amendments/request - contract ownership", () => {
  const REQUEST = "/api/v1/arc-v2/amendments/request";
  let arcId, contractId, lineId;

  const dIso = (offsetDays) => {
    const d = new Date(Date.now() + offsetDays * 86400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const body = () => ({
    arc_contract_id: contractId,
    amendment_type: "price",
    amendment_from: dIso(1),
    amendment_to: dIso(90),
    reason: "Input cost increase",
    payload: { arc_contract_line_id: lineId, new_rate: 120 },
  });
  const amendmentCount = async () =>
    (await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_amendment WHERE arc_contract_id = $1`, [contractId])).n;

  const sideEffects = async () => ({
    events: (await db.one(`SELECT COUNT(*)::int AS n FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId])).n,
    instances: (await db.one(
      `SELECT COUNT(*)::int AS n FROM tbl_approval_instances WHERE entity_type = 'ARC_AMENDMENT'
        AND entity_id IN (SELECT id FROM tbl_arc_amendment WHERE arc_contract_id = $1)`, [contractId])).n,
    notifications: (await db.one(`SELECT COUNT(*)::int AS n FROM tbl_notifications`)).n,
  });

  beforeAll(async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by)
       VALUES ('ARC-TEST-OWN-1', 'Ownership ARC', $1, $2, $3, $4, $5,
               'contract_active',
               NOW() - INTERVAL '40 days', NOW() - INTERVAL '30 days',
               NOW() - INTERVAL '20 days', (NOW() + INTERVAL '180 days')::date,
               $6) RETURNING id`,
      [TEST_CATEGORIES.beverages, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom)
       VALUES ($1, $2, 500, 'litre') RETURNING id`,
      [arcId, PRODUCT_VARIANT]
    );
    contractId = (await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
      [arcId, VENDOR_A]
    )).id;
    lineId = (await db.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
       VALUES ($1, $2, 100, 5, 500) RETURNING id`,
      [contractId, item.id]
    )).id;
    await db.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id,
          is_active, created_by, process_id, is_master, is_department_scoped, version)
       VALUES ($1, 'ARC_AMENDMENT', $2, $3, NULL, true, $4, $5, false, false, 1)
       ON CONFLICT (id) DO NOTHING`,
      [POLICY_ID, HC, HOTEL, BUYER, PROC]
    );
    await db.none(
      `INSERT INTO tbl_approval_policy_steps
         (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ALL', 'USER', $2)`,
      [POLICY_ID, APPROVER]
    );
    await ensureArcApprovable(db, [APPROVER], HC);
  });

  afterAll(async () => {
    const instanceIds = (await db.any(
      `SELECT approval_instance_id AS id FROM tbl_arc_amendment
        WHERE arc_contract_id = $1 AND approval_instance_id IS NOT NULL`,
      [contractId]
    )).map((r) => r.id);
    await db.none(
      `DELETE FROM tbl_arc_amendment_edit_history
        WHERE arc_amendment_id IN (SELECT id FROM tbl_arc_amendment WHERE arc_contract_id = $1)`,
      [contractId]
    );
    await db.none(`DELETE FROM tbl_arc_amendment WHERE arc_contract_id = $1`, [contractId]);
    if (instanceIds.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(
        `DELETE FROM tbl_approval_step_approvers
          WHERE approval_instance_step_id IN
            (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
        [instanceIds]
      );
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
    }
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [POLICY_ID]);
    await db.none(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  });

  it("rejects another vendor's request on this contract with 403 and creates nothing", async () => {
    const vendorB = await httpClient(VENDOR_B);
    const notificationsBefore = (await sideEffects()).notifications;

    const res = await vendorB.post(REQUEST).send(body());

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("You can only request amendments on your own contracts");
    expect(await amendmentCount()).toBe(0);
    expect(await sideEffects()).toEqual({ events: 0, instances: 0, notifications: notificationsBefore });
  });

  it("lets the contract's own vendor request an amendment", async () => {
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(REQUEST).send(body());

    expect(res.status).toBe(200);
    expect(await amendmentCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. SPOC endpoints
// ---------------------------------------------------------------------------
describe("/users SPOC endpoints - ownership", () => {
  const createdSpocIds = [];
  const spocPayload = (extra = {}) => ({
    spoc_name: "Test Contact",
    spoc_email: `spoc-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`,
    spoc_mobile: "+91-9876543210",
    spoc_role: "sales",
    ...extra,
  });
  const spocsOf = (userId) => db.any(`SELECT id, name FROM tbl_users_spoc WHERE user_id = $1 ORDER BY id`, [userId]);
  async function seedSpoc(userId, name = "Seeded") {
    const row = await db.one(
      `INSERT INTO tbl_users_spoc (name, email, mobile, role, user_id) VALUES ($1, 's@x.test', '+91-9876543210', 'r', $2) RETURNING id`,
      [name, userId]
    );
    createdSpocIds.push(row.id);
    return row.id;
  }

  afterEach(async () => {
    await db.none(`DELETE FROM tbl_users_spoc WHERE user_id = ANY($1::int[])`, [[VENDOR_A, VENDOR_B]]);
    createdSpocIds.length = 0;
  });

  it("add-spoc: a foreign vendor_id is refused with 403 and adds nothing to either vendor", async () => {
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post("/api/v1/users/add-spoc").send(spocPayload({ vendor_id: String(VENDOR_B) }));

    expect(res.status).toBe(403);
    expect(await spocsOf(VENDOR_B)).toEqual([]);
    expect(await spocsOf(VENDOR_A)).toEqual([]);
  });

  it("add-spoc: no vendor_id, or the caller's own, adds to the caller", async () => {
    const vendorA = await httpClient(VENDOR_A);

    const bare = await vendorA.post("/api/v1/users/add-spoc").send(spocPayload());
    const own = await vendorA.post("/api/v1/users/add-spoc").send(spocPayload({ vendor_id: String(VENDOR_A) }));

    expect(bare.status).toBe(200);
    expect(own.status).toBe(200);
    expect(await spocsOf(VENDOR_A)).toHaveLength(2);
    expect(await spocsOf(VENDOR_B)).toEqual([]);
  });

  it("update-spoc / delete-spoc: another vendor's SPOC is refused and left untouched", async () => {
    const bSpoc = await seedSpoc(VENDOR_B, "B's contact");
    const vendorA = await httpClient(VENDOR_A);

    const upd = await vendorA.put(`/api/v1/users/update-spoc/${bSpoc}`).send(spocPayload({ spoc_name: "Hijacked" }));
    const del = await vendorA.delete(`/api/v1/users/delete-spoc/${bSpoc}`);

    expect([400, 403]).toContain(upd.status);
    expect([400, 403]).toContain(del.status);
    expect(await spocsOf(VENDOR_B)).toEqual([{ id: bSpoc, name: "B's contact" }]);
  });

  it("update-spoc / delete-spoc: the owner can still edit and remove its own SPOC", async () => {
    const aSpoc = await seedSpoc(VENDOR_A, "Mine");
    const vendorA = await httpClient(VENDOR_A);

    const upd = await vendorA.put(`/api/v1/users/update-spoc/${aSpoc}`).send(spocPayload({ spoc_name: "Renamed" }));
    expect(upd.status).toBe(200);
    expect((await spocsOf(VENDOR_A))[0].name).toBe("Renamed");

    const del = await vendorA.delete(`/api/v1/users/delete-spoc/${aSpoc}`);
    expect(del.status).toBe(200);
    expect(await spocsOf(VENDOR_A)).toEqual([]);
  });
});

describe("/users/add-spoc - buyer adding a SPOC to a vendor", () => {
  const spocPayload = (vendor_id) => ({
    spoc_name: "Buyer Added",
    spoc_email: `buyer-added-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`,
    spoc_mobile: "+91-9876543210",
    spoc_role: "sales",
    vendor_id: String(vendor_id),
  });
  const spocsOf = (userId) => db.any(`SELECT id FROM tbl_users_spoc WHERE user_id = $1`, [userId]);
  const rfqIds = [];

  afterEach(async () => {
    await db.none(`DELETE FROM tbl_users_spoc WHERE user_id = ANY($1::int[])`, [[VENDOR_G]]);
    await db.none(`DELETE FROM tbl_buyer_private_vendors_mapping WHERE vendor_id = ANY($1::int[])`, [[VENDOR_G]]);
    if (rfqIds.length) {
      await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
      await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
      await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
      rfqIds.length = 0;
    }
  });

  it("is refused with 403 when the buyer's company has no relationship with the vendor", async () => {
    const buyer = await httpClient(BUYER);

    const res = await buyer.post("/api/v1/users/add-spoc").send(spocPayload(VENDOR_G));

    expect(res.status).toBe(403);
    expect(await spocsOf(VENDOR_G)).toEqual([]);
  });

  it("is refused when the only relationship belongs to a different buyer company", async () => {
    const other = IDS.users.companyB_admin;
    const [prev] = await db.any(`SELECT user_type FROM tbl_users WHERE id = $1`, [other]);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [other]);
    await db.none(
      `INSERT INTO tbl_buyer_private_vendors_mapping (created_by, vendor_id, company_id) VALUES ($1, $2, $3)`,
      [BUYER, VENDOR_G, companyBuyer]
    );
    try {
      const otherBuyer = await httpClient(other);
      const res = await otherBuyer.post("/api/v1/users/add-spoc").send(spocPayload(VENDOR_G));
      expect(res.status).toBe(403);
      expect(await spocsOf(VENDOR_G)).toEqual([]);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [other, prev.user_type]);
    }
  });

  // Prod: one tbl_company holds buyers of several unrelated hospitality
  // clients. A relationship held by one client must not leak to another buyer
  // that merely shares the tbl_company.
  async function withSiblingBuyer(fn) {
    const sibling = IDS.users.companyB_admin; // mapped to hospitality B
    const [prev] = await db.any(`SELECT user_type, company_id FROM tbl_users WHERE id = $1`, [sibling]);
    await db.none(`UPDATE tbl_users SET user_type = 2, company_id = $2 WHERE id = $1`, [sibling, companyBuyer]);
    try {
      await fn(sibling);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2, company_id = $3 WHERE id = $1`, [sibling, prev.user_type, prev.company_id]);
    }
  }

  it("does not leak one hospitality client's relationship to a buyer sharing the same tbl_company", async () => {
    await db.none(
      `INSERT INTO tbl_buyer_private_vendors_mapping (created_by, vendor_id, company_id) VALUES ($1, $2, $3)`,
      [BUYER, VENDOR_G, companyBuyer]
    );
    await withSiblingBuyer(async (sibling) => {
      const owner = await httpClient(BUYER);
      const other = await httpClient(sibling);

      const allowed = await owner.post("/api/v1/users/add-spoc").send(spocPayload(VENDOR_G));
      const leaked = await other.post("/api/v1/users/add-spoc").send(spocPayload(VENDOR_G));

      expect(allowed.status).toBe(200);
      expect(leaked.status).toBe(403);
      expect(await spocsOf(VENDOR_G)).toHaveLength(1);
    });
  });

  it("does not leak an RFQ-based relationship to a buyer of another hospitality client", async () => {
    const { rfq_id } = await makeRFQ(db, { createdBy: BUYER, status: 1, is_published: 1 });
    rfqIds.push(rfq_id);
    await db.none(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)`,
      [rfq_id, PRODUCT_VARIANT]
    );
    await attachVendorToRfqProduct({ rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: VENDOR_G });
    await withSiblingBuyer(async (sibling) => {
      const other = await httpClient(sibling);

      const res = await other.post("/api/v1/users/add-spoc").send(spocPayload(VENDOR_G));

      expect(res.status).toBe(403);
      expect(await spocsOf(VENDOR_G)).toEqual([]);
    });
  });

  it("is refused for a buyer with no hospitality mapping at all", async () => {
    await db.none(
      `INSERT INTO tbl_buyer_private_vendors_mapping (created_by, vendor_id, company_id) VALUES ($1, $2, $3)`,
      [BUYER, VENDOR_G, companyBuyer]
    );
    const unmapped = IDS.users.inactive;
    const [prev] = await db.any(`SELECT user_type, company_id, status FROM tbl_users WHERE id = $1`, [unmapped]);
    await db.none(`UPDATE tbl_users SET user_type = 2, company_id = $2, status = 1 WHERE id = $1`, [unmapped, companyBuyer]);
    const savedMappings = await db.any(`SELECT * FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [unmapped]);
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [unmapped]);
    try {
      const client = await httpClient(unmapped);
      const res = await client.post("/api/v1/users/add-spoc").send(spocPayload(VENDOR_G));
      expect(res.status).toBe(403);
    } finally {
      for (const m of savedMappings) {
        await db.none(
          `INSERT INTO tbl_hospitality_user_mappings (id, user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
           VALUES ($1, $2, $3, $4, $5)`,
          [m.id, m.user_id, m.hospitality_company_id, m.hospitality_hotel_id, m.mapping_type]
        );
      }
      await db.none(`UPDATE tbl_users SET user_type = $2, company_id = $3, status = $4 WHERE id = $1`,
        [unmapped, prev.user_type, prev.company_id, prev.status]);
    }
  });

  it("is allowed when the vendor is in the buyer company's private-vendor list", async () => {
    await db.none(
      `INSERT INTO tbl_buyer_private_vendors_mapping (created_by, vendor_id, company_id) VALUES ($1, $2, $3)`,
      [BUYER, VENDOR_G, companyBuyer]
    );
    const buyer = await httpClient(BUYER);

    const res = await buyer.post("/api/v1/users/add-spoc").send(spocPayload(VENDOR_G));

    expect(res.status).toBe(200);
    expect(await spocsOf(VENDOR_G)).toHaveLength(1);
  });

  it("is allowed when the vendor is mapped to an RFQ of the buyer's company", async () => {
    const { rfq_id } = await makeRFQ(db, { createdBy: BUYER, status: 1, is_published: 1 });
    rfqIds.push(rfq_id);
    await db.none(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)`,
      [rfq_id, PRODUCT_VARIANT]
    );
    await attachVendorToRfqProduct({ rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id: VENDOR_G });
    const buyer = await httpClient(BUYER);

    const res = await buyer.post("/api/v1/users/add-spoc").send(spocPayload(VENDOR_G));

    expect(res.status).toBe(200);
    expect(await spocsOf(VENDOR_G)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Company locations and SPOC <-> location mapping
// ---------------------------------------------------------------------------
describe("vendor location endpoints - company ownership", () => {
  const location = (extra = {}) => ({ address: "1 Test Road", postal_code: "560001", city: 1, state: 1, country: 1, ...extra });
  const locationsOf = (companyId) =>
    db.any(`SELECT id, address FROM tbl_company_location WHERE company_id = $1 ORDER BY id`, [companyId]);
  const mappingsOf = (locationId) =>
    db.any(`SELECT spoc_id FROM tbl_spoc_location_mapping WHERE location_id = $1 ORDER BY spoc_id`, [locationId]);
  async function seedLocation(companyId, address = "Seeded") {
    return (await db.one(
      `INSERT INTO tbl_company_location (company_id, address, postal_code, created_by) VALUES ($1, $2, '560001', $3) RETURNING id`,
      [companyId, address, VENDOR_A]
    )).id;
  }
  async function seedSpoc(userId) {
    return (await db.one(
      `INSERT INTO tbl_users_spoc (name, email, mobile, role, user_id) VALUES ('S', 's@x.test', '+91-9876543210', 'r', $1) RETURNING id`,
      [userId]
    )).id;
  }

  afterEach(async () => {
    const locIds = (await db.any(`SELECT id FROM tbl_company_location WHERE company_id = ANY($1::int[])`, [[companyA, companyB, companyBuyer, companyG]])).map((r) => r.id);
    if (locIds.length) await db.none(`DELETE FROM tbl_spoc_location_mapping WHERE location_id = ANY($1::int[])`, [locIds]);
    await db.none(`DELETE FROM tbl_company_location WHERE company_id = ANY($1::int[])`, [[companyA, companyB, companyBuyer, companyG]]);
    await db.none(`DELETE FROM tbl_users_spoc WHERE user_id = ANY($1::int[])`, [[VENDOR_A, VENDOR_B]]);
  });

  it("add: a foreign company_id is refused with 403 and writes nothing", async () => {
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post("/api/v1/users/add-buyer-vendor-location").send(location({ company_id: companyB }));

    expect(res.status).toBe(403);
    expect(await locationsOf(companyB)).toEqual([]);
    expect(await locationsOf(companyA)).toEqual([]);
  });

  it("add: lands on the caller's own company whether or not the body names it", async () => {
    const vendorA = await httpClient(VENDOR_A);

    const bare = await vendorA.post("/api/v1/users/add-buyer-vendor-location").send(location());
    const own = await vendorA.post("/api/v1/users/add-buyer-vendor-location").send(location({ company_id: companyA }));

    expect(bare.status).toBe(200);
    expect(own.status).toBe(200);
    expect(await locationsOf(companyA)).toHaveLength(2);
    expect(await locationsOf(companyB)).toEqual([]);
  });

  it("update: another company's location is refused and unchanged, even when the body claims the caller's company", async () => {
    const bLoc = await seedLocation(companyB, "B's office");
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.put("/api/v1/users/update-buyer-vendor-location")
      .send(location({ id: bLoc, company_id: companyA, address: "Hijacked" }));

    expect(res.status).toBe(403);
    expect(await locationsOf(companyB)).toEqual([{ id: bLoc, address: "B's office" }]);
  });

  it("update: the owner can edit its own location and cannot move it to another company", async () => {
    const aLoc = await seedLocation(companyA, "Old");
    const vendorA = await httpClient(VENDOR_A);

    const ok = await vendorA.put("/api/v1/users/update-buyer-vendor-location")
      .send(location({ id: aLoc, company_id: companyA, address: "New" }));
    expect(ok.status).toBe(200);
    expect(await locationsOf(companyA)).toEqual([{ id: aLoc, address: "New" }]);

    const move = await vendorA.put("/api/v1/users/update-buyer-vendor-location")
      .send(location({ id: aLoc, company_id: companyB, address: "Moved" }));
    expect(move.status).toBe(403);
    expect(await locationsOf(companyA)).toEqual([{ id: aLoc, address: "New" }]);
  });

  it("delete: another company's location is refused and kept; the owner's own is deleted", async () => {
    const bLoc = await seedLocation(companyB, "B's office");
    const aLoc = await seedLocation(companyA, "Mine");
    const vendorA = await httpClient(VENDOR_A);

    const foreign = await vendorA.delete(`/api/v1/users/delete-buyer-vendor-location/${bLoc}`);
    expect(foreign.status).toBe(403);
    expect(await locationsOf(companyB)).toHaveLength(1);

    const own = await vendorA.delete(`/api/v1/users/delete-buyer-vendor-location/${aLoc}`);
    expect(own.status).toBe(200);
    expect(await locationsOf(companyA)).toEqual([]);
  });

  it("map-spoc-location: refuses a foreign location or a foreign SPOC, changes nothing", async () => {
    const aLoc = await seedLocation(companyA);
    const bLoc = await seedLocation(companyB);
    const aSpoc = await seedSpoc(VENDOR_A);
    const bSpoc = await seedSpoc(VENDOR_B);
    await db.none(`INSERT INTO tbl_spoc_location_mapping (spoc_id, location_id) VALUES ($1, $2)`, [bSpoc, bLoc]);
    const vendorA = await httpClient(VENDOR_A);

    const foreignLocation = await vendorA.post("/api/v1/users/map-spoc-location").send({ spoc_id: [aSpoc], location_id: bLoc });
    const foreignSpoc = await vendorA.post("/api/v1/users/map-spoc-location").send({ spoc_id: [aSpoc, bSpoc], location_id: aLoc });

    expect(foreignLocation.status).toBe(403);
    expect(foreignSpoc.status).toBe(403);
    expect(await mappingsOf(bLoc)).toEqual([{ spoc_id: bSpoc }]);
    expect(await mappingsOf(aLoc)).toEqual([]);
  });

  it("map-spoc-location: the owner maps its own SPOC to its own location", async () => {
    const aLoc = await seedLocation(companyA);
    const aSpoc = await seedSpoc(VENDOR_A);
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post("/api/v1/users/map-spoc-location").send({ spoc_id: [aSpoc], location_id: aLoc });

    expect(res.status).toBe(200);
    expect(await mappingsOf(aLoc)).toEqual([{ spoc_id: aSpoc }]);
  });

  it("a buyer manages its own company's locations (add, update, delete) but not another company's", async () => {
    const buyer = await httpClient(BUYER);
    const foreign = await seedLocation(companyA, "Vendor's office");

    const add = await buyer.post("/api/v1/users/add-buyer-vendor-location").send(location({ company_id: companyBuyer }));
    expect(add.status).toBe(200);
    const [mine] = await locationsOf(companyBuyer);
    expect(mine).toBeDefined();

    const upd = await buyer.put("/api/v1/users/update-buyer-vendor-location")
      .send(location({ id: mine.id, company_id: companyBuyer, address: "Buyer HQ" }));
    expect(upd.status).toBe(200);
    expect(await locationsOf(companyBuyer)).toEqual([{ id: mine.id, address: "Buyer HQ" }]);

    const hijack = await buyer.put("/api/v1/users/update-buyer-vendor-location")
      .send(location({ id: foreign, company_id: companyBuyer, address: "Hijacked" }));
    expect(hijack.status).toBe(403);
    const delForeign = await buyer.delete(`/api/v1/users/delete-buyer-vendor-location/${foreign}`);
    expect(delForeign.status).toBe(403);
    expect(await locationsOf(companyA)).toEqual([{ id: foreign, address: "Vendor's office" }]);

    const del = await buyer.delete(`/api/v1/users/delete-buyer-vendor-location/${mine.id}`);
    expect(del.status).toBe(200);
    expect(await locationsOf(companyBuyer)).toEqual([]);
  });

  describe("GET /users/get-buyer-vendor-location/:id", () => {
    const GETLOC = (id) => `/api/v1/users/get-buyer-vendor-location/${id}`;
    afterEach(async () => {
      await db.none(`DELETE FROM tbl_buyer_private_vendors_mapping WHERE vendor_id = ANY($1::int[])`, [[VENDOR_G]]);
    });

    it("a vendor reads its own company, not another's", async () => {
      await seedLocation(companyA, "A office");
      await seedLocation(companyB, "B office");
      const vendorA = await httpClient(VENDOR_A);

      const own = await vendorA.get(GETLOC(companyA));
      const foreign = await vendorA.get(GETLOC(companyB));

      expect(own.status).toBe(200);
      expect(own.body.data.map((l) => l.address)).toEqual(["A office"]);
      expect(foreign.status).toBe(403);
      expect(JSON.stringify(foreign.body)).not.toContain("B office");
    });

    it("a buyer reads its own company", async () => {
      await seedLocation(companyBuyer, "Buyer HQ");
      const buyer = await httpClient(BUYER);

      const res = await buyer.get(GETLOC(companyBuyer));

      expect(res.status).toBe(200);
      expect(res.body.data.map((l) => l.address)).toEqual(["Buyer HQ"]);
    });

    it("a buyer reads a vendor company only when its company works with that vendor", async () => {
      await seedLocation(companyG, "A office");
      const buyer = await httpClient(BUYER);

      const before = await buyer.get(GETLOC(companyG));
      expect(before.status).toBe(403);

      await db.none(
        `INSERT INTO tbl_buyer_private_vendors_mapping (created_by, vendor_id, company_id) VALUES ($1, $2, $3)`,
        [BUYER, VENDOR_G, companyBuyer]
      );
      const after = await buyer.get(GETLOC(companyG));
      expect(after.status).toBe(200);
      expect(after.body.data.map((l) => l.address)).toEqual(["A office"]);
    });

    it("a buyer sharing the vendor-relationship holder's tbl_company does not inherit the read", async () => {
      await seedLocation(companyG, "G office");
      await db.none(
        `INSERT INTO tbl_buyer_private_vendors_mapping (created_by, vendor_id, company_id) VALUES ($1, $2, $3)`,
        [BUYER, VENDOR_G, companyBuyer]
      );
      const sibling = IDS.users.companyB_admin;
      const [prev] = await db.any(`SELECT user_type, company_id FROM tbl_users WHERE id = $1`, [sibling]);
      await db.none(`UPDATE tbl_users SET user_type = 2, company_id = $2 WHERE id = $1`, [sibling, companyBuyer]);
      try {
        const owner = await httpClient(BUYER);
        const other = await httpClient(sibling);

        expect((await owner.get(GETLOC(companyG))).status).toBe(200);
        expect((await other.get(GETLOC(companyG))).status).toBe(403);
      } finally {
        await db.none(`UPDATE tbl_users SET user_type = $2, company_id = $3 WHERE id = $1`, [sibling, prev.user_type, prev.company_id]);
      }
    });

    it("the internal console still reads any company", async () => {
      await seedLocation(companyB, "B office");
      const app = await buildTestApp();
      const { headers } = await loginAsInternalStaff(STAFF);
      let r = request(app).get(`/api/v1/admin/vendor/get-vendor-locations/${companyB}`);
      for (const [k, v] of Object.entries(headers)) r = r.set(k, v);

      const res = await r;

      expect(res.status).toBe(200);
      expect(res.body.data.map((l) => l.address)).toEqual(["B office"]);
    });
  });

  describe("internal console keeps its behaviour (jwtAdm, /admin/vendor/*)", () => {
    async function staff() {
      const app = await buildTestApp();
      const { headers } = await loginAsInternalStaff(STAFF);
      const call = (method, path) => {
        let r = request(app)[method](path);
        for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
        return r;
      };
      return call;
    }

    it("add / update / delete / map act on any company's rows", async () => {
      const call = await staff();
      const bSpoc = await seedSpoc(VENDOR_B);

      const add = await call("post", "/api/v1/admin/vendor/add-vendor-location").send(location({ company_id: companyB }));
      expect(add.status).toBe(200);
      const [created] = await locationsOf(companyB);
      expect(created).toBeDefined();

      const upd = await call("put", `/api/v1/admin/vendor/update-vendor-location/${created.id}`)
        .send(location({ id: created.id, company_id: companyB, address: "Edited by staff" }));
      expect(upd.status).toBe(200);
      expect(await locationsOf(companyB)).toEqual([{ id: created.id, address: "Edited by staff" }]);

      const map = await call("post", "/api/v1/admin/vendor/map-spoc-location").send({ spoc_id: [bSpoc], location_id: created.id });
      expect(map.status).toBe(200);
      expect(await mappingsOf(created.id)).toEqual([{ spoc_id: bSpoc }]);

      await db.none(`DELETE FROM tbl_spoc_location_mapping WHERE location_id = $1`, [created.id]);
      const del = await call("delete", `/api/v1/admin/vendor/delete-vendor-location/${created.id}`);
      expect(del.status).toBe(200);
      expect(await locationsOf(companyB)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Clarification raising
// ---------------------------------------------------------------------------
describe("POST /rfq/clarification/raise - RFQ mapping", () => {
  const RAISE = "/api/v1/rfq/clarification/raise";
  const rfqIds = [];

  async function makeRfq({ vendors }) {
    const { rfq_id } = await makeRFQ(db, { createdBy: BUYER, status: 1, is_published: 1 });
    rfqIds.push(rfq_id);
    await db.none(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)`,
      [rfq_id, PRODUCT_VARIANT]
    );
    for (const vendor_id of vendors) {
      await attachVendorToRfqProduct({ rfq_id, product_variant_id: PRODUCT_VARIANT, vendor_id });
    }
    return rfq_id;
  }
  const clarificationsOf = (rfq_id) =>
    db.any(`SELECT id, raised_by FROM tbl_rfq_clarifications WHERE rfq_id = $1`, [rfq_id]);
  const payload = (rfq_id) => ({
    rfq_id,
    subject: "Delivery schedule",
    question: "Can the delivery window be extended by a week?",
  });

  afterEach(async () => {
    if (!rfqIds.length) return;
    const clar = `SELECT id FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[])`;
    await db.none(
      `DELETE FROM tbl_rfq_clarification_message_files WHERE message_id IN
         (SELECT id FROM tbl_rfq_clarification_messages WHERE clarification_id IN (${clar}))`,
      [rfqIds]
    ).catch(() => {});
    await db.none(`DELETE FROM tbl_rfq_clarification_messages WHERE clarification_id IN (${clar})`, [rfqIds]).catch(() => {});
    await db.none(`DELETE FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
    rfqIds.length = 0;
  });

  it("refuses a vendor that is not mapped to the RFQ with 403 and opens nothing", async () => {
    const rfq_id = await makeRfq({ vendors: [VENDOR_B] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(RAISE).send(payload(rfq_id));

    expect(res.status).toBe(403);
    expect(await clarificationsOf(rfq_id)).toEqual([]);
  });

  it("refuses an anonymous multipart upload with 401 before the upload handler runs", async () => {
    const rfq_id = await makeRfq({ vendors: [VENDOR_A] });
    const anon = await httpClient(null);

    const res = await anon.post(RAISE)
      .field("rfq_id", String(rfq_id))
      .field("subject", "Delivery schedule")
      .field("question", "Can the delivery window be extended by a week?")
      .attach("files", Buffer.from("anonymous upload"), "note.txt");

    expect(res.status).toBe(401);
    expect(await clarificationsOf(rfq_id)).toEqual([]);
  });

  it("refuses an unauthenticated caller with 401 and opens nothing", async () => {
    const rfq_id = await makeRfq({ vendors: [VENDOR_A] });
    const anon = await httpClient(null);

    const res = await anon.post(RAISE).send(payload(rfq_id));

    expect(res.status).toBe(401);
    expect(await clarificationsOf(rfq_id)).toEqual([]);
  });

  it("lets a mapped vendor raise a clarification", async () => {
    const rfq_id = await makeRfq({ vendors: [VENDOR_A] });
    const vendorA = await httpClient(VENDOR_A);

    const res = await vendorA.post(RAISE).send(payload(rfq_id));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(await clarificationsOf(rfq_id)).toHaveLength(1);
  });
});
