// PDF — every document renderer goes through the shared pdfRenderer.
// ----------------------------------------------------------------------------
// Six sites used to launch their own Chromium per request and wait for
// `networkidle0`, which hung for 30 s in prod (payment confirmation emails went
// out with NO invoice/receipt because both PDFs timed out). They now render
// through app/util/pdfRenderer.js: one reused, concurrency-capped Chromium,
// `domcontentloaded`, page options per document.
//
// This suite (Chromium shard) swaps a REAL renderer in for the jestEnv stub and
// drives each site the way production does, asserting a real, non-empty PDF:
//   - paymentDocuments: tax invoice + payment received (subscription emails)
//   - usersController.generateHospitalityInvoice
//   - GET /api/v1/rfq/terms-pdf                     (rfqController)
//   - GET /api/v1/arc-v2/vendor/quote/:arcId/pdf    (arcVendorController)
//   - arcContractController.generateContractPdf     (bytes captured at S3)
//   - callOffPoRenderer.renderCallOffPoPdfFile      (generateCallOffPoPdf's render)
// plus the renderer's own option handling, against a fake Chromium.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { httpClient } from "../helpers/http.js";
import { makeRFQ } from "../factories/rfq.js";
import s3Client from "../../app/config/s3config.js";
import {
  pdfRenderer,
  createPdfRenderer,
  DEFAULT_PDF_OPTIONS,
  NO_MARGIN,
} from "../../app/util/pdfRenderer.js";
import { generateTaxInvoicePdf, generatePaymentReceivedPdf } from "../../app/helper/paymentDocuments.js";
import UsersController from "../../app/controllers/users/usersController.js";
import { generateContractPdf } from "../../app/controllers/arc_v2/arcContractController.js";
import { renderCallOffPoPdfFile } from "../../app/helper/arc_v2/callOffPoRenderer.js";

const BUYER = IDS.users.a1_proc_buyer;
const VENDOR = IDS.users.vendor_alpha;

let realRenderer;
const stubs = {};
const renderCalls = { file: 0, buffer: 0 };
const filesToRemove = [];
const created = { rfqs: [], arcs: [] };
let vendorTypeBefore;

const isRealPdf = (buf) => {
  expect(Buffer.isBuffer(buf)).toBe(true);
  expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  // The jestEnv stub is ~50 bytes; a real one-page Chromium PDF is KBs.
  expect(buf.length).toBeGreaterThan(1000);
};

beforeAll(async () => {
  realRenderer = createPdfRenderer({ maxConcurrent: 1 });
  stubs.renderToFile = pdfRenderer.renderToFile;
  stubs.renderToBuffer = pdfRenderer.renderToBuffer;
  pdfRenderer.renderToFile = (...a) => {
    renderCalls.file += 1;
    return realRenderer.renderToFile(...a);
  };
  pdfRenderer.renderToBuffer = (...a) => {
    renderCalls.buffer += 1;
    return realRenderer.renderToBuffer(...a);
  };
  ({ user_type: vendorTypeBefore } = await db.one(`SELECT user_type FROM tbl_users WHERE id = $1`, [VENDOR]));
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
});

