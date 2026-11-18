// ARC v2 — server-stamped audit times leave the API as IST wall clock (REQ-2026-0093).
//
// The buyer's vendor response tracker printed "Submitted · 17 Nov, 09:43" for a quote
// sent at 15:13 IST: `responded_at` / `submitted_at` are stamped by a UTC database clock
// into `timestamp without time zone` columns, and every ARC screen reads naive ARC times
// as IST (the submission window is stored that way). The fix converts those columns at
// the API boundary. These tests pin the stored UTC value and assert what each endpoint
// returns; against the base branch they fail with the raw `09:43:20`.
//
//   1. utcToIstWallClock — the conversion itself (rollover, zones, untouched inputs).
//   2. Buyer GET /arc-v2/:id — invitation responded_at (the tracker) in IST.
//   3. Vendor GET /vendor/requests/:arcId — quote + invitation times in IST;
//      terms_accepted_at (already written in IST) untouched.
//   4. Vendor GET /vendor/quote/:arcId/history — version submitted_at in IST.
//   5. A Manual ARC's typed (IST) times pass through untouched.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";
import { seedAutoApproveArcPolicy, cleanupArcPublishPolicy } from "../../helpers/arcPublishPolicy.js";
import { grantFixtureVendorHotelSubs, revokeVendorSubs } from "../../helpers/arcGroupSeed.js";
import { utcToIstWallClock, istAuditTimes } from "../../../app/helper/arc_v2/arcAuditTime.js";

const STORED_UTC = "2026-11-17 09:43:20";   // what CURRENT_TIMESTAMP wrote (UTC)
const SHOWN_IST  = "2026-11-17 15:13:20";   // what the screens must print

describe("utcToIstWallClock", () => {
  test("adds 5h30m to a naive UTC string", () => {
    expect(utcToIstWallClock(STORED_UTC)).toBe(SHOWN_IST);
    expect(utcToIstWallClock("2026-11-17T09:43:20.123456")).toBe(SHOWN_IST);
  });
  test("rolls over the day, month and year", () => {
    expect(utcToIstWallClock("2026-11-17 20:00:00")).toBe("2026-11-18 01:30:00");
    expect(utcToIstWallClock("2026-12-31 22:15:00")).toBe("2027-01-01 03:45:00");
  });
  test("honours a value that names its own zone, and a Date", () => {
    expect(utcToIstWallClock("2026-11-17T09:43:20Z")).toBe(SHOWN_IST);
    expect(utcToIstWallClock("2026-11-17T15:13:20+05:30")).toBe(SHOWN_IST);
    expect(utcToIstWallClock(new Date(Date.UTC(2026, 10, 17, 9, 43, 20)))).toBe(SHOWN_IST);
  });
  test("leaves empty, date-only and unparseable values alone", () => {
    expect(utcToIstWallClock(null)).toBeNull();
    expect(utcToIstWallClock(undefined)).toBeUndefined();
    expect(utcToIstWallClock("")).toBe("");
    expect(utcToIstWallClock("2026-11-17")).toBe("2026-11-17");
    expect(utcToIstWallClock("not a date")).toBe("not a date");
  });
  test("istAuditTimes converts only the named fields, in place", () => {
    const row = { submitted_at: STORED_UTC, terms_accepted_at: SHOWN_IST, withdrawn_at: null };
    expect(istAuditTimes(row, ["submitted_at", "withdrawn_at"])).toBe(row);
    expect(row).toEqual({ submitted_at: SHOWN_IST, terms_accepted_at: SHOWN_IST, withdrawn_at: null });
    expect(istAuditTimes(null, ["submitted_at"])).toBeNull();
  });
});

