// ARC v2 — Multi-vendor contract generation + OTP sign + ARC activation.
//
// Proves:
//   1. handleArcCommitteeApproval generates one contract per awarded vendor
//      with committed_qty = allocated_qty per line.
//   2. The vendor OTP-sign flow flips the contract status to 'active' and
//      hash-pins the document.
//   3. The parent ARC moves to 'contract_active' only when EVERY vendor
//      contract has been signed.
//
// Bypasses the approval engine and calls the post-approval hook directly so
// the test doesn't need an ARC_COMMITTEE policy seeded. The hook is the same
// one approvalActionService dispatches to in production.

import { httpClient } from "../../helpers/http.js";
import { db } from "../../setup/db.js";
import { IDS } from "../../fixtures/ids.js";
import { TEST_CATEGORIES } from "../../fixtures/vendors.js";

const HC     = IDS.hospitality.A;
const HOTEL  = IDS.hotels.A1;
const DEPT   = IDS.departments.proc;
const PROC   = IDS.processes.A_P1;
const BUYER  = IDS.users.a1_proc_buyer;
const VENDOR_A = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const CATEGORY = TEST_CATEGORIES.beverages;
const VARIANT_ID = 1;

describe("ARC v2 — multi-vendor contract generation + OTP sign", () => {
  let arcId, itemId, quoteLineA, quoteLineB, commId;
  let buyerClient, vendorAClient, vendorBClient;

  beforeAll(async () => {
    await db.none(
      `INSERT INTO tbl_category_department (category_id, department_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CATEGORY, DEPT]
    );
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [BUYER]);
    // Vendor users are user_type=3 in the fixture (vendor portal).
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id IN ($1, $2)`,
      [VENDOR_A, VENDOR_B]);

    buyerClient   = await httpClient(BUYER);
    vendorAClient = await httpClient(VENDOR_A);
    vendorBClient = await httpClient(VENDOR_B);

    // Seed an ARC sitting at 'committee_review' with split allocations recorded.
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at,
          payment_terms_expected, delivery_expected,
          created_by)
       VALUES ('ARC-TEST-CONTRACT-1', 'Contract gen test',
               $1, $2, $3, $4, $5, 'committee_review',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day',
               NOW() + INTERVAL '7 days', NOW() + INTERVAL '180 days',
               'Net 30', 'Within 7 days of call-off',
               $6)
       RETURNING *`,
      [CATEGORY, HC, HOTEL, DEPT, PROC, BUYER]
    );
    arcId = arc.id;
    itemId = (await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, $2, 1000, 'litre', 100) RETURNING *`,
      [arcId, VARIANT_ID]
    )).id;

    const qA = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, payment_terms)
       VALUES ($1, $2, NOW(), 'Net 30') RETURNING *`,
      [arcId, VENDOR_A]
    );
    quoteLineA = (await db.one(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, 90, 5) RETURNING *`,
      [qA.id, itemId]
    )).id;
    const qB = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, payment_terms)
       VALUES ($1, $2, NOW(), 'Net 30') RETURNING *`,
      [arcId, VENDOR_B]
    );
    quoteLineB = (await db.one(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct)
       VALUES ($1, $2, 95, 5) RETURNING *`,
      [qB.id, itemId]
    )).id;

    // Record the split allocation directly (60/40).
    commId = (await db.one(
      `INSERT INTO tbl_arc_comm_evaluation (arc_id, status)
       VALUES ($1, 'finalized') RETURNING *`,
      [arcId]
    )).id;
    await db.none(
      `INSERT INTO tbl_arc_comm_evaluation_award
         (arc_comm_evaluation_id, arc_item_id, awarded_vendor_id,
          awarded_quote_line_id, allocated_qty, l_rank, is_l1_default,
          awarded_quote_snapshot)
       VALUES
         ($1, $2, $3, $4, 600, 'L1', false, $5::jsonb),
         ($1, $2, $6, $7, 400, 'L2', false, $8::jsonb)`,
      [
        commId, itemId,
        VENDOR_A, quoteLineA, JSON.stringify({ rate: 90, gst_pct: 5, payment_terms: 'Net 30' }),
        VENDOR_B, quoteLineB, JSON.stringify({ rate: 95, gst_pct: 5, payment_terms: 'Net 30' }),
      ]
    );
  });

  afterAll(async () => {
    // Tear down in FK order — contract lines + OTPs first, then contracts,
    // then arc event log + comm eval awards, then ARC.
    await db.none(`DELETE FROM tbl_arc_contract_signature_otp
                    WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = $1)`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_contract_line
                    WHERE arc_contract_id IN (SELECT id FROM tbl_arc_contract WHERE arc_id = $1)`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = $1`, [arcId]);
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arcId]);
    await db.none(
      `DELETE FROM tbl_category_department WHERE category_id = $1 AND department_id = $2`,
      [CATEGORY, DEPT]
    );
  });

  test("committee post-approval hook generates one contract per awarded vendor", async () => {
    const { handleArcCommitteeApproval } = await import(
      "../../../app/controllers/arc_v2/arcCommitteeController.js"
    );
    // Simulate the approval engine calling the hook with a fake instance.
    await handleArcCommitteeApproval(99999, BUYER, {
      instance: { id: 99999, entity_type: 'ARC_COMMITTEE', entity_id: arcId, status: 'APPROVED' },
    });

    const contracts = await db.any(
      `SELECT * FROM tbl_arc_contract WHERE arc_id = $1 ORDER BY vendor_id`,
      [arcId]
    );
    expect(contracts.length).toBe(2);
    const vendorIds = contracts.map(c => c.vendor_id).sort((a, b) => a - b);
    expect(vendorIds).toEqual([VENDOR_A, VENDOR_B].sort((a, b) => a - b));
    expect(contracts.every(c => c.status === 'awaiting_acceptance')).toBe(true);

    // Each contract has one line with committed_qty matching the allocation.
    for (const c of contracts) {
      const lines = await db.any(
        `SELECT * FROM tbl_arc_contract_line WHERE arc_contract_id = $1`, [c.id]);
      expect(lines.length).toBe(1);
      const expected = (c.vendor_id === VENDOR_A) ? 600 : 400;
      expect(Number(lines[0].committed_qty)).toBe(expected);
      expect(Number(lines[0].unit_rate)).toBe(c.vendor_id === VENDOR_A ? 90 : 95);
    }

    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arc.status).toBe('awaiting_vendor_acceptance');
  });

  test("Vendor A OTP-signs their contract — contract goes active, ARC stays awaiting", async () => {
    const contracts = await db.any(
      `SELECT * FROM tbl_arc_contract WHERE arc_id = $1 ORDER BY vendor_id`,
      [arcId]
    );
    const contractA = contracts.find(c => c.vendor_id === VENDOR_A);

    const reqRes = await vendorAClient.post(`/api/v1/arc-v2/vendor/contracts/${contractA.id}/otp/request`).send({});
    expect(reqRes.status).toBe(200);
    const devCode = reqRes.body.data.dev_code;
    expect(devCode).toMatch(/^\d{6}$/);

    const verifyRes = await vendorAClient.post(`/api/v1/arc-v2/vendor/contracts/${contractA.id}/otp/verify`).send({ code: devCode });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.contract.status).toBe('active');
    expect(verifyRes.body.data.contract.document_hash).toMatch(/^[a-f0-9]{64}$/);

    // ARC should still be awaiting acceptance — vendor B hasn't signed yet.
    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arc.status).toBe('awaiting_vendor_acceptance');
  });

  test("Vendor B signs — ARC flips to contract_active", async () => {
    const contracts = await db.any(
      `SELECT * FROM tbl_arc_contract WHERE arc_id = $1`, [arcId]);
    const contractB = contracts.find(c => c.vendor_id === VENDOR_B);

    const reqRes = await vendorBClient.post(`/api/v1/arc-v2/vendor/contracts/${contractB.id}/otp/request`).send({});
    expect(reqRes.status).toBe(200);
    const devCode = reqRes.body.data.dev_code;
    const verifyRes = await vendorBClient.post(`/api/v1/arc-v2/vendor/contracts/${contractB.id}/otp/verify`).send({ code: devCode });
    expect(verifyRes.status).toBe(200);

    const arc = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [arcId]);
    expect(arc.status).toBe('contract_active');
  });

  test("wrong OTP attempts are rejected", async () => {
    // Bring up a clean awaiting contract by simulating a third vendor's contract.
    const c = await db.one(
      `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, awaiting_until)
       VALUES ($1, $2, 'awaiting_acceptance', NOW() + INTERVAL '3 days')
       RETURNING *`,
      [arcId, IDS.users.vendor_gamma]
    );
    await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = $1`, [IDS.users.vendor_gamma]);
    const gammaClient = await httpClient(IDS.users.vendor_gamma);

    const reqRes = await gammaClient.post(`/api/v1/arc-v2/vendor/contracts/${c.id}/otp/request`).send({});
    expect(reqRes.status).toBe(200);
    // Verify with a wrong code.
    const wrongRes = await gammaClient.post(`/api/v1/arc-v2/vendor/contracts/${c.id}/otp/verify`).send({ code: '000000' });
    expect(wrongRes.status).toBe(400);
    expect(wrongRes.body.message).toMatch(/OTP/);
  });

  // ── Cross-tenant isolation for ARC buyer-side READ endpoints (IDOR guards) ──
  // Pre-prod QA (2026-07-27): getCommitteeView / getActiveSummary /
  // getVendorDocumentsBundle were acl([2,8])-only (global buyer role, NO tenant
  // scope). companyB_admin (Company B) must NOT read this Company-A ARC by id
  // enumeration. Guarded now via userCanAccessHotel(arc.hotel_id).
  describe("cross-tenant isolation (IDOR guards)", () => {
    beforeAll(async () => {
      await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [IDS.users.companyB_admin]);
    });

    it("getCommitteeView: out-of-scope company-B buyer gets 403; in-scope gets 200", async () => {
      const outClient = await httpClient(IDS.users.companyB_admin);
      const denied = await outClient.get(`/api/v1/arc-v2/committee/${arcId}`);
      expect(denied.status).toBe(403);
      const inClient = await httpClient(BUYER);
      const allowed = await inClient.get(`/api/v1/arc-v2/committee/${arcId}`);
      expect(allowed.status).toBe(200);
    });

    it("getActiveSummary: out-of-scope company-B buyer gets 403", async () => {
      const outClient = await httpClient(IDS.users.companyB_admin);
      const denied = await outClient.get(`/api/v1/arc-v2/${arcId}/active-summary`);
      expect(denied.status).toBe(403);
    });

    it("getVendorDocumentsBundle: out-of-scope company-B buyer gets 403 (no vendor KYC leak)", async () => {
      const c = await db.oneOrNone(`SELECT id FROM tbl_arc_contract WHERE arc_id=$1 ORDER BY id LIMIT 1`, [arcId]);
      expect(c).not.toBeNull(); // contracts generated by the committee hook above
      const outClient = await httpClient(IDS.users.companyB_admin);
      const denied = await outClient.get(`/api/v1/arc-v2/contracts/${c.id}/vendor-documents`);
      expect(denied.status).toBe(403);
    });
  });
});