afterAll(async () => {
  pdfRenderer.renderToFile = stubs.renderToFile;
  pdfRenderer.renderToBuffer = stubs.renderToBuffer;
  await realRenderer.close();
  for (const f of filesToRemove) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
  if (created.arcs.length) {
    await db.none(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [created.arcs]);
    await db.none(`DELETE FROM tbl_arc_invitation WHERE arc_id = ANY($1::bigint[])`, [created.arcs]);
    await db.none(`DELETE FROM tbl_arc_event_log WHERE arc_id = ANY($1::bigint[])`, [created.arcs]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::bigint[])`, [created.arcs]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [created.arcs]);
  }
  if (created.rfqs.length) {
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqs]);
  }
  await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [VENDOR, vendorTypeBefore]);
  await closeDb();
});

describe("pdfRenderer options (fake Chromium)", () => {
  function fakeLaunch() {
    const pdfCalls = [];
    const contentCalls = [];
    const launch = async () => ({
      isConnected: () => true,
      close: async () => {},
      newPage: async () => ({
        setContent: async (html, opts) => contentCalls.push(opts),
        pdf: async (opts) => {
          pdfCalls.push(opts);
          return new Uint8Array([37, 80, 68, 70, 45]); // "%PDF-"
        },
        close: async () => {},
      }),
    });
    return { launch, pdfCalls, contentCalls };
  }

  it("renderToBuffer returns a Buffer with the A4/background/12mm defaults and never waits for network idle", async () => {
    const f = fakeLaunch();
    const r = createPdfRenderer({ launch: f.launch });
    const buf = await r.renderToBuffer("<p>x</p>");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe("%PDF-");
    expect(f.pdfCalls[0]).toEqual({ ...DEFAULT_PDF_OPTIONS });
    expect(f.pdfCalls[0].path).toBeUndefined();
    expect(f.contentCalls[0]).toEqual({ waitUntil: "domcontentloaded" });
  });

  it("renderToFile writes to the path and per-document options replace the defaults", async () => {
    const f = fakeLaunch();
    const r = createPdfRenderer({ launch: f.launch });
    await r.renderToFile("<p>x</p>", "/tmp/out.pdf", { margin: NO_MARGIN });
    expect(f.pdfCalls[0]).toMatchObject({
      path: "/tmp/out.pdf",
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
  });
});

describe("migrated sites render real PDFs through the shared renderer", () => {
  it("paymentDocuments: tax invoice and payment receipt", async () => {
    const before = renderCalls.file;
    const invoice = await generateTaxInvoicePdf({
      recipientName: "Alpha Vendor Pvt Ltd",
      amount: 11800,
      paymentId: "pay_pdfsites",
      orderId: "order_pdfsites",
    });
    const receipt = await generatePaymentReceivedPdf({
      recipientName: "Alpha Vendor Pvt Ltd",
      amount: 11800,
      paymentId: "pay_pdfsites",
      orderId: "order_pdfsites",
    });
    expect(invoice).not.toBeNull();
    expect(receipt).not.toBeNull();
    filesToRemove.push(invoice.filePath, receipt.filePath);
    isRealPdf(fs.readFileSync(invoice.filePath));
    isRealPdf(fs.readFileSync(receipt.filePath));
    expect(renderCalls.file - before).toBe(2);
  });

  it("usersController.generateHospitalityInvoice", async () => {
    const before = renderCalls.file;
    const result = await UsersController.generateHospitalityInvoice(
      { id: -1, razorpay_order_id: "order_pdfsites_inv", amount: 5000 },
      { name: "Alpha Vendor", email: "alpha@test.local" },
      { name: "Alpha Vendor Pvt Ltd" },
      [{ item_type: "category", item_name: "Beverages", fee_amount: 5000, end_date: "2027-03-31" }]
    );
    expect(result).not.toBeNull();
    filesToRemove.push(result.filePath);
    isRealPdf(fs.readFileSync(result.filePath));
    expect(renderCalls.file - before).toBe(1);
  });

  it("GET /rfq/terms-pdf streams a real PDF", async () => {
    const { rfq_id } = await makeRFQ(db, { createdBy: BUYER, title: "PDF sites T&C" });
    created.rfqs.push(rfq_id);
    await db.none(`UPDATE tbl_rfq SET comment = $2 WHERE id = $1`, [
      rfq_id,
      "<h3>Payment</h3><p>Net 30 days from delivery.</p><ul><li>Delivery to site</li></ul>",
    ]);
    const before = renderCalls.buffer;
    const client = await httpClient(BUYER);
    const res = await client
      .get(`/api/v1/rfq/terms-pdf?rfq_id=${rfq_id}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    isRealPdf(res.body);
    expect(renderCalls.buffer - before).toBe(1);
  });

  it("GET /arc-v2/vendor/quote/:arcId/pdf streams the vendor's own quote as a real PDF", async () => {
    const arc = await db.one(
      `INSERT INTO tbl_arc
         (arc_number, title, category_id, hospitality_company_id, hotel_id,
          department_id, process_id, status,
          submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
       VALUES ('ARC-PDFSITES', 'PDF sites quote', $1, $2, $3, $4, $5, 'floated',
               NOW() - INTERVAL '7 days', NOW() + INTERVAL '7 days',
               NOW() + INTERVAL '30 days', NOW() + INTERVAL '365 days', $6)
       RETURNING id`,
      [TEST_CATEGORIES.beverages, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1, BUYER]
    );
    created.arcs.push(Number(arc.id));
    const item = await db.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom, target_price)
       VALUES ($1, 1, 500, 'litre', 120) RETURNING id`,
      [arc.id]
    );
    await db.none(`INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status) VALUES ($1, $2, 'invited')`, [
      arc.id,
      VENDOR,
    ]);
    const quote = await db.one(
      `INSERT INTO tbl_arc_quote (arc_id, vendor_id, submitted_at, terms_accepted_at, payment_terms)
       VALUES ($1, $2, NOW(), NOW(), 'Net 30') RETURNING id`,
      [arc.id, VENDOR]
    );
    await db.none(
      `INSERT INTO tbl_arc_quote_line (arc_quote_id, arc_item_id, rate, gst_pct, lead_time_days)
       VALUES ($1, $2, 110, 18, 7)`,
      [quote.id, item.id]
    );

    const before = renderCalls.file;
    const client = await httpClient(VENDOR);
    const res = await client
      .get(`/api/v1/arc-v2/vendor/quote/${arc.id}/pdf`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    isRealPdf(res.body);
    expect(renderCalls.file - before).toBe(1);
  });

  it("arcContractController.generateContractPdf hashes and uploads a real PDF", async () => {
    const realSend = s3Client.send;
    let uploaded = null;
    s3Client.send = async (command) => {
      uploaded = command.input;
      return { ETag: '"test"', $metadata: { httpStatusCode: 200 } };
    };
    try {
      const before = renderCalls.file;
      const out = await generateContractPdf(
        { arc_number: "ARC-PDFSITES", arc_id: null, is_group: false },
        { name: "Alpha Vendor" },
        [],
        987654,
        { htmlOverride: "<html><body><h1>Rate contract addendum</h1><p>Clause 1.</p></body></html>" }
      );
      expect(renderCalls.file - before).toBe(1);
      expect(uploaded).not.toBeNull();
      isRealPdf(uploaded.Body);
      const crypto = await import("crypto");
      expect(out.hash).toBe(crypto.createHash("sha256").update(uploaded.Body).digest("hex"));
    } finally {
      s3Client.send = realSend;
    }
  });

  it("callOffPoRenderer renders a call-off PO context to a real PDF", async () => {
    const out = path.join(os.tmpdir(), `calloff-pdfsites-${Date.now()}.pdf`);
    filesToRemove.push(out);
    const before = renderCalls.file;
    await renderCallOffPoPdfFile(
      {
        po: { po_number: "CO-PDFSITES-1", total_value: 23600, created_at: "2026-10-01 10:00:00" },
        buyer: { company_name: "Company A", hotel_name: "Hotel A-1", gst: "27AAAAA0000A1Z5", delivery_address: "Mumbai" },
        vendor: { name: "Alpha Vendor", email: "alpha@test.local" },
        arc: { arc_number: "ARC-PDFSITES", arc_title: "Beverages", mr_number: "MR-1" },
        lines: [{ quantity: 200, unit: "litre", unit_price: 100, total_price: 20000, gst_pct: 18, product_name: "Water" }],
      },
      out
    );
    expect(renderCalls.file - before).toBe(1);
    isRealPdf(fs.readFileSync(out));
  });
});
