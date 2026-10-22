// "Draft PO ready" notification + single 48h reminder (client ticket T1).
// ----------------------------------------------------------------------------
// The award approval is driven over real HTTP; the reminder is driven by calling
// remindStaleDrafts(now) with a controlled `now`. Mail never leaves the machine:
// the SMTP transport (nodemailer.createTransport) is replaced BEFORE the app is imported.
// Recipients are checked against the independent facts of the fixture (who holds
// read + awarding.create on the tuple), not by re-running the predicate.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, jest } from "@jest/globals";

const sentMails = [];
// The real sendMail runs; only the SMTP transport underneath it is replaced.
const fakeTransport = {
  sendMail: (opts, cb) => { sentMails.push(opts); cb(null, { messageId: "<captured>" }); },
};
jest.unstable_mockModule("nodemailer", () => {
  const api = { createTransport: () => fakeTransport };
  return { default: api, ...api };
});

const { db, closeDb } = await import("../setup/db.js");
const { IDS } = await import("../fixtures/ids.js");
const { ROLE_IDS } = await import("../fixtures/users.js");
const { httpClient } = await import("../helpers/http.js");
const { grantRoleScope, revokeRoleScopes } = await import("../helpers/roleScope.js");
const { makeRfqVisibleToDashboard, addProductToRfq, makePO, cleanupPurchaseOrders, cleanupRfqs } =
  await import("../helpers/dashboardSeed.js");
const { createApprovalInstance } = await import("../../app/models/generalModel.js");
const { remindStaleDrafts } = await import("../../app/services/po/poInitiateNotifier.js");

const CREATOR = IDS.users.a1_proc_buyer;
const DEPT_USER = IDS.users.a1_proc_poApp;
const HOTEL_USER = IDS.users.a1_proc_finance;
const COMPANY_USER = IDS.users.a1_proc_techApp;
const WRONG_PROCESS = IDS.users.a1_proc_commEval;
const READER = IDS.users.a1_proc_commApp;   // the approver: awarding.read only
const VENDOR_A = IDS.users.vendor_alpha;
const EXPECTED = [DEPT_USER, HOTEL_USER, COMPANY_USER];
const NOT_EXPECTED = [WRONG_PROCESS, READER, CREATOR];
const ALL_BUYERS = [CREATOR, DEPT_USER, HOTEL_USER, COMPANY_USER, WRONG_PROCESS, READER];

const grantIds = [];
const backup = new Map();
const created = { rfqIds: [], poIds: [], instanceIds: [] };
let approver;

beforeAll(async () => {
  for (const u of [...ALL_BUYERS, VENDOR_A]) {
    backup.set(u, await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [u]));
  }
  await db.none(`UPDATE tbl_users SET user_type = 2, status = 1 WHERE id = ANY($1::int[])`, [ALL_BUYERS]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR_A]);
  const grant = async (userId, scope) => grantIds.push(await grantRoleScope(db, {
    userId, roleId: ROLE_IDS.FINAL_AWARDING_P1, companyId: IDS.hospitality.A, ...scope,
  }));
  await grant(HOTEL_USER, { hotelId: IDS.hotels.A1 });
  await grant(COMPANY_USER, {});
  await grant(WRONG_PROCESS, { hotelId: IDS.hotels.A1, departmentId: IDS.departments.proc, processId: IDS.processes.A_P2 });
  for (const u of [HOTEL_USER, COMPANY_USER, WRONG_PROCESS]) {
    grantIds.push(await grantRoleScope(db, { userId: u, roleId: ROLE_IDS.TENDER_CREATOR, companyId: IDS.hospitality.A }));
  }
  // A vendor holding the very same grants must still never be told.
  await grant(VENDOR_A, {});
  approver = await httpClient(READER);
});

beforeEach(() => { sentMails.length = 0; });

