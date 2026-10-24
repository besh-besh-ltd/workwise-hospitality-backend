// Existing PO receiving defects and the site-rep token (Task B6).
//
//   D2  addSiteRepresentative: the UPDATE lost a comma, and a `t.one` over the
//       PO's lines threw for multi-line and call-off POs.
//   D3  the site-rep token was stored in plain text, never expired, and only
//       ever travelled in a query string.
//   D7  GRN reminders were one-shot in-memory cron jobs, lost on restart. A
//       daily database-driven sweeper replaces them.
//   D9  milestones and tasks on call-off POs (no RFQ).
//   plus: invoice / GRN document URLs must point at our own bucket.
//
// HTTP tests commit for real; everything they create is tracked and deleted in
// afterAll. The sweeper tests run inside withTx and roll back.

import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from "@jest/globals";
import crypto from "crypto";

// Capture outgoing mail so a test can follow the link the site rep receives.
const sentMail = [];
jest.unstable_mockModule("nodemailer", () => {
  const transport = {
    sendMail(opts, cb) {
      sentMail.push(opts);
      const info = { messageId: "<captured>", response: "250 OK" };
      if (typeof cb === "function") return cb(null, info);
      return Promise.resolve(info);
    },
    verify(cb) { if (typeof cb === "function") cb(null, true); return Promise.resolve(true); },
    close() {},
  };
  const api = { createTransport: () => transport };
  return { default: api, ...api };
});

const { db, withTx, closeDb } = await import("../setup/db.js");
const { IDS } = await import("../fixtures/ids.js");
const { makeRFQ } = await import("../factories/rfq.js");
const { httpClient, boundRequest } = await import("../helpers/http.js");
const { buildTestApp } = await import("../setup/app.js");
const express = (await import("express")).default;

const CO = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const B1 = IDS.hotels.B1;
const ADMIN = IDS.users.companyA_admin;     // CEO, company-wide: PO read + grn.create
const VIEWER = IDS.users.a1_proc_buyer;    // sees A1/proc POs, holds no grn.create
const PO_APPROVER = IDS.users.a1_proc_poApp; // Final Awarding P1 at A1: grn.create at A1
const FOREIGN = IDS.users.companyB_admin;
const VENDOR = IDS.users.vendor_alpha;

const BUCKET_HOST = `${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
const OWN_URL = (key) => `https://${BUCKET_HOST}/${key}`;
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const tracked = { rfqIds: [], poIds: [], arcIds: [], mrIds: [] };
const BUYERS = [ADMIN, VIEWER, PO_APPROVER, FOREIGN];

beforeAll(async () => {
  // acl()/noAcl() branch on user_type; the shared fixtures leave it NULL.
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = ANY($1::int[])`, [BUYERS]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
});

afterAll(async () => {
  const { poIds, rfqIds, mrIds, arcIds } = tracked;
  if (poIds.length) {
    await db.none(`DELETE FROM tbl_token_login_data WHERE token_type = 'GRN' AND entity_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_payment_milestone WHERE po_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_purchase_order_tasks WHERE po_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_purchase_order_document WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_po_delivery WHERE po_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'PO' AND entity_id = ANY($1::int[])`, [poIds]);
    await db.none(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);
  }
  if (rfqIds.length) {
    await db.none(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_lifecycle_history WHERE entity_id = ANY($1::int[])`, [rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);
  }
  if (mrIds.length) {
    await db.none(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::int[])`, [mrIds]);
  }
  if (arcIds.length) {
    await db.none(
      `DELETE FROM tbl_arc_contract_line WHERE arc_contract_id IN
         (SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::int[]))`,
      [arcIds]
    );
    await db.none(`DELETE FROM tbl_arc_contract WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc_item WHERE arc_id = ANY($1::int[])`, [arcIds]);
    await db.none(`DELETE FROM tbl_arc WHERE id = ANY($1::int[])`, [arcIds]);
  }
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = ANY($1::int[])`, [[...BUYERS, VENDOR]]);
  await closeDb();
});

let seq = 0;
const tag = () => `b6-${process.pid}-${++seq}`;

