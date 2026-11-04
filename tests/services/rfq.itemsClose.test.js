// RFQ items closed without award.
// ----------------------------------------------------------------------------
// An RFQ with several items is often only partly awarded: some items get a
// vendor and a PO, others are never quoted (or never acceptably). Until now an
// item had no state of its own, so the leftovers stayed "open" for good: the
// RFQ never reached Completed, its draft POs never auto-initiated (that waits
// for every item to be awarded), linked requisition lines stayed in sourcing,
// and vendors could keep quoting the leftovers.
//
// The buyer can now close an item without award, with a reason. These tests
// run the real routes over HTTP (POST /rfq/:id/items/close, .../reopen,
// GET /rfq/:id/close-preview, POST /rfq/close-rfq/:id) and the real shared
// queries that must now treat a closed item as settled: PO auto-initiate,
// PO coverage, the lifecycle stage, the RFQ outcome, and the gates on
// quoting, awarding, negotiation, vendor refresh and reminders.

import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import { makePO } from "../helpers/dashboardSeed.js";
import rfqModel from "../../app/models/rfqModel.js";
import hospitalityModel from "../../app/models/hospitalityModel.js";
import { isRfqFullyAwarded } from "../../app/models/purchaseOrderModel.js";
import { getRfqPoCoverage, classifyInitiateKind } from "../../app/models/po/poInitiateGuide.js";
import { getAwardOutcomes } from "../../app/services/rfq/rfqItemClosure.js";

const BUYER = IDS.users.a1_proc_buyer; // the RFQ creator
const OTHER_BUYER = IDS.users.a1_eng_buyer;
const VENDOR = IDS.users.vendor_alpha;
const VENDOR_B = IDS.users.vendor_beta;
const NEGOTIATOR = 80975; // negotiation.create + quote-compare.create on HC A / A1
const ROLE_NEG = 8;

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** "YYYY-MM-DD HH:mm:ss" IST wall clock `offsetMs` from now: how bid_end_date is stored. */
const ist = (offsetMs) => new Date(Date.now() + offsetMs + 5.5 * HOUR).toISOString().replace("T", " ").slice(0, 19);
const utc = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);

let VARIANT = 1;
let POLICY_ID = null;
let userTypesBefore = [];

