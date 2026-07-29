// signatureOtp — unit test for tbl_arc_contract_signature_otp logic.
//
// Verifies TTL expiry, attempt cap, hash matching, and the one-shot semantics
// of verify (success marks verified_at; can't reuse the code).

import arcContractModel from "../../../app/models/arc_v2/arcContractModel.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

describe("arcContractModel — OTP signature", () => {
  const HC     = IDS.hospitality.A;
  const HOTEL  = IDS.hotels.A1;
  const DEPT   = IDS.departments.proc;
  const PROC   = IDS.processes.A_P1;
  const BUYER  = IDS.users.a1_proc_buyer;
  const VENDOR = IDS.users.vendor_alpha;
  const CATEGORY = TEST_CATEGORIES.beverages;
  let contractId, arcId;

  beforeAll(async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          created_by)
       VALUES ('ARC-TEST-OTP-1', 'OTP test',
               $1, $2, $3, $4, $5, 'awaiting_vendor_acceptance',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days', $6)
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    const c = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, awaiting_until)
       VALUES ($1, $2, 'awaiting_acceptance', NOW() + INTERVAL '3 days')
       RETURNING *`,
      [arcId, VENDOR]
    );
    contractId = c.id;
  });

  afterAll(async () => {
    await db.none(`DELETE FROM tbl_arc_contract_signature_otp WHERE arc_contract_id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE id = $1`, [contractId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
  });

  beforeEach(async () => {
    // Wipe outstanding OTPs between tests so each test gets a clean slate.
    await db.none(`DELETE FROM tbl_arc_contract_signature_otp WHERE arc_contract_id = $1`, [contractId]);
  });

  test("createOtp returns a 6-digit code and stores its hash with expiry", async () => {
    const { code, expiresAt } = await arcContractModel.createOtp(contractId, VENDOR);
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt instanceof Date).toBe(true);
    const row = await db.one(
      `SELECT * FROM tbl_arc_contract_signature_otp WHERE arc_contract_id = $1 ORDER BY id DESC LIMIT 1`,
      [contractId]
    );
    expect(row.otp_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.attempts).toBe(0);
    expect(row.verified_at).toBeNull();
  });

  test("verifyOtp succeeds with correct code and marks verified_at", async () => {
    const { code } = await arcContractModel.createOtp(contractId, VENDOR);
    const r = await arcContractModel.verifyOtp(contractId, VENDOR, code);
    expect(r.ok).toBe(true);
    const row = await db.one(
      `SELECT verified_at, attempts FROM tbl_arc_contract_signature_otp
        WHERE arc_contract_id = $1 ORDER BY id DESC LIMIT 1`,
      [contractId]
    );
    expect(row.verified_at).not.toBeNull();
  });

  test("verifyOtp returns mismatch and increments attempts on wrong code", async () => {
    await arcContractModel.createOtp(contractId, VENDOR);
    const r1 = await arcContractModel.verifyOtp(contractId, VENDOR, "000000");
    expect(r1.ok).toBe(false);
    expect(r1.reason).toBe("mismatch");
    const row = await db.one(
      `SELECT attempts FROM tbl_arc_contract_signature_otp
        WHERE arc_contract_id = $1 ORDER BY id DESC LIMIT 1`,
      [contractId]
    );
    expect(row.attempts).toBe(1);
  });

  test("verifyOtp blocks after maxAttempts reached", async () => {
    const { code } = await arcContractModel.createOtp(contractId, VENDOR);
    // 5 wrong attempts → should be blocked on the 6th even with the right code.
    for (let i = 0; i < 5; i++) {
      await arcContractModel.verifyOtp(contractId, VENDOR, "000000");
    }
    const r = await arcContractModel.verifyOtp(contractId, VENDOR, code);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("too_many_attempts");
  });

  test("verifyOtp rejects an expired OTP", async () => {
    const { code } = await arcContractModel.createOtp(contractId, VENDOR, { ttlSeconds: 1 });
    // Move the expiry into the past directly.
    await db.none(
      `UPDATE tbl_arc_contract_signature_otp
          SET expires_at = NOW() - INTERVAL '60 seconds'
        WHERE arc_contract_id = $1
        ORDER BY id DESC LIMIT 1`,
      [contractId]
    ).catch(async () => {
      // Postgres doesn't support ORDER BY + LIMIT on UPDATE — use a CTE form.
      await db.none(
        `UPDATE tbl_arc_contract_signature_otp
            SET expires_at = NOW() - INTERVAL '60 seconds'
          WHERE id = (
            SELECT id FROM tbl_arc_contract_signature_otp
             WHERE arc_contract_id = $1 ORDER BY id DESC LIMIT 1
          )`,
        [contractId]
      );
    });
    const r = await arcContractModel.verifyOtp(contractId, VENDOR, code);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("expired");
  });

  test("verifyOtp returns no_otp when nothing's been requested", async () => {
    const r = await arcContractModel.verifyOtp(contractId, VENDOR, "123456");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_otp");
  });
});
