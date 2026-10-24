// Vendor invoices per delivery (Task C4, spec §5.2 "Invoices", D6).
//
// POST /po/raiseInvoice now takes the invoice's number, date and amount and,
// optionally, the dispatch note it bills; a PO carries as many invoices as it
// has deliveries. The old one-invoice-per-PO guard is gone. The legacy body
// (po_id + invoice_url only) still raises one invoice, as before.
//
// D6: an invoice raised before the goods arrive no longer blocks the GRN, and
// the GRN does not move the PO's status back from invoice_raised.
//
// Everything goes through HTTP and commits; the suite truncates the dynamic
// tables before and after. sendMail is wrapped (the transport is already
// stubbed by jestEnv) so the buyer team's email can be read.

import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import { randomUUID } from "crypto";

const actualCommon = await import("../../app/helper/common.js");
const sendMail = jest.fn((opts) => actualCommon.sendMail(opts));
jest.unstable_mockModule("../../app/helper/common.js", () => ({ ...actualCommon, sendMail }));

const { db, closeDb, truncateDynamic } = await import("../setup/db.js");
const { IDS } = await import("../fixtures/ids.js");
const { httpClient } = await import("../helpers/http.js");
const { grantRoleScope, revokeRoleScopes } = await import("../helpers/roleScope.js");
const fx = await import("../helpers/invPlanFixtures.js");
const { drainReceivingNotices } = await import("../../app/services/inventory/notifier.js");
const { getPODetailFull } = await import("../../app/models/poDashboardModel.js");

const { A1, A2, CO, VENDOR } = fx;
const OTHER_VENDOR = IDS.users.vendor_beta;
const LAPSED_VENDOR = IDS.users.vendor_gamma; // subscription ended 30 days ago
const RECV = IDS.users.a1_proc_techEval; // Storekeeper at A1 for the GRN test

const BUCKET_HOST = `${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
const OWN_URL = (key) => `https://${BUCKET_HOST}/${key}`;

let vendor, otherVendor, recv;
let TODAY;
const stamped = new Map();
const scopeIds = [];
const poIds = [];
const tracker = fx.newTracker(); // the call-off's ARC, contract and MR (not dynamic tables)

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  await truncateDynamic();
  TODAY = (await db.one(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
  // Fixture users carry user_type NULL; /po/raiseInvoice admits vendors only.
  for (const id of [VENDOR, OTHER_VENDOR, LAPSED_VENDOR]) {
    stamped.set(id, await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [id]));
    await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [id]);
  }
  const storekeeper = Number((await db.one(
    `SELECT id FROM tbl_roles WHERE title = 'Storekeeper' AND created_by IS NULL`
  )).id);
  scopeIds.push(await grantRoleScope(db, { userId: RECV, roleId: storekeeper, companyId: CO, hotelId: A1 }));
  [vendor, otherVendor, recv] = await Promise.all([VENDOR, OTHER_VENDOR, RECV].map((u) => httpClient(u)));
});

afterAll(async () => {
  await drainReceivingNotices();
  // The activity capture writes after each response; let the last ones land.
  await new Promise((r) => setTimeout(r, 500));
  await revokeRoleScopes(db, scopeIds);
  if (poIds.length) {
    await db.none(`DELETE FROM tbl_activity_events WHERE entity_type = 'PO' AND entity_id = ANY($1::bigint[])`, [poIds]);
  }
  await truncateDynamic();
  await fx.cleanupTracked(db, tracker);
  for (const [id, row] of stamped) {
    await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [id, row.user_type, row.status]);
  }
  await closeDb();
});

/** A committed RFQ PO of VENDOR's, delivered to A1 (and A2 when multi-hotel). */
async function makePo(opts = {}) {
  const po = await fx.makeRfqPo(db, { status: "dispatched", lines: [{ qty: 10, unit: "kg" }], ...opts });
  poIds.push(po.poId);
  return po;
}