beforeAll(async () => {
  const v = await db.oneOrNone(`SELECT id FROM tbl_product_variant ORDER BY id ASC LIMIT 1`);
  if (v) VARIANT = v.id;
  // acl([2, 8]) and createQuote read user_type; fixture users leave it NULL.
  userTypesBefore = await db.any(
    `SELECT id, user_type FROM tbl_users WHERE id = ANY($1::int[])`, [[BUYER, OTHER_BUYER, VENDOR, VENDOR_B]]
  );
  await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [[BUYER, OTHER_BUYER]]);
  await db.none(`UPDATE tbl_users SET user_type = 3 WHERE id = ANY($1::int[])`, [[VENDOR, VENDOR_B]]);

  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'Item close negotiator', 'itemclose.negotiator@test.local', 1, 2, $2, now(), now())
     ON CONFLICT (id) DO UPDATE SET user_type = 2, status = 1`,
    [NEGOTIATOR, IDS.companies.A]
  );
  await db.none(
    `INSERT INTO tbl_hospitality_user_mappings
       (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
    [NEGOTIATOR, IDS.hospitality.A, IDS.hotels.A1, IDS.users.superAdmin]
  );
  await db.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
     VALUES ($1, $2, $3, $4, NULL)`,
    [NEGOTIATOR, ROLE_NEG, IDS.hospitality.A, IDS.hotels.A1]
  );

  // Any policy row: approval instances need one by FK; these tests seed the
  // instances they need directly.
  POLICY_ID = Number((await db.one(`SELECT id FROM tbl_approval_policies ORDER BY id LIMIT 1`)).id);
});

afterAll(async () => {
  for (const u of userTypesBefore) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id = $1`, [u.id, u.user_type]);
  }
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [NEGOTIATOR]);
  await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1`, [NEGOTIATOR]);
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [NEGOTIATOR]);
  await closeDb();
});

const made = { rfqIds: [], poIds: [] };
beforeEach(() => { made.rfqIds = []; made.poIds = []; });

afterEach(async () => {
  const rfqIds = made.rfqIds;
  if (!rfqIds.length) return;
  const poIds = (await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[])`, [rfqIds]))
    .map((r) => Number(r.id));
  const instanceIds = (await db.any(
    `SELECT id FROM tbl_approval_instances
      WHERE (entity_type = 'PO' AND entity_id = ANY($2::int[]))
         OR (entity_type IN ('NEGOTIATION_QUOTE', 'ARC')
             AND entity_id IN (SELECT id FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])))
         OR (entity_type IN ('RFQ', 'TENDER') AND entity_id = ANY($1::int[]))`,
    [rfqIds, poIds]
  )).map((r) => Number(r.id));
  // An auto-initiated PO points at its approval instance.
  if (poIds.length) {
    await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE id = ANY($1::int[])`, [poIds]);
  }
  if (instanceIds.length) {
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN (
         SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [instanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);
  }
  if (poIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_document WHERE purchase_order_id = ANY($1::int[])`, [poIds]).catch(() => {});
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
  }
  await db.none(`DELETE FROM tbl_negotiation_rounds WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_notifications WHERE additional_data->>'rfq_id' = ANY($1::text[])`, [rfqIds.map(String)]).catch(() => {});
  await db.none(`DELETE FROM tbl_quote_finalization_history WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_quotes_payment_terms WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`, [rfqIds]);
  await db.none(`DELETE FROM tbl_quote_item_history WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`, [rfqIds]);
  await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_vendor_rfq_tokens_non_login WHERE rfq_no = ANY($1::int[])`, [rfqIds]).catch(() => {});
  await db.none(`DELETE FROM tbl_rfq_product_closure WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[]) AND entity_type IN ('RFQ', 'TENDER')`, [rfqIds]);
  await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
});

// ---- setup helpers ---------------------------------------------------------

/**
 * A published RFQ with three items (same variant, variants 0/1/2) and VENDOR
 * invited on all of them. Bid window closed two days ago unless `bidOpen`.
 * Returns { rfq_id, rfq_no, items: [A, B, C] } (tbl_rfq_products ids).
 */
async function threeItemRfq({ bidOpen = false, invite = [VENDOR] } = {}) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: BUYER,
    status: 1,
    is_published: 1,
    tender_publish_date: utc(-4 * DAY),
    vendor_clarification_date: utc(-3 * DAY),
    bid_end_date: bidOpen ? ist(3 * DAY) : ist(-2 * DAY),
    hospitality: IDS.hospitality.A,
    hotel: IDS.hotels.A1,
    department: IDS.departments.proc,
    process: IDS.processes.A_P1,
    title: "items close fixture",
  });
  made.rfqIds.push(rfq_id);
  const items = [];
  for (const variant of [0, 1, 2]) {
    const row = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, $3) RETURNING id`,
      [rfq_id, VARIANT, variant]
    );
    items.push(Number(row.id));
    await db.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, $2, 'Quantity', '10', $3), ($1, $2, 'Unit', 'NOS', $3)`,
      [rfq_id, VARIANT, variant]
    );
    for (const v of invite) {
      await db.none(
        `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, $4)`,
        [rfq_id, VARIANT, v, variant]
      );
    }
  }
  return { rfq_id, rfq_no, items };
}

const variantOf = (rfq, itemId) => rfq.items.indexOf(itemId);

/** A vendor's quote line on one item; returns { quote_id, quote_item_id }. */
async function plantQuote(rfq, vendorId, itemId, { regret = false } = {}) {
  const q = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, is_regret, "timestamp")
     VALUES ($1, $2, $3, $3, 1, $4, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')) RETURNING id`,
    [rfq.rfq_id, rfq.rfq_no, vendorId, regret ? 1 : 0]
  );
  if (regret) return { quote_id: Number(q.id), quote_item_id: null };
  const qi = await db.one(
    `INSERT INTO tbl_quote_items
       (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, package_price,
        tax, freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
     VALUES ($1, $2, $3, $4, 100, 1000, 0, 18, 0, $5, 'q', '15', '10', 'percentage', '[]')
     RETURNING id`,
    [rfq.rfq_id, rfq.rfq_no, q.id, VARIANT, variantOf(rfq, itemId)]
  );
  return { quote_id: Number(q.id), quote_item_id: Number(qi.id) };
}

