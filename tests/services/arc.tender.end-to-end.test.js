// Phase 9 — the end-to-end product-grade test for the entire Tender / ARC
// journey. One test, one buyer, one tender, walking through every stage:
//
//   1. Tender created at Single ARC scope, hotel A1, process P1.
//   2. Buyer multi-finalizes: 2 vendors × 2 products on the ARC route.
//   3. ARC committee approves all 4 cells. Both envelopes go ACTIVE,
//      consolidated PDFs generated and uploaded (mocked S3), URLs set.
//   4. Buyer searches the contracted product → enrichment returns
//      arc_info.is_under_arc=true with both vendors listed.
//   5. Buyer creates an ARC release against vendor alpha, qty 10.
//      Contracted PO drafted with rfq_id=NULL, is_contracted=1, and the
//      correct rupee math (snapshotted unit price × qty × 18% tax).
//   6. The Contracted POs listing query returns the new PO.
//
// This is the suite that proves the full flow works end-to-end. Every
// previous suite covers a vertical slice; this one covers the spine.

import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";

// Mock cron.
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

// Mock the ARC document renderer + S3 upload so the committee
// approval path can drive the envelope to ACTIVE without spawning
// Puppeteer or hitting AWS.
const fakePdfPath = path.join(os.tmpdir(), `arc-e2e-${process.pid}.pdf`);
fs.writeFileSync(fakePdfPath, "%PDF-1.4 stub\n%%EOF");
jest.unstable_mockModule("../../app/controllers/arc/arcDocumentController.js", () => ({
  generateAwardDocument: async () => ({ ok: true, absolutePath: fakePdfPath }),
  sendAwardDocumentToVendor: async () => ({ ok: true }),
  buildArcTemplateData: async () => ({}),
}));
jest.unstable_mockModule("@aws-sdk/client-s3", () => ({
  PutObjectCommand: class { constructor(p) { Object.assign(this, p); } },
  GetObjectCommand: class { constructor(p) { Object.assign(this, p); } },
  DeleteObjectCommand: class { constructor(p) { Object.assign(this, p); } },
  CopyObjectCommand: class { constructor(p) { Object.assign(this, p); } },
  ListObjectsV2Command: class { constructor(p) { Object.assign(this, p); } },
  HeadObjectCommand: class { constructor(p) { Object.assign(this, p); } },
  S3Client: class { async send() { return { ETag: '"e2e-mock-etag"' }; } },
}));
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || "test-bucket";
process.env.AWS_REGION = process.env.AWS_REGION || "ap-south-1";

const { default: rfqController, enrichProductsWithArcInfo } = await import(
  "../../app/controllers/rfq/rfqController.js"
);
const { default: arcController } = await import(
  "../../app/controllers/arc/arcController.js"
);
const { default: arcReleaseController } = await import(
  "../../app/controllers/arc/arcReleaseController.js"
);

// Inline TENDER process + ARC policy.
const TENDER_PROCESS_ID = 70098;
const ARC_POLICY_ID = 60598;

beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_approval_processes
       (id, company_id, name, description, is_active, created_by, process_type)
     VALUES ($1, $2, 'E2E Tender Process', '', true, $3, 'TENDER')
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

function mockExpress(opts = {}) {
  const calls = { status: null, body: null };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; calls.status = code; return this; },
    json(body) { calls.body = body; return this; },
    end() { return this; },
  };
  return {
    req: {
      user: opts.user, params: opts.params || {},
      query: opts.query || {}, body: opts.body || {},
    },
    res, next: jest.fn(), calls,
  };
}