/** A dispatch note straight in the table (B2 owns the API; this suite tests invoices). */
async function makeDispatch(poId, { hotelId = A1, status = "in_transit", number = null } = {}) {
  const row = await db.one(
    `INSERT INTO tbl_po_dispatch (dispatch_number, hospitality_company_id, po_id, vendor_id, hotel_id, status,
                                  challan_no, challan_date, expected_delivery_date)
     VALUES ($1, $2, $3, $4, $5, $6, 'DC-1', $7, $7) RETURNING id, dispatch_number`,
    [number ?? `DSP/${hotelId}/2026-27/${randomUUID().slice(0, 8)}`, CO, poId, VENDOR, hotelId, status, TODAY]
  );
  return { id: Number(row.id), dispatchNumber: row.dispatch_number };
}

const invoicesOf = (poId) => db.any(
  `SELECT id, document_url, invoice_number, invoice_date::text AS invoice_date, invoice_amount::text AS invoice_amount,
          dispatch_id, uploaded_by
     FROM tbl_purchase_order_document
    WHERE purchase_order_id = $1 AND document_type = 'invoice'
    ORDER BY id`,
  [poId]
);
const statusOf = async (poId) =>
  (await db.one(`SELECT status::text AS s FROM tbl_rfq_purchase_order WHERE id = $1`, [poId])).s;