/** The award row for an item (tbl_quote_finalization), as finalize writes it. */
async function award(rfq, itemId, vendorId = VENDOR) {
  const { quote_id } = await plantQuote(rfq, vendorId, itemId);
  await db.none(
    `INSERT INTO tbl_quote_finalization (rfq_id, rfq_no, quote_id, product_variant_id, vendor_id, created_by, variant)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [rfq.rfq_id, rfq.rfq_no, quote_id, VARIANT, vendorId, BUYER, variantOf(rfq, itemId)]
  );
}

/** A PENDING award approval (NEGOTIATION_QUOTE, entity = the item). */
async function pendingAward(rfq, itemId) {
  await db.none(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by, metadata, created_at)
     VALUES ('NEGOTIATION_QUOTE', $1, $2, 'PENDING', 1, $3, $4, $5, $6, $7::jsonb, NOW())`,
    [itemId, POLICY_ID, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, BUYER,
     JSON.stringify({ rfq_id: rfq.rfq_id })]
  );
}

async function po(rfq, itemId, status) {
  const { po_id } = await makePO(db, {
    rfq_id: rfq.rfq_id, rfq_product_id: itemId, vendor_user_id: VENDOR, company_id: IDS.companies.A,
    status, unit_price: 100, quantity: 10, total_value: 1000, initiated_by: BUYER,
  });
  return Number(po_id);
}

const item = (id) => db.one(
  `SELECT closed_at, closed_by, close_reason_code, close_remarks FROM tbl_rfq_products WHERE id = $1`, [id]
);
const closureLog = (rfqId) => db.any(
  `SELECT rfq_product_id, action, reason_code, remarks, acted_by FROM tbl_rfq_product_closure
    WHERE rfq_id = $1 ORDER BY id`, [rfqId]
);

async function closeItems(rfqId, body, userId = BUYER) {
  return (await httpClient(userId)).post(`/api/v1/rfq/${rfqId}/items/close`).send(body);
}
async function reopenItems(rfqId, body, userId = BUYER) {
  return (await httpClient(userId)).post(`/api/v1/rfq/${rfqId}/items/reopen`).send(body);
}

// ============================================================================