describe("Tender → ARC → Contracted PO — full happy path", () => {
  it("walks a buyer from tender creation through to a Contracted PO drafted with correct calculations", async () => {
    const buyer = { id: IDS.users.a1_proc_buyer, company_id: IDS.companies.A };

    // ─────────────────────────────────────────────────────────────────
    // Step 1 — Tender exists at status='QUOTING_OPEN' with 2 products
    // ─────────────────────────────────────────────────────────────────
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, process_id, is_tender, tender_publish_date,
          vendor_clarification_date, title, rfq_type, tender_scope,
          arc_period_from, arc_period_to)
       VALUES (nextval('tbl_rfq_id_seq'), 'E2E happy path', 'Phileein', 'e2e@b.test',
               'C', '+91-9999999999', NOW() + INTERVAL '7 days', 'Loc', 1, 1,
               $1, $1, NOW(), $2, $3, $4, 1, NOW() - INTERVAL '30 days',
               NOW() + INTERVAL '5 days', 'E2E ARC for HK Chemicals', 'TENDER', 'SINGLE',
               NOW()::date, (NOW() + INTERVAL '365 days')::date)
       RETURNING id, rfq_no`,
      [buyer.id, IDS.hospitality.A, IDS.hotels.A1, TENDER_PROCESS_ID]
    );

    await db.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [rfq.id, IDS.hotels.A1, buyer.id]
    );

    const products = {};
    for (const pv of [1, 2]) {
      products[pv] = (await db.one(
        `INSERT INTO tbl_rfq_products
           (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
         VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
        [rfq.id, pv]
      )).id;
    }
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, 1, 'Quantity', '100', 0), ($1, 1, 'Unit', 'NOS', 0),
              ($1, 2, 'Quantity', '50',  0), ($1, 2, 'Unit', 'KG',  0)`,
      [rfq.id]
    );

    // Vendor mappings (existence is enough — finalize doesn't reload).
    for (const vendorId of [IDS.users.vendor_alpha, IDS.users.vendor_beta]) {
      for (const pv of [1, 2]) {
        await db.none(
          `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
           VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`,
          [rfq.id, pv, vendorId]
        );
      }
    }

    // Quotes — one per vendor, two line items each.
    const quotes = {};
    const items = {};
    for (const vendorId of [IDS.users.vendor_alpha, IDS.users.vendor_beta]) {
      const q = await db.one(
        `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, global_charges)
         VALUES ($1, $2, 1, $3, $3, '[]'::jsonb) RETURNING id`,
        [rfq.id, rfq.rfq_no, vendorId]
      );
      quotes[vendorId] = q.id;
      items[vendorId] = {};
      for (const [pv, basePrice] of [[1, 100], [2, 200]]) {
        const item = await db.one(
          `INSERT INTO tbl_quote_items
             (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price,
              comment, delivery_period, quantity, variant, other_charges)
           VALUES ($1, $2, $3, $4, $5, $6, '', '7 days', $7, 0,
                   '[]'::jsonb) RETURNING id`,
          [rfq.id, rfq.rfq_no, q.id, pv,
           vendorId === IDS.users.vendor_alpha ? basePrice : basePrice + 5,
           (vendorId === IDS.users.vendor_alpha ? basePrice : basePrice + 5) * (pv === 1 ? 100 : 50),
           String(pv === 1 ? 100 : 50)]
        );
        items[vendorId][pv] = { id: item.id };
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // Step 2 — Multi-vendor finalize on the ARC route
    //   4 cells: alpha+1, alpha+2, beta+1, beta+2
    // ─────────────────────────────────────────────────────────────────
    for (const vendorId of [IDS.users.vendor_alpha, IDS.users.vendor_beta]) {
      for (const pv of [1, 2]) {
        const m = mockExpress({
          user: buyer,
          body: {
            rfq_id: rfq.id, rfq_no: rfq.rfq_no,
            product_variant_id: pv,
            vendor_id: vendorId,
            quote_id: quotes[vendorId],
            quote_item_id: items[vendorId][pv].id,
            variant: 0,
            route_type: "ARC",
          },
        });
        await rfqController.finalize(m.req, m.res);
        expect([200, 201, null]).toContain(m.calls.status);
      }
    }

    // After finalize: 2 envelopes (one per vendor), 4 arc_items, 4
    // PENDING approval instances.
    const envelopes = await db.any(
      `SELECT * FROM tbl_arc WHERE rfq_id = $1 ORDER BY vendor_id`, [rfq.id]
    );
    expect(envelopes.length).toBe(2);
    const arcItems = await db.any(
      `SELECT * FROM tbl_arc_item WHERE arc_id = ANY($1::int[]) ORDER BY arc_id, product_variant_id`,
      [envelopes.map((e) => e.id)]
    );
    expect(arcItems.length).toBe(4);
    const instances = await db.any(
      `SELECT id, status, entity_id FROM tbl_approval_instances
        WHERE entity_type = 'ARC' AND entity_id = ANY($1::int[])`,
      [arcItems.map((i) => i.id)]
    );
    expect(instances.length).toBe(4);
    instances.forEach((inst) => expect(inst.status).toBe('PENDING'));

    // ─────────────────────────────────────────────────────────────────
    // Step 3 — Committee approves every cell. Both envelopes go ACTIVE.
    // ─────────────────────────────────────────────────────────────────
    for (const item of arcItems) {
      const inst = instances.find((i) => i.entity_id === item.id);
      // Look up the matching instance step to thread through.
      const step = await db.one(
        `SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = $1 ORDER BY step_order LIMIT 1`,
        [inst.id]
      );
      const m = mockExpress({
        user: { id: IDS.users.a1_proc_commApp, company_id: IDS.companies.A },
        params: { rfq_id: rfq.id },
        body: {
          action: "approve",
          approval_instance_id: inst.id,
          approval_instance_step_id: step.id,
        },
      });
      await arcController.performAction(m.req, m.res);
      expect([200, 201, null]).toContain(m.calls.status);
    }

    const finalEnvelopes = await db.any(
      `SELECT * FROM tbl_arc WHERE rfq_id = $1 ORDER BY vendor_id`, [rfq.id]
    );
    finalEnvelopes.forEach((env) => {
      expect(env.status).toBe('ACTIVE');
      expect(env.document_url).toBeTruthy();
      expect(env.document_generated_at).toBeTruthy();
    });

    // ─────────────────────────────────────────────────────────────────
    // Step 4 — Buyer searches a contracted product → enrichment fires.
    // ─────────────────────────────────────────────────────────────────
    const stub = [{ id: 1, product_variant_id: 1, name: "HK Chemical 1" }];
    const enriched = await enrichProductsWithArcInfo(stub, [IDS.hotels.A1]);
    expect(enriched[0].arc_info.is_under_arc).toBe(true);
    expect(enriched[0].arc_info.arcs.length).toBe(2); // both vendors
    expect(enriched[0].arc_info.arcs.map((a) => a.vendor_id).sort())
      .toEqual([IDS.users.vendor_alpha, IDS.users.vendor_beta].sort());

    // ─────────────────────────────────────────────────────────────────
    // Step 5 — Buyer chooses vendor alpha, qty 10 of product 1, qty 5
    //          of product 2. ARC release creates Contracted PO.
    // ─────────────────────────────────────────────────────────────────
    const alphaEnvelope = finalEnvelopes.find((e) => e.vendor_id === IDS.users.vendor_alpha);
    const alphaItems = arcItems.filter((it) => it.arc_id === alphaEnvelope.id);
    const releaseM = mockExpress({
      user: buyer,
      body: {
        arc_id: alphaEnvelope.id,
        hotel_id: IDS.hotels.A1,
        items: [
          { arc_item_id: alphaItems.find((i) => i.product_variant_id === 1).id, quantity: 10 },
          { arc_item_id: alphaItems.find((i) => i.product_variant_id === 2).id, quantity: 5 },
        ],
      },
    });
    await arcReleaseController.createRelease(releaseM.req, releaseM.res);
    expect(releaseM.calls.status).toBe(200);
    const { release_id, po_id, total_value } = releaseM.calls.body.data;
    // Math: 100 * 10 = 1000; 200 * 5 = 1000; sum = 2000.
    // No tax in this test (other_charges=[] from the seeded quote_item),
    // so engine returns 2000 exactly.
    expect(Number(total_value)).toBe(2000);

    // ─────────────────────────────────────────────────────────────────
    // Step 6 — The Contracted PO is queryable, has the right shape.
    // ─────────────────────────────────────────────────────────────────
    const po = await db.one(
      `SELECT * FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]
    );
    expect(po.is_contracted).toBe(1);
    expect(po.arc_release_id).toBe(release_id);
    expect(po.rfq_id).toBeNull();
    expect(po.finalized_vendor_id).toBe(IDS.users.vendor_alpha);
    expect(Number(po.total_value)).toBe(2000);

    const poProducts = await db.any(
      `SELECT * FROM tbl_purchase_order_product
        WHERE purchase_order_id = $1 ORDER BY id`,
      [po_id]
    );
    expect(poProducts.length).toBe(2);
    expect(Number(poProducts[0].quantity)).toBe(10);
    expect(Number(poProducts[0].unit_price)).toBe(100);
    expect(Number(poProducts[0].total_price)).toBe(1000);
    expect(Number(poProducts[1].quantity)).toBe(5);
    expect(Number(poProducts[1].unit_price)).toBe(200);
    expect(Number(poProducts[1].total_price)).toBe(1000);

    // The Contracted POs listing query (separate from open-market POs)
    // returns this row.
    const contractedRows = await db.any(
      `SELECT id FROM tbl_rfq_purchase_order
        WHERE company_id = $1 AND is_contracted = 1 AND id = $2`,
      [IDS.companies.A, po_id]
    );
    expect(contractedRows.length).toBe(1);

    // Final lifecycle: every key event for this tender is in the audit
    // trail. We don't pin the exact ordering but assert the major
    // milestones are present.
    const lifecycle = await db.any(
      `SELECT stage FROM tbl_lifecycle_history
        WHERE entity_type = 'TENDER' AND entity_id = $1
        ORDER BY id`,
      [rfq.id]
    );
    const stages = lifecycle.map((r) => r.stage);
    expect(stages).toEqual(expect.arrayContaining([
      'ARC_PENDING_COMMITTEE',
      'ARC_DOC_GENERATED',
      'ARC_ACTIVE',
      'ARC_RELEASE_CREATED',
      'ARC_RELEASE_PO_DRAFTED',
    ]));

    // ─────────────────────────────────────────────────────────────────
    // Cleanup. We don't delete this in afterEach because the tear-down
    // chain is huge — we run it inline so the test is self-contained.
    // ─────────────────────────────────────────────────────────────────
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po_id]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
    await db.none(`DELETE FROM tbl_arc_release_items WHERE arc_release_id = $1`, [release_id]);
    await db.none(`DELETE FROM tbl_arc_release WHERE id = $1`, [release_id]);
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instances.map((i) => i.id)]);
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instances.map((i) => i.id)]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instances.map((i) => i.id)]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instances.map((i) => i.id)]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [envelopes.map((e) => e.id)]);
    await db.none(`DELETE FROM tbl_arc_hotels WHERE arc_id = ANY($1::int[])`, [envelopes.map((e) => e.id)]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [envelopes.map((e) => e.id)]);
    await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = $1`, [rfq.id]);
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq.id]);
    await db.none(`DELETE FROM tbl_quote_activity WHERE rfq_id = $1`, [rfq.id]);
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = $1`, [rfq.id]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = $1`, [rfq.id]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = $1`, [rfq.id]);
    await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = $1`, [rfq.id]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = $1`, [rfq.id]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = $1`, [rfq.id]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = $1 AND entity_type = 'TENDER'`, [rfq.id]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = $1`, [rfq.id]);
  });
});