afterEach(async () => {
  const poRows = created.rfqIds.length
    ? await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]) : [];
  const poIds = [...new Set([...created.poIds, ...poRows.map((p) => p.id)])];
  if (poIds.length) {
    await db.none(`DELETE FROM tbl_notifications WHERE (additional_data->>'po_id')::int = ANY($1::int[])`, [poIds]);
  }
  const instIds = [...created.instanceIds];
  if (poIds.length) {
    const rows = await db.any(`SELECT id FROM tbl_approval_instances WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]);
    instIds.push(...rows.map((r) => r.id));
  }
  if (instIds.length) {
    await db.none(`UPDATE tbl_rfq_purchase_order SET approval_instance_id = NULL WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
    await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
    await db.none(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
         (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [instIds]);
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [instIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instIds]);
  }
  if (poIds.length) {
    await db.none(`DELETE FROM tbl_purchase_order_document WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]);
    await cleanupPurchaseOrders(db, poIds);
  }
  if (created.rfqIds.length) {
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_finalization WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [created.rfqIds]);
    await cleanupRfqs(db, created.rfqIds);
  }
  created.rfqIds = []; created.poIds = []; created.instanceIds = [];
});

afterAll(async () => {
  await revokeRoleScopes(db, grantIds);
  for (const [u, b] of backup) await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [u, b.user_type, b.status]);
  await closeDb();
});

// The award flow sends its own unrelated mails; only look at ours.
const initiateMails = () => sentMails.filter((m) => /initiate/i.test(m.subject || ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(50); }
}
const notesFor = (poId, type) => db.any(
  `SELECT recipient_user_id, action_url, type FROM tbl_notifications
    WHERE (additional_data->>'po_id')::int = $1 AND type = $2`, [poId, type]);
const emailOf = async (ids) => (await db.any(`SELECT id, email FROM tbl_users WHERE id = ANY($1::int[])`, [ids]));

/** Award setup staged like rfqController.finalize; returns the approve call. */
async function stageAward({ withProduct2 = false } = {}) {
  const oneDayAgo = new Date(Date.now() - 86400_000).toISOString().replace("T", " ").slice(0, 19);
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, department_id, process_id, is_tender, title)
     VALUES ((SELECT COALESCE(MAX(rfq_no), 8000000) + 1 FROM tbl_rfq), '<p>e2e</p>', '', 'b@a', 'A1', '+91', $1,
             'Mumbai', 1, 1, $2, $2, NOW(), $3, $4, $5, $6, 0, 'initiate notify')
     RETURNING id, rfq_no`,
    [oneDayAgo, CREATOR, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, IDS.processes.A_P1]);
  created.rfqIds.push(rfq.id);
  await db.none(`INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, 1, $2, 0), ($1, 1, $2, 1)`, [rfq.id, VENDOR_A]);
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
     VALUES ($1, $2, $3, $3, 1, NOW()) RETURNING id`, [rfq.id, rfq.rfq_no, VENDOR_A]);
  const award = async (variant) => {
    const prod = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, $2) RETURNING id`, [rfq.id, variant]);
    await db.none(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, package_price, tax,
          freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
       VALUES ($1, $2, $3, 1, 500, 25000, 0, 0, 0, $4, '', '15', '50', 'absolute', '[]'::jsonb)`,
      [rfq.id, rfq.rfq_no, quote.id, variant]);
    const approval = await createApprovalInstance({
      entity_type: "NEGOTIATION_QUOTE", entity_id: prod.id,
      hospitality_company_id: IDS.hospitality.A, hotel_id: IDS.hotels.A1, department_id: null,
      process_id: IDS.processes.A_P1, initiated_by: CREATOR,
      metadata: {
        rfq_id: rfq.id, rfq_number: rfq.rfq_no, rfq_product_id: prod.id, is_tender: 0,
        selected_quotes: [{ quote_id: quote.id, vendor_id: VENDOR_A, quoted_price: 500 }],
      },
    });
    created.instanceIds.push(approval.instance.id);
    const res = await approver.post(`/api/v1/negotiation/quotes/${prod.id}/approve`).send({});
    expect(res.status).toBe(200);
    return res;
  };
  return { rfq, award };
}

async function seedDraft({ ageHours, status = "draft", rfqStatus = 1 }) {
  return db.tx(async (t) => {
    const { rfq_id } = await makeRfqVisibleToDashboard(t, {
      createdBy: CREATOR, hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1,
      department: IDS.departments.proc, status: rfqStatus, is_published: 1, title: "initiate reminder",
    });
    created.rfqIds.push(rfq_id);
    const { rfq_product_id } = await addProductToRfq(t, rfq_id);
    const { po_id } = await makePO(t, {
      rfq_id, rfq_product_id, status, company_id: IDS.companies.A, vendor_user_id: VENDOR_A, initiated_by: CREATOR,
    });
    created.poIds.push(po_id);
    return { rfq_id, po_id };
  });
}
const ageTo = (poId, now, hours) => db.none(
  `UPDATE tbl_rfq_purchase_order SET created_at = $2::timestamptz - make_interval(hours => $3) WHERE id = $1`,
  [poId, now, hours]);

describe("draft PO ready", () => {
  it("notifies every initiator once when the award approval drafts a PO", async () => {
    const { rfq, award } = await stageAward();
    await award(0);
    const po = await db.one(`SELECT id, po_number FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.id]);

    const rows = await waitFor(async () => {
      const r = await notesFor(po.id, "po_draft_ready");
      return r.length >= EXPECTED.length ? r : null;
    });
    const ids = rows.map((r) => r.recipient_user_id);
    for (const u of EXPECTED) expect(ids).toContain(u);
    for (const u of NOT_EXPECTED) expect(ids).not.toContain(u);
    // exactly one row per recipient, and the link opens the PO on the Initiate button
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of rows) expect(r.action_url).toBe(`/dashboard/buyer/purchase-orders/${po.id}?action=initiate`);

    // one email per recipient that has an address, each with the link and the copy
    const addr = (await emailOf(ids)).filter((u) => u.email);
    await waitFor(() => initiateMails().length >= addr.length);
    expect(initiateMails().map((m) => m.to).sort()).toEqual(addr.map((u) => u.email).sort());
    for (const m of initiateMails()) {
      expect(m.html).toContain(`/dashboard/buyer/purchase-orders/${po.id}?action=initiate`);
      expect(m.subject).toContain(`PO ${po.po_number}`);
      expect(m.html).toContain(`RFQ #${rfq.rfq_no}`);
    }
    // the approver caused the draft but is not an initiator here; nobody is excluded for triggering it
    expect(ids).not.toContain(READER);
  });

  it("does not notify again when a later award merges into the draft", async () => {
    const { rfq, award } = await stageAward();
    await award(0);
    const po = await db.one(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.id]);
    await waitFor(async () => (await notesFor(po.id, "po_draft_ready")).length >= EXPECTED.length);
    const before = (await notesFor(po.id, "po_draft_ready")).length;
    await waitFor(() => initiateMails().length >= EXPECTED.length);
    const mailsBefore = initiateMails().length;

    await award(1);   // same vendor, same RFQ: merges into the existing draft
    const pos = await db.any(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.id]);
    expect(pos).toHaveLength(1);
    const lines = await db.one(`SELECT count(*)::int AS n FROM tbl_purchase_order_product WHERE purchase_order_id = $1`, [po.id]);
    expect(lines.n).toBe(2);

    await sleep(600);
    expect((await notesFor(po.id, "po_draft_ready")).length).toBe(before);
    expect(initiateMails().length).toBe(mailsBefore);
  });

  it("never notifies vendors", async () => {
    const { rfq, award } = await stageAward();
    await award(0);
    const po = await db.one(`SELECT id FROM tbl_rfq_purchase_order WHERE rfq_id = $1`, [rfq.id]);
    await waitFor(async () => (await notesFor(po.id, "po_draft_ready")).length >= EXPECTED.length);
    const vendor = (await emailOf([VENDOR_A]))[0];
    expect((await notesFor(po.id, "po_draft_ready")).map((r) => r.recipient_user_id)).not.toContain(VENDOR_A);

    const now = new Date();
    await ageTo(po.id, now, 49);
    await remindStaleDrafts(now);
    expect((await notesFor(po.id, "po_draft_initiate_reminder")).map((r) => r.recipient_user_id)).not.toContain(VENDOR_A);
    expect(sentMails.map((m) => m.to)).not.toContain(vendor.email);
    expect(vendor.email).toBeTruthy();
  });
});

