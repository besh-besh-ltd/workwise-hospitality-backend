// The one test that launches a real browser.
//
// Everything else about PO documents is tested with the renderer stubbed, which
// is right for speed — but it leaves the single most dangerous assumption in
// this change unverified.
//
// The change made document generation STRICT: a PO whose document cannot be
// produced now fails its approval instead of quietly committing. That is the
// point. It also means that if the Handlebars template throws on some real PO
// shape — a missing helper argument, a null where a number is expected, a
// template picked by poTemplateSelector that nobody has rendered in months —
// the blast radius is no longer "stale PDF", it is "nobody can approve this PO".
// A stubbed renderer cannot catch that, because the stub never renders the
// template.
//
// So this suite runs the real chain end to end:
//
//   buildPOTemplateData (real, against Postgres)
//     -> Handlebars (real template from poTemplateSelector)
//       -> Chromium (real, via pdfRenderer)
//         -> PDF bytes on disk
//
// Only the S3 upload is stubbed, because that is a network call to someone
// else's service and has its own tests.
//
// It is deliberately slow (a real browser launch) and deliberately small.

import { describe, it, expect, afterAll, beforeAll } from "@jest/globals";
import fs from "fs";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import seoController from "../../app/controllers/seo/seoController.js";
import { pdfRenderer, createPdfRenderer } from "../../app/util/pdfRenderer.js";

// tests/setup/jestEnv.js replaces the shared renderer with a stub that writes a
// placeholder file. This suite wants the real one, so it swaps a genuine
// renderer back in for its own duration and restores the stub afterwards.
let realRenderer;
let stubbedRenderToFile;

beforeAll(() => {
  realRenderer = createPdfRenderer({ maxConcurrent: 1 });
  stubbedRenderToFile = pdfRenderer.renderToFile;
  pdfRenderer.renderToFile = (html, out) => realRenderer.renderToFile(html, out);
});

let SEQ = 7_900_000;
const next = () => ++SEQ;

const created = { rfqs: [], pos: [] };

// One afterAll, in order: restore the stub, close the browser, clean the rows,
// and only then release the pool — closeDb has to come last or the cleanup
// queries above it run against a closed connection.
afterAll(async () => {
  pdfRenderer.renderToFile = stubbedRenderToFile;
  await realRenderer.close();

  if (created.pos.length) {
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [created.pos]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [created.pos]);
  }
  if (created.rfqs.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [created.rfqs]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [created.rfqs]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [created.rfqs]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [created.rfqs]);
  }

  await closeDb();
});

/**
 * A PO complete enough to print: RFQ, product, vendor quote with charges, PO
 * header and PO line items. Committed (not withTx) because the render reads it
 * back through the production code path.
 */
