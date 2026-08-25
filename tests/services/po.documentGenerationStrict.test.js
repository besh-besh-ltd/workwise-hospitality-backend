// A PO document either lands or the caller finds out. No third outcome.
//
// CONFIRMED DEFECT (hospitality_main). regeneratePODocument swallowed every
// failure and returned null; both of its callers caught again on top of that.
// So an approval whose document never rendered committed anyway, transitioned
// the PO to acceptance_pending, and emailed the vendor a link to the document
// from *before* the approval. Sixteen production POs carry one.
//
// Worse, two paths turned a failure into a fake success:
//
//   1. `s3Url.url || pdfResult.file` — uploadToS3 RETURNS {ok:false} rather
//      than throwing, so an S3 failure fell through to the container-local
//      path (`/app/storage/invoices/po-483.pdf`) and wrote *that* into
//      po_pdf_url, then logged "Regenerated PO document" and returned truthy.
//
//   2. seoController.poPDF caught a buildPOTemplateData failure and fell back
//      to `{...poData}` — four keys, no line items, no approvers. Handlebars
//      renders missing fields as empty rather than throwing, so this produced
//      a near-blank PDF with ok:true which was then uploaded over the good one.
//      Its filename came out as `po-undefined.pdf`, shared by every concurrent
//      failure across every tenant.
//
// The rule these tests pin: generation failure propagates, and po_pdf_url only
// ever holds a URL the vendor can actually open.

import { describe, it, expect, beforeEach } from "@jest/globals";
import { createPoDocumentWriter, PoDocumentError } from "../../app/services/poDocumentService.js";

const PO_ROW = {
  id: 483,
  po_number: "138757",
  company_id: 13,
  hospitality_company_id: 4,
  hotel_id: 30,
};

const S3_URL = "https://bucket.s3.ap-south-1.amazonaws.com/purchase-order/po-138757-1756000000000.pdf";

let renderImpl;
let uploadImpl;
let updates;

const conn = {
  oneOrNone: async (sql) => (/FROM tbl_rfq_purchase_order/i.test(sql) ? PO_ROW : null),
  none: async (sql, params) => { updates.push({ sql, params }); },
};

const storedUrl = () => updates.at(-1)?.params?.[0];

const write = (writer = makeWriter(), poId = 483) => writer(poId, conn);

const makeWriter = (extra = {}) =>
  createPoDocumentWriter({
    render: (...a) => renderImpl(...a),
    upload: (...a) => uploadImpl(...a),
    ...extra,
  });

beforeEach(() => {
  updates = [];
  renderImpl = async () => ({ absolutePath: "/tmp/po-138757.pdf" });
  uploadImpl = async () => ({ ok: true, url: S3_URL });
});

describe("PO document write", () => {
  it("stores the S3 URL when everything works", async () => {
    const url = await write();

    expect(url).toBe(S3_URL);
    expect(storedUrl()).toBe(S3_URL);
  });

  it("throws when the S3 upload fails, instead of storing a local path", async () => {
    // The exact production shape: uploadToS3 resolves {ok:false}, never throws.
    uploadImpl = async () => ({ ok: false, error: "NetworkingError" });

    await expect(write()).rejects.toThrow(/upload/i);
  });

  it("writes nothing to po_pdf_url when the S3 upload fails", async () => {
    uploadImpl = async () => ({ ok: false, error: "NetworkingError" });

    await expect(write()).rejects.toThrow();
    expect(updates).toHaveLength(0);
  });

  it("throws when rendering fails, rather than returning null", async () => {
    // PO 510's case on 2026-08-24: Chromium would not start.
    renderImpl = async () => { throw new Error("Failed to launch the browser process"); };

    await expect(write()).rejects.toThrow(/launch/i);
    expect(updates).toHaveLength(0);
  });

  it("refuses a URL the vendor could not open", async () => {
    // Belt and braces: even if some future upload path hands back a non-HTTP
    // location, it must never reach the column the vendor email links to.
    uploadImpl = async () => ({ ok: true, url: "/app/storage/invoices/po-138757.pdf" });

    await expect(write()).rejects.toThrow(/https/i);
    expect(updates).toHaveLength(0);
  });

  it("throws when the upload reports success but returns no URL", async () => {
    uploadImpl = async () => ({ ok: true });

    await expect(write()).rejects.toThrow(/https/i);
    expect(updates).toHaveLength(0);
  });

  it("tags its failures so callers can tell them apart", async () => {
    // The approve endpoint turns a document failure into "please approve
    // again". It must not say that when the real problem was authorization or
    // a dead database connection, so the document failures are identifiable.
    uploadImpl = async () => ({ ok: false, error: "NetworkingError" });

    await expect(write()).rejects.toBeInstanceOf(PoDocumentError);
  });

  it("wraps a renderer failure in the same type, keeping the cause", async () => {
    renderImpl = async () => { throw new Error("Failed to launch the browser process"); };

    const err = await write().catch((e) => e);

    expect(err).toBeInstanceOf(PoDocumentError);
    expect(err.cause?.message).toMatch(/launch/i);
  });

  it("throws when the PO does not exist", async () => {
    const emptyConn = { oneOrNone: async () => null, none: async () => {} };

    await expect(makeWriter()(999999, emptyConn)).rejects.toThrow(/999999/);
  });

  it("still stores the URL when the document-state columns are absent", async () => {
    // Deploy-order safety. backend/.github/workflows/deploy-prod.yml has no
    // migration step — it builds an image, pushes to ECR and restarts over SSH.
    // Migrations are applied by hand. So the container WILL, at least briefly,
    // run this code against a schema without po_document_generated_at.
    //
    // Those columns are watchdog bookkeeping. po_pdf_url is the contract. If a
    // missing bookkeeping column could fail this write, a deploy without the
    // migration would turn a stale-document bug into "nobody can approve
    // anything" — strictly worse than what is being fixed.
    const url = await write(makeWriter({ hasDocumentStateColumns: async () => false }));

    expect(url).toBe(S3_URL);
    expect(storedUrl()).toBe(S3_URL);
  });

  it("does not reference the new columns when they are absent", async () => {
    await write(makeWriter({ hasDocumentStateColumns: async () => false }));

    expect(updates.at(-1).sql).toContain("po_pdf_url");
    expect(updates.at(-1).sql).not.toContain("po_document_generated_at");
  });

  it("records the bookkeeping columns once the migration has run", async () => {
    await write(makeWriter({ hasDocumentStateColumns: async () => true }));

    expect(updates.at(-1).sql).toContain("po_document_generated_at");
    expect(updates.at(-1).sql).toContain("po_document_attempts");
  });

  it("probes the schema once, not on every document written", async () => {
    // A probe per approval is a wasted round trip on the critical path.
    let probes = 0;
    const writer = makeWriter({ hasDocumentStateColumns: async () => { probes += 1; return true; } });

    await write(writer);
    await write(writer);
    await write(writer);

    expect(probes).toBe(1);
  });

  it("names the S3 object after the PO so uploads never collide", async () => {
    let key;
    uploadImpl = async (_path, k) => { key = k; return { ok: true, url: S3_URL }; };

    await write();

    expect(key).toContain("138757");
  });
});