/** The PO's invoice events, once `n` have been written (or after 5 s). */
async function eventsOf(poId, n) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const rows = await db.any(
      `SELECT hospitality_company_id, hotel_id, metadata
         FROM tbl_activity_events
        WHERE event_key = 'po_invoice_raised' AND entity_type = 'PO' AND entity_id = $1
        ORDER BY id`,
      [poId]
    );
    if (rows.length >= n || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const raise = (client, body) => client.post("/api/v1/po/raiseInvoice").send(body);
const invoice = (poId, over = {}) => ({
  po_id: poId,
  invoice_url: OWN_URL(`invoices/${randomUUID()}.pdf`),
  invoice_number: "INV-1001",
  invoice_date: TODAY,
  invoice_amount: "11800.50",
  ...over,
});

describe("invoices per delivery", () => {
  it("second invoice allowed with number/date/amount", async () => {
    const po = await makePo({ mappedHotels: [A1, A2] });
    const toA1 = await makeDispatch(po.poId, { hotelId: A1 });
    const toA2 = await makeDispatch(po.poId, { hotelId: A2 });

    const first = await raise(vendor, invoice(po.poId, { dispatch_id: toA1.id, invoice_date: addDays(TODAY, -2) }));
    expect(first.status).toBe(200);
    expect(first.body.status).toBe(1);
    expect(first.body.data).toMatchObject({ invoice_number: "INV-1001", dispatch_id: toA1.id });
    expect(await statusOf(po.poId)).toBe("invoice_raised");

    // The next delivery carries its own tax invoice: a second one is welcome.
    const second = await raise(vendor, invoice(po.poId, {
      invoice_number: "INV-1002", invoice_amount: 4500, dispatch_id: String(toA2.id),
    }));
    expect(second.status).toBe(200);
    // And one billing no particular dispatch.
    const third = await raise(vendor, invoice(po.poId, { invoice_number: "INV-1003", invoice_amount: "99.9" }));
    expect(third.status).toBe(200);

    expect(await invoicesOf(po.poId)).toEqual([
      expect.objectContaining({ invoice_number: "INV-1001", invoice_date: addDays(TODAY, -2), invoice_amount: "11800.5000", dispatch_id: toA1.id, uploaded_by: String(VENDOR) }),
      expect.objectContaining({ invoice_number: "INV-1002", invoice_date: TODAY, invoice_amount: "4500.0000", dispatch_id: toA2.id }),
      expect.objectContaining({ invoice_number: "INV-1003", invoice_amount: "99.9000", dispatch_id: null }),
    ]);
    expect(await statusOf(po.poId)).toBe("invoice_raised");

    // The vendor's Deliveries tab lists them, against their dispatch notes.
    const view = await vendor.get(`/api/v1/inventory/vendor/po/${po.poId}/deliveries`);
    expect(view.status).toBe(200);
    expect(view.body.data.invoices).toEqual([
      expect.objectContaining({
        invoiceNumber: "INV-1001", invoiceDate: addDays(TODAY, -2), invoiceAmount: 11800.5,
        dispatchId: toA1.id, dispatchNumber: toA1.dispatchNumber, documentUrl: expect.stringContaining("/invoices/"),
        createdAt: expect.any(String),
      }),
      expect.objectContaining({ invoiceNumber: "INV-1002", invoiceAmount: 4500, dispatchId: toA2.id, dispatchNumber: toA2.dispatchNumber }),
      expect.objectContaining({ invoiceNumber: "INV-1003", invoiceAmount: 99.9, dispatchId: null, dispatchNumber: null }),
    ]);

    // The trail records each invoice with what was billed (the capture writes
    // after the response, so wait for it).
    // Each is filed under the hotel it bills: its dispatch's, and, for the one
    // naming no dispatch, the PO's own hotel (A1), not "no hotel".
    const events = await eventsOf(po.poId, 3);
    expect(events.map((e) => [e.metadata.invoiceNumber, e.hospitality_company_id, e.hotel_id])).toEqual([
      ["INV-1001", CO, A1],
      ["INV-1002", CO, A2],
      ["INV-1003", CO, A1],
    ]);
    expect(events[1].metadata).toMatchObject({ invoiceNumber: "INV-1002", invoiceAmount: "4500.00", dispatchId: toA2.id });
    expect(events[2].metadata).toMatchObject({ invoiceAmount: "99.90", dispatchId: null });
  });

  it("the buyer team's email names the invoice, its date, amount and dispatch", async () => {
    const po = await makePo();
    const sent = await makeDispatch(po.poId, { number: `DSP/A1/2026-27/${randomUUID().slice(0, 6)}` });
    sendMail.mockClear();
    const res = await raise(vendor, invoice(po.poId, {
      invoice_number: "INV-<B&C>", invoice_date: "2026-04-03", invoice_amount: "70500", dispatch_id: sent.id,
    }));
    expect(res.status).toBe(200);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toContain("Invoice INV-<B&C> raised by");
    expect(mail.html).toContain("Invoice Details");
    expect(mail.html).toContain("INV-&lt;B&amp;C&gt;"); // the vendor's text, escaped
    expect(mail.html).not.toContain("INV-<B&C>");
    expect(mail.html).toContain("3 Apr 2026");
    expect(mail.html).toContain("₹70,500.00");
    expect(mail.html).toContain(sent.dispatchNumber);

    // A file-only invoice has no details to list.
    const legacyPo = await makePo();
    sendMail.mockClear();
    expect((await raise(vendor, { po_id: legacyPo.poId, invoice_url: OWN_URL("invoices/l.pdf") })).status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].html).not.toContain("Invoice Details");
  });

  it("the PO's documents name each invoice, and the lifecycle dates the first", async () => {
    const po = await makePo();
    expect((await raise(vendor, { po_id: po.poId, invoice_url: OWN_URL("invoices/old.pdf") })).status).toBe(200);
    expect((await raise(vendor, invoice(po.poId, { invoice_number: "INV-1", invoice_amount: "70500" }))).status).toBe(200);
    expect((await raise(vendor, invoice(po.poId, { invoice_number: "INV-2", invoice_amount: "1234.5" }))).status).toBe(200);
    // Spread the three in time so "first" is unambiguous.
    const rows = await invoicesOf(po.poId);
    for (const [i, row] of rows.entries()) {
      await db.none(
        `UPDATE tbl_purchase_order_document SET created_at = TIMESTAMP '2026-04-01 10:00' + ($2 || ' days')::interval WHERE id = $1`,
        [row.id, i]
      );
    }

    const detail = await getPODetailFull(po.poId, { vendorId: VENDOR });
    const names = detail.docs.filter((d) => d.type === "invoice").map((d) => d.name).sort();
    expect(names).toEqual(["Invoice INV-1 · ₹70,500", "Invoice INV-2 · ₹1,234.50", "Invoice document"]);

    const first = await db.one(`SELECT created_at FROM tbl_purchase_order_document WHERE id = $1`, [rows[0].id]);
    const step = detail.workflow.find((w) => w.title === "Invoice raised");
    expect(step).toMatchObject({ status: "done" });
    expect(new Date(step.when).toISOString()).toBe(new Date(first.created_at).toISOString());
  });

  it("a call-off PO is invoiced, and the trail files it under the MR's hotel", async () => {
    // Call-offs have no RFQ, so the registry's PO lookup finds no scope: the
    // controller's own (from the PO row) is what keeps the event.
    const po = await fx.makeCallOffPo(db, { hotel: A2, status: "dispatched", lines: [{ qty: 6 }], tracker });
    poIds.push(po.poId);
    const res = await raise(vendor, invoice(po.poId, { invoice_number: "CO-INV-1" }));
    expect(res.status).toBe(200);
    expect(await statusOf(po.poId)).toBe("invoice_raised");
    const [event] = await eventsOf(po.poId, 1);
    expect(event).toMatchObject({ hospitality_company_id: CO, hotel_id: A2 });
    expect(event.metadata).toMatchObject({ invoiceNumber: "CO-INV-1", dispatchId: null });
  });

  it("invoice before GRN no longer blocks GRN", async () => {
    // The vendor bills as the goods leave, before the hotel has received anything.
    const po = await makePo({ status: "approved", lines: [{ qty: 10, unit: "kg" }] });
    const res = await raise(vendor, invoice(po.poId, { invoice_number: "EARLY-1" }));
    expect(res.status).toBe(200);
    expect(await statusOf(po.poId)).toBe("invoice_raised");

    // The hotel then receives against the PO: the invoice is no obstacle.
    const grn = await recv.post("/api/v1/inventory/grn").send({
      poId: po.poId, hotelId: A1, receivedAt: TODAY, post: true, clientEventId: randomUUID(),
      lines: [{ poLineId: po.lineIds[0], receivedQty: 4, acceptedQty: 4, rejectedQty: 0 }],
    });
    expect(grn.status).toBe(201);
    expect(grn.body.data).toMatchObject({ poId: po.poId, status: "posted" });

    // Status only moves forward: the GRN leaves invoice_raised where it is.
    const head = await db.one(
      `SELECT status::text AS status, receipt_status FROM tbl_rfq_purchase_order WHERE id = $1`, [po.poId]
    );
    expect(head).toEqual({ status: "invoice_raised", receipt_status: "partial" });
  });

  it("the legacy body (file only) still raises one invoice", async () => {
    const po = await makePo();
    const url = OWN_URL("invoices/legacy.pdf");
    const legacy = await raise(vendor, { po_id: po.poId, invoice_url: url });
    expect(legacy.status).toBe(200);
    expect(await invoicesOf(po.poId)).toEqual([
      expect.objectContaining({ document_url: url, invoice_number: null, invoice_date: null, invoice_amount: null, dispatch_id: null }),
    ]);
    expect(await statusOf(po.poId)).toBe("invoice_raised");

    // A second file-only invoice (a double click) is refused: nothing tells them apart.
    const again = await raise(vendor, { po_id: po.poId, invoice_url: url });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ status: 0, code: "CONFLICT" });
    // A numbered one is fine.
    expect((await raise(vendor, invoice(po.poId, { invoice_number: "INV-9" }))).status).toBe(200);
    expect(await invoicesOf(po.poId)).toHaveLength(2);
  });

  it("a dispatch of another PO, or a cancelled one, is refused", async () => {
    const po = await makePo();
    const other = await makePo();
    const foreign = await makeDispatch(other.poId);
    const cancelled = await makeDispatch(po.poId, { status: "cancelled" });

    const res = await raise(vendor, invoice(po.poId, { dispatch_id: foreign.id }));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: 2, code: "NOT_FOUND" });
    const gone = await raise(vendor, invoice(po.poId, { dispatch_id: 999999999 }));
    expect(gone.status).toBe(404);
    const bad = await raise(vendor, invoice(po.poId, { dispatch_id: "12abc" }));
    expect(bad.status).toBe(400);
    expect(bad.body.details).toMatchObject({ field: "dispatch_id" });
    const withdrawn = await raise(vendor, invoice(po.poId, { dispatch_id: cancelled.id }));
    expect(withdrawn.status).toBe(409);

    expect(await invoicesOf(po.poId)).toEqual([]);
    expect(await statusOf(po.poId)).toBe("dispatched");
  });

  it("another vendor gets 404 and nothing is written", async () => {
    const po = await makePo();
    const res = await raise(otherVendor, invoice(po.poId));
    expect(res.status).toBe(404);
    expect(await invoicesOf(po.poId)).toEqual([]);
    expect(await statusOf(po.poId)).toBe("dispatched");

    // A buyer is not a vendor at all.
    const buyer = await httpClient(fx.BUYER);
    await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [fx.BUYER]);
    try {
      expect((await raise(buyer, invoice(po.poId))).status).toBe(403);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [fx.BUYER]);
    }
  });

  it("only an accepted purchase order can be invoiced", async () => {
    // Not released to the vendor yet: not theirs to see.
    for (const status of ["draft", "pending_approval"]) {
      const po = await makePo({ status });
      const res = await raise(vendor, invoice(po.poId));
      expect([status, res.status]).toEqual([status, 404]);
    }
    // Released but not accepted, or turned down: refused, with the reason.
    for (const status of ["acceptance_pending", "rejected_by_vendor"]) {
      const po = await makePo({ status });
      const res = await raise(vendor, invoice(po.poId));
      expect([status, res.status, res.body.code]).toEqual([status, 409, "CONFLICT"]);
      expect(await invoicesOf(po.poId)).toEqual([]);
      expect(await statusOf(po.poId)).toBe(status);
    }
    // A completed PO takes a late invoice and stays completed.
    const done = await makePo({ status: "completed" });
    expect((await raise(vendor, invoice(done.poId))).status).toBe(200);
    expect(await statusOf(done.poId)).toBe("completed");
  });

  it("a duplicate invoice number is refused", async () => {
    const po = await makePo();
    expect((await raise(vendor, invoice(po.poId, { invoice_number: "inv/77" }))).status).toBe(200);
    const dup = await raise(vendor, invoice(po.poId, { invoice_number: "  INV/77 " }));
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: "CONFLICT", details: { field: "invoice_number" } });
    expect(dup.body.message).toMatch(/INV\/77/);
    expect(await invoicesOf(po.poId)).toHaveLength(1);

    // The same number on another PO is that PO's business.
    const other = await makePo();
    expect((await raise(vendor, invoice(other.poId, { invoice_number: "INV/77" }))).status).toBe(200);
  });

  it("refuses a bad amount, date or number", async () => {
    const po = await makePo();
    const cases = [
      [{ invoice_amount: 0 }, "invoice_amount"],
      [{ invoice_amount: "-5" }, "invoice_amount"],
      [{ invoice_amount: "12.345" }, "invoice_amount"],
      [{ invoice_amount: "1,000" }, "invoice_amount"],
      [{ invoice_amount: "abc" }, "invoice_amount"],
      [{ invoice_amount: true }, "invoice_amount"],
      [{ invoice_amount: "123456789012345" }, "invoice_amount"],
      [{ invoice_amount: null }, "invoice_amount"],
      [{ invoice_date: "2026-02-30" }, "invoice_date"],
      [{ invoice_date: "30/01/2026" }, "invoice_date"],
      [{ invoice_date: addDays(TODAY, 1) }, "invoice_date"],
      [{ invoice_date: "" }, "invoice_date"],
      [{ invoice_number: "" }, "invoice_number"],
      [{ invoice_number: "   " }, "invoice_number"],
      [{ invoice_number: "X".repeat(65) }, "invoice_number"],
      [{ invoice_number: { a: 1 } }, "invoice_number"],
    ];
    for (const [over, field] of cases) {
      const res = await raise(vendor, invoice(po.poId, over));
      expect([JSON.stringify(over), res.status, res.body.code, res.body.details?.field])
        .toEqual([JSON.stringify(over), 400, "VALIDATION", field]);
    }
    expect(await invoicesOf(po.poId)).toEqual([]);
    expect(await statusOf(po.poId)).toBe("dispatched");

    // The edges that are fine: 64 characters, today, two decimals.
    const ok = await raise(vendor, invoice(po.poId, { invoice_number: "Y".repeat(64), invoice_amount: "0.01" }));
    expect(ok.status).toBe(200);
  });
});

