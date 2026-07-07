// ARC v2 — GROUP H (Sr 29 + Sr 33): backend read-shape fixes.
//
//   Sr 29 — arcModel.listInvitations now selects u.organization_name AS
//           vendor_company (additive) so the buyer ARC Overview "Invited
//           vendors" tracker can show the COMPANY, not the contact person.
//           Consumed via GET /api/v1/arc-v2/:id (arcController.getById),
//           whose invitations[] rows come straight from listInvitations.
//   Sr 33 — arcVendorController.getRequestDetail now enriches the bare
//           `arc` row (hotel_id/category_id/department_id ints only) with
//           resolved display names (hotel_name, hotel_city, category_title,
//           department_title), placed AFTER the existing Group-G
//           (Sr 27 Option C) not-yet-open guard so a hidden floated ARC
//           still 404s before the enrichment query ever runs.
//   REVIEW FIX — getRequestDetail also now gates on vendorInvitedToArc (mirrors
//           getRequestLifecycle), placed after the Group-G window guard but
//           before the enrichment query. A non-invited vendor now gets 403
//           instead of leaking arc/items/tech-envelope. The "open ARC" Sr 33
//           enrichment test seeds an invitation for the requesting vendor
//           (VENDOR_A) so it exercises the real invited-vendor path; a
//           dedicated non-invited-vendor case proves the 403.
//
// Product-level: real Express app + real Postgres. No internal call-count
// assertions — only observable HTTP payloads.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import moment from "moment-timezone";

const HC       = IDS.hospitality.A;
const HOTEL    = IDS.hotels.A1;       // fixture name: "Hotel A-1", city: NULL
const DEPT     = IDS.departments.proc; // fixture title: "Procurement"
const PROC     = IDS.processes.A_P1;
const BUYER    = IDS.users.a1_proc_buyer;
const VENDOR_A = IDS.users.vendor_alpha;   // will be stamped with a distinct company name
const VENDOR_B = IDS.users.vendor_beta;    // left with organization_name = NULL (fallback case)
const VENDOR_E = IDS.users.vendor_epsilon; // not invited to any ARC below
const CATEGORY = TEST_CATEGORIES.beverages; // fixture title: "BEVERAGES"
const VARIANT_ID = 1;

const IST = "Asia/Kolkata";
const nowIst = () => moment.tz(IST);

