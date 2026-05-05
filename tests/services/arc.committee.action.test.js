// Phase 9 — product-level tests for the ARC committee per-cell action
// flow. Covers the spine of Phase 3:
//
//   - Buyer/committee user calls POST /arc/tender/:rfq_id/action with
//     action='approve' | 'reject' for each (product, vendor) cell.
//   - Each call runs the central executeApprovalAction → submitAction
//     → handleArcPostApproval pipeline.
//
// The committee-observable outcomes for an envelope:
//   * Some pending after a decision        → status PARTIALLY_DECIDED
//   * All decided, all rejected            → status VOID (no PDF)
//   * All decided, ≥1 approved             → status ACTIVE +
//                                             document_url populated +
//                                             ARC_DOC_GENERATED +
//                                             ARC_ACTIVE lifecycle events
//   * Approve transitions tbl_arc_item.status → APPROVED with
//     approved_at, approved_by populated
//   * Reject also kicks the resetQuoteFinalizationForSendback path so
//     the buyer's stale finalization row goes away
//
// The PDF + S3 dependencies are mocked (real Puppeteer would slow each
// test by ~1-2s and S3 needs AWS env). The mocks are tight: they only
// cover the dependency surface, not the handler logic itself.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import arcModel from "../../app/models/arcModel.js";

// 1. Cron — same pattern as the rest of the suite.
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

// 2. ARC document controller — Puppeteer is heavyweight; we only care
//    that handleArcPostApproval calls it and threads its result. The
//    mock writes a real (but tiny) PDF file so uploadToS3's
//    fs.existsSync check passes.
const fakePdfPath = path.join(os.tmpdir(), `arc-mock-${process.pid}.pdf`);
fs.writeFileSync(fakePdfPath, "%PDF-1.4 stub\n%%EOF");
jest.unstable_mockModule("../../app/controllers/arc/arcDocumentController.js", () => ({
  generateAwardDocument: async () => ({ ok: true, absolutePath: fakePdfPath }),
  sendAwardDocumentToVendor: async () => ({ ok: true }),
}));

// 3. AWS SDK — uploadToS3 wraps PutObjectCommand. Stub the client so
//    no network call is made and the handler sees a clean upload.
jest.unstable_mockModule("@aws-sdk/client-s3", () => ({
  PutObjectCommand: class { constructor(p) { Object.assign(this, p); } },
  GetObjectCommand: class { constructor(p) { Object.assign(this, p); } },
  S3Client: class { async send() { return { ETag: '"mocked-etag"' }; } },
}));

// Set the env vars uploadToS3 reads to construct the URL.
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || "test-bucket";
process.env.AWS_REGION = process.env.AWS_REGION || "ap-south-1";

const { default: arcController } = await import(
  "../../app/controllers/arc/arcController.js"
);

const TENDER_PROCESS_ID = 70095;
const ARC_POLICY_ID = 60095;

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_approval_processes
       (id, company_id, name, description, is_active, created_by, process_type)
     VALUES ($1, $2, 'Tender Single Hotel — committee test', '', true, $3, 'TENDER')
     ON CONFLICT (id) DO NOTHING`,
    [TENDER_PROCESS_ID, IDS.companies.A, IDS.users.companyA_admin]
  );
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped, version,
        company_id, is_global)
     VALUES ($1, 'ARC', $2, $3, NULL, true, $4, $5, false, false, 1, $6, 0)
     ON CONFLICT (id) DO NOTHING`,
    [ARC_POLICY_ID, IDS.hospitality.A, IDS.hotels.A1,
     IDS.users.companyA_admin, TENDER_PROCESS_ID, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ANY', 'USER', $2)
     ON CONFLICT DO NOTHING`,
    [ARC_POLICY_ID, IDS.users.a1_proc_commApp]
  );
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [ARC_POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [ARC_POLICY_ID]);
  await db.none(`DELETE FROM tbl_approval_processes WHERE id = $1`, [TENDER_PROCESS_ID]);
  try { fs.unlinkSync(fakePdfPath); } catch (_) {}
  await closeDb();
});

const inserted = { rfqIds: [] };
afterEach(async () => {
  if (inserted.rfqIds.length) {
    const ids = inserted.rfqIds;
    await db.none(
      `DELETE FROM tbl_approval_actions
       WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances
         WHERE entity_type = 'ARC' AND entity_id IN (
           SELECT id FROM tbl_arc_item WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))
         )
       )`, [ids]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers
       WHERE approval_instance_step_id IN (
         SELECT s.id FROM tbl_approval_instance_steps s
         JOIN tbl_approval_instances i ON i.id = s.approval_instance_id
         WHERE i.entity_type = 'ARC' AND i.entity_id IN (
           SELECT id FROM tbl_arc_item WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))
         )
       )`, [ids]);
    await db.none(
      `DELETE FROM tbl_approval_instance_steps
       WHERE approval_instance_id IN (
         SELECT id FROM tbl_approval_instances
         WHERE entity_type = 'ARC' AND entity_id IN (
           SELECT id FROM tbl_arc_item WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))
         )
       )`, [ids]);
    await db.none(
      `DELETE FROM tbl_approval_instances
       WHERE entity_type = 'ARC' AND entity_id IN (
         SELECT id FROM tbl_arc_item WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))
       )`, [ids]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))`, [ids]);
    await db.none(`DELETE FROM tbl_arc_hotels WHERE arc_id IN (SELECT id FROM tbl_arc WHERE rfq_id = ANY($1::int[]))`, [ids]);
    await db.none(`DELETE FROM tbl_arc WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'TENDER' AND entity_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [ids]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
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

