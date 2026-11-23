// REQ-2026-0099 — no quote may be sent OR CHANGED while the vendor
// clarification window is open, on an RFQ exactly as on a tender.
// ---------------------------------------------------------------------------
// createQuote has refused a NEW quote during the window for a long time
// (rfq.clarificationTimezone.test.js §3). The edit path — PUT
// /rfq/quote/update/:quoteId → updateQuoteItems — never checked the window,
// so a vendor who already held a quote could change it mid-window. The client
// runs a pre-bid meeting during that window and needs every rate held back
// until it closes.
//
// Matrix pinned here, for BOTH an RFQ (is_tender 0) and a tender (is_tender 1):
//
//   window          create            update (existing quote)
//   open (+3h)      400, nothing      400, quote unchanged      ← update is new
//   closed (-3h)    200               200, price changed
//   none (NULL)     200               200, price changed
//
// plus: an OPEN clarification still blocks the edit (existing rule, untouched),
// and the window check reads IST (fixtures 3 hours from the boundary sit inside
// the 5h30m blind spot a UTC-process misparse would create).
//
// Product-level: the real controller functions against the local test DB.

import {
  describe, it, expect, afterAll, beforeEach, afterEach, jest,
} from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import rfqController from "../../app/controllers/rfq/rfqController.js";
import { makeRFQ } from "../factories/rfq.js";

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
      user: opts.user || null,
      params: opts.params || {},
      body: opts.body || {},
      query: opts.query || {},
      files: opts.files || [],
    },
    res,
    next: jest.fn(),
    calls,
  };
}

const vendor = () => ({
  id: IDS.users.vendor_alpha,
  user_type: 3,
  company_id: IDS.companies.vendorAlpha,
});

/** Naive IST wall-clock 'YYYY-MM-DD HH:MI:SS' at now + interval (DB clock). */
async function istWall(interval) {
  const { s } = await db.one(
    `SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') + $1::interval,
                    'YYYY-MM-DD HH24:MI:SS') AS s`,
    [interval]
  );
  return s;
}

const inserted = { rfqIds: [] };

beforeEach(() => {
  inserted.rfqIds = [];
});

afterEach(async () => {
  if (!inserted.rfqIds.length) return;
  const ids = inserted.rfqIds;
  await db.none(
    `DELETE FROM tbl_rfq_clarification_messages
     WHERE clarification_id IN (SELECT id FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[]))`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_clarifications WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(
    `DELETE FROM tbl_quote_item_history
     WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`, [ids]);
  await db.none(
    `DELETE FROM tbl_quote_item_files
     WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`, [ids]);
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(
    `DELETE FROM tbl_quotes_payment_terms
     WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`, [ids]);
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [ids]);
});

afterAll(async () => {
  await closeDb();
});

/**
 * A published RFQ or tender, bidding open for 5 days, one line (variant 1/0)
 * with vendor_alpha invited. `window`: 'open' | 'closed' | 'none'.
 */
