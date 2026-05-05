// Phase 9 — proof test for the partial-save fix in saveRfqDraft.
//
// Scenario the wizard exercises in real use:
//   1. Buyer creates a tender draft with sensible defaults (comment +
//      company_name pre-populated, hotel hint, etc.).
//   2. On step-1 of the Tender wizard the buyer commits ONLY tender-
//      shaped fields: tender_scope, period dates, hotel_ids. No filters,
//      no terms, no products body.
//
// Bugs this test was created to nail down (caught 2026-05-05):
//   (a) saveRfqDraft was passing every wizard-shaped key — even the
//       undefined ones — to updateWithTimestamp, so partial saves were
//       writing NULL into NOT NULL columns like comment / company_name
//       and 500'ing.
//   (b) saveRfqDraft also did `filters.global` without an optional
//       chain, so a partial body with no filters block threw a
//       TypeError mid-transaction that rolled the entire UPDATE back.
//
// The proof: after a partial save with only tender fields, the existing
// values for comment/company_name/etc. are PRESERVED, the tender fields
// are PERSISTED, and the buyer never sees a crash.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";

jest.unstable_mockModule("../../app/helper/cronManager.js", () => ({
  scheduleMilestoneReminder: async () => {},
  rescheduleMilestoneReminder: async () => {},
  removeMilestoneReminder: () => {},
  rescheduleAllMilestoneReminders: async () => {},
  scheduleGRNReminders: async () => {},
  publishRfqById: async () => {},
  scheduleRfqPublish: async () => {},
  removeRfqPublishJob: async () => ({ ok: true }),
  rescheduleAllRfqPublishJobs: async () => {},
  startVendorAcceptanceReminderCron: () => {},
  scheduleNegotiationRoundExpiration: () => {},
  removeNegotiationRoundExpiration: () => {},
  rescheduleAllNegotiationRoundExpirations: async () => {},
}));

const { default: rfqController } = await import(
  "../../app/controllers/rfq/rfqController.js"
);

