// Verifies that seed_fixtures populated the expected ambient population.
// Each test asserts on a coherent slice and the named IDs match what fixtures.js
// promises.

import { describe, it, expect, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";

describe("fixtures", () => {
  afterAll(async () => {
    await closeDb();
  });

  describe("network", () => {
    it("seeds 7 parent companies (2 buyers + 5 vendors)", async () => {
      const ids = await db.any(
        `SELECT id FROM tbl_company WHERE id IN ($1,$2,$3,$4,$5,$6,$7) ORDER BY id`,
        [
          IDS.companies.A,
          IDS.companies.B,
          IDS.companies.vendorAlpha,
          IDS.companies.vendorBeta,
          IDS.companies.vendorGamma,
          IDS.companies.vendorDelta,
          IDS.companies.vendorEpsilon,
        ]
      );
      expect(ids.map((r) => r.id)).toEqual([
        IDS.companies.A, IDS.companies.B,
        IDS.companies.vendorAlpha, IDS.companies.vendorBeta,
        IDS.companies.vendorGamma, IDS.companies.vendorDelta,
        IDS.companies.vendorEpsilon,
      ]);
    });

    it("seeds 2 hospitality companies referencing parent companies", async () => {
      const a = await db.one(
        `SELECT buyer_company_id FROM tbl_hospitality_companies WHERE id=$1`,
        [IDS.hospitality.A]
      );
      expect(a.buyer_company_id).toBe(IDS.companies.A);
    });

    it("seeds 5 hotels (3 under A, 2 under B)", async () => {
      const counts = await db.one(`
        SELECT
          (SELECT count(*)::int FROM tbl_hospitality_company_hotels WHERE hospitality_company_id=$1) AS A,
          (SELECT count(*)::int FROM tbl_hospitality_company_hotels WHERE hospitality_company_id=$2) AS B
      `, [IDS.hospitality.A, IDS.hospitality.B]);
      expect(counts.a).toBe(3);
      expect(counts.b).toBe(2);
    });

    it("seeds 4 global departments", async () => {
      const titles = await db.any(
        `SELECT title FROM tbl_department WHERE id IN ($1,$2,$3,$4) ORDER BY id`,
        [IDS.departments.proc, IDS.departments.eng, IDS.departments.fb, IDS.departments.hk]
      );
      expect(titles.map((r) => r.title)).toEqual([
        "Procurement", "Engineering", "F&B", "Housekeeping",
      ]);
    });
  });

  describe("users", () => {
    it("seeds the super admin and company admins", async () => {
      const su = await db.one(`SELECT email, status FROM tbl_users WHERE id=$1`, [
        IDS.users.superAdmin,
      ]);
      expect(su.email).toBe("super.admin@test.local");
      expect(su.status).toBe(1);

      const inactive = await db.one(`SELECT status FROM tbl_users WHERE id=$1`, [
        IDS.users.inactive,
      ]);
      expect(inactive.status).toBe(0);
    });

    it("seeds the A1 procurement chain with role-scopes per role", async () => {
      const scopes = await db.any(
        `SELECT user_id, role_id, hotel_id, department_id
         FROM tbl_user_role_scopes
         WHERE user_id IN ($1,$2,$3,$4,$5,$6,$7)
         ORDER BY user_id, role_id`,
        [
          IDS.users.a1_proc_buyer, IDS.users.a1_proc_techEval,
          IDS.users.a1_proc_techApp, IDS.users.a1_proc_commEval,
          IDS.users.a1_proc_commApp, IDS.users.a1_proc_poApp,
          IDS.users.a1_proc_finance,
        ]
      );
      // 9, not 7: two users carry a SECOND role because a fixture policy names
      // them as an approver for an entity their primary role grants nothing on.
      // USER-source policy steps are permission-gated now, so a1_proc_commApp
      // (named on A1_P2_RFQ) also holds TENDER_APPROVER for rfq.read+approve,
      // and a1_proc_techEval (named on A1_P2_TECHNICAL) also holds
      // TECH_APPROVER for te.read+approve. Without them those steps are dropped
      // and the policies resolve to nobody. See tests/fixtures/users.js.
      expect(scopes.length).toBe(9);
      // Every scope should be Hotel A1 / Procurement dept.
      for (const s of scopes) {
        expect(s.hotel_id).toBe(IDS.hotels.A1);
        expect(s.department_id).toBe(IDS.departments.proc);
      }
      // Buyer = TENDER_CREATOR
      const buyer = scopes.find((s) => s.user_id === IDS.users.a1_proc_buyer);
      expect(buyer.role_id).toBe(ROLE_IDS.TENDER_CREATOR);
      // Tech approver = TECH_APPROVER
      const techApp = scopes.find((s) => s.user_id === IDS.users.a1_proc_techApp);
      expect(techApp.role_id).toBe(ROLE_IDS.TECH_APPROVER);
    });

    it("multi-hotel user is mapped to two hotels and has scopes in both", async () => {
      const mappings = await db.any(
        `SELECT hospitality_hotel_id FROM tbl_hospitality_user_mappings
         WHERE user_id=$1 ORDER BY hospitality_hotel_id`,
        [IDS.users.multiHotel]
      );
      expect(mappings.map((r) => r.hospitality_hotel_id)).toEqual([
        IDS.hotels.A1, IDS.hotels.A2,
      ]);

      const scopes = await db.any(
        `SELECT hotel_id FROM tbl_user_role_scopes WHERE user_id=$1 ORDER BY hotel_id`,
        [IDS.users.multiHotel]
      );
      expect(scopes.map((r) => r.hotel_id)).toEqual([IDS.hotels.A1, IDS.hotels.A2]);
    });

    it("dual-role user has TENDER_CREATOR in A1 and TECH_EVAL in A2", async () => {
      const scopes = await db.any(
        `SELECT role_id, hotel_id FROM tbl_user_role_scopes
         WHERE user_id=$1 ORDER BY hotel_id`,
        [IDS.users.dualRole]
      );
      expect(scopes).toEqual([
        { role_id: ROLE_IDS.TENDER_CREATOR, hotel_id: IDS.hotels.A1 },
        { role_id: ROLE_IDS.TECH_EVAL,      hotel_id: IDS.hotels.A2 },
      ]);
    });

    it("cross-company user is mapped to BOTH hospitality A and B", async () => {
      const mappings = await db.any(
        `SELECT hospitality_company_id FROM tbl_hospitality_user_mappings
         WHERE user_id=$1 ORDER BY hospitality_company_id`,
        [IDS.users.crossCompany]
      );
      expect(mappings.map((r) => r.hospitality_company_id)).toEqual([
        IDS.hospitality.A, IDS.hospitality.B,
      ]);
    });

    it("seeds all 5 vendor users tied to their parent companies", async () => {
      const vendors = await db.any(
        `SELECT u.id, u.company_id
         FROM tbl_users u
         WHERE u.id IN ($1,$2,$3,$4,$5)
         ORDER BY u.id`,
        [
          IDS.users.vendor_alpha, IDS.users.vendor_beta,
          IDS.users.vendor_gamma, IDS.users.vendor_delta,
          IDS.users.vendor_epsilon,
        ]
      );
      expect(vendors).toEqual([
        { id: IDS.users.vendor_alpha,   company_id: IDS.companies.vendorAlpha },
        { id: IDS.users.vendor_beta,    company_id: IDS.companies.vendorBeta },
        { id: IDS.users.vendor_gamma,   company_id: IDS.companies.vendorGamma },
        { id: IDS.users.vendor_delta,   company_id: IDS.companies.vendorDelta },
        { id: IDS.users.vendor_epsilon, company_id: IDS.companies.vendorEpsilon },
      ]);
    });
  });

  describe("processes + policies", () => {
    it("seeds 3 fixture approval processes (A.P1, A.P2, B.P1)", async () => {
      const procs = await db.any(
        `SELECT id, company_id, name FROM tbl_approval_processes
         WHERE id IN ($1,$2,$3) ORDER BY id`,
        [IDS.processes.A_P1, IDS.processes.A_P2, IDS.processes.B_P1]
      );
      expect(procs).toEqual([
        { id: IDS.processes.A_P1, company_id: IDS.companies.A, name: "Standard Procurement" },
        { id: IDS.processes.A_P2, company_id: IDS.companies.A, name: "Daily Bazaar" },
        { id: IDS.processes.B_P1, company_id: IDS.companies.B, name: "Standard Procurement" },
      ]);
    });

    it("A1/P1 has 5 distinct entity policies (RFQ, TECHNICAL, NEGOTIATION, NEGOTIATION_QUOTE, PO)", async () => {
      const policies = await db.any(
        `SELECT entity_type FROM tbl_approval_policies
         WHERE process_id=$1 AND hotel_id=$2 AND department_id IS NULL
         ORDER BY entity_type`,
        [IDS.processes.A_P1, IDS.hotels.A1]
      );
      expect(policies.map((p) => p.entity_type).sort()).toEqual(
        ["NEGOTIATION", "NEGOTIATION_QUOTE", "PO", "RFQ", "TECHNICAL"]
      );
    });

    it("A1/P1 RFQ policy has 2 ALL steps (TECH_APPROVER role, then finance user)", async () => {
      const steps = await db.any(
        `SELECT step_order, decision_rule, approver_source_type, approver_source_id
         FROM tbl_approval_policy_steps WHERE approval_policy_id=$1
         ORDER BY step_order`,
        [IDS.policies.A1_P1_RFQ]
      );
      expect(steps).toEqual([
        { step_order: 1, decision_rule: "ALL", approver_source_type: "ROLE", approver_source_id: ROLE_IDS.TECH_APPROVER },
        { step_order: 2, decision_rule: "ALL", approver_source_type: "USER", approver_source_id: IDS.users.a1_proc_finance },
      ]);
    });

    it("A2/P1 RFQ policy is intentionally empty (zero-approver auto-skip test)", async () => {
      const steps = await db.any(
        `SELECT count(*)::int AS n FROM tbl_approval_policy_steps WHERE approval_policy_id=$1`,
        [IDS.policies.A2_P1_RFQ]
      );
      expect(steps[0].n).toBe(0);
    });

    it("A3/P1 PO policy is intentionally NOT seeded (under-configured BU)", async () => {
      const policy = await db.oneOrNone(
        `SELECT id FROM tbl_approval_policies
         WHERE process_id=$1 AND hotel_id=$2 AND department_id IS NULL AND entity_type='PO'`,
        [IDS.processes.A_P1, IDS.hotels.A3]
      );
      expect(policy).toBeNull();
    });

    it("A1/P1 RFQ chain and A1/P2 RFQ chain resolve to DIFFERENT policy IDs (cross-process routing)", async () => {
      const p1 = await db.one(
        `SELECT id FROM tbl_approval_policies
         WHERE process_id=$1 AND hotel_id=$2 AND department_id IS NULL AND entity_type='RFQ'`,
        [IDS.processes.A_P1, IDS.hotels.A1]
      );
      const p2 = await db.one(
        `SELECT id FROM tbl_approval_policies
         WHERE process_id=$1 AND hotel_id=$2 AND department_id IS NULL AND entity_type='RFQ'`,
        [IDS.processes.A_P2, IDS.hotels.A1]
      );
      expect(p1.id).toBe(IDS.policies.A1_P1_RFQ);
      expect(p2.id).toBe(IDS.policies.A1_P2_RFQ);
      expect(p1.id).not.toBe(p2.id);
    });
  });

  describe("vendors + subscriptions", () => {
    it("each vendor has exactly the expected subscription state", async () => {
      const states = await db.any(
        `SELECT vendor_id, item_id, status FROM tbl_vendor_hotel_category_subscription
         WHERE vendor_id IN ($1,$2,$3,$4,$5)
         ORDER BY vendor_id, item_id`,
        [
          IDS.users.vendor_alpha, IDS.users.vendor_beta,
          IDS.users.vendor_gamma, IDS.users.vendor_delta,
          IDS.users.vendor_epsilon,
        ]
      );
      const byVendor = (id) => states.filter((s) => s.vendor_id === id);
      expect(byVendor(IDS.users.vendor_alpha).map((s) => s.status)).toEqual(["active"]);
      expect(byVendor(IDS.users.vendor_beta).map((s) => s.status)).toEqual(["active", "active"]); // multi-category
      expect(byVendor(IDS.users.vendor_gamma).map((s) => s.status)).toEqual(["expired"]);
      expect(byVendor(IDS.users.vendor_delta).map((s) => s.status)).toEqual(["cancelled"]);
      expect(byVendor(IDS.users.vendor_epsilon).map((s) => s.status)).toEqual(["pending"]);
    });

    it("seeds preferred-vendor mappings", async () => {
      const rows = await db.any(
        `SELECT created_by, vendor_id, company_id
         FROM tbl_buyer_private_vendors_mapping
         WHERE created_by IN ($1, $2)
         ORDER BY created_by, vendor_id`,
        [IDS.users.a1_proc_buyer, IDS.users.companyB_admin]
      );
      expect(rows.length).toBeGreaterThanOrEqual(3);
    });

    it("uses real seeded categories for subscriptions (BEVERAGES family)", async () => {
      const cat = await db.one(
        `SELECT title FROM tbl_category WHERE id=$1`,
        [TEST_CATEGORIES.beverages]
      );
      expect(cat.title).toBe("BEVERAGES");
    });
  });
});
