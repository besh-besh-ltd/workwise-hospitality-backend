// ARC expiry sweep — behavioural integration tests.
//
// Exercises runArcExpirySweep against a REAL seeded ARC + REAL Postgres.
// nodemailer is stubbed by jestEnv.js; sendMail is additionally intercepted via
// the common.js module mock (same pattern as arc.notifications.test.js) so the
// email channel is observable without SMTP.
//
// Observable contracts:
//   - An ARC whose contract_end_at has passed flips tbl_arc + tbl_arc_contract
//     to 'expired' and notifies creator + awarded vendor (EXPIRED).
//   - An ARC N days from contract_end_at (N in 30/15/7/1) flips to
//     'expiring_soon' and notifies (EXPIRING_SOON, with daysLeft).
//   - An ARC far from expiry / not a live contract is untouched.
//   - Re-running the sweep the same day does NOT duplicate notifications.
//
// Dates are seeded relative to the REAL `now` so the event-log idempotency
// guard (at::date = today) aligns with the sweep's date window.

import { describe, test, expect, beforeAll, afterAll, jest } from "@jest/globals";

// ── Email interception (must be registered BEFORE the service import) ─────────
const mailCalls = [];
jest.unstable_mockModule("../../../app/helper/common.js", () => ({
  sendMail: async (opts) => { mailCalls.push(opts); return { messageId: "<test-mock-mail>" }; },
  logError: (..._args) => { /* swallow */ },
}));

const { runArcExpirySweep } = await import("../../../app/services/arcExpiryService.js");

import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const BUYER    = IDS.users.a1_proc_buyer;   // ARC creator
const VENDOR   = IDS.users.vendor_alpha;    // awarded vendor
const HOTEL    = IDS.hotels.A1;
const DEPT     = IDS.departments.proc;
const HC       = IDS.hospitality.A;
const CATEGORY = TEST_CATEGORIES.beverages;
const PROC     = IDS.processes.A_P1;

const now = new Date();
function plusDays(n) {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const createdArcIds = [];

/** Insert an ARC with an explicit status + contract_end_at (date string). */
async function insertArc({ status, contractEndAt, label }) {
  const row = await db.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
        process_id, status, created_by,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at,
        eligibility_type, escalation_clause_json, sub_category_ids)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9,
        NOW() - INTERVAL '60 days', NOW() - INTERVAL '40 days',
        NOW() - INTERVAL '30 days', $10::date,
        'open', '{}'::jsonb, '[]'::jsonb)
     RETURNING id`,
    [
      `ARC-EXP-${label}-${Date.now()}`, `Expiry Test ${label}`, CATEGORY, HC, HOTEL, DEPT,
      PROC, status, BUYER, contractEndAt,
    ]
  );
  createdArcIds.push(Number(row.id));
  return Number(row.id);
}

/** Insert an awarded contract row (so AWARDED_VENDORS resolves). */
async function insertAwardedVendor(arcId, contractStatus = "active") {
  await db.none(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (arc_id, vendor_id) DO UPDATE SET status = EXCLUDED.status`,
    [arcId, VENDOR, contractStatus]
  );
}

async function notifRows(arcId, type) {
  return db.any(
    `SELECT recipient_user_id, type, title, message
       FROM tbl_notifications
      WHERE additional_data->>'arc_id' = $1 AND type = $2
      ORDER BY recipient_user_id`,
    [String(arcId), type]
  );
}
async function arcStatus(arcId) {
  const r = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
  return r.status;
}
async function contractStatus(arcId) {
  const r = await db.one(`SELECT status FROM tbl_arc_contract WHERE arc_id = $1 AND vendor_id = $2`, [arcId, VENDOR]);
  return r.status;
}

beforeAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
});