async function makePrintablePo({ quantity = 10, unitPrice = 1500.5, deliveryPeriod = "7" } = {}) {
  const rfqNo = next();
  const rfq = await db.one(
    `INSERT INTO tbl_rfq (rfq_no, comment, company_name, response_email, contact_name,
                          contact_number, bid_end_date, location, is_published, status,
                          created_by, updated_by, "timestamp", hospitality_company_id,
                          hotel_id, process_id, is_tender, title)
     VALUES ($1,'','','b@t','b','0', NOW() + INTERVAL '7 days','Mumbai',1,1,$2,$2,NOW(),$3,$4,$5,0,$6)
     RETURNING id, rfq_no`,
    [rfqNo, IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1, IDS.processes.A_P1, `E2E PDF RFQ ${rfqNo}`]
  );
  created.rfqs.push(rfq.id);

  const product = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1,'','','','','',1,0) RETURNING id`,
    [rfq.id]
  );

  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp", is_regret)
     VALUES ($1,$2,$3,$3,1,NOW(),0) RETURNING id`,
    [rfq.id, rfq.rfq_no, IDS.users.vendor_alpha]
  );

  const quoteItem = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, package_price,
        tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
     VALUES ($1,$2,$3,1,$4,$5,0,18,0,0,'',$6,$7,'percentage','[]'::jsonb)
     RETURNING id`,
    [rfq.id, rfq.rfq_no, quote.id, unitPrice, unitPrice * quantity, deliveryPeriod, String(quantity)]
  );

  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order (rfq_id, rfq_product_id, quote_id, po_number, company_id,
                                         status, quantity, unit_price, finalized_vendor_id,
                                         total_value, initiated_by, created_at)
     VALUES ($1,ARRAY[$2::int],ARRAY[$3::int],$4,$5,'pending_approval',$6,$7,$8,$9,$10,NOW())
     RETURNING id, po_number`,
    [rfq.id, product.id, quoteItem.id, `E2E-${next()}`, IDS.companies.A, quantity, unitPrice,
     IDS.users.vendor_alpha, unitPrice * quantity, IDS.users.a1_proc_buyer]
  );
  created.pos.push(po.id);

  await db.none(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
     VALUES ($1,$2,$3,$4,'NOS',$5,$6)`,
    [po.id, product.id, quoteItem.id, quantity, unitPrice, unitPrice * quantity]
  );

  return po;
}

const readPdf = (absolutePath) => fs.readFileSync(absolutePath);

describe("PO document — real template, real browser", () => {
  it("renders a real PO to an actual PDF file", async () => {
    const po = await makePrintablePo();

    const result = await seoController.poPDF({
      po_id: po.id,
      company_id: IDS.companies.A,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
    });

    expect(result.ok).toBe(true);
    const bytes = readPdf(result.absolutePath);
    // %PDF- magic, and big enough to be a real page rather than an error stub.
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(5000);
  });

  it("names the file after the PO, never po-undefined.pdf", async () => {
    // The collision that let one tenant's failed render overwrite another's
    // scratch file.
    const po = await makePrintablePo();

    const result = await seoController.poPDF({
      po_id: po.id,
      company_id: IDS.companies.A,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
    });

    expect(result.file).toContain(po.po_number);
    expect(result.file).not.toContain("undefined");
  });

  it("renders a zero-quantity PO without throwing", async () => {
    // Strictness cuts both ways: a template helper that throws on an edge-case
    // PO now blocks its approval outright. Numeric edges are the likeliest
    // source, so they get rendered for real rather than assumed safe.
    const po = await makePrintablePo({ quantity: 0, unitPrice: 0 });

    const result = await seoController.poPDF({
      po_id: po.id,
      company_id: IDS.companies.A,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
    });

    expect(result.ok).toBe(true);
    expect(readPdf(result.absolutePath).length).toBeGreaterThan(1000);
  });

  it("renders a PO with a fractional total (amount-in-words path)", async () => {
    // amountInWords splits rupees from paise and calls toWords on each. A
    // fractional total is the input that exercises both branches.
    const po = await makePrintablePo({ quantity: 3, unitPrice: 1234.57 });

    const result = await seoController.poPDF({
      po_id: po.id,
      company_id: IDS.companies.A,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
    });

    expect(result.ok).toBe(true);
  });

  it("refuses a PO that does not exist rather than rendering a blank one", async () => {
    // The old fallback rendered a near-empty template and reported success.
    await expect(
      seoController.poPDF({
        po_id: 99_999_999,
        company_id: IDS.companies.A,
        hospitality_company_id: IDS.hospitality.A,
        hotel_id: IDS.hotels.A1,
      })
    ).rejects.toThrow();
  });

  it("renders several POs in a row on one browser", async () => {
    // The production failure was a burst: eight approvals in eighteen minutes,
    // collapsing after the fourth. This is that shape, scaled down, against a
    // real browser.
    const pos = [await makePrintablePo(), await makePrintablePo(), await makePrintablePo()];

    const results = [];
    for (const po of pos) {
      results.push(
        await seoController.poPDF({
          po_id: po.id,
          company_id: IDS.companies.A,
          hospitality_company_id: IDS.hospitality.A,
          hotel_id: IDS.hotels.A1,
        })
      );
    }

    expect(results.every((r) => r.ok)).toBe(true);
    for (const r of results) {
      expect(readPdf(r.absolutePath).subarray(0, 5).toString()).toBe("%PDF-");
    }
  });
});
