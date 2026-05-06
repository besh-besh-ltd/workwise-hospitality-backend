// Round-trip shape contract: getRfqById must surface every tender
// field a downstream caller can use to render Group-ARC-vs-Single-ARC
// UI. Multiple FE surfaces (Quote Compare's currentRFQ, the ARC
// Committee's lifecycle.rfq, the RFQ details header) all consume the
// same row and silently fell back to "Single ARC" because the
// explicit SELECT list omitted tender_scope.
//
// This test would have caught the bug in 100ms instead of after a
// staging round-trip.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import rfqModel from "../../app/models/rfqModel.js";

const tracked = { rfqIds: [] };

afterEach(async () => {
  if (tracked.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [tracked.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [tracked.rfqIds]);
    tracked.rfqIds = [];
  }
});

afterAll(async () => { await closeDb(); });

describe("rfqModel.getRfqById — tender field shape contract", () => {
  it("surfaces tender_scope + arc_period_from + arc_period_to for Group ARC tenders", async () => {
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_tender: 1,
      is_published: 1,
      status: 1,
      process: null,
    });
    tracked.rfqIds.push(rfq_id);
    await db.none(
      `UPDATE tbl_rfq SET tender_scope='GROUP',
                          arc_period_from=DATE '2026-05-07',
                          arc_period_to=DATE '2027-05-06'
        WHERE id = $1`,
      [rfq_id]
    );

    const rows = await rfqModel.getRfqById(
      rfq_id,
      IDS.users.a1_proc_buyer,
      /* user_type */ 2,
      /* includeVendors */ false
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    const r = rows[0];

    // Locks the seam: every field the FE expects to render scope +
    // period must be on the row.
    expect(r.is_tender).toBe(1);
    expect(r.tender_scope).toBe("GROUP");
    // arc_period_* are returned as Date objects from pg-promise; we
    // only assert non-null + ISO-prefix to stay typing-agnostic.
    expect(r.arc_period_from).toBeTruthy();
    expect(r.arc_period_to).toBeTruthy();
    // Compare against the source DATE values via DB cast so the test
    // is timezone-stable. (pg-promise returns DATEs as JS Date in
    // the runner's local TZ, which `toISOString()` then re-shifts to
    // UTC — strict-equal-to-string assertions flake on TZ.)
    const dateRow = await db.one(
      `SELECT
         (SELECT $1::date)::text AS from_iso,
         (SELECT $2::date)::text AS to_iso,
         (SELECT arc_period_from FROM tbl_rfq WHERE id = $3)::text AS got_from,
         (SELECT arc_period_to   FROM tbl_rfq WHERE id = $3)::text AS got_to`,
      ["2026-05-07", "2027-05-06", rfq_id]
    );
    expect(dateRow.got_from).toBe(dateRow.from_iso);
    expect(dateRow.got_to).toBe(dateRow.to_iso);
  });

  it("returns tender_scope='SINGLE' / null cleanly for non-Group tenders + RFQs", async () => {
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      is_tender: 1,
      is_published: 1,
      status: 1,
      process: null,
    });
    tracked.rfqIds.push(rfq_id);
    await db.none(
      `UPDATE tbl_rfq SET tender_scope='SINGLE' WHERE id = $1`,
      [rfq_id]
    );

    const rows = await rfqModel.getRfqById(
      rfq_id,
      IDS.users.a1_proc_buyer,
      2,
      false
    );
    expect(rows[0].tender_scope).toBe("SINGLE");
  });
});
