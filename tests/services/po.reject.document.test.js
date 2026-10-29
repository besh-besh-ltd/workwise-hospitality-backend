// A rejected PO's stored document shows the rejection.
// ----------------------------------------------------------------------------
// The PO PDF is a stored file (`po_pdf_url`), rewritten on every approval but,
// until 2026-10-29, never on a rejection. A production PO approved at L1 and
// rejected at L2 kept printing its L2 rejecter as "Invited": the state of the
// last approval's write.
//
// The rules pinned here:
//   - a rejection, on either surface, rewrites the document as part of the
//     rejection, as of the decision: before the de-finalization cancels the
//     award approval its Commercial Evaluation section prints from;
//   - the rejecter prints "Rejected" with the time; every other row prints
//     exactly as before (an approver who never acted stays "Invited"), in the
//     same order, and nothing else in the document moves;
//   - the document of an approval still in progress is unchanged ("Invited");
//   - a document that cannot be written never undoes the rejection;
//   - a refused rejection, or a retry of one, writes no document.
//
// Real HTTP, real Postgres. The harness stubs Chromium and S3; the data build
// and the Handlebars render are real, and the rendered HTML is captured here.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";

const fakeTransport = { sendMail: (opts, cb) => cb(null, { messageId: "<captured>" }) };
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { makePoRejectWorld, W } = await import("../helpers/poRejectWorld.js");
const { drainPoRejectedNotifications } = await import("../../app/services/po/poRejectionNotifier.js");
const { planFollowUpsSettled } = await import("../../app/services/inventory/planService.js");
const { buildPOTemplateData } = await import("../../app/helper/poTemplateDataBuilder.js");
const { pdfRenderer } = await import("../../app/util/pdfRenderer.js");

const world = makePoRejectWorld(db);
const SENTINEL_PDF = "https://bucket.s3.ap-south-1.amazonaws.com/purchase-order/po-SENTINEL-1.pdf";

// Every PO document's HTML, newest last. The harness stub still writes the file.
const rendered = [];
const harnessRender = pdfRenderer.renderToFile;

beforeAll(async () => {
  pdfRenderer.renderToFile = async (html, outputPath) => {
    rendered.push(html);
    return harnessRender(html, outputPath);
  };
  await world.setup();
});
afterEach(async () => {
  await drainPoRejectedNotifications();
  await planFollowUpsSettled();
  await world.cleanup();
  rendered.length = 0;
});
afterAll(async () => {
  pdfRenderer.renderToFile = harnessRender;
  await world.teardown();
  await closeDb();
});

const docOf = (poId) =>
  db.one(
    `SELECT status::text AS status, po_pdf_url, po_document_generated_at FROM tbl_rfq_purchase_order WHERE id = $1`,
    [poId]
  );
const instanceStatus = async (id) => (await db.one(`SELECT status FROM tbl_approval_instances WHERE id = $1`, [id])).status;
const markPdf = (poId) => db.none(`UPDATE tbl_rfq_purchase_order SET po_pdf_url = $1 WHERE id = $2`, [SENTINEL_PDF, poId]);

const NAMES = new Map();
const nameOf = async (userId) => {
  if (!NAMES.has(userId)) NAMES.set(userId, (await db.one(`SELECT name FROM tbl_users WHERE id = $1`, [userId])).name);
  return NAMES.get(userId);
};

/** The approver table as the document data carries it. */
const printedApprovers = async (poId) =>
  (await buildPOTemplateData(poId)).poApprovers.map((a) => ({ name: a.name, status: a.status, actioned: a.timestamp !== null }));

/** Name -> status cell (text and inline style) from the PO Approvers table of rendered HTML. */
function approverCells(html) {
  const cells = new Map();
  const row = /<tr>\s*<td>([^<]*)<\/td>\s*<td style="([^"]*)">([^<]*)<\/td>/g;
  for (const m of html.matchAll(row)) cells.set(m[1].trim(), { style: m[2], status: m[3].trim() });
  return cells;
}

/** The document with its PO Approvers rows removed: the part a rejection must not move. */
const withoutApproverRows = (html) =>
  html.replace(/<tr>\s*<td>[^<]*<\/td>\s*<td style="[^"]*">[^<]*<\/td>\s*<td>[^<]*<\/td>\s*<\/tr>/g, "");

const rejectAs = async (userId, poId, body = {}) =>
  (await world.client(userId)).post(`/api/v1/po/approve/${poId}`).send({ decision: "rejected", ...body });
const approveAs = async (userId, poId) =>
  (await world.client(userId)).post(`/api/v1/po/approve/${poId}`).send({ decision: "approved", remarks: "ok" });

/**
 * The reported shape, three levels:
 *   L1  ANY  PO_APPROVER (approves), CREATOR (never asked once L1 clears)
 *   L2  ANY  COMM_APP (added mid-flight; rejects), INITIATOR
 *   L3  ANY  COMM_EVAL
 * Returns the PO with L1 already approved over HTTP, so L2 is current.
 */