describe("ARC v2 — audit times in IST through the API", () => {
  const BUYER = IDS.users.a1_proc_buyer;
  const VENDOR = IDS.users.vendor_alpha;
  const HC = IDS.hospitality.A;
  const HOTEL = IDS.hotels.A1;
  const DEPT = IDS.departments.proc;
  const CATEGORY = TEST_CATEGORIES.beverages;
  const VARIANT_ID = 1;
  const PUBLISH_POLICY_ID = 64933; // auto-approve ARC policy so publish floats

  let buyerClient, vendorClient, arcId, itemId;
  const createdArcIds = [];
  let hotelSubIds = [];

  async function createAndPublish(title) {
    const now = Date.now();
    const res = await buyerClient.post("/api/v1/arc-v2").send({
      title,
      category_id: CATEGORY,
      hotel_id: HOTEL,
      department_id: DEPT,
      eligibility_type: "open",
      submission_start_at: new Date(now - 2 * 86400_000).toISOString(),
      submission_end_at:   new Date(now + 10 * 86400_000).toISOString(),
      contract_start_at:   new Date(now + 30 * 86400_000).toISOString(),
      contract_end_at:     new Date(now + 365 * 86400_000).toISOString(),
      items: [{ product_variant_id: VARIANT_ID, indicative_qty: 100, uom: "litre" }],
    });
    expect(res.status).toBe(200);
    const id = Number(res.body.data.arc.id);
    createdArcIds.push(id);
    const pub = await buyerClient.post(`/api/v1/arc-v2/${id}/publish`).send({});
    expect(pub.status).toBe(200);
    return { id, itemId: Number(res.body.data.items[0].id) };
  }

  // Pin every server-stamped time on the vendor's rows to one known UTC instant.
  async function pinStoredTimes(aId) {
    await db.none(
      `UPDATE tbl_arc_quote SET submitted_at = $3, updated_at = $3, created_at = $3,
              terms_accepted_at = $4
        WHERE arc_id = $1 AND vendor_id = $2`,
      [aId, VENDOR, STORED_UTC, SHOWN_IST]
    );
    await db.none(
      `UPDATE tbl_arc_invitation SET responded_at = $3, invited_at = $3
        WHERE arc_id = $1 AND vendor_id = $2`,
      [aId, VENDOR, STORED_UTC]
    );
    await db.none(
      `UPDATE tbl_arc_quote_version SET submitted_at = $3 WHERE arc_id = $1 AND vendor_id = $2`,
      [aId, VENDOR, STORED_UTC]
    );
  }

  const buyerInvitation = async (aId) => {
    const r = await buyerClient.get(`/api/v1/arc-v2/${aId}`);
    expect(r.status).toBe(200);
    return (r.body.data.invitations || []).find((i) => Number(i.vendor_id) === Number(VENDOR));
  };

  beforeAll(async () => {
    hotelSubIds = await grantFixtureVendorHotelSubs([HOTEL]);
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
    buyerClient = await httpClient(BUYER);
    vendorClient = await httpClient(VENDOR);
    await seedAutoApproveArcPolicy({
      policyId: PUBLISH_POLICY_ID, hospitalityCompanyId: HC, hotelId: HOTEL,
      departmentId: null, processId: null, createdBy: BUYER, approver: BUYER,
    });

    ({ id: arcId, itemId } = await createAndPublish("Audit times · IST"));
    const draft = await vendorClient.post("/api/v1/arc-v2/vendor/quote/draft").send({
      arc_id: arcId, lines: [{ arc_item_id: itemId, rate: 100, gst_pct: 18 }],
    });
    expect(draft.status).toBe(200);
    const submit = await vendorClient.post("/api/v1/arc-v2/vendor/quote/submit").send({ arc_id: arcId });
    expect(submit.status).toBe(200);
    // The submit response is flushed inside its tx; wait for the archived version.
    for (let i = 0; i < 15; i++) {
      const n = await db.one(`SELECT count(*)::int AS n FROM tbl_arc_quote_version WHERE arc_id = $1`, [arcId]);
      if (n.n > 0) break;
      await new Promise((ok) => setTimeout(ok, 40));
    }
    await pinStoredTimes(arcId);
  });

  afterAll(async () => {
    await revokeVendorSubs(hotelSubIds);
    await cleanupArcPublishPolicy({ policyId: PUBLISH_POLICY_ID, arcIds: createdArcIds });
    if (createdArcIds.length) {
      const ids = createdArcIds;
      await db.none(`DELETE FROM tbl_arc_manual_entry WHERE arc_id = ANY($1::int[])`, [ids]);
      await db.none(`DELETE FROM tbl_arc_quote_version WHERE arc_id = ANY($1::int[])`, [ids]);
      await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = ANY($1::text[])`, [ids.map(String)]);
      await db.none(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::int[]))`, [ids]);
      await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::int[])`, [ids]);
      await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::int[])`, [ids]);
      await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::int[])`, [ids]);
      await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [ids]);
      await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [ids]);
    }
    await db.none(`DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`, [CATEGORY, DEPT]);
  });

  test("buyer detail: the tracker's submitted time (invitation responded_at) is IST", async () => {
    const inv = await buyerInvitation(arcId);
    expect(inv).toBeTruthy();
    expect(inv.responded_at).toBe(SHOWN_IST);
    expect(inv.invited_at).toBe(SHOWN_IST);
  });

  test("vendor request detail: quote and invitation times are IST; terms_accepted_at untouched", async () => {
    const r = await vendorClient.get(`/api/v1/arc-v2/vendor/requests/${arcId}`);
    expect(r.status).toBe(200);
    const { quote, invitation } = r.body.data;
    expect(quote.submitted_at).toBe(SHOWN_IST);
    expect(quote.updated_at).toBe(SHOWN_IST);
    expect(quote.terms_accepted_at).toBe(SHOWN_IST); // written in IST, not shifted again
    expect(invitation.responded_at).toBe(SHOWN_IST);
  });

  test("vendor quote history: each version's submitted_at is IST", async () => {
    const r = await vendorClient.get(`/api/v1/arc-v2/vendor/quote/${arcId}/history`);
    expect(r.status).toBe(200);
    expect(r.body.data.versions.length).toBeGreaterThan(0);
    for (const v of r.body.data.versions) expect(v.submitted_at).toBe(SHOWN_IST);
  });

  test("a Manual ARC's typed times pass through untouched", async () => {
    await db.none(
      `INSERT INTO tbl_arc_manual_entry (arc_id, target_stage, entered_by) VALUES ($1, 'floated', $2)`,
      [arcId, BUYER]
    );
    try {
      const inv = await buyerInvitation(arcId);
      expect(inv.responded_at).toBe(STORED_UTC);
    } finally {
      await db.none(`DELETE FROM tbl_arc_manual_entry WHERE arc_id = $1`, [arcId]);
    }
  });
});