describe("vendor dispatch guards", () => {
  const dispatchNote = (poLineId) => ({
    challanNo: "DC-9", challanDate: TODAY, expectedDeliveryDate: TODAY, lines: [{ poLineId, qty: 1 }],
  });
  const dispatchesOf = (poId) => db.any(`SELECT id, status FROM tbl_po_dispatch WHERE po_id = $1 ORDER BY id`, [poId]);

  it("a vendor whose subscription has lapsed cannot record or withdraw a dispatch, but still sees the plan", async () => {
    const po = await makePo({ status: "approved", vendor: LAPSED_VENDOR });
    const before = await db.one(`SELECT is_hospitality FROM tbl_company WHERE id = $1`, [IDS.companies.vendorGamma]);
    // The gate restricts hospitality vendors only; Gamma is one for this test.
    await db.none(`UPDATE tbl_company SET is_hospitality = 1 WHERE id = $1`, [IDS.companies.vendorGamma]);
    try {
      const lapsed = await httpClient(LAPSED_VENDOR);
      const base = `/api/v1/inventory/vendor/po/${po.poId}`;
      const post = await lapsed.post(`${base}/dispatches`).send(dispatchNote(po.lineIds[0]));
      expect(post.status).toBe(403);
      expect(post.body).toMatchObject({ status: 0, subscription_expired: true });
      expect(await dispatchesOf(po.poId)).toEqual([]);

      const onRoad = await makeDispatch(po.poId);
      await db.none(`UPDATE tbl_po_dispatch SET vendor_id = $2 WHERE id = $1`, [onRoad.id, LAPSED_VENDOR]);
      const cancel = await lapsed.post(`${base}/dispatches/${onRoad.id}/cancel`);
      expect(cancel.status).toBe(403);
      expect(await dispatchesOf(po.poId)).toEqual([{ id: onRoad.id, status: "in_transit" }]);

      // Reading is not gated.
      expect((await lapsed.get(`${base}/deliveries`)).status).toBe(200);
    } finally {
      await db.none(`UPDATE tbl_company SET is_hospitality = $2 WHERE id = $1`, [IDS.companies.vendorGamma, before.is_hospitality]);
    }
  });

  it("a dispatch an invoice bills cannot be withdrawn", async () => {
    const po = await makePo({ status: "approved" });
    const billed = await makeDispatch(po.poId);
    const unbilled = await makeDispatch(po.poId);
    expect((await raise(vendor, invoice(po.poId, { invoice_number: "INV-55", dispatch_id: billed.id }))).status).toBe(200);

    const base = `/api/v1/inventory/vendor/po/${po.poId}/dispatches`;
    const refused = await vendor.post(`${base}/${billed.id}/cancel`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ status: 0, code: "CONFLICT", details: { dispatchId: billed.id } });
    expect(refused.body.message).toMatch(/INV-55/);

    // A dispatch no invoice names is withdrawn as before.
    expect((await vendor.post(`${base}/${unbilled.id}/cancel`)).status).toBe(200);
    expect(await dispatchesOf(po.poId)).toEqual([
      { id: billed.id, status: "in_transit" },
      { id: unbilled.id, status: "cancelled" },
    ]);
  });
});