async function threeLevelPoAtL2() {
  const a = await world.pendingPo();
  const l1 = await world.currentStepId(a.instanceId);
  await db.none(`UPDATE tbl_approval_instance_steps SET decision_rule = 'ANY' WHERE id = $1`, [l1]);
  await db.none(
    `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status) VALUES ($1, $2, 'PENDING')`,
    [l1, W.CREATOR]
  );
  const order = (await db.one(`SELECT step_order FROM tbl_approval_instance_steps WHERE id = $1`, [l1])).step_order;
  const later = [
    [order + 1, [[W.COMM_APP, true], [W.INITIATOR, false]]],
    [order + 2, [[W.COMM_EVAL, false]]],
  ];
  for (const [stepOrder, approvers] of later) {
    const step = await db.one(
      `INSERT INTO tbl_approval_instance_steps (approval_instance_id, step_order, decision_rule, status)
       VALUES ($1, $2, 'ANY', 'PENDING') RETURNING id`,
      [a.instanceId, stepOrder]
    );
    for (const [userId, midFlight] of approvers) {
      await db.none(
        `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status, added_mid_flight)
         VALUES ($1, $2, 'PENDING', $3)`,
        [step.id, userId, midFlight]
      );
    }
  }

  const res = await approveAs(W.PO_APPROVER, a.poId);
  expect(res.status).toBe(200);
  expect(await instanceStatus(a.instanceId)).toBe("PENDING");
  return a;
}