describe("ARC v2 — Group H: vendor_company on listInvitations (Sr 29) + getRequestDetail enrichment/guard (Sr 33)", () => {
  let buyerClient, alphaClient, epsilonClient;
  const createdArcIds = [];
  let savedAlpha, savedBeta;

  async function seedArcDirect({ number, status, startAt, endAt }) {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by, eligibility_type, escalation_clause_json, sub_category_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               $9::timestamp, $10::timestamp,
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days',
               $11, 'invitation', '{}'::jsonb, '[]'::jsonb)
       RETURNING *`,
      [number, `Group H test — ${number}`, CATEGORY, HC, HOTEL, DEPT, PROC, status, startAt, endAt, BUYER]
    );
    const arcId = Number(arc.id);
    createdArcIds.push(arcId);
    await db.none(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 100, 'litre', 50)`,
      [arcId, VARIANT_ID]
    );
    return arcId;
  }

  async function invite(arcId, vendorId) {
    await db.none(
      `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1, $2, 'invited')
       ON CONFLICT (arc_id, vendor_id) DO NOTHING`,
      [arcId, vendorId]
    );
  }

  beforeAll(async () => {
    await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = $1`, [BUYER]);
    await db.none(
      `UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = ANY($1::int[])`,
      [[VENDOR_A, VENDOR_B, VENDOR_E]]
    );

    // Stamp vendor_alpha with a company name that differs from the contact-
    // person `name`, so vendor_company is provably distinct. Leave vendor_beta
    // with organization_name = NULL to exercise the fallback-to-vendor_name path.
    savedAlpha = await db.one(`SELECT name, organization_name FROM tbl_users WHERE id = $1`, [VENDOR_A]);
    savedBeta  = await db.one(`SELECT name, organization_name FROM tbl_users WHERE id = $1`, [VENDOR_B]);
    await db.none(`UPDATE tbl_users SET organization_name = $2 WHERE id = $1`,
      [VENDOR_A, "Alpha Distributors Pvt Ltd"]);
    await db.none(`UPDATE tbl_users SET organization_name = NULL WHERE id = $1`, [VENDOR_B]);

    buyerClient   = await httpClient(BUYER);
    alphaClient   = await httpClient(VENDOR_A);
    epsilonClient = await httpClient(VENDOR_E);
  });

  afterAll(async () => {
    // Restore vendor rows to their fixture state.
    await db.none(`UPDATE tbl_users SET name = $2, organization_name = $3 WHERE id = $1`,
      [VENDOR_A, savedAlpha.name, savedAlpha.organization_name]);
    await db.none(`UPDATE tbl_users SET name = $2, organization_name = $3 WHERE id = $1`,
      [VENDOR_B, savedBeta.name, savedBeta.organization_name]);

    if (createdArcIds.length) {
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`, [createdArcIds]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [createdArcIds]);
    }
  });

  // ── Sr 29 ────────────────────────────────────────────────────────────────
  describe("Sr 29 — buyer ARC detail invitations[] carries vendor_company", () => {
    let arcId;

    beforeAll(async () => {
      arcId = await seedArcDirect({
        number: `ARC-GH-29-${Date.now()}`,
        status: "floated",
        startAt: nowIst().subtract(1, "day").format("YYYY-MM-DD HH:mm:ss"),
        endAt: nowIst().add(5, "days").format("YYYY-MM-DD HH:mm:ss"),
      });
      await invite(arcId, VENDOR_A);
      await invite(arcId, VENDOR_B);
    });

    test("GET /arc-v2/:id → invitations[] includes vendor_company = organization_name, and vendor_name (contact person) is still present", async () => {
      const res = await buyerClient.get(`/api/v1/arc-v2/${arcId}`);
      expect(res.status).toBe(200);

      const invitations = res.body.data.invitations;
      expect(Array.isArray(invitations)).toBe(true);

      const alphaRow = invitations.find((i) => Number(i.vendor_id) === Number(VENDOR_A));
      expect(alphaRow).toBeTruthy();
      expect(alphaRow.vendor_company).toBe("Alpha Distributors Pvt Ltd");
      // Additive — the contact-person name must still be present, unchanged.
      expect(alphaRow.vendor_name).toBe(savedAlpha.name);
      expect(alphaRow.vendor_company).not.toBe(alphaRow.vendor_name);

      const betaRow = invitations.find((i) => Number(i.vendor_id) === Number(VENDOR_B));
      expect(betaRow).toBeTruthy();
      // organization_name is NULL for beta — vendor_company comes back null,
      // FE falls back to vendor_name (proven separately in the FE code read);
      // here we just prove the BE doesn't fabricate a company name.
      expect(betaRow.vendor_company == null).toBe(true);
      expect(betaRow.vendor_name).toBe(savedBeta.name);
    });
  });

  // ── Sr 33 ────────────────────────────────────────────────────────────────
  describe("Sr 33 — getRequestDetail enrichment + Group-G guard still intact", () => {
    let openArcId, futureArcId;

    beforeAll(async () => {
      openArcId = await seedArcDirect({
        number: `ARC-GH-33-OPEN-${Date.now()}`,
        status: "floated",
        startAt: nowIst().subtract(1, "day").format("YYYY-MM-DD HH:mm:ss"),
        endAt: nowIst().add(5, "days").format("YYYY-MM-DD HH:mm:ss"),
      });
      await invite(openArcId, VENDOR_A);

      // Group-G fixture: floated, submission_start_at still in the IST future.
      futureArcId = await seedArcDirect({
        number: `ARC-GH-33-FUTURE-${Date.now()}`,
        status: "floated",
        startAt: nowIst().add(2, "hours").format("YYYY-MM-DD HH:mm:ss"),
        endAt: nowIst().add(5, "hours").format("YYYY-MM-DD HH:mm:ss"),
      });
      await invite(futureArcId, VENDOR_A);
    });

    test("invited vendor on an OPEN floated ARC → arc payload carries hotel_name/category_title/department_title", async () => {
      const res = await alphaClient.get(`/api/v1/arc-v2/vendor/requests/${openArcId}`);
      expect(res.status).toBe(200);
      const { arc } = res.body.data;
      expect(arc.hotel_name).toBe("Hotel A-1");
      expect(arc.category_title).toBe("BEVERAGES");
      expect(arc.department_title).toBe("Procurement");
      // hotel_city: fixture hotel has no city set — null-tolerant, but the key
      // must be present (i.e. the enrichment ran, didn't silently omit it).
      expect("hotel_city" in arc).toBe(true);
      expect(arc.hotel_city == null).toBe(true);
    });

    test("REGRESSION (Group G / Sr 27 Option C): floated ARC with FUTURE submission_start_at still 404s for the invited vendor — enrichment must not run before/bypass the guard", async () => {
      const res = await alphaClient.get(`/api/v1/arc-v2/vendor/requests/${futureArcId}`);
      expect(res.status).toBe(404);
      // Must be a clean 404, not a 200 leaking partial/enriched data.
      expect(res.body.data).toBeUndefined();
    });

    test("SECURITY: a non-invited vendor is blocked from reading detail (403) — getRequestDetail must gate on invitation same as getRequestLifecycle", async () => {
      // VENDOR_E (epsilon) was never invited to openArcId. Prior to the fix,
      // getRequestDetail had no invitation-scoped gate, so any vendor with a
      // "live" ARC status could read arc/items/tech-envelope by direct id —
      // that's the vulnerability this test locks in as fixed.
      const res = await epsilonClient.get(`/api/v1/arc-v2/vendor/requests/${openArcId}`);
      expect(res.status).toBe(403);
      expect(res.body.data).toBeUndefined();
      expect(res.body.message).toMatch(/not invited/i);
    });
  });
});