/**
 * Build a tender at the ARC committee stage: 2 products × 2 vendors,
 * one envelope per vendor, 2 arc_items per envelope, one PENDING ARC
 * approval instance per arc_item — exactly the shape Phase 2 leaves
 * behind after multi-vendor finalize.
 */
async function makeArcCommitteeFixture() {
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, process_id, is_tender, tender_publish_date,
        vendor_clarification_date, title, rfq_type, tender_scope, arc_period_from, arc_period_to)
     VALUES (nextval('tbl_rfq_id_seq'), 'committee fixture', 'Phileein', 'a@b.test',
             'C', '+91-9999999999', NOW() + INTERVAL '7 days', 'Loc', 1, 1,
             $1, $1, NOW(), $2, $3, $4, 1, NOW() + INTERVAL '1 day',
             NOW() + INTERVAL '5 days', 'Committee fixture', 'TENDER', 'SINGLE',
             NOW()::date, (NOW() + INTERVAL '365 days')::date)
     RETURNING id, rfq_no`,
    [IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, TENDER_PROCESS_ID]
  );
  inserted.rfqIds.push(rfq.id);
  await db.none(
    `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [rfq.id, IDS.hotels.A1, IDS.users.a1_proc_buyer]
  );
  const products = {};
  for (const pv of [1, 2]) {
    products[pv] = (await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq.id, pv]
    )).id;
  }

  const envelopes = {};
  const items = {};
  for (const vendorId of [IDS.users.vendor_alpha, IDS.users.vendor_beta]) {
    const env = await arcModel.ensureEnvelope({
      rfq_id: rfq.id,
      vendor_id: vendorId,
      created_by: IDS.users.a1_proc_buyer,
    });
    envelopes[vendorId] = env.id;
    items[vendorId] = {};
    for (const pv of [1, 2]) {
      const it = await arcModel.upsertItem({
        arc_id: env.id,
        rfq_product_id: products[pv],
        product_variant_id: pv,
        variant: 0,
        quote_id: 0,
        unit_price: pv === 1 ? 100 : 200,
      });
      // Per-cell ARC approval instance.
      const inst = await db.one(
        `INSERT INTO tbl_approval_instances
          (entity_type, entity_id, approval_policy_id, status, current_step,
           hospitality_company_id, hotel_id, initiated_by, metadata)
         VALUES ('ARC', $1, $2, 'PENDING', 1, $3, $4, $5, $6::jsonb)
         RETURNING id`,
        [it.id, ARC_POLICY_ID, IDS.hospitality.A, IDS.hotels.A1, IDS.users.a1_proc_buyer,
         JSON.stringify({ rfq_id: rfq.id, arc_id: env.id, arc_item_id: it.id, rfq_product_id: products[pv] })]
      );
      const step = await db.one(
        `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
         VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
        [inst.id]
      );
      await db.none(
        `INSERT INTO tbl_approval_step_approvers
           (approval_instance_step_id, approver_user_id, status)
         VALUES ($1, $2, 'PENDING')`,
        [step.id, IDS.users.a1_proc_commApp]
      );
      await arcModel.setItemApprovalInstance({ arc_item_id: it.id, approval_instance_id: inst.id });
      items[vendorId][pv] = { ...it, approval_instance_id: inst.id, approval_instance_step_id: step.id };
    }
  }

  // Seed a finalization row per cell so REJECT's reset path has work to do.
  for (const vendorId of [IDS.users.vendor_alpha, IDS.users.vendor_beta]) {
    for (const pv of [1, 2]) {
      await db.none(
        `INSERT INTO tbl_quote_finalization
          (rfq_id, rfq_no, product_variant_id, vendor_id, quote_id, created_by, variant)
         VALUES ($1, $2, $3, $4, 0, $5, 0)`,
        [rfq.id, rfq.rfq_no, pv, vendorId, IDS.users.a1_proc_buyer]
      );
    }
  }

  return { rfq, products, envelopes, items };
}

describe("ARC committee — per-cell action flow", () => {
  it("approves all 4 cells → both envelopes go ACTIVE with document_url populated", async () => {
    const { rfq, envelopes, items } = await makeArcCommitteeFixture();

    // Approve all 4 cells via the public action endpoint.
    for (const vendorId of [IDS.users.vendor_alpha, IDS.users.vendor_beta]) {
      for (const pv of [1, 2]) {
        const it = items[vendorId][pv];
        const m = mockExpress({
          user: { id: IDS.users.a1_proc_commApp, company_id: IDS.companies.A },
          params: { rfq_id: rfq.id },
          body: {
            action: "approve",
            approval_instance_id: it.approval_instance_id,
            approval_instance_step_id: it.approval_instance_step_id,
            remarks: "OK",
          },
        });
        await arcController.performAction(m.req, m.res);
        expect([200, 201, null]).toContain(m.calls.status);
      }
    }

    // Each arc_item APPROVED.
    const approvedItems = await db.any(
      `SELECT * FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`,
      [Object.values(envelopes)]
    );
    expect(approvedItems.length).toBe(4);
    approvedItems.forEach((it) => {
      expect(it.status).toBe("APPROVED");
      expect(it.approved_at).toBeTruthy();
      expect(it.approved_by).toBe(IDS.users.a1_proc_commApp);
    });

    // Each envelope reaches ACTIVE with document_url set (mock S3 url).
    const finalEnvelopes = await db.any(
      `SELECT * FROM tbl_arc WHERE id = ANY($1::int[])`,
      [Object.values(envelopes)]
    );
    expect(finalEnvelopes.length).toBe(2);
    finalEnvelopes.forEach((env) => {
      expect(env.status).toBe("ACTIVE");
      expect(env.document_url).toBeTruthy();
      // Document URL should be the S3-style URL the upload helper produces.
      expect(env.document_url).toMatch(/^https:\/\/[\w.-]+\.s3\.[\w-]+\.amazonaws\.com\/arc-documents\//);
      expect(env.document_generated_at).toBeTruthy();
    });

    // Lifecycle: ARC_DOC_GENERATED + ARC_ACTIVE one per envelope.
    const lifecycle = await db.any(
      `SELECT stage FROM tbl_lifecycle_history
        WHERE entity_type = 'TENDER' AND entity_id = $1
          AND stage IN ('ARC_DOC_GENERATED', 'ARC_ACTIVE')
        ORDER BY id`,
      [rfq.id]
    );
    const docCount = lifecycle.filter((l) => l.stage === "ARC_DOC_GENERATED").length;
    const activeCount = lifecycle.filter((l) => l.stage === "ARC_ACTIVE").length;
    expect(docCount).toBe(2);
    expect(activeCount).toBe(2);
  });

  it("partial decisions keep the envelope at PARTIALLY_DECIDED until the last item is decided", async () => {
    const { rfq, envelopes, items } = await makeArcCommitteeFixture();

    // Approve only the first cell of vendor_alpha.
    const firstCell = items[IDS.users.vendor_alpha][1];
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_commApp, company_id: IDS.companies.A },
      params: { rfq_id: rfq.id },
      body: {
        action: "approve",
        approval_instance_id: firstCell.approval_instance_id,
        approval_instance_step_id: firstCell.approval_instance_step_id,
        remarks: "OK",
      },
    });
    await arcController.performAction(m.req, m.res);
    expect([200, 201, null]).toContain(m.calls.status);

    const env = await db.one(
      `SELECT status, document_url FROM tbl_arc WHERE id = $1`,
      [envelopes[IDS.users.vendor_alpha]]
    );
    expect(env.status).toBe("PARTIALLY_DECIDED");
    expect(env.document_url).toBeNull();

    // The other vendor's envelope is untouched — still PENDING_COMMITTEE.
    const otherEnv = await db.one(
      `SELECT status FROM tbl_arc WHERE id = $1`,
      [envelopes[IDS.users.vendor_beta]]
    );
    expect(otherEnv.status).toBe("PENDING_COMMITTEE");
  });

  it("rejecting all items in an envelope marks it VOID and triggers finalization reset", async () => {
    const { rfq, envelopes, items } = await makeArcCommitteeFixture();

    // Reject both cells of vendor_alpha.
    for (const pv of [1, 2]) {
      const it = items[IDS.users.vendor_alpha][pv];
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_commApp, company_id: IDS.companies.A },
        params: { rfq_id: rfq.id },
        body: {
          action: "reject",
          approval_instance_id: it.approval_instance_id,
          approval_instance_step_id: it.approval_instance_step_id,
          remarks: "Price out of band",
        },
      });
      await arcController.performAction(m.req, m.res);
      expect([200, 201, null]).toContain(m.calls.status);
    }

    const env = await db.one(`SELECT * FROM tbl_arc WHERE id = $1`, [envelopes[IDS.users.vendor_alpha]]);
    expect(env.status).toBe("VOID");
    expect(env.document_url).toBeNull();

    // Vendor-alpha finalization rows wiped (resetQuoteFinalizationForSendback).
    const finRows = await db.any(
      `SELECT id FROM tbl_quote_finalization WHERE rfq_id = $1 AND vendor_id = $2`,
      [rfq.id, IDS.users.vendor_alpha]
    );
    expect(finRows.length).toBe(0);

    // Vendor-beta's finalization rows + envelope are untouched.
    const betaFin = await db.any(
      `SELECT id FROM tbl_quote_finalization WHERE rfq_id = $1 AND vendor_id = $2`,
      [rfq.id, IDS.users.vendor_beta]
    );
    expect(betaFin.length).toBe(2);
    const betaEnv = await db.one(`SELECT status FROM tbl_arc WHERE id = $1`, [envelopes[IDS.users.vendor_beta]]);
    expect(betaEnv.status).toBe("PENDING_COMMITTEE");

    const lifecycleVoid = await db.any(
      `SELECT id FROM tbl_lifecycle_history
        WHERE entity_type = 'TENDER' AND entity_id = $1 AND stage = 'ARC_VOID'`,
      [rfq.id]
    );
    expect(lifecycleVoid.length).toBe(1);
  });

  it("mixed approve+reject within one envelope still produces an ACTIVE envelope (≥1 approved → PDF)", async () => {
    const { rfq, envelopes, items } = await makeArcCommitteeFixture();

    // For vendor_alpha: approve product 1, reject product 2.
    const approveCell = items[IDS.users.vendor_alpha][1];
    const rejectCell = items[IDS.users.vendor_alpha][2];

    const mApprove = mockExpress({
      user: { id: IDS.users.a1_proc_commApp, company_id: IDS.companies.A },
      params: { rfq_id: rfq.id },
      body: {
        action: "approve",
        approval_instance_id: approveCell.approval_instance_id,
        approval_instance_step_id: approveCell.approval_instance_step_id,
      },
    });
    await arcController.performAction(mApprove.req, mApprove.res);
    expect([200, 201, null]).toContain(mApprove.calls.status);

    const mReject = mockExpress({
      user: { id: IDS.users.a1_proc_commApp, company_id: IDS.companies.A },
      params: { rfq_id: rfq.id },
      body: {
        action: "reject",
        approval_instance_id: rejectCell.approval_instance_id,
        approval_instance_step_id: rejectCell.approval_instance_step_id,
      },
    });
    await arcController.performAction(mReject.req, mReject.res);
    expect([200, 201, null]).toContain(mReject.calls.status);

    const env = await db.one(`SELECT * FROM tbl_arc WHERE id = $1`, [envelopes[IDS.users.vendor_alpha]]);
    expect(env.status).toBe("ACTIVE");
    expect(env.document_url).toBeTruthy();

    // Only the approved item carries the APPROVED stamp.
    const approvedItem = await db.one(`SELECT status FROM tbl_arc_item WHERE id = $1`, [approveCell.id]);
    expect(approvedItem.status).toBe("APPROVED");
    const rejectedItem = await db.one(`SELECT status FROM tbl_arc_item WHERE id = $1`, [rejectCell.id]);
    expect(rejectedItem.status).toBe("REJECTED");
  });

  it("rejects performAction on a non-tender RFQ", async () => {
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, process_id, is_tender, tender_publish_date,
          vendor_clarification_date, title, rfq_type)
       VALUES (nextval('tbl_rfq_id_seq'), 'non-tender', 'X', 'a@b.test',
               'C', '+91-9999999999', NOW() + INTERVAL '7 days', 'Loc', 1, 1,
               $1, $1, NOW(), $2, $3, $4, 0, NULL, NULL, 'Non-tender', 'RFQ')
       RETURNING id`,
      [IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1]
    );
    inserted.rfqIds.push(rfq.id);
    const m = mockExpress({
      user: { id: IDS.users.a1_proc_commApp, company_id: IDS.companies.A },
      params: { rfq_id: rfq.id },
      body: { action: "approve" },
    });
    await arcController.performAction(m.req, m.res);
    expect(m.calls.status).toBe(400);
    expect(m.calls.body.message).toMatch(/only applicable for tenders/i);
  });
});