afterAll(async () => {
  for (const arcId of createdArcIds) {
    await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'arc_id' = $1`, [String(arcId)]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  }
});

describe("ARC expiry sweep — runArcExpirySweep", () => {
  test("expired: live ARC past contract_end_at flips to 'expired' and notifies creator + awarded vendor", async () => {
    const arcId = await insertArc({ status: "contract_active", contractEndAt: plusDays(-5), label: "past" });
    await insertAwardedVendor(arcId, "active");

    await runArcExpirySweep({ now });

    expect(await arcStatus(arcId)).toBe("expired");
    expect(await contractStatus(arcId)).toBe("expired");

    const rows = await notifRows(arcId, "EXPIRED");
    const recipients = rows.map((r) => Number(r.recipient_user_id)).sort((a, b) => a - b);
    expect(recipients).toEqual([BUYER, VENDOR].sort((a, b) => a - b));
  });

  test("expiring_soon: ARC exactly 30 days out flips to 'expiring_soon' and notifies with daysLeft", async () => {
    const arcId = await insertArc({ status: "contract_active", contractEndAt: plusDays(30), label: "d30" });
    await insertAwardedVendor(arcId, "active");

    await runArcExpirySweep({ now });

    expect(await arcStatus(arcId)).toBe("expiring_soon");
    expect(await contractStatus(arcId)).toBe("expiring_soon");

    const rows = await notifRows(arcId, "EXPIRING_SOON");
    expect(rows.length).toBe(2); // creator + vendor
    expect(rows.some((r) => /30 days/.test(r.message))).toBe(true);
  });

  test("expiring_soon: ARC exactly 7 days out notifies (daysLeft 7)", async () => {
    const arcId = await insertArc({ status: "contract_active", contractEndAt: plusDays(7), label: "d7" });
    await insertAwardedVendor(arcId, "active");

    await runArcExpirySweep({ now });

    expect(await arcStatus(arcId)).toBe("expiring_soon");
    const rows = await notifRows(arcId, "EXPIRING_SOON");
    expect(rows.length).toBe(2);
    expect(rows.some((r) => /7 days/.test(r.message))).toBe(true);
  });

  test("far from expiry: ARC 200 days out is untouched (no notification, status unchanged)", async () => {
    const arcId = await insertArc({ status: "contract_active", contractEndAt: plusDays(200), label: "far" });
    await insertAwardedVendor(arcId, "active");

    await runArcExpirySweep({ now });

    expect(await arcStatus(arcId)).toBe("contract_active");
    expect((await notifRows(arcId, "EXPIRING_SOON")).length).toBe(0);
    expect((await notifRows(arcId, "EXPIRED")).length).toBe(0);
  });

  test("not a live contract: a floated ARC past its date is NOT expired", async () => {
    const arcId = await insertArc({ status: "floated", contractEndAt: plusDays(-5), label: "floated" });

    await runArcExpirySweep({ now });

    expect(await arcStatus(arcId)).toBe("floated");
    expect((await notifRows(arcId, "EXPIRED")).length).toBe(0);
  });

  test("idempotent: re-running the same day does NOT duplicate EXPIRED or EXPIRING_SOON notifications", async () => {
    const expiredArc  = await insertArc({ status: "contract_active", contractEndAt: plusDays(-3), label: "idem-exp" });
    await insertAwardedVendor(expiredArc, "active");
    const soonArc     = await insertArc({ status: "contract_active", contractEndAt: plusDays(15), label: "idem-soon" });
    await insertAwardedVendor(soonArc, "active");

    await runArcExpirySweep({ now });
    await runArcExpirySweep({ now }); // second run, same day

    expect((await notifRows(expiredArc, "EXPIRED")).length).toBe(2);      // not 4
    expect((await notifRows(soonArc, "EXPIRING_SOON")).length).toBe(2);   // not 4
  });

  test("already expired: an ARC already in 'expired' is not re-notified", async () => {
    const arcId = await insertArc({ status: "expired", contractEndAt: plusDays(-10), label: "already" });
    await insertAwardedVendor(arcId, "expired");

    await runArcExpirySweep({ now });

    expect((await notifRows(arcId, "EXPIRED")).length).toBe(0);
  });
});