/** An RFQ PO at `hotel` (dept proc) with `lines` lines; `mappedHotels` adds hotel mappings. */
async function makeRfqPo(c, { hotel = A1, mappedHotels = [], lines = 1, status = "approved" } = {}) {
  const { rfq_id, rfq_no } = await makeRFQ(c, {
    createdBy: VIEWER, status: 1, is_published: 1, hotel, department: IDS.departments.proc,
  });
  if (c === db) tracked.rfqIds.push(rfq_id);
  for (const h of mappedHotels) {
    await c.none(`INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [rfq_id, h, VIEWER]);
  }
  const quote = await c.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, VENDOR]
  );
  const po = await c.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by)
     VALUES ($1, $2, $3, $4, '{}', 1, 100, $5, 100, '{}', $6) RETURNING id, po_number`,
    [rfq_id, IDS.companies.A, `B6-${tag()}`, status, VENDOR, VIEWER]
  );
  if (c === db) tracked.poIds.push(po.id);
  const lineIds = [];
  for (let i = 0; i < lines; i++) {
    const rp = await c.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', 1, 0) RETURNING id`,
      [rfq_id]
    );
    const qi = await c.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, comment, delivery_period, quantity)
       VALUES ($1, $2, $3, 1, 100, 1000, '', '7', '10') RETURNING id`,
      [rfq_id, rfq_no, quote.id]
    );
    const pop = await c.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, total_price)
       VALUES ($1, $2, $3, 10, 'kg', 100, 1000) RETURNING id`,
      [po.id, rp.id, qi.id]
    );
    lineIds.push(Number(pop.id));
  }
  return { poId: Number(po.id), poNumber: po.po_number, rfqId: Number(rfq_id), lineIds };
}

/** A call-off PO (no RFQ) raised by an MR at `hotel`. */
async function makeCallOffPo(c, { hotel = A2, status = "approved" } = {}) {
  const t0 = tag();
  const arc = await c.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ($1, 'B6 ARC', (SELECT id FROM tbl_category ORDER BY id LIMIT 1), $2, $3, $4, $5,
             'contract_active', NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days',
             NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6)
     RETURNING id`,
    [`ARC-${t0}`.slice(0, 40), CO, A1, IDS.departments.proc, IDS.processes.A_P1, VIEWER]
  );
  if (c === db) tracked.arcIds.push(arc.id);
  const arcItem = await c.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, 1, 100, 'litre') RETURNING id`,
    [arc.id]
  );
  const contract = await c.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [arc.id, VENDOR]
  );
  const contractLine = await c.one(
    `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
     VALUES ($1, $2, 90, 5, 1000) RETURNING id`,
    [contract.id, arcItem.id]
  );
  const mr = await c.one(
    `INSERT INTO tbl_material_requisition
       (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, required_by_date)
     VALUES ($1, 'B6 MR', $2, $3, $4, 'normal', $5, 'po_released', '2031-01-01') RETURNING id`,
    [`MR-${t0}`.slice(0, 40), CO, hotel, IDS.departments.fb, VIEWER]
  );
  if (c === db) tracked.mrIds.push(mr.id);
  const po = await c.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id,
        total_value, quote_id, arc_contract_id, source_mr_id, is_call_off)
     VALUES (NULL, $1, $2, $3, '{}', 6, 90, $4, 0, '{}', $5, $6, TRUE) RETURNING id, po_number`,
    [IDS.companies.A, `CO-${t0}`, status, VENDOR, contract.id, mr.id]
  );
  if (c === db) tracked.poIds.push(po.id);
  const pop = await c.one(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, quantity, unit, unit_price, charges_meta, total_price, product_variant_id, arc_contract_line_id)
     VALUES ($1, 6, 'litre', 90, '{"tax":5,"tax_mode":"percentage","other_charges":[]}'::jsonb, 567, 1, $2)
     RETURNING id`,
    [po.id, contractLine.id]
  );
  return { poId: Number(po.id), poNumber: po.po_number, lineIds: [Number(pop.id)] };
}

const siteRepRows = (poId) =>
  db.any(
    `SELECT id, name, email, phone, hotel_id, token, token_hash, revoked_at, last_used_at,
            expires_at, created_at,
            EXTRACT(EPOCH FROM (expires_at - now()))::float AS expires_in_s
       FROM tbl_token_login_data WHERE token_type = 'GRN' AND entity_id = $1 ORDER BY id`,
    [poId]
  );