describe("reminder", () => {
  it("reminds once after 48 hours and never twice", async () => {
    const now = new Date();
    const { po_id } = await seedDraft({ ageHours: 49 });
    await ageTo(po_id, now, 47);
    await remindStaleDrafts(now);
    expect(await notesFor(po_id, "po_draft_initiate_reminder")).toHaveLength(0);

    await ageTo(po_id, now, 49);
    const first = await remindStaleDrafts(now);
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    const rows = await notesFor(po_id, "po_draft_initiate_reminder");
    const ids = rows.map((r) => r.recipient_user_id);
    for (const u of EXPECTED) expect(ids).toContain(u);
    for (const u of NOT_EXPECTED) expect(ids).not.toContain(u);
    for (const r of rows) expect(r.action_url).toBe(`/dashboard/buyer/purchase-orders/${po_id}?action=initiate`);
    const marked = await db.one(`SELECT initiate_reminded_at FROM tbl_rfq_purchase_order WHERE id = $1`, [po_id]);
    expect(marked.initiate_reminded_at).not.toBeNull();
    const mails = initiateMails().length;
    expect(mails).toBeGreaterThanOrEqual(EXPECTED.length);

    await remindStaleDrafts(new Date(now.getTime() + 3 * 86400_000));
    expect(await notesFor(po_id, "po_draft_initiate_reminder")).toHaveLength(rows.length);
    expect(initiateMails().length).toBe(mails);
  });

  it("skips initiated drafts, closed RFQs and drafts older than 14 days", async () => {
    const now = new Date();
    const initiated = await seedDraft({ ageHours: 60, status: "pending_approval" });
    const closed = await seedDraft({ ageHours: 60, rfqStatus: 2 });
    const old = await seedDraft({ ageHours: 60 });
    const live = await seedDraft({ ageHours: 60 });
    for (const p of [initiated, closed, live]) await ageTo(p.po_id, now, 60);
    await ageTo(old.po_id, now, 15 * 24);

    await remindStaleDrafts(now);
    for (const p of [initiated, closed, old]) {
      expect(await notesFor(p.po_id, "po_draft_initiate_reminder")).toHaveLength(0);
      const r = await db.one(`SELECT initiate_reminded_at FROM tbl_rfq_purchase_order WHERE id = $1`, [p.po_id]);
      expect(r.initiate_reminded_at).toBeNull();
    }
    expect((await notesFor(live.po_id, "po_draft_initiate_reminder")).length).toBeGreaterThan(0);
  });
});