describe("POST /rfq/:id/items/close", () => {
  it("closes open items with a reason and leaves the RFQ open", async () => {
    const rfq = await threeItemRfq();
    const [, B, C] = rfq.items;

    const res = await closeItems(rfq.rfq_id, {
      rfq_product_ids: [B, C], reason_code: "no_quotes_received", remarks: "  nobody quoted  ",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.closed.sort()).toEqual([B, C].sort());
    expect(res.body.data.already_closed).toEqual([]);

    for (const id of [B, C]) {
      const row = await item(id);
      expect(row.closed_at).not.toBeNull();
      expect(Number(row.closed_by)).toBe(BUYER);
      expect(row.close_reason_code).toBe("no_quotes_received");
      expect(row.close_remarks).toBe("nobody quoted");
    }
    expect((await item(rfq.items[0])).closed_at).toBeNull();

    const log = await closureLog(rfq.rfq_id);
    expect(log.map((r) => [r.rfq_product_id, r.action, r.reason_code])).toEqual(
      [B, C].sort((a, b) => a - b).map((id) => [id, "close", "no_quotes_received"])
    );

    const rfqRow = await db.one(`SELECT status FROM tbl_rfq WHERE id = $1`, [rfq.rfq_id]);
    expect(Number(rfqRow.status)).toBe(1);

    const ev = await db.oneOrNone(
      `SELECT metadata FROM tbl_lifecycle_history
        WHERE entity_type = 'RFQ' AND entity_id = $1 AND action = 'RFQ_ITEMS_CLOSED'`,
      [rfq.rfq_id]
    );
    expect(ev.metadata.rfq_product_ids.sort()).toEqual([B, C].sort());

    // The response carries the fresh preview, so the dialog can redraw.
    const states = Object.fromEntries(res.body.data.preview.items.map((i) => [i.rfq_product_id, i.state]));
    expect(states[B]).toBe("closed_no_award");
    expect(states[rfq.items[0]]).toBe("open");
  });

  it("refuses anyone but the RFQ creator and writes nothing", async () => {
    const rfq = await threeItemRfq();
    const res = await closeItems(rfq.rfq_id, { rfq_product_ids: [rfq.items[1]], reason_code: "no_quotes_received" }, OTHER_BUYER);
    expect(res.status).toBe(403);
    expect((await item(rfq.items[1])).closed_at).toBeNull();
    expect(await closureLog(rfq.rfq_id)).toEqual([]);
  });

  it("refuses while the bid window is open, unless every invited vendor regretted", async () => {
    const rfq = await threeItemRfq({ bidOpen: true });
    const [A] = rfq.items;

    let res = await closeItems(rfq.rfq_id, { rfq_product_ids: [A], reason_code: "no_quotes_received" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
    expect(res.body.details.items[0].blockers).toEqual(["bid_window_open"]);
    expect((await item(A)).closed_at).toBeNull();

    await plantQuote(rfq, VENDOR, A, { regret: true });
    res = await closeItems(rfq.rfq_id, { rfq_product_ids: [A], reason_code: "all_vendors_regretted" });
    expect(res.status).toBe(200);
    expect((await item(A)).close_reason_code).toBe("all_vendors_regretted");
  });

  it("refuses an awarded item or one awaiting award approval, and closes nothing in that request", async () => {
    const rfq = await threeItemRfq();
    const [A, B, C] = rfq.items;
    await award(rfq, A);
    await pendingAward(rfq, B);

    let res = await closeItems(rfq.rfq_id, { rfq_product_ids: [A, C], reason_code: "quotes_not_acceptable" });
    expect(res.status).toBe(409);
    expect(res.body.details.items).toEqual([expect.objectContaining({ rfq_product_id: A, blockers: ["awarded"] })]);
    // All or nothing: C was closable but the request was refused as a whole.
    expect((await item(C)).closed_at).toBeNull();

    res = await closeItems(rfq.rfq_id, { rfq_product_ids: [B], reason_code: "quotes_not_acceptable" });
    expect(res.status).toBe(409);
    expect(res.body.details.items[0].blockers).toEqual(["award_pending"]);
    expect(await closureLog(rfq.rfq_id)).toEqual([]);
  });

  it("refuses an item a live negotiation round covers", async () => {
    const rfq = await threeItemRfq();
    const [A] = rfq.items;
    await db.none(
      `INSERT INTO tbl_negotiation_rounds
         (rfq_id, rfq_product_id, round_number, end_date, status, created_by, source_type, source_id,
          vendor_ids, vendor_approvals, created_at)
       VALUES ($1, $2, 1, (now() AT TIME ZONE 'UTC') + interval '1 day', 'ACTIVE', $3, 'RFQ', $1,
               ARRAY[$4]::int[], '[]'::jsonb, now())`,
      [rfq.rfq_id, A, BUYER, VENDOR]
    );
    const res = await closeItems(rfq.rfq_id, { rfq_product_ids: [A], reason_code: "quotes_not_acceptable" });
    expect(res.status).toBe(409);
    expect(res.body.details.items[0].blockers).toEqual(["negotiation_round"]);
  });

  it("validates the input", async () => {
    const rfq = await threeItemRfq();
    const other = await threeItemRfq();
    const [A] = rfq.items;

    let res = await closeItems(rfq.rfq_id, { rfq_product_ids: [A], reason_code: "other" });
    expect(res.status).toBe(400);
    expect(res.body.details.field).toBe("remarks");

    res = await closeItems(rfq.rfq_id, { rfq_product_ids: [A], reason_code: "rfq_closed" });
    expect(res.status).toBe(400); // reserved for Close RFQ

    res = await closeItems(rfq.rfq_id, { rfq_product_ids: [], reason_code: "no_quotes_received" });
    expect(res.status).toBe(400);

    res = await closeItems(rfq.rfq_id, { rfq_product_ids: [other.items[0]], reason_code: "no_quotes_received" });
    expect(res.status).toBe(404);
    expect(res.body.status).toBe(2);

    res = await closeItems(rfq.rfq_id, { rfq_product_ids: [A], reason_code: "other", remarks: "ordered by phone" });
    expect(res.status).toBe(200);
    expect((await item(A)).close_remarks).toBe("ordered by phone");
  });

  it("is a no-op on replay: the item stays closed once, with one history row", async () => {
    const rfq = await threeItemRfq();
    const [, B] = rfq.items;
    const body = { rfq_product_ids: [B], reason_code: "no_quotes_received" };
    expect((await closeItems(rfq.rfq_id, body)).status).toBe(200);
    const again = await closeItems(rfq.rfq_id, body);
    expect(again.status).toBe(200);
    expect(again.body.data.closed).toEqual([]);
    expect(again.body.data.already_closed).toEqual([B]);
    expect((await closureLog(rfq.rfq_id)).length).toBe(1);
  });

  it("refuses on a closed RFQ", async () => {
    const rfq = await threeItemRfq();
    await db.none(`UPDATE tbl_rfq SET status = 2 WHERE id = $1`, [rfq.rfq_id]);
    const res = await closeItems(rfq.rfq_id, { rfq_product_ids: [rfq.items[0]], reason_code: "no_quotes_received" });
    expect(res.status).toBe(409);
  });

  it("closing the last open item settles the RFQ and auto-initiates its draft PO", async () => {
    const rfq = await threeItemRfq();
    const [A, B, C] = rfq.items;
    await award(rfq, A);
    const draft = await po(rfq, A, "draft");
    expect(await isRfqFullyAwarded(rfq.rfq_id)).toBe(false);

    const res = await closeItems(rfq.rfq_id, { rfq_product_ids: [B, C], reason_code: "no_quotes_received" });
    expect(res.status).toBe(200);
    expect(await isRfqFullyAwarded(rfq.rfq_id)).toBe(true);

    // Initiated, or skipped for want of a PO policy — either way the batch ran on it.
    const s = res.body.data.auto_initiate_summary;
    expect(s).not.toBeNull();
    expect([...s.initiated, ...s.skipped_no_policy, ...s.failed.map((f) => f.po_id)]).toContain(draft);
  });
});

describe("POST /rfq/:id/items/reopen", () => {
  it("needs remarks, clears the closure and logs the reopen", async () => {
    const rfq = await threeItemRfq();
    const [, B] = rfq.items;
    await closeItems(rfq.rfq_id, { rfq_product_ids: [B], reason_code: "no_quotes_received" });

    let res = await reopenItems(rfq.rfq_id, { rfq_product_ids: [B] });
    expect(res.status).toBe(400);
    expect((await item(B)).closed_at).not.toBeNull();

    res = await reopenItems(rfq.rfq_id, { rfq_product_ids: [B], remarks: "closed by mistake" });
    expect(res.status).toBe(200);
    expect(res.body.data.reopened).toEqual([B]);
    expect(await item(B)).toEqual({ closed_at: null, closed_by: null, close_reason_code: null, close_remarks: null });
    expect((await closureLog(rfq.rfq_id)).map((r) => [r.action, r.remarks])).toEqual([
      ["close", null],
      ["reopen", "closed by mistake"],
    ]);
  });
});

describe("GET /rfq/:id/close-preview", () => {
  it("names each item's state, what blocks it, and what Close RFQ would cancel", async () => {
    const rfq = await threeItemRfq();
    const [A, B, C] = rfq.items;
    await award(rfq, A);
    const pending = await po(rfq, A, "pending_approval");
    await plantQuote(rfq, VENDOR, B);

    const res = await (await httpClient(BUYER)).get(`/api/v1/rfq/${rfq.rfq_id}/close-preview`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    const byId = Object.fromEntries(d.items.map((i) => [i.rfq_product_id, i]));
    expect(byId[A]).toMatchObject({ state: "awarded", closable: false, blockers: ["awarded"] });
    expect(byId[B]).toMatchObject({ state: "open", closable: true, suggested_reason: null, quoted_vendor_count: 1 });
    expect(byId[C]).toMatchObject({ state: "open", closable: true, suggested_reason: "no_quotes_received" });
    expect(d.summary).toEqual({ total: 3, awarded: 1, award_pending: 0, closed_no_award: 0, open: 2 });
    expect(d.award_outcome).toBe("in_progress");
    expect(d.on_close_rfq.items_to_close.sort()).toEqual([B, C].sort());
    expect(d.on_close_rfq.pending_po_approvals_cancelled.map((p) => p.po_id)).toEqual([pending]);

    const other = await (await httpClient(OTHER_BUYER)).get(`/api/v1/rfq/${rfq.rfq_id}/close-preview`);
    expect(other.status).toBe(403);
  });
});

describe("POST /rfq/close-rfq/:id — leftover items", () => {
  it("closes every item still open with the chosen reason, and leaves awarded items alone", async () => {
    const rfq = await threeItemRfq();
    const [A, B, C] = rfq.items;
    await award(rfq, A);

    const res = await (await httpClient(BUYER)).post(`/api/v1/rfq/close-rfq/${rfq.rfq_id}`).send({
      comment: "sourcing finished",
      item_reason_code: "requirement_cancelled",
      items: [{ rfq_product_id: C, reason_code: "no_quotes_received", remarks: "no vendor stocks it" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.closed_item_ids.sort()).toEqual([B, C].sort());

    expect((await item(A)).closed_at).toBeNull();
    expect(await item(B)).toMatchObject({ close_reason_code: "requirement_cancelled", close_remarks: "sourcing finished" });
    expect(await item(C)).toMatchObject({ close_reason_code: "no_quotes_received", close_remarks: "no vendor stocks it" });
    expect(Number((await db.one(`SELECT status FROM tbl_rfq WHERE id = $1`, [rfq.rfq_id])).status)).toBe(2);

    const outcome = (await getAwardOutcomes([rfq.rfq_id])).get(rfq.rfq_id);
    expect(outcome.award_outcome).toBe("partially_awarded");
  });

  it("defaults the reason to rfq_closed with the close comment as remarks", async () => {
    const rfq = await threeItemRfq();
    const res = await (await httpClient(BUYER)).post(`/api/v1/rfq/close-rfq/${rfq.rfq_id}`).send({ comment: "budget withdrawn" });
    expect(res.status).toBe(200);
    for (const id of rfq.items) {
      expect(await item(id)).toMatchObject({ close_reason_code: "rfq_closed", close_remarks: "budget withdrawn" });
    }
  });

  it("refuses a bad item reason before closing anything", async () => {
    const rfq = await threeItemRfq();
    const res = await (await httpClient(BUYER)).post(`/api/v1/rfq/close-rfq/${rfq.rfq_id}`)
      .send({ comment: "x", item_reason_code: "not_a_reason" });
    expect(res.status).toBe(400);
    expect(Number((await db.one(`SELECT status FROM tbl_rfq WHERE id = $1`, [rfq.rfq_id])).status)).toBe(1);
    expect((await item(rfq.items[0])).closed_at).toBeNull();
  });
});

describe("a closed item counts as settled", () => {
  it("award outcome: in_progress → partially_awarded; all closed → not_awarded", async () => {
    const rfq = await threeItemRfq();
    const [A, B, C] = rfq.items;
    await award(rfq, A);
    expect((await getAwardOutcomes([rfq.rfq_id])).get(rfq.rfq_id)).toEqual({
      items: { total: 3, awarded: 1, award_pending: 0, closed_no_award: 0, open: 2 },
      award_outcome: "in_progress",
    });
    await closeItems(rfq.rfq_id, { rfq_product_ids: [B, C], reason_code: "no_quotes_received" });
    expect((await getAwardOutcomes([rfq.rfq_id])).get(rfq.rfq_id).award_outcome).toBe("partially_awarded");

    const none = await threeItemRfq();
    await closeItems(none.rfq_id, { rfq_product_ids: none.items, reason_code: "no_quotes_received" });
    expect((await getAwardOutcomes([none.rfq_id])).get(none.rfq_id).award_outcome).toBe("not_awarded");
  });

  it("PO coverage: a draft covering every item that was not closed is complete, not partial", async () => {
    const rfq = await threeItemRfq();
    const [A, B, C] = rfq.items;
    await award(rfq, A);
    const draft = await po(rfq, A, "draft");
    expect(classifyInitiateKind((await getRfqPoCoverage(rfq.rfq_id)).get(draft))).toBe("partial");

    await closeItems(rfq.rfq_id, { rfq_product_ids: [B, C], reason_code: "no_quotes_received" });
    const cov = (await getRfqPoCoverage(rfq.rfq_id)).get(draft);
    expect(cov).toMatchObject({ rfq_product_count: 1, po_product_count: 1, products_unawarded: 0, products_closed: 2 });
    expect(classifyInitiateKind(cov)).toBe("complete");
  });

  it("lifecycle: the RFQ reaches APPROVED_COMPLETED once the awarded item's PO is approved", async () => {
    const rfq = await threeItemRfq();
    const [A, B, C] = rfq.items;
    await award(rfq, A);
    await po(rfq, A, "approved");
    expect((await rfqModel.computeLifecycleStages([rfq.rfq_id]))[rfq.rfq_id]).not.toBe("APPROVED_COMPLETED");

    await closeItems(rfq.rfq_id, { rfq_product_ids: [B, C], reason_code: "no_quotes_received" });
    expect((await rfqModel.computeLifecycleStages([rfq.rfq_id]))[rfq.rfq_id]).toBe("APPROVED_COMPLETED");
  });

  it("RFQ detail marks the closed item, with the reason for buyers only", async () => {
    const rfq = await threeItemRfq();
    const [A, B] = rfq.items;
    await award(rfq, A);
    await closeItems(rfq.rfq_id, { rfq_product_ids: [B], reason_code: "quotes_not_acceptable", remarks: "over budget" });

    const buyerView = await (await httpClient(BUYER)).get(`/api/v1/rfq/getRfqById/${rfq.rfq_id}`);
    expect(buyerView.status).toBe(200);
    const bp = buyerView.body.data.products.find((p) => Number(p.id) === B);
    expect(bp.finalization_status).toBe("Closed without award");
    expect(bp.close_reason_code).toBe("quotes_not_acceptable");
    expect(bp.close_remarks).toBe("over budget");
    expect(buyerView.body.data.award_outcome).toBe("in_progress");
    expect(buyerView.body.data.items_summary).toMatchObject({ awarded: 1, closed_no_award: 1, open: 1 });

    const vendorView = await (await httpClient(VENDOR)).get(`/api/v1/rfq/getRfqById/${rfq.rfq_id}`);
    expect(vendorView.status).toBe(200);
    const vp = vendorView.body.data.products.find((p) => Number(p.id) === B);
    expect(vp.finalization_status).toBe("Closed without award");
    expect(vp.closed_at).not.toBeNull();
    expect(vp.close_reason_code).toBeNull();
    expect(vp.close_remarks).toBeNull();
    expect(vendorView.body.data.award_outcome).toBeUndefined();
  });
});

describe("a closed item takes no further work", () => {
  const closeDirect = (id) => db.none(
    `UPDATE tbl_rfq_products SET closed_at = now(), closed_by = $2, close_reason_code = 'no_quotes_received' WHERE id = $1`,
    [id, BUYER]
  );

  const quoteBody = (rfq, itemIds) => ({
    rfq_id: rfq.rfq_id,
    rfq_no: rfq.rfq_no,
    status: 1,
    products: itemIds.map((id) => ({
      product_id: VARIANT, product_name: "item", unit_price: 100, tax: 18, total_price: 0, comment: "",
      delivery_period: "7", quantity: "10", variant: variantOf(rfq, id), tax_mode: "percentage",
      other_charges: [], document_files: [],
    })),
    globalPaymentTerms: "", globalComment: "", global_payment_term_list: [], term_and_condition_files: [],
    vendorGSTIN: "", global_charges: [],
  });

  it("vendors cannot quote it; the open items can still be quoted", async () => {
    const rfq = await threeItemRfq({ bidOpen: true });
    const [A, B] = rfq.items;
    await closeDirect(B);
    const vendor = await httpClient(VENDOR);

    const refused = await vendor.post("/api/v1/rfq/quote/create").send(quoteBody(rfq, [A, B]));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("ITEM_CLOSED");
    expect(refused.body.details.rfq_product_ids).toEqual([B]);
    // A truthy-but-not-regret flag ("0") is stored as a quote, so it is checked too.
    const sneaky = await vendor.post("/api/v1/rfq/quote/create").send({ ...quoteBody(rfq, [A, B]), is_regret: "0" });
    expect(sneaky.status).toBe(409);
    expect(sneaky.body.code).toBe("ITEM_CLOSED");
    expect((await db.one(`SELECT count(*)::int AS n FROM tbl_quotes WHERE rfq_id = $1`, [rfq.rfq_id])).n).toBe(0);

    const ok = await vendor.post("/api/v1/rfq/quote/create").send(quoteBody(rfq, [A]));
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe(1);
  });

  it("the buyer cannot award it", async () => {
    const rfq = await threeItemRfq();
    const [, B] = rfq.items;
    const { quote_id, quote_item_id } = await plantQuote(rfq, VENDOR, B);
    await closeDirect(B);

    const res = await (await httpClient(BUYER)).post("/api/v1/rfq/finalize").send({
      rfq_id: rfq.rfq_id, rfq_no: rfq.rfq_no, product_variant_id: VARIANT, variant: variantOf(rfq, B),
      vendor_id: VENDOR, quote_id, quote_item_id, route_type: "PO", comment: "awarding the closed item",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ITEM_CLOSED");
    expect((await db.one(`SELECT count(*)::int AS n FROM tbl_quote_finalization WHERE rfq_id = $1`, [rfq.rfq_id])).n).toBe(0);
  });

  it("no negotiation round or award submission can include it", async () => {
    const rfq = await threeItemRfq();
    const [, B] = rfq.items;
    const { quote_item_id } = await plantQuote(rfq, VENDOR, B);
    await closeDirect(B);
    const negotiator = await httpClient(NEGOTIATOR);

    const round = await negotiator.post("/api/v1/negotiation/rounds").send({
      rfq_id: rfq.rfq_id,
      end_date: new Date(Date.now() + 3 * DAY).toISOString(),
      products: [{ rfq_product_id: B, vendor_targets: [{ vendor_id: VENDOR, negotiation_fields: [] }] }],
    });
    expect(round.status).toBe(409);
    expect(round.body.code).toBe("ITEM_CLOSED");
    expect((await db.one(`SELECT count(*)::int AS n FROM tbl_negotiation_rounds WHERE rfq_id = $1`, [rfq.rfq_id])).n).toBe(0);

    const submit = await negotiator.post("/api/v1/negotiation/quotes/submit-for-approval").send({
      rfq_id: rfq.rfq_id, rfq_product_id: B, quote_ids: [quote_item_id], quote_source: "regular",
    });
    expect(submit.status).toBe(409);
    expect(submit.body.code).toBe("ITEM_CLOSED");
  });

  it("vendor refresh and reminders leave it out", async () => {
    const rfq = await threeItemRfq({ bidOpen: true });
    const [A, B] = rfq.items;
    // VENDOR_B is invited on B only.
    await db.none(
      `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, $4)`,
      [rfq.rfq_id, VARIANT, VENDOR_B, variantOf(rfq, B)]
    );
    await closeDirect(B);

    const refresh = await hospitalityModel.addMissingVendorsForRfq(rfq.rfq_id, [IDS.hotels.A1], { preview: true });
    const refreshed = refresh.products.map((p) => Number(p.rfq_product_id));
    expect(refreshed).toContain(A);
    expect(refreshed).not.toContain(B);

    const { vendors } = await rfqModel.getVendorsForReminder(rfq.rfq_id);
    const byVendor = Object.fromEntries(vendors.map((r) => [Number(r.user_id), r]));
    expect(byVendor[VENDOR_B]).toBeUndefined();
    const remaining = (byVendor[VENDOR]?.remainingProducts || []).map((p) => Number(p.variant));
    expect(remaining).toContain(variantOf(rfq, A));
    expect(remaining).not.toContain(variantOf(rfq, B));
  });
});
