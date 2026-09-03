// The backstop behind the all-or-nothing rule.
//
// Making a PO approval roll back when its document fails closes the hole that
// produced sixteen stale documents in production. It does not help the POs
// already in that state, and it does not cover the paths that write a document
// outside an approval — a PO initiated while S3 was unreachable, a document
// nulled by an edit and never rebuilt.
//
// So: a sweep that finds POs whose stored document is older than their latest
// approval (or missing entirely), rebuilds it, and escalates to a human when
// rebuilding keeps failing. Modelled on runRfqStuckPublishWatchdogTick in
// cronManager.js, which has been doing the same job for stuck RFQ publishes.
//
// Staleness is measurable because the S3 key carries a millisecond timestamp:
//   .../purchase-order/po-138757-1756000000000.pdf
// which is how the production damage was quantified in the first place.

import { describe, it, expect, afterAll, beforeEach } from "@jest/globals";
import { withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { runPoDocumentWatchdogTick } from "../../app/services/poDocumentWatchdog.js";

afterAll(async () => { await closeDb(); });

let SEQ = 7_600_000;
const next = () => ++SEQ;

const urlAt = (ms) => `https://bucket.s3.ap-south-1.amazonaws.com/purchase-order/po-X-${ms}.pdf`;
const HOUR = 3_600_000;

let now;
beforeEach(() => { now = 1_756_000_000_000; });

// A PO with an APPROVED approval instance whose last approval happened at
// `approvedAtMs`, and a stored document written at `pdfAtMs` (or none).
async function makeApprovedPo(t, { pdfAtMs, approvedAtMs, status = "acceptance_pending" }) {
  const rfqNo = next();
  const rfq = await t.one(
    `INSERT INTO tbl_rfq (rfq_no, comment, company_name, response_email, contact_name,
                          contact_number, bid_end_date, location, is_published, status,
                          created_by, updated_by, "timestamp", hospitality_company_id,
                          hotel_id, process_id, is_tender, title)
     VALUES ($1,'','','b@t','b','0', NOW() + INTERVAL '7 days','Mumbai',1,1,$2,$2,NOW(),$3,$4,$5,0,$6)
     RETURNING id`,
    [rfqNo, IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1, `WD RFQ ${rfqNo}`]
  );
  // One policy per transaction: the scope is uniquely constrained, so two POs
  // in the same test must share it.
  const policy =
    (await t.oneOrNone(
      `SELECT id FROM tbl_approval_policies
        WHERE entity_type = 'PO' AND hospitality_company_id = $1 AND hotel_id = $2
        LIMIT 1`,
      [IDS.hospitality.A, IDS.hotels.A1]
    )) ||
    (await t.one(
      `INSERT INTO tbl_approval_policies (entity_type, hospitality_company_id, hotel_id, is_active, created_by)
       VALUES ('PO',$1,$2,true,$3) RETURNING id`,
      [IDS.hospitality.A, IDS.hotels.A1, IDS.users.a1_proc_buyer]
    ));
  const instance = await t.one(
    `INSERT INTO tbl_approval_instances (entity_type, entity_id, approval_policy_id, status,
                                         current_step, hospitality_company_id, hotel_id, initiated_by, metadata)
     VALUES ('PO', 0, $1, 'APPROVED', 1, $2, $3, $4, '{}'::jsonb) RETURNING id`,
    [policy.id, IDS.hospitality.A, IDS.hotels.A1, IDS.users.a1_proc_buyer]
  );
  const step = await t.one(
    `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status, completed_at)
     VALUES ($1,1,'ANY','APPROVED', to_timestamp($2::bigint / 1000.0) AT TIME ZONE 'UTC') RETURNING id`,
    [instance.id, approvedAtMs]
  );
  await t.none(
    `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status, acted_at)
     VALUES ($1,$2,'APPROVED', to_timestamp($3::bigint / 1000.0) AT TIME ZONE 'UTC')`,
    [step.id, IDS.users.a1_proc_poApp, approvedAtMs]
  );
  const product = await t.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1,'','','','','',1,0) RETURNING id`,
    [rfq.id]
  );
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order (rfq_id, rfq_product_id, po_number, company_id, status,
                                         quantity, unit_price, finalized_vendor_id, total_value,
                                         approval_instance_id, po_pdf_url, created_at)
     VALUES ($1,ARRAY[$2::int],$3,$4,$5,10,100,$6,1000,$7,$8,NOW()) RETURNING id`,
    [rfq.id, product.id, String(next()), IDS.companies.A, status,
     IDS.users.vendor_alpha, instance.id, pdfAtMs == null ? null : urlAt(pdfAtMs)]
  );
  await t.none(`UPDATE tbl_approval_instances SET entity_id = $1 WHERE id = $2`, [po.id, instance.id]);
  return po.id;
}