async function seedRfq({ isTender, window }) {
  const { rfq_id } = await makeRFQ(db, {
    createdBy: IDS.users.a1_proc_buyer,
    status: 1,
    is_published: 1,
    is_tender: isTender ? 1 : 0,
    tender_publish_date: await istWall("-2 days"),
    vendor_clarification_date: await istWall(window === "open" ? "3 hours" : "-3 hours"),
    bid_end_date: await istWall("5 days"),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    process: IDS.processes.A_P1,
  });
  inserted.rfqIds.push(rfq_id);
  // The factory defaults a NULL clarification date to +5 days, so "no window"
  // is set explicitly afterwards.
  if (window === "none") {
    await db.none(`UPDATE tbl_rfq SET vendor_clarification_date = NULL WHERE id = $1`, [rfq_id]);
  }
  await db.none(
    `INSERT INTO tbl_rfq_products
       (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0)`,
    [rfq_id]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, 1, $2, 0)`,
    [rfq_id, IDS.users.vendor_alpha]
  );
  return rfq_id;
}

const line = (unitPrice) => ({
  product_id: 1,
  variant: 0,
  unit_price: unitPrice,
  tax: 18,
  tax_mode: "percentage",
  total_price: Math.round(unitPrice * 10 * 1.18),
  comment: "",
  delivery_period: "7d",
  quantity: "10",
  other_charges: [],
});

async function createQuote(rfq_id, unitPrice = 500) {
  const m = mockExpress({
    user: vendor(),
    body: { rfq_id, rfq_no: 999601, status: 1, products: [line(unitPrice)] },
  });
  await rfqController.createQuote(m.req, m.res, m.next);
  return m.calls;
}

async function updateQuote(rfq_id, quoteId, unitPrice) {
  const m = mockExpress({
    user: vendor(),
    params: { quoteId: String(quoteId) },
    body: {
      rfq_id, rfq_no: 999601,
      globalPaymentTerms: null, globalComment: null,
      global_payment_term_list: { createdTerms: [], updatedTerms: [], deletedTerms: [] },
      products: [line(unitPrice)],
    },
  });
  await rfqController.updateQuoteItems(m.req, m.res, m.next);
  return m.calls;
}

async function quoteState(rfq_id) {
  return db.oneOrNone(
    `SELECT q.id AS quote_id, qi.unit_price::numeric AS unit_price
       FROM tbl_quotes q
       JOIN tbl_quote_items qi ON qi.quote_id = q.id
      WHERE q.rfq_id = $1 AND q.created_by = $2
      ORDER BY qi.id DESC LIMIT 1`,
    [rfq_id, IDS.users.vendor_alpha]
  );
}

/**
 * A vendor holding a quote: quote while no window is set, then put the
 * window in the requested state — the only way a quote can pre-date an open
 * window (the buyer can no longer move the date once quotes are in).
 */
async function seedQuoted({ isTender, window }) {
  const rfq_id = await seedRfq({ isTender, window: "none" });
  const created = await createQuote(rfq_id, 500);
  expect(created.status).toBe(200);
  const before = await quoteState(rfq_id);
  expect(Number(before.unit_price)).toBe(500);
  if (window !== "none") {
    await db.none(`UPDATE tbl_rfq SET vendor_clarification_date = $2 WHERE id = $1`,
      [rfq_id, await istWall(window === "open" ? "3 hours" : "-3 hours")]);
  }
  return { rfq_id, quoteId: before.quote_id };
}

for (const kind of [{ label: "RFQ", isTender: false }, { label: "tender", isTender: true }]) {
  describe(`${kind.label}: sending a NEW quote`, () => {
    it("is refused while the clarification window is open, and nothing is written", async () => {
      const rfq_id = await seedRfq({ isTender: kind.isTender, window: "open" });
      const calls = await createQuote(rfq_id);
      expect(calls.status).toBe(400);
      expect(calls.body.message).toMatch(/blocked until the vendor clarification period ends/i);
      expect(await quoteState(rfq_id)).toBeNull();
    });

    it("is accepted once the clarification window has closed", async () => {
      const rfq_id = await seedRfq({ isTender: kind.isTender, window: "closed" });
      const calls = await createQuote(rfq_id);
      expect(calls.status).toBe(200);
      expect(Number((await quoteState(rfq_id)).unit_price)).toBe(500);
    });

    it("is accepted when there is no clarification window at all", async () => {
      const rfq_id = await seedRfq({ isTender: kind.isTender, window: "none" });
      const calls = await createQuote(rfq_id);
      expect(calls.status).toBe(200);
      expect(Number((await quoteState(rfq_id)).unit_price)).toBe(500);
    });
  });

  describe(`${kind.label}: CHANGING an existing quote`, () => {
    it("is refused while the clarification window is open, and the quote is untouched", async () => {
      const { rfq_id, quoteId } = await seedQuoted({ isTender: kind.isTender, window: "open" });
      const calls = await updateQuote(rfq_id, quoteId, 450);
      expect(calls.status).toBe(400);
      expect(calls.body.message).toMatch(/Quote update is blocked until the vendor clarification period ends/i);
      expect(Number((await quoteState(rfq_id)).unit_price)).toBe(500);
    });

    it("is accepted once the clarification window has closed", async () => {
      const { rfq_id, quoteId } = await seedQuoted({ isTender: kind.isTender, window: "closed" });
      const calls = await updateQuote(rfq_id, quoteId, 450);
      expect(calls.status).toBe(200);
      expect(Number((await quoteState(rfq_id)).unit_price)).toBe(450);
    });

    it("is accepted when there is no clarification window at all", async () => {
      const { rfq_id, quoteId } = await seedQuoted({ isTender: kind.isTender, window: "none" });
      const calls = await updateQuote(rfq_id, quoteId, 450);
      expect(calls.status).toBe(200);
      expect(Number((await quoteState(rfq_id)).unit_price)).toBe(450);
    });
  });
}

describe("an OPEN clarification still blocks changing a quote (rule unchanged)", () => {
  it("refuses the edit after the window has closed while a clarification is open", async () => {
    const { rfq_id, quoteId } = await seedQuoted({ isTender: false, window: "closed" });
    await db.none(
      `INSERT INTO tbl_rfq_clarifications (rfq_id, raised_by, subject, question, status, created_at)
       VALUES ($1, $2, 'Pre-bid meeting', 'Please share the meeting link', 'OPEN', NOW())`,
      [rfq_id, IDS.users.vendor_beta]
    );
    const calls = await updateQuote(rfq_id, quoteId, 450);
    expect(calls.status).toBe(400);
    expect(calls.body.message).toMatch(/open clarification pending response/i);
    expect(Number((await quoteState(rfq_id)).unit_price)).toBe(500);
  });
});