/** The token in the newest site-rep mail sent to `email` (from its /receive/token?t= link). */
function tokenMailedTo(email) {
  const mail = [...sentMail].reverse().find((m) => [].concat(m.to).includes(email));
  if (!mail) throw new Error(`no mail to ${email}`);
  const m = /\/receive\/token\?t=([A-Za-z0-9_-]+)/.exec(mail.html);
  if (!m) throw new Error(`no receive link in mail to ${email}`);
  return { token: m[1], mail };
}

const addSiteRep = async (client, body) => client.post("/api/v1/po/addSiteRepresentative").send(body);

/** A bare app that runs receiveTokenAuth and echoes what it established. */
async function tokenHarness() {
  const { receiveTokenAuth } = await import("../../app/middleware/receiveTokenAuth.js");
  const app = express();
  app.get("/echo", receiveTokenAuth, (req, res) =>
    res.json({ receiveToken: req.receiveToken, isTokenUser: req.user?.is_token_user === true })
  );
  return boundRequest(app);
}

// ---------------------------------------------------------------------------
// D2 + D3: adding a site representative
// ---------------------------------------------------------------------------

describe("site representative", () => {
  it("site rep add works for multi-line and call-off PO", async () => {
    const admin = await httpClient(ADMIN);

    const multi = await makeRfqPo(db, { lines: 2 });
    const res = await addSiteRep(admin, {
      po_id: multi.poId, name: "Ravi Kumar", email: "ravi.site@example.test", phone: "9876543210",
    });
    expect(res.status).toBe(200);
    const [row] = await siteRepRows(multi.poId);
    expect(row).toMatchObject({ name: "Ravi Kumar", email: "ravi.site@example.test", hotel_id: A1, token: null });
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const { token, mail } = tokenMailedTo("ravi.site@example.test");
    expect(sha256(token)).toBe(row.token_hash);
    expect(mail.html).not.toContain("/dashboard/buyer/purchase-order/grn");
    // The buyer's response never carries the credential.
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(JSON.stringify(res.body)).not.toContain(row.token_hash);

    const callOff = await makeCallOffPo(db, { hotel: A2 });
    const res2 = await addSiteRep(admin, {
      po_id: callOff.poId, name: "Meena", email: "meena.site@example.test", phone: "9876500000",
    });
    expect(res2.status).toBe(200);
    const [row2] = await siteRepRows(callOff.poId);
    expect(row2).toMatchObject({ hotel_id: A2, token: null });
    expect(sha256(tokenMailedTo("meena.site@example.test").token)).toBe(row2.token_hash);
  });

  it("a multi-hotel PO needs a hotel from its own hotel set", async () => {
    const admin = await httpClient(ADMIN);
    const po = await makeRfqPo(db, { mappedHotels: [A1, A2] });
    const base = { po_id: po.poId, name: "Site", email: "multi.site@example.test", phone: "9000000000" };

    const missing = await addSiteRep(admin, base);
    expect(missing.status).toBe(400);
    const foreign = await addSiteRep(admin, { ...base, hotel_id: B1 });
    expect(foreign.status).toBe(400);
    expect(await siteRepRows(po.poId)).toHaveLength(0);

    const ok = await addSiteRep(admin, { ...base, hotel_id: A2 });
    expect(ok.status).toBe(200);
    expect((await siteRepRows(po.poId))[0].hotel_id).toBe(A2);
  });

  it("issuing a receiving link needs grn.create at that hotel; another tenant's PO is a 404", async () => {
    const { hotelIdsWithPermission } = await import("../../app/services/inventory/scope.js");
    expect(await hotelIdsWithPermission(db, VIEWER, "grn", "create")).not.toContain(A1);
    expect(await hotelIdsWithPermission(db, ADMIN, "grn", "create")).toContain(A1);
    const po = await makeRfqPo(db);
    const body = { po_id: po.poId, name: "X", email: "nogrn.site@example.test", phone: "9000000001" };

    const viewer = await addSiteRep(await httpClient(VIEWER), body);
    expect(viewer.status).toBe(403);
    const foreign = await addSiteRep(await httpClient(FOREIGN), body);
    expect(foreign.status).toBe(404);
    expect(await siteRepRows(po.poId)).toHaveLength(0);
  });

  it("site rep update persists token", async () => {
    const admin = await httpClient(ADMIN);
    const anon = await httpClient(null);
    const po = await makeRfqPo(db);

    await addSiteRep(admin, { po_id: po.poId, name: "First", email: "first.site@example.test", phone: "9000000002" });
    const first = tokenMailedTo("first.site@example.test").token;
    const res = await addSiteRep(admin, {
      po_id: po.poId, name: "Second", email: "second.site@example.test", phone: "9000000003",
    });
    expect(res.status).toBe(200);
    const second = tokenMailedTo("second.site@example.test").token;

    // The old row is revoked, not rewritten: a GRN received through it keeps
    // naming the person who used it (tbl_grn.received_by_token_id).
    const rows = await siteRepRows(po.poId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "First", token: null });
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ name: "Second", email: "second.site@example.test", token: null, revoked_at: null });
    expect(rows[1].token_hash).toBe(sha256(second));
    expect(res.body.data).toMatchObject({ id: rows[1].id, name: "Second", hotel_id: A1 });

    // The re-issued link works; the old one is dead.
    expect((await anon.get(`/api/v1/po/${po.poId}`).set("X-Receive-Token", second)).status).toBe(200);
    expect((await anon.get(`/api/v1/po/${po.poId}`).set("X-Receive-Token", first)).status).toBe(403);
  });

  it("token stored hashed, expires after 14 days, revoked token rejected", async () => {
    const admin = await httpClient(ADMIN);
    const anon = await httpClient(null);
    const po = await makeRfqPo(db);
    await addSiteRep(admin, { po_id: po.poId, name: "Rep", email: "expiry.site@example.test", phone: "9000000004" });
    const { token } = tokenMailedTo("expiry.site@example.test");

    let [row] = await siteRepRows(po.poId);
    expect(row.token).toBeNull();
    expect(row.token_hash).toBe(sha256(token));
    expect(Math.abs(row.expires_in_s - 14 * 86400)).toBeLessThan(120);

    // The new token routes take the header only.
    const harness = await tokenHarness();
    const ok = await harness.get("/echo").set("X-Receive-Token", token);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ receiveToken: { tokenId: row.id, poId: po.poId, hotelId: A1 }, isTokenUser: true });
    expect((await siteRepRows(po.poId))[0].last_used_at).not.toBeNull();
    const viaQuery = await harness.get(`/echo?token=${token}`);
    expect(viaQuery.status).toBe(401);
    expect(viaQuery.body).toEqual({ status: 0, message: "Invalid or expired link" });
    expect((await harness.get("/echo").set("X-Receive-Token", "not-a-real-token-at-all-0000000000")).status).toBe(401);

    // Expired.
    await db.none(`UPDATE tbl_token_login_data SET expires_at = now() - interval '1 second' WHERE id = $1`, [row.id]);
    expect((await harness.get("/echo").set("X-Receive-Token", token)).status).toBe(401);
    expect((await anon.get(`/api/v1/po/${po.poId}`).set("X-Receive-Token", token)).status).toBe(403);
    await db.none(`UPDATE tbl_token_login_data SET expires_at = now() + interval '1 day' WHERE id = $1`, [row.id]);
    expect((await harness.get("/echo").set("X-Receive-Token", token)).status).toBe(200);

    // Revoke: a viewer without grn.create may not; another tenant gets a 404.
    const revokePath = `/api/v1/inventory/po/${po.poId}/site-rep/revoke`;
    expect((await (await httpClient(VIEWER)).post(revokePath).send({})).status).toBe(403);
    expect((await (await httpClient(FOREIGN)).post(revokePath).send({})).status).toBe(404);
    const revoked = await admin.post(revokePath).send({});
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: 1, data: { poId: po.poId, revoked: 1 } });
    [row] = await siteRepRows(po.poId);
    expect(row.revoked_at).not.toBeNull();
    expect((await harness.get("/echo").set("X-Receive-Token", token)).status).toBe(401);
    expect((await anon.get(`/api/v1/po/${po.poId}?token=${token}`)).status).toBe(403);
  });

  it("a token dies with its PO: cancelled, or fully received more than a day ago", async () => {
    const admin = await httpClient(ADMIN);
    const harness = await tokenHarness();
    const po = await makeRfqPo(db);
    await addSiteRep(admin, { po_id: po.poId, name: "Rep", email: "dies.site@example.test", phone: "9000000005" });
    const { token } = tokenMailedTo("dies.site@example.test");
    expect((await harness.get("/echo").set("X-Receive-Token", token)).status).toBe(200);

    await db.none(`UPDATE tbl_rfq_purchase_order SET receipt_status = 'received' WHERE id = $1`, [po.poId]);
    expect((await harness.get("/echo").set("X-Receive-Token", token)).status).toBe(401);
    await db.none(`UPDATE tbl_rfq_purchase_order SET receipt_status = 'not_received', status = 'cancelled' WHERE id = $1`, [po.poId]);
    expect((await harness.get("/echo").set("X-Receive-Token", token)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// D3: tokens issued before the hashing change
// ---------------------------------------------------------------------------

describe("legacy plain tokens", () => {
  const legacyToken = () => crypto.randomBytes(32).toString("base64url");
  const insertLegacy = (poId, token, age) =>
    db.one(
      `INSERT INTO tbl_token_login_data (token_type, entity_id, name, email, phone, token, added_by, created_at)
       VALUES ('GRN', $1, 'Old Rep', 'old.rep@example.test', '9000000006', $2, $3, now() - $4::interval)
       RETURNING id`,
      [poId, token, ADMIN, age]
    );

  it("legacy query-string token still authenticates GET /po/:id within expiry", async () => {
    const anon = await httpClient(null);
    const po = await makeRfqPo(db);
    const other = await makeRfqPo(db);
    const token = legacyToken();
    const { id } = await insertLegacy(po.poId, token, "2 days");

    const first = await anon.get(`/api/v1/po/${po.poId}?token=${token}`);
    expect(first.status).toBe(200);
    expect(Number(first.body.data.id)).toBe(po.poId);

    // First use upgrades the row: hash stored, plain token gone, expiry pinned
    // to 14 days after issue.
    const row = await db.one(
      `SELECT token, token_hash, (expires_at = created_at + interval '14 days') AS pinned
         FROM tbl_token_login_data WHERE id = $1`,
      [id]
    );
    expect(row).toEqual({ token: null, token_hash: sha256(token), pinned: true });

    // Still works afterwards (now by hash), and only for its own PO.
    expect((await anon.get(`/api/v1/po/${po.poId}?token=${token}`)).status).toBe(200);
    expect((await anon.get(`/api/v1/po/${other.poId}?token=${token}`)).status).toBe(403);
  });

  it("a legacy token older than 14 days is refused and left as it was", async () => {
    const anon = await httpClient(null);
    const po = await makeRfqPo(db);
    const token = legacyToken();
    const { id } = await insertLegacy(po.poId, token, "15 days");

    expect((await anon.get(`/api/v1/po/${po.poId}?token=${token}`)).status).toBe(403);
    const row = await db.one(`SELECT token, token_hash FROM tbl_token_login_data WHERE id = $1`, [id]);
    expect(row).toEqual({ token, token_hash: null });
  });
});

// ---------------------------------------------------------------------------
// Document URLs
// ---------------------------------------------------------------------------

describe("document URLs", () => {
  it("isOwnS3Url accepts only our bucket, parsed rather than substring-matched", async () => {
    const { isOwnS3Url } = await import("../../app/helper/s3Urls.js");
    expect(isOwnS3Url(OWN_URL("1729-abc.pdf"))).toBe(true);
    expect(isOwnS3Url(`https://${process.env.AWS_S3_BUCKET}.s3.amazonaws.com/x.pdf`)).toBe(true);
    for (const bad of [
      "https://evil.example/x.pdf",
      `https://${BUCKET_HOST}.evil.example/x.pdf`,
      `https://evil.example/${BUCKET_HOST}/x.pdf`,
      `https://evil.example/?u=${OWN_URL("x.pdf")}`,
      `http://${BUCKET_HOST}/x.pdf`,
      `https://user:pw@${BUCKET_HOST}/x.pdf`,
      `https://${BUCKET_HOST}:8443/x.pdf`,
      `https://other-bucket.s3.${process.env.AWS_REGION}.amazonaws.com/x.pdf`,
      `https://${BUCKET_HOST}/`,
      "javascript:alert(1)",
      "",
      null,
      undefined,
      42,
    ]) {
      expect([bad, isOwnS3Url(bad)]).toEqual([bad, false]);
    }
  });

  it("invoice URL outside our bucket rejected", async () => {
    const vendor = await httpClient(VENDOR);
    const po = await makeRfqPo(db, { status: "dispatched" });

    const bad = await vendor.post("/api/v1/po/raiseInvoice").send({ po_id: po.poId, invoice_url: "https://evil.example/inv.pdf" });
    expect(bad.status).toBe(400);
    expect(bad.body.status).toBe(0);
    const docs = () => db.any(`SELECT document_url FROM tbl_purchase_order_document WHERE purchase_order_id = $1`, [po.poId]);
    expect(await docs()).toHaveLength(0);
    expect((await db.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id = $1`, [po.poId])).status).toBe("dispatched");

    const good = await vendor.post("/api/v1/po/raiseInvoice").send({ po_id: po.poId, invoice_url: OWN_URL("inv-1.pdf") });
    expect(good.status).toBe(200);
    expect(await docs()).toEqual([{ document_url: OWN_URL("inv-1.pdf") }]);
  });

  it("GRN document URL outside our bucket rejected before anything is recorded", async () => {
    const admin = await httpClient(ADMIN);
    const po = await makeRfqPo(db, { status: "dispatched" });
    const res = await admin.post("/api/v1/po/markGRN").send({
      po_id: po.poId, grn_document_url: "https://evil.example/grn.pdf", remarks: "x",
    });
    expect(res.status).toBe(400);
    expect((await db.one(`SELECT status FROM tbl_rfq_purchase_order WHERE id = $1`, [po.poId])).status).toBe("dispatched");
    expect(await db.any(`SELECT id FROM tbl_purchase_order_document WHERE purchase_order_id = $1`, [po.poId])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D9: milestones and tasks on call-off POs
// ---------------------------------------------------------------------------

describe("milestones and tasks", () => {
  it("milestone can be created on call-off PO", async () => {
    const admin = await httpClient(ADMIN);
    const callOff = await makeCallOffPo(db);
    const unrelated = await makeRfqPo(db);

    // rfq_id comes from the PO, never from the body.
    const ms = await admin.post("/api/v1/po/milestones").send({
      po_id: callOff.poId, rfq_id: unrelated.rfqId, milestone_name: "Advance",
      due_date: "2026-01-15", milestone_description: "30% advance",
    });
    expect(ms.status).toBe(201);
    expect(ms.body.data).toMatchObject({ po_id: callOff.poId, rfq_id: null, milestone_name: "Advance" });

    const list = await admin.get(`/api/v1/po/${callOff.poId}/milestones`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((m) => m.id)).toContain(ms.body.data.id);

    const task = await admin.post("/api/v1/po/tasks").send({
      po_id: callOff.poId, rfq_id: unrelated.rfqId, task_name: "Inspect",
      completion_date: "2026-01-20", status: "pending",
    });
    expect(task.status).toBe(201);
    expect(task.body.data).toMatchObject({ po_id: callOff.poId, rfq_id: null });

    const rfqPo = await makeRfqPo(db);
    const ms2 = await admin.post("/api/v1/po/milestones").send({
      po_id: rfqPo.poId, rfq_id: unrelated.rfqId, milestone_name: "Balance", due_date: "2026-02-01",
    });
    expect(ms2.status).toBe(201);
    expect(ms2.body.data.rfq_id).toBe(rfqPo.rfqId);

    const foreign = await (await httpClient(FOREIGN)).post("/api/v1/po/milestones").send({
      po_id: callOff.poId, milestone_name: "Nope", due_date: "2026-01-15",
    });
    expect(foreign.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// D7: the daily phase-due sweeper
// ---------------------------------------------------------------------------

// Far from any real date so committed rows from other suites never match.
const TODAY = "2031-03-14";
const DAY = (n) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function addDelivery(t, { poId, lineId, hotelId, phaseNo = 1, due, planned = 4, accepted = 0 }) {
  const d = await t.one(
    `INSERT INTO tbl_po_delivery (hospitality_company_id, po_id, hotel_id, phase_no, due_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [CO, poId, hotelId, phaseNo, due]
  );
  await t.none(
    `INSERT INTO tbl_po_delivery_line (hospitality_company_id, delivery_id, po_line_id, planned_qty, accepted_qty)
     VALUES ($1, $2, $3, $4, $5)`,
    [CO, d.id, lineId, planned, accepted]
  );
  return Number(d.id);
}

async function addToken(t, { poId, hotelId, email, revoked = false }) {
  return t.one(
    `INSERT INTO tbl_token_login_data
       (token_type, entity_id, name, email, phone, added_by, token_hash, expires_at, revoked_at, hotel_id)
     VALUES ('GRN', $1, 'Rep', $2, '9000000007', $3, $4, now() + interval '5 days', $5, $6) RETURNING id`,
    [poId, email, ADMIN, sha256(crypto.randomBytes(16).toString("hex")), revoked ? new Date() : null, hotelId]
  );
}

describe("phase-due sweeper", () => {
  it("phase-due sweeper digests per hotel and skips legacy POs", async () => {
    const { runPhaseDueSweep } = await import("../../app/services/inventory/phaseDueSweeper.js");
    await withTx(async (t) => {
      const p1 = await makeRfqPo(t);
      await addDelivery(t, { poId: p1.poId, lineId: p1.lineIds[0], hotelId: A1, phaseNo: 1, due: DAY(0) });
      await addDelivery(t, { poId: p1.poId, lineId: p1.lineIds[0], hotelId: A1, phaseNo: 2, due: DAY(1) });
      await addDelivery(t, { poId: p1.poId, lineId: p1.lineIds[0], hotelId: A1, phaseNo: 3, due: DAY(5) });
      await addDelivery(t, { poId: p1.poId, lineId: p1.lineIds[0], hotelId: A1, phaseNo: 4, due: DAY(-3) });
      await addDelivery(t, { poId: p1.poId, lineId: p1.lineIds[0], hotelId: A1, phaseNo: 5, due: DAY(0), accepted: 4 });
      await addDelivery(t, { poId: p1.poId, lineId: p1.lineIds[0], hotelId: A1, phaseNo: 6, due: DAY(-1) });
      const rep = await addToken(t, { poId: p1.poId, hotelId: A1, email: "p1.rep@example.test" });

      const p2 = await makeCallOffPo(t, { hotel: A2 });
      await addDelivery(t, { poId: p2.poId, lineId: p2.lineIds[0], hotelId: A2, due: DAY(1) });
      await addToken(t, { poId: p2.poId, hotelId: A2, email: "p2.rep@example.test", revoked: true });

      const legacy = await makeRfqPo(t);
      await t.none(`UPDATE tbl_rfq_purchase_order SET receipt_legacy = true WHERE id = $1`, [legacy.poId]);
      await addDelivery(t, { poId: legacy.poId, lineId: legacy.lineIds[0], hotelId: A1, due: DAY(0) });

      const cancelled = await makeRfqPo(t, { status: "cancelled" });
      await addDelivery(t, { poId: cancelled.poId, lineId: cancelled.lineIds[0], hotelId: A1, due: DAY(0) });

      const received = await makeRfqPo(t);
      await t.none(`UPDATE tbl_rfq_purchase_order SET receipt_status = 'received' WHERE id = $1`, [received.poId]);
      await addDelivery(t, { poId: received.poId, lineId: received.lineIds[0], hotelId: A1, due: DAY(0) });

      const pending = await makeRfqPo(t, { status: "acceptance_pending" });
      await addDelivery(t, { poId: pending.poId, lineId: pending.lineIds[0], hotelId: A1, due: DAY(0) });

      const unsplit = await makeRfqPo(t, { mappedHotels: [A1, A2] });
      await addDelivery(t, { poId: unsplit.poId, lineId: unsplit.lineIds[0], hotelId: null, due: DAY(0) });

      const notify = jest.fn(async () => ({ sent: true }));
      const remindSiteRep = jest.fn(async () => true);
      const out = await runPhaseDueSweep({ conn: t, today: TODAY, notify, remindSiteRep });

      const byHotel = Object.fromEntries(notify.mock.calls.map(([arg]) => [arg.hotelId, arg]));
      expect(Object.keys(byHotel).map(Number).sort()).toEqual([A1, A2]);
      const keys = (arg) => arg.deliveries.map((d) => `${d.poId}:${d.phaseNo}:${d.bucket}`).sort();
      expect(keys(byHotel[A1])).toEqual([
        `${p1.poId}:1:due_today`, `${p1.poId}:2:due_tomorrow`, `${p1.poId}:4:overdue`,
        `${unsplit.poId}:1:due_today`,
      ].sort());
      expect(keys(byHotel[A2])).toEqual([`${p2.poId}:1:due_tomorrow`, `${unsplit.poId}:1:due_today`].sort());
      expect(byHotel[A1]).toMatchObject({ date: TODAY, hotelName: expect.any(String) });
      const p1Today = byHotel[A1].deliveries.find((d) => d.poId === p1.poId && d.phaseNo === 1);
      expect(p1Today).toMatchObject({ poNumber: p1.poNumber, dueDate: DAY(0), openLineCount: 1 });

      // The live rep on P1 is reminded; the revoked one on P2 is not. No credential travels.
      expect(remindSiteRep).toHaveBeenCalledTimes(1);
      const [reminder] = remindSiteRep.mock.calls[0];
      expect(reminder).toMatchObject({ to: "p1.rep@example.test", poNumber: p1.poNumber });
      expect(reminder.deliveries.map((d) => d.phaseNo).sort()).toEqual([1, 2, 4]);
      const tokenRow = await t.one(`SELECT token_hash FROM tbl_token_login_data WHERE id = $1`, [rep.id]);
      expect(JSON.stringify(reminder)).not.toContain(tokenRow.token_hash);

      expect(out).toMatchObject({ date: TODAY, digests: 2, siteRepEmails: 1 });
    });
  });

  it("the digest reaches grn.create holders at that hotel, once per day", async () => {
    const { runPhaseDueSweep } = await import("../../app/services/inventory/phaseDueSweeper.js");
    const digestRows = () =>
      db.any(
        `SELECT recipient_user_id, action_url, message FROM tbl_notifications
          WHERE type = 'inventory_phase_due_digest' AND additional_data->>'date' = $1`,
        [TODAY]
      );
    try {
      await withTx(async (t) => {
        const po = await makeRfqPo(t);
        await addDelivery(t, { poId: po.poId, lineId: po.lineIds[0], hotelId: A1, due: DAY(1) });
        const remindSiteRep = jest.fn(async () => true);

        const out = await runPhaseDueSweep({ conn: t, today: TODAY, remindSiteRep });
        expect(out.digests).toBe(1);
        const rows = await digestRows();
        const recipients = rows.map((r) => Number(r.recipient_user_id));
        expect(recipients).toEqual(expect.arrayContaining([ADMIN, PO_APPROVER]));
        expect(recipients).not.toContain(FOREIGN);
        expect(recipients).not.toContain(VIEWER);
        expect(recipients).not.toContain(VENDOR);
        expect(rows[0].action_url).toBe(`/dashboard/buyer/inventory/receive?hotelId=${A1}`);
        expect(rows[0].message).toContain(po.poNumber);

        const again = await runPhaseDueSweep({ conn: t, today: TODAY, remindSiteRep });
        expect(again.digests).toBe(0);
        expect(await digestRows()).toHaveLength(rows.length);
      });
    } finally {
      await db.none(
        `DELETE FROM tbl_notifications WHERE type = 'inventory_phase_due_digest' AND additional_data->>'date' = $1`,
        [TODAY]
      );
    }
  });
});

// ---------------------------------------------------------------------------
// CORS: the token header must survive a cross-origin preflight
// ---------------------------------------------------------------------------

describe("CORS", () => {
  it("allows the X-Receive-Token header", async () => {
    const req = await boundRequest(await buildTestApp());
    const pre = await req.options("/api/v1/inventory/token/receive-context")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "x-receive-token");
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers["access-control-allow-headers"].toLowerCase()).toContain("x-receive-token");

    const plain = await req.get("/api/v1/inventory/token/receive-context").set("Origin", "http://localhost:3000");
    expect(plain.status).toBe(401);
    expect(plain.headers["access-control-allow-headers"].toLowerCase()).toContain("x-receive-token");
  });
});

afterEach(() => {
  sentMail.length = 0;
});