const tick = (t, opts = {}) =>
  runPoDocumentWatchdogTick({
    conn: t,
    clock: () => now,
    writeDocument: async () => urlAt(now),
    notify: async () => {},
    ...opts,
  });

describe("PO document watchdog", () => {
  it("rebuilds a document older than its own approval", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, { pdfAtMs: now - 3 * HOUR, approvedAtMs: now - 2 * HOUR });

      const result = await tick(t);

      expect(result.repaired).toContain(poId);
    });
  });

  it("leaves a document newer than its approval alone", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, { pdfAtMs: now - HOUR, approvedAtMs: now - 2 * HOUR });

      const result = await tick(t);

      expect(result.repaired).not.toContain(poId);
      expect(result.examined).not.toContain(poId);
    });
  });

  it("rebuilds an approved PO that has no document at all", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, { pdfAtMs: null, approvedAtMs: now - 2 * HOUR });

      const result = await tick(t);

      expect(result.repaired).toContain(poId);
    });
  });

  it("ignores drafts, which are not supposed to have a document yet", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, { pdfAtMs: null, approvedAtMs: now - 2 * HOUR, status: "draft" });

      const result = await tick(t);

      expect(result.examined).not.toContain(poId);
    });
  });

  it("holds off during the grace period so it never races a live approval", async () => {
    // An approval that committed thirty seconds ago is not stale, it is recent.
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, { pdfAtMs: now - 5 * HOUR, approvedAtMs: now - 30_000 });

      const result = await tick(t, { graceMs: 10 * 60_000 });

      expect(result.examined).not.toContain(poId);
    });
  });

  it("stores the new URL when a rebuild succeeds", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, { pdfAtMs: now - 3 * HOUR, approvedAtMs: now - 2 * HOUR });

      await tick(t, {
        writeDocument: async (id, conn) => {
          await conn.none(`UPDATE tbl_rfq_purchase_order SET po_pdf_url = $1 WHERE id = $2`, [urlAt(now), id]);
          return urlAt(now);
        },
      });

      const row = await t.one(`SELECT po_pdf_url FROM tbl_rfq_purchase_order WHERE id = $1`, [poId]);
      expect(row.po_pdf_url).toBe(urlAt(now));
    });
  });

  it("records the failure and keeps the old document when a rebuild fails", async () => {
    await withTx(async (t) => {
      const stale = now - 3 * HOUR;
      const poId = await makeApprovedPo(t, { pdfAtMs: stale, approvedAtMs: now - 2 * HOUR });

      const result = await tick(t, {
        writeDocument: async () => { throw new Error("Failed to launch the browser process"); },
      });

      expect(result.failed).toContain(poId);
      const row = await t.one(
        `SELECT po_pdf_url, po_document_attempts, po_document_failure_reason
           FROM tbl_rfq_purchase_order WHERE id = $1`, [poId]);
      expect(row.po_pdf_url).toBe(urlAt(stale));
      expect(row.po_document_attempts).toBe(1);
      expect(row.po_document_failure_reason).toMatch(/launch/i);
    });
  });

  it("escalates to a human once retries are exhausted", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, { pdfAtMs: now - 3 * HOUR, approvedAtMs: now - 2 * HOUR });
      await t.none(`UPDATE tbl_rfq_purchase_order SET po_document_attempts = 4 WHERE id = $1`, [poId]);
      const notified = [];

      await tick(t, {
        writeDocument: async () => { throw new Error("still broken"); },
        maxAttempts: 5,
        notify: async (po) => { notified.push(po.id); },
      });

      expect(notified).toContain(poId);
    });
  });

  it("escalates only once", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, { pdfAtMs: now - 3 * HOUR, approvedAtMs: now - 2 * HOUR });
      await t.none(
        `UPDATE tbl_rfq_purchase_order
            SET po_document_attempts = 9, po_document_failure_notified_at = NOW()
          WHERE id = $1`, [poId]);
      const notified = [];

      await tick(t, {
        writeDocument: async () => { throw new Error("still broken"); },
        maxAttempts: 5,
        notify: async (po) => { notified.push(po.id); },
      });

      expect(notified).not.toContain(poId);
    });
  });

  it("clears the failure record once a rebuild succeeds", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, { pdfAtMs: now - 3 * HOUR, approvedAtMs: now - 2 * HOUR });
      await t.none(
        `UPDATE tbl_rfq_purchase_order
            SET po_document_attempts = 2, po_document_failure_reason = 'old failure'
          WHERE id = $1`, [poId]);

      await tick(t);

      const row = await t.one(
        `SELECT po_document_attempts, po_document_failure_reason
           FROM tbl_rfq_purchase_order WHERE id = $1`, [poId]);
      expect(row.po_document_attempts).toBe(0);
      expect(row.po_document_failure_reason).toBeNull();
    });
  });

  it("does not silently rewrite a long-settled document", async () => {
    // Four of the sixteen damaged production POs were approved in March and
    // May. Their documents have been downloaded, attached to emails and
    // possibly signed against. Rebuilding one now would hand the client a
    // different PDF for a PO they consider closed — template and pricing code
    // have both moved since. Anything past the window is a human's call.
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, {
        pdfAtMs: now - 200 * 24 * HOUR,
        approvedAtMs: now - 190 * 24 * HOUR,
      });

      const result = await tick(t);

      expect(result.examined).not.toContain(poId);
    });
  });

  it("still repairs a recently approved document", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, {
        pdfAtMs: now - 8 * 24 * HOUR,
        approvedAtMs: now - 7 * 24 * HOUR,
      });

      const result = await tick(t);

      expect(result.repaired).toContain(poId);
    });
  });

  it("reports what it skipped as too old rather than staying silent", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, {
        pdfAtMs: now - 200 * 24 * HOUR,
        approvedAtMs: now - 190 * 24 * HOUR,
      });

      const result = await tick(t);

      expect(result.skippedTooOld).toContain(poId);
    });
  });

  it("ignores a PO whose approval was rejected", async () => {
    // Found by running the report against production. Staleness is measured
    // against the last APPROVED action, so a PO that collected two approvals
    // and was then REJECTED looks stale forever: the reject never rewrites the
    // document, by design, and never will.
    //
    // Four of the sixteen damaged production POs are exactly this. They are
    // dead purchase orders, and without this the watchdog would rebuild their
    // documents every five minutes for the rest of time.
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, {
        pdfAtMs: now - 3 * HOUR,
        approvedAtMs: now - 2 * HOUR,
        status: "rejected",
      });
      await t.none(
        `UPDATE tbl_approval_instances SET status = 'REJECTED'
          WHERE id = (SELECT approval_instance_id FROM tbl_rfq_purchase_order WHERE id = $1)`,
        [poId]
      );

      const result = await tick(t);

      expect(result.examined).not.toContain(poId);
    });
  });

  it("ignores a cancelled PO", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, {
        pdfAtMs: now - 3 * HOUR,
        approvedAtMs: now - 2 * HOUR,
        status: "cancelled",
      });

      const result = await tick(t);

      expect(result.examined).not.toContain(poId);
    });
  });

  it("ignores a PO the vendor rejected", async () => {
    await withTx(async (t) => {
      const poId = await makeApprovedPo(t, {
        pdfAtMs: now - 3 * HOUR,
        approvedAtMs: now - 2 * HOUR,
        status: "rejected_by_vendor",
      });

      const result = await tick(t);

      expect(result.examined).not.toContain(poId);
    });
  });

  it("stands down quietly when its columns have not been migrated yet", async () => {
    // Same deploy-order reality as poDocumentService: deploy-prod.yml has no
    // migration step, so the container can run ahead of the schema. The
    // watchdog is a backstop, not the guarantee — when it cannot run it should
    // say so once and do nothing, not throw a scan error into the logs every
    // five minutes.
    await withTx(async (t) => {
      await makeApprovedPo(t, { pdfAtMs: now - 3 * HOUR, approvedAtMs: now - 2 * HOUR });

      const result = await tick(t, { hasDocumentStateColumns: async () => false });

      expect(result.examined).toEqual([]);
      expect(result.skippedNoSchema).toBe(true);
    });
  });

  it("keeps going after one PO fails", async () => {
    await withTx(async (t) => {
      const doomed = await makeApprovedPo(t, { pdfAtMs: now - 3 * HOUR, approvedAtMs: now - 2 * HOUR });
      const fine = await makeApprovedPo(t, { pdfAtMs: now - 3 * HOUR, approvedAtMs: now - 2 * HOUR });

      const result = await tick(t, {
        writeDocument: async (id) => {
          if (id === doomed) throw new Error("nope");
          return urlAt(now);
        },
      });

      expect(result.failed).toContain(doomed);
      expect(result.repaired).toContain(fine);
    });
  });
});