const TENDER_PROCESS_ID = 70093;
beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_approval_processes
       (id, company_id, name, description, is_active, created_by, process_type)
     VALUES ($1, $2, 'Tender Single Hotel — partial save test', '', true, $3, 'TENDER')
     ON CONFLICT (id) DO NOTHING`,
    [TENDER_PROCESS_ID, IDS.companies.A, IDS.users.companyA_admin]
  );
});
afterAll(async () => {
  await db.none(`DELETE FROM tbl_approval_processes WHERE id = $1`, [TENDER_PROCESS_ID]);
  await closeDb();
});

const inserted = { rfqIds: [] };
afterEach(async () => {
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
    inserted.rfqIds = [];
  }
});

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: { user: opts.user, params: opts.params || {}, body: opts.body || {} },
    res, next: jest.fn(), calls,
  };
}

// Use bare YYYY-MM-DD strings so timezone-aware Date conversions don't
// shift the day in the assertion. The controller's normalizeDate path
// appends T00:00:00 to bare dates, then the column stores DATE (no time).
const FROM_DATE = "2027-01-01";
const TO_DATE = "2027-12-31";
const FROM_DATE_GROUP = "2027-02-01";
const TO_DATE_GROUP = "2028-01-31";

function dateColumnAsIso(value) {
  // pg-promise returns DATE columns as JS Date in local TZ. Use the
  // local YYYY-MM-DD slice so the comparison stays in the same TZ as
  // the original input string.
  const d = new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("saveRfqDraft — partial body with only tender fields", () => {
  it("preserves the existing comment/company_name and persists the tender fields", async () => {
    // Existing draft pre-populated with the values the buyer wouldn't
    // resend on a step-1-only save.
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      is_tender: 1,
      status: 0,
      is_published: 0,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      process: TENDER_PROCESS_ID,
      comment: "Initial tender brief — keep me intact",
      company_name: "Acme Hospitality Pvt Ltd",
      title: "RC for HK chemicals",
    });
    inserted.rfqIds.push(rfq_id);

    // Body the wizard step-1 sends: tender-shape only. No filters, no
    // terms, no products, no comment / company_name re-send.
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        rfq_id,
        is_tender: 1,
        tender_scope: "SINGLE",
        process_id: TENDER_PROCESS_ID,
        hotel_ids: [IDS.hotels.A1],
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        arc_period_from: FROM_DATE,
        arc_period_to: TO_DATE,
      },
    });

    await rfqController.saveDraft(m.req, m.res);

    // The save must NOT 500 with a NOT NULL violation or a TypeError.
    // Either the controller returns success or it returns a status 0 /
    // 2 / 3 with a structured error; what matters is "no crash".
    expect([null, 200, 201]).toContain(m.calls.status);

    // Existing fields preserved — proves the NULL-coalesce bug is fixed.
    const after = await db.one(
      `SELECT comment, company_name, title, tender_scope, arc_period_from, arc_period_to,
              process_id, hospitality_company_id, hotel_id, is_tender
       FROM tbl_rfq WHERE id = $1`,
      [rfq_id]
    );
    expect(after.comment).toBe("Initial tender brief — keep me intact");
    expect(after.company_name).toBe("Acme Hospitality Pvt Ltd");
    expect(after.title).toBe("RC for HK chemicals");

    // Tender fields persisted — proves the partial save actually wrote
    // the new values rather than rolling back from a downstream throw.
    expect(after.tender_scope).toBe("SINGLE");
    expect(dateColumnAsIso(after.arc_period_from)).toBe(FROM_DATE);
    expect(dateColumnAsIso(after.arc_period_to)).toBe(TO_DATE);
    expect(after.process_id).toBe(TENDER_PROCESS_ID);
    expect(after.hospitality_company_id).toBe(IDS.hospitality.A);
    expect(after.hotel_id).toBe(IDS.hotels.A1);
    expect(after.is_tender).toBe(1);

    // Hotel mapping reconciled — covers the legacy single-hotel field
    // and the new tbl_rfq_hotel_mappings junction in lockstep.
    const mappings = await db.any(
      `SELECT hotel_id FROM tbl_rfq_hotel_mappings WHERE rfq_id = $1 ORDER BY hotel_id`,
      [rfq_id]
    );
    expect(mappings.map((m) => m.hotel_id)).toEqual([IDS.hotels.A1]);
  });

  it("handles a Group-ARC partial save with multiple hotels and no filters block", async () => {
    const { rfq_id } = await makeRFQ(db, {
      createdBy: IDS.users.a1_proc_buyer,
      is_tender: 1,
      status: 0,
      is_published: 0,
      hospitality: IDS.hospitality.A,
      hotel: IDS.hotels.A1,
      process: TENDER_PROCESS_ID,
      comment: "Group ARC pilot — chemicals",
      company_name: "Phileein Hospitality",
      title: "Group RC HK chemicals",
    });
    inserted.rfqIds.push(rfq_id);

    const m = mockExpress({
      user: { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A },
      body: {
        rfq_id,
        is_tender: 1,
        tender_scope: "GROUP",
        // process_id deliberately omitted — Group ARC routes to the
        // global hierarchy in the Hospitality Network, no per-process
        // config required.
        hotel_ids: [IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3],
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
        arc_period_from: FROM_DATE_GROUP,
        arc_period_to: TO_DATE_GROUP,
      },
    });

    await rfqController.saveDraft(m.req, m.res);

    expect([null, 200, 201]).toContain(m.calls.status);

    const after = await db.one(
      `SELECT comment, company_name, tender_scope, arc_period_from, arc_period_to
       FROM tbl_rfq WHERE id = $1`,
      [rfq_id]
    );
    expect(after.comment).toBe("Group ARC pilot — chemicals");
    expect(after.company_name).toBe("Phileein Hospitality");
    expect(after.tender_scope).toBe("GROUP");
    expect(dateColumnAsIso(after.arc_period_from)).toBe(FROM_DATE_GROUP);
    expect(dateColumnAsIso(after.arc_period_to)).toBe(TO_DATE_GROUP);

    const mappings = await db.any(
      `SELECT hotel_id FROM tbl_rfq_hotel_mappings WHERE rfq_id = $1 ORDER BY hotel_id`,
      [rfq_id]
    );
    expect(mappings.map((r) => r.hotel_id)).toEqual([
      IDS.hotels.A1, IDS.hotels.A2, IDS.hotels.A3,
    ]);
  });
});