describe("a rejected PO's document shows the rejection", () => {
  it("prints the rejecter Rejected and leaves every other row as it was", async () => {
    const a = await threeLevelPoAtL2();

    // While the approval is open the document is exactly what it was before
    // this change: the L1 approver approved, L1's peer skipped, everyone ahead
    // invited.
    expect(await printedApprovers(a.poId)).toEqual([
      { name: await nameOf(W.PO_APPROVER), status: "Approved", actioned: true },
      { name: await nameOf(W.CREATOR), status: "Skipped", actioned: true },
      { name: await nameOf(W.COMM_APP), status: "Invited", actioned: false },
      { name: await nameOf(W.INITIATOR), status: "Invited", actioned: false },
      { name: await nameOf(W.COMM_EVAL), status: "Invited", actioned: false },
    ]);
    const atApproval = rendered.at(-1);
    expect(atApproval).toContain("Commercial Evaluation");
    await markPdf(a.poId);
    rendered.length = 0;

    const res = await rejectAs(W.COMM_APP, a.poId, { remarks: "Need more details", reason_category: "OTHER" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);

    const doc = await docOf(a.poId);
    expect(doc.status).toBe("rejected");
    expect(doc.po_pdf_url).not.toBe(SENTINEL_PDF);
    expect(doc.po_pdf_url).toMatch(/^https:\/\//);
    expect(doc.po_document_generated_at).not.toBeNull();

    expect(await printedApprovers(a.poId)).toEqual([
      { name: await nameOf(W.PO_APPROVER), status: "Approved", actioned: true },
      { name: await nameOf(W.CREATOR), status: "Skipped", actioned: true },
      { name: await nameOf(W.COMM_APP), status: "Rejected", actioned: true },
      { name: await nameOf(W.INITIATOR), status: "Invited", actioned: false },
      { name: await nameOf(W.COMM_EVAL), status: "Invited", actioned: false },
    ]);

    // The stored document itself: one render, with the same table.
    expect(rendered).toHaveLength(1);
    const cells = approverCells(rendered[0]);
    expect(cells.get(await nameOf(W.COMM_APP))).toEqual({ status: "Rejected", style: "color: #ef4444;" });
    expect(cells.get(await nameOf(W.INITIATOR))).toEqual({ status: "Invited", style: "color: #6b7280;" });
    expect(cells.get(await nameOf(W.COMM_EVAL))).toEqual({ status: "Invited", style: "color: #6b7280;" });
    expect(cells.get(await nameOf(W.PO_APPROVER))).toEqual({ status: "Approved", style: "color: #22c55e;" });
    // Same people, same order as the approval-time document.
    expect([...cells.keys()]).toEqual([...approverCells(atApproval).keys()]);

    // Everything outside the approver rows is the approval-time document,
    // byte for byte: the Commercial Evaluation section above all, which the
    // de-finalization would blank if the document were written after it.
    expect(withoutApproverRows(rendered[0])).toBe(withoutApproverRows(atApproval));
  });

  it("rewrites the document on both reject surfaces", async () => {
    const a = await world.pendingPo();
    const b = await world.pendingPo();
    await markPdf(a.poId);
    await markPdf(b.poId);

    const viaPage = await world.rejectOnPoPage(a.poId, { remarks: "GST is wrong", reason_category: "PRICE_TAX_QUERY" });
    const viaCard = await world.rejectOnApprovalCard(b.instanceId, { remarks: "GST is wrong", reason_category: "PRICE_TAX_QUERY" });
    expect(viaPage.status).toBe(200);
    expect(viaCard.status).toBe(200);

    for (const staged of [a, b]) {
      const doc = await docOf(staged.poId);
      expect(doc.status).toBe("rejected");
      expect(doc.po_pdf_url).not.toBe(SENTINEL_PDF);
      expect(await printedApprovers(staged.poId)).toEqual([
        { name: await nameOf(W.PO_APPROVER), status: "Rejected", actioned: true },
      ]);
    }
  });

  it("rewrites the document when the PO is cancelled as not needed", async () => {
    const a = await world.pendingPo();
    await markPdf(a.poId);

    const res = await world.rejectOnPoPage(a.poId, { remarks: "Not needed", reason_category: "NOT_REQUIRED" });
    expect(res.status).toBe(200);

    const doc = await docOf(a.poId);
    expect(doc.status).toBe("cancelled");
    expect(doc.po_pdf_url).not.toBe(SENTINEL_PDF);
    expect(await printedApprovers(a.poId)).toEqual([
      { name: await nameOf(W.PO_APPROVER), status: "Rejected", actioned: true },
    ]);
  });

  it("still commits the rejection when the document cannot be written, keeping the old one", async () => {
    const a = await world.pendingPo();
    await markPdf(a.poId);

    pdfRenderer.renderToFile = async () => { throw new Error("test: Chromium unavailable"); };
    let res;
    try {
      res = await world.rejectOnPoPage(a.poId, { remarks: "GST is wrong", reason_category: "PRICE_TAX_QUERY" });
    } finally {
      pdfRenderer.renderToFile = async (html, outputPath) => {
        rendered.push(html);
        return harnessRender(html, outputPath);
      };
    }

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const doc = await docOf(a.poId);
    expect(doc.status).toBe("rejected");
    expect(doc.po_pdf_url).toBe(SENTINEL_PDF);
    expect(await instanceStatus(a.instanceId)).toBe("REJECTED");
  });

  it("still commits the rejection when the document's own database write fails", async () => {
    // A failed statement aborts a Postgres transaction (25P02). The document
    // write runs in a savepoint, so its failure must not take the rejection
    // down with it. A test-only trigger refuses the po_pdf_url write for this PO.
    const a = await world.pendingPo();
    await markPdf(a.poId);
    await db.none(`
      CREATE OR REPLACE FUNCTION pg_temp_po_reject_doc_refuse() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.id = ${Number(a.poId)} AND NEW.po_pdf_url IS DISTINCT FROM OLD.po_pdf_url THEN
          RAISE EXCEPTION 'test: po_pdf_url write refused';
        END IF;
        RETURN NEW;
      END
      $fn$`);
    await db.none(`
      CREATE TRIGGER test_po_reject_doc_refuse BEFORE UPDATE ON tbl_rfq_purchase_order
      FOR EACH ROW EXECUTE FUNCTION pg_temp_po_reject_doc_refuse()`);
    let res;
    try {
      res = await world.rejectOnPoPage(a.poId, { remarks: "GST is wrong", reason_category: "PRICE_TAX_QUERY" });
    } finally {
      await db.none(`DROP TRIGGER IF EXISTS test_po_reject_doc_refuse ON tbl_rfq_purchase_order`);
      await db.none(`DROP FUNCTION IF EXISTS pg_temp_po_reject_doc_refuse()`);
    }

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    const doc = await docOf(a.poId);
    expect(doc.status).toBe("rejected");
    expect(doc.po_pdf_url).toBe(SENTINEL_PDF);
    expect(await instanceStatus(a.instanceId)).toBe("REJECTED");
  });

  it("writes nothing for an approver's retry of their own rejection", async () => {
    const a = await world.pendingPo();
    expect((await world.rejectOnPoPage(a.poId, { remarks: "no", reason_category: "OTHER" })).status).toBe(200);
    await markPdf(a.poId);
    rendered.length = 0;

    const retry = await world.rejectOnPoPage(a.poId, { remarks: "no", reason_category: "OTHER" });
    expect(retry.status).toBe(200);

    expect((await docOf(a.poId)).po_pdf_url).toBe(SENTINEL_PDF);
    expect(rendered).toHaveLength(0);
  });

  it("writes nothing for a rejection refused because the PO was already approved", async () => {
    const a = await world.pendingPo();
    const l1 = await world.currentStepId(a.instanceId);
    await db.none(`UPDATE tbl_approval_instance_steps SET decision_rule = 'ANY' WHERE id = $1`, [l1]);
    await db.none(
      `INSERT INTO tbl_approval_step_approvers (approval_instance_step_id, approver_user_id, status) VALUES ($1, $2, 'PENDING')`,
      [l1, W.COMM_APP]
    );
    expect((await approveAs(W.PO_APPROVER, a.poId)).status).toBe(200);
    await planFollowUpsSettled();
    await markPdf(a.poId);
    rendered.length = 0;

    const late = await rejectAs(W.COMM_APP, a.poId, { remarks: "too late", reason_category: "OTHER" });
    expect(late.status).toBe(409);

    expect((await docOf(a.poId)).po_pdf_url).toBe(SENTINEL_PDF);
    expect(rendered).toHaveLength(0);
  });
});
