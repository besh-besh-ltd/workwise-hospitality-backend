// Site-rep receive link (Task C5, spec §10.3): the three /inventory/token/*
// endpoints and the rate limit.
//
// A link holder is an unauthenticated person with an emailed token. They see
// only their own PO and hotel, never a price or a buyer contact, post receipts
// only at the link's hotel, attach files only to receipts the link posted, and
// are capped at 60 requests per 10 minutes per link.
//
// Everything goes through HTTP with committed data (the suite truncates the
// dynamic tables before and after). Each PO line uses its own catalogue
// variant so stock items and balances never collide between tests.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import crypto, { randomUUID } from "crypto";
import { db, closeDb, truncateDynamic } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { httpClient } from "../helpers/http.js";
import s3Client from "../../app/config/s3config.js";
import { generateReceiveToken } from "../../app/helper/receiveToken.js";
import { COMMERCIAL_KEY } from "../../app/helper/receiveTokenView.js";
import {
  receiveTokenLimiter,
  createRequestLimiter,
  RECEIVE_TOKEN_RATE_LIMIT,
} from "../../app/middleware/receiveTokenRateLimit.js";

const CO = IDS.hospitality.A;
const A1 = IDS.hotels.A1;
const A2 = IDS.hotels.A2;
const ADMIN = IDS.users.companyA_admin; // CEO, company-wide: grn.create at every A hotel
const INITIATOR = IDS.users.a1_proc_buyer; // raised the POs
const VENDOR = IDS.users.vendor_alpha;

const BASE = "/api/v1/inventory/token";
const PRICE_A = 4321.77;
const PRICE_B = 98765.43;
// The carry-forward's regex, and B6's wider one (adds gst, discount, freight, total, charge).
const PRICE_KEY = /price|rate|cost|value|amount|tax/i;

let anon;
let admin;
let variants = [];
let nextVariantIdx = 0;
let TODAY;
let initiatorEmail;
let adminName;
const prevUserType = {};

// Count S3 writes, to prove a refused upload stores nothing.
const realSend = s3Client.send;
let s3Puts = 0;

beforeAll(async () => {
  await truncateDynamic();
  variants = (await db.any(`SELECT id FROM tbl_product_variant ORDER BY id DESC LIMIT 60`)).map((r) => Number(r.id));
  TODAY = (await db.one(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
  for (const id of [ADMIN, VENDOR]) {
    prevUserType[id] = await db.one(`SELECT user_type, status FROM tbl_users WHERE id = $1`, [id]);
  }
  await db.none(`UPDATE tbl_users SET user_type = 2 WHERE id = $1`, [ADMIN]);
  await db.none(`UPDATE tbl_users SET user_type = 3, status = 1 WHERE id = $1`, [VENDOR]);
  initiatorEmail = (await db.one(`SELECT email FROM tbl_users WHERE id = $1`, [INITIATOR])).email;
  adminName = (await db.one(`SELECT name FROM tbl_users WHERE id = $1`, [ADMIN])).name;
  anon = await httpClient(null);
  admin = await httpClient(ADMIN);
  s3Client.send = function countingSend(command, ...rest) {
    const name = command?.constructor?.name || "";
    if (/^(Put|CreateMultipartUpload|UploadPart)/.test(name)) s3Puts += 1;
    return realSend.call(this, command, ...rest);
  };
});

afterAll(async () => {
  s3Client.send = realSend;
  const grnIds = (await db.any(`SELECT id FROM tbl_grn`)).map((r) => Number(r.id));
  if (grnIds.length) {
    await db.none(`DELETE FROM tbl_activity_events WHERE entity_type = 'GRN' AND entity_id = ANY($1::bigint[])`, [grnIds]);
  }
  await truncateDynamic();
  for (const [id, row] of Object.entries(prevUserType)) {
    await db.none(`UPDATE tbl_users SET user_type = $2, status = $3 WHERE id = $1`, [id, row.user_type, row.status]);
  }
  await closeDb();
});

beforeEach(() => {
  receiveTokenLimiter.reset();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let seq = 0;
const tag = () => `${process.pid}-${++seq}`;

const nextVariant = () => {
  const v = variants[nextVariantIdx++];
  if (!v) throw new Error("ran out of catalogue variants for the token tests");
  return v;
};

/** A committed RFQ PO; lines = [{qty, price}]; mappedHotels makes it multi-hotel. */
async function makePo({ hotel = A1, mappedHotels = [], lines = [{ qty: 10, price: PRICE_A }] } = {}) {
  const { rfq_id, rfq_no } = await makeRFQ(db, {
    createdBy: INITIATOR, status: 1, is_published: 1, hotel, department: IDS.departments.proc,
  });
  for (const h of mappedHotels) {
    await db.none(`INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by) VALUES ($1, $2, $3)`, [rfq_id, h, INITIATOR]);
  }
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [rfq_id, rfq_no, VENDOR]
  );
  const total = lines.reduce((a, l) => a + l.qty * l.price, 0);
  const po = await db.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, company_id, po_number, status, rfq_product_id, quantity, unit_price,
        finalized_vendor_id, total_value, quote_id, initiated_by)
     VALUES ($1, $2, $3, 'approved', '{}', 1, $4, $5, $6, '{}', $7) RETURNING id, po_number`,
    [rfq_id, IDS.companies.A, `C5-PO-${tag()}`, lines[0].price, VENDOR, total, INITIATOR]
  );
  const lineIds = [];
  const lineVariants = [];
  for (const l of lines) {
    const variant = nextVariant();
    const rp = await db.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id`,
      [rfq_id, variant]
    );
    const qi = await db.one(
      `INSERT INTO tbl_quote_items
         (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, comment, delivery_period, quantity)
       VALUES ($1, $2, $3, $4, $5, $6, '', '', $7) RETURNING id`,
      [rfq_id, rfq_no, quote.id, variant, l.price, l.price * l.qty, String(l.qty)]
    );
    const pop = await db.one(
      `INSERT INTO tbl_purchase_order_product
         (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, charges_meta, total_price, product_variant_id)
       VALUES ($1, $2, $3, $4, 'kg', $5, '{"tax":18,"tax_mode":"percentage","other_charges":[]}'::jsonb, $6, $7)
       RETURNING id`,
      [po.id, rp.id, qi.id, l.qty, l.price, l.price * l.qty, variant]
    );
    lineIds.push(Number(pop.id));
    lineVariants.push(variant);
  }
  return { poId: Number(po.id), poNumber: po.po_number, lineIds, variants: lineVariants };
}

/**
 * A site-rep link as B6 issues it: only the sha256 is stored. Returns the
 * plain token (what the emailed link carries) and the row id.
 */
async function issueToken(poId, { hotelId = A1, expired = false, revoked = false } = {}) {
  const token = generateReceiveToken();
  const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const row = await db.one(
    `INSERT INTO tbl_token_login_data
       (token_type, entity_id, name, email, phone, added_by, token, token_hash, hotel_id, expires_at, revoked_at)
     VALUES ('GRN', $1, 'Ravi (site)', 'ravi.site@example.test', '9876543210', $2, NULL, $3, $4,
             CASE WHEN $5 THEN now() - interval '1 minute' ELSE now() + interval '14 days' END,
             CASE WHEN $6 THEN now() ELSE NULL END)
     RETURNING id`,
    [poId, ADMIN, hash, hotelId, expired, revoked]
  );
  return { token, tokenId: Number(row.id) };
}

const line = (poLineId, accepted, rejected = 0, extra = {}) => ({
  poLineId, receivedQty: accepted + rejected, acceptedQty: accepted, rejectedQty: rejected, ...extra,
});
const receipt = (lines, extra = {}) => ({ receivedAt: TODAY, clientEventId: randomUUID(), lines, ...extra });

const getContext = (token) => anon.get(`${BASE}/receive-context`).set("X-Receive-Token", token);
const postReceipt = (token, body) => anon.post(`${BASE}/grn`).set("X-Receive-Token", token).send(body);
const upload = (token, grnId, name = "challan.pdf") =>
  anon.post(`${BASE}/grn/${grnId}/attachments`)
    .set("X-Receive-Token", token)
    .field("kind", "CHALLAN")
    .attach("file", Buffer.from("%PDF-1.4 challan"), { filename: name, contentType: "application/pdf" });

/** A receipt a buyer user posts through the buyer route. */
async function buyerReceipt(poId, hotelId, lines) {
  const res = await admin.post("/api/v1/inventory/grn")
    .send({ poId, hotelId, post: true, ...receipt(lines) });
  expect(res.status).toBe(201);
  return res.body.data;
}

/** Every key in a JSON value, at any depth. */
function allKeys(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

/** The response leaks no price key, no price value and no buyer contact. */
function expectNoPrices(body) {
  const keys = allKeys(body);
  expect(keys.filter((k) => PRICE_KEY.test(k))).toEqual([]);
  expect(keys.filter((k) => COMMERCIAL_KEY.test(k))).toEqual([]);
  const text = JSON.stringify(body);
  for (const leak of [String(PRICE_A), String(PRICE_B), initiatorEmail, adminName]) {
    expect(text).not.toContain(leak);
  }
}

async function balanceOf(hotelId, variant) {
  const r = await db.oneOrNone(
    `SELECT b.qty::float8 AS qty
       FROM tbl_inv_balance b
       JOIN tbl_inv_item_variant iv ON iv.inv_item_id = b.inv_item_id AND iv.hospitality_company_id = $3
      WHERE b.hotel_id = $1 AND iv.product_variant_id = $2`,
    [hotelId, variant, CO]
  );
  return r ? r.qty : 0;
}

const grnRows = (poId) =>
  db.any(
    `SELECT id, hotel_id, status, posted_by, received_by, received_by_token_id
       FROM tbl_grn WHERE po_id = $1 ORDER BY id`,
    [poId]
  );

async function waitForActivity(grnId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.oneOrNone(
      `SELECT event_key, hospitality_company_id, hotel_id, entity_label, actor_type, actor_label, summary
         FROM tbl_activity_events WHERE entity_type = 'GRN' AND entity_id = $1 ORDER BY id LIMIT 1`,
      [grnId]
    );
    if (row || Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---------------------------------------------------------------------------
// what the link may see
// ---------------------------------------------------------------------------

describe("token receive context", () => {
  it("token context has no price keys at any depth", async () => {
    const { poId, poNumber, lineIds } = await makePo({
      lines: [{ qty: 10, price: PRICE_A }, { qty: 4, price: PRICE_B }],
    });
    const other = await makePo();
    // A buyer's draft at the same hotel: their work in progress, not the link's.
    const draft = await admin.post("/api/v1/inventory/grn")
      .send({ poId, hotelId: A1, post: false, ...receipt([line(lineIds[0], 1)]) });
    expect(draft.status).toBe(201);
    const { token } = await issueToken(poId, { hotelId: A1 });

    // Query parameters are not a way to another PO or hotel.
    const res = await getContext(token).query({ poId: other.poId, hotelId: A2 });
    expect(res.status).toBe(200);
    const ctx = res.body.data;
    expect(ctx.po).toMatchObject({ id: poId, poNumber, isCallOff: false });
    expect(ctx.hotel).toEqual({ id: A1, name: expect.any(String) });
    expect(ctx.hotelChoices).toEqual([ctx.hotel]);
    expect(ctx.lines.map((l) => [l.poLineId, l.openAtHotel, l.maxAcceptable])).toEqual([
      [lineIds[0], 10, 10],
      [lineIds[1], 4, 4],
    ]);
    expect(ctx).toMatchObject({
      draft: null, itemSuggestions: {}, receivable: true, notReceivableReason: null, receipts: [],
    });
    expect(Date.parse(ctx.linkExpiresAt) - Date.now()).toBeGreaterThan(13 * 86400_000);
    expectNoPrices(res.body);

    // The receipt the link posts, and a file it attaches, are just as clean.
    const posted = await postReceipt(token, receipt([line(lineIds[0], 3), line(lineIds[1], 1, 1, { rejectionReason: "damaged" })]));
    expect(posted.status).toBe(201);
    expect(posted.body.data).toMatchObject({ poId, hotelId: A1, status: "posted" });
    expectNoPrices(posted.body);
    const file = await upload(token, posted.body.data.id);
    expect(file.status).toBe(201);
    expectNoPrices(file.body);

    const after = await getContext(token);
    expect(after.status).toBe(200);
    expect(after.body.data.receipts).toEqual([
      expect.objectContaining({
        id: posted.body.data.id,
        grnNumber: posted.body.data.grnNumber,
        status: "posted",
        lineCount: 2,
        attachments: [expect.objectContaining({ id: file.body.data.id, kind: "CHALLAN", fileName: "challan.pdf" })],
      }),
    ]);
    expect(after.body.data.lines.map((l) => l.openAtHotel)).toEqual([7, 3]);
    expectNoPrices(after.body);
  });
});

// ---------------------------------------------------------------------------
// posting
// ---------------------------------------------------------------------------

describe("token receipts", () => {
  it("token GRN posts at token hotel only", async () => {
    const { poId, lineIds: [l1], variants: [v] } = await makePo({ mappedHotels: [A1, A2] });
    const { token, tokenId } = await issueToken(poId, { hotelId: A2 });

    // The page asks for A1; the link is for A2, and A2 is where it lands.
    const body = receipt([line(l1, 4)], { hotelId: A1, poId });
    const res = await postReceipt(token, body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ hotelId: A2, status: "posted", receivedByTokenId: tokenId });
    expect(await grnRows(poId)).toEqual([
      { id: res.body.data.id, hotel_id: A2, status: "posted", posted_by: null, received_by: null, received_by_token_id: tokenId },
    ]);
    expect(await balanceOf(A2, v)).toBe(4);
    expect(await balanceOf(A1, v)).toBe(0);

    // In the trail under the link's hotel, as the site rep.
    const event = await waitForActivity(res.body.data.id);
    expect(event).toMatchObject({
      event_key: "inventory_token_grn_created",
      hospitality_company_id: CO,
      hotel_id: A2,
      entity_label: res.body.data.grnNumber,
      actor_label: expect.stringContaining("Ravi"),
    });

    // A dropped connection replays: the same GRN, nothing posted twice.
    const replay = await postReceipt(token, body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(res.body.data.id);
    expect(await grnRows(poId)).toHaveLength(1);
    expect(await balanceOf(A2, v)).toBe(4);

    // A link records receipts; it never parks a draft.
    const asDraft = await postReceipt(token, { ...receipt([line(l1, 1)]), post: false });
    expect(asDraft.status).toBe(400);
    expect(asDraft.body).toMatchObject({ code: "VALIDATION", details: { field: "post" } });
    expect(await grnRows(poId)).toHaveLength(1);

    // An old link with no hotel on a multi-hotel PO can't receive anywhere.
    const { token: hotelless } = await issueToken(poId, { hotelId: null });
    const ctx = await getContext(hotelless);
    expect(ctx.status).toBe(409);
    expect(ctx.body).toMatchObject({ code: "CONFLICT", details: { reason: "TOKEN_NO_HOTEL" } });
    const refused = await postReceipt(hotelless, receipt([line(l1, 1)], { hotelId: A1 }));
    expect(refused.status).toBe(409);
    expect(await grnRows(poId)).toHaveLength(1);
    expect(await balanceOf(A1, v)).toBe(0);
  });

  it("a fully received PO still answers 200 (receivable:false) and takes paperwork for 24 hours", async () => {
    const { poId, lineIds: [l1] } = await makePo({ lines: [{ qty: 5, price: PRICE_A }] });
    const { token } = await issueToken(poId);
    const posted = await postReceipt(token, receipt([line(l1, 5)]));
    expect(posted.status).toBe(201);

    const res = await getContext(token);
    expect(res.status).toBe(200);
    const ctx = res.body.data;
    expect(ctx).toMatchObject({
      po: { id: poId },
      hotel: { id: A1 },
      lines: [],
      dispatches: [],
      draft: null,
      receivable: false,
      notReceivableReason: "received",
      receipts: [expect.objectContaining({ id: posted.body.data.id, status: "posted" })],
    });
    const postedAt = Date.parse(ctx.receipts[0].postedAt);
    expect(Date.parse(ctx.linkExpiresAt)).toBe(postedAt + 24 * 3600_000);
    expectNoPrices(res.body);

    const more = await postReceipt(token, receipt([line(l1, 1)]));
    expect(more.status).toBe(409);
    expect(more.body.details).toMatchObject({ reason: "PO_NOT_RECEIVABLE" });

    expect((await upload(token, posted.body.data.id)).status).toBe(201);

    // Past the grace the link is dead.
    await db.none(`UPDATE tbl_grn SET posted_at = posted_at - interval '25 hours' WHERE po_id = $1`, [poId]);
    expect((await getContext(token)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

describe("token refusals", () => {
  it("expired or revoked token is 401", async () => {
    const { poId, lineIds: [l1] } = await makePo();
    const live = await issueToken(poId);
    const grn = await postReceipt(live.token, receipt([line(l1, 2)]));
    expect(grn.status).toBe(201);
    const grnId = grn.body.data.id;

    const expired = await issueToken(poId, { expired: true });
    const revoked = await issueToken(poId, { revoked: true });
    // The live link, revoked after it posted: its own GRN is closed to it too.
    await db.none(`UPDATE tbl_token_login_data SET revoked_at = now() WHERE id = $1`, [live.tokenId]);

    const putsBefore = s3Puts;
    for (const { token } of [expired, revoked, live]) {
      const ctx = await getContext(token);
      expect(ctx.status).toBe(401);
      expect(ctx.body).toEqual({ status: 0, message: "Invalid or expired link" });
      const post = await postReceipt(token, receipt([line(l1, 1)]));
      expect(post.status).toBe(401);
      const file = await upload(token, grnId);
      expect(file.status).toBe(401);
    }
    expect(s3Puts).toBe(putsBefore);
    expect(await grnRows(poId)).toHaveLength(1);
    expect(Number((await db.one(`SELECT COUNT(*) AS c FROM tbl_grn_attachment WHERE grn_id = $1`, [grnId])).c)).toBe(0);
  });

  it("token cannot read another PO", async () => {
    const mine = await makePo();
    const theirs = await makePo();
    const { token } = await issueToken(mine.poId);

    // Its context is always its own PO.
    const ctx = await getContext(token).query({ poId: theirs.poId });
    expect(ctx.body.data.po.id).toBe(mine.poId);

    // Posting against another PO, by id or by that PO's lines, opens nothing.
    const byId = await postReceipt(token, receipt([line(theirs.lineIds[0], 1)], { poId: theirs.poId }));
    expect(byId.status).toBe(404);
    const byLine = await postReceipt(token, receipt([line(theirs.lineIds[0], 1)]));
    expect(byLine.status).toBe(400);
    expect(await grnRows(theirs.poId)).toEqual([]);
    expect(await grnRows(mine.poId)).toEqual([]);

    // The legacy PO view refuses the link for any PO but its own.
    const legacyTheirs = await anon.get(`/api/v1/po/${theirs.poId}`).set("X-Receive-Token", token);
    expect(legacyTheirs.status).toBe(403);

    // Attachments go only onto receipts this link posted: not another PO's,
    // and not a buyer's receipt on the same PO and hotel. Nothing is stored.
    const foreignGrn = await buyerReceipt(theirs.poId, A1, [line(theirs.lineIds[0], 1)]);
    const buyerGrn = await buyerReceipt(mine.poId, A1, [line(mine.lineIds[0], 1)]);
    const putsBefore = s3Puts;
    for (const id of [foreignGrn.id, buyerGrn.id, 999999999]) {
      const res = await upload(token, id);
      expect(res.status).toBe(404);
    }
    expect(s3Puts).toBe(putsBefore);

    // Nor can it "replay" a buyer's receipt by reusing its clientEventId.
    const hijack = await postReceipt(token, receipt([line(mine.lineIds[0], 1)], { clientEventId: buyerGrn.clientEventId }));
    expect(hijack.status).toBe(409);
    expect(JSON.stringify(hijack.body)).not.toContain(buyerGrn.grnNumber);
    expect(await grnRows(mine.poId)).toHaveLength(1);

    const own = await postReceipt(token, receipt([line(mine.lineIds[0], 2)]));
    expect(own.status).toBe(201);
    const ok = await upload(token, own.body.data.id, "photo.pdf");
    expect(ok.status).toBe(201);
    expect(ok.body.data).toEqual({ id: expect.any(Number), fileName: "photo.pdf", kind: "CHALLAN", url: expect.any(String) });
    expect(await db.one(`SELECT uploaded_by FROM tbl_grn_attachment WHERE id = $1`, [ok.body.data.id]))
      .toEqual({ uploaded_by: null });

    // A buyer's file on the link's own receipt (a priced invoice, say) is never listed back.
    await db.none(
      `INSERT INTO tbl_grn_attachment (hospitality_company_id, grn_id, s3_key, file_name, kind, uploaded_by)
       VALUES ($1, $2, 'grn/attachments/buyer-invoice.pdf', 'invoice.pdf', 'INVOICE', $3)`,
      [CO, own.body.data.id, ADMIN]
    );
    const receipts = (await getContext(token)).body.data.receipts;
    expect(receipts.map((r) => r.id)).toEqual([own.body.data.id]);
    expect(receipts[0].attachments.map((a) => a.id)).toEqual([ok.body.data.id]);
  });
});

// ---------------------------------------------------------------------------
// rate limit
// ---------------------------------------------------------------------------

describe("token rate limit", () => {
  it("answers 429 past 60 requests per token in 10 minutes, on every token route", async () => {
    const { poId, lineIds: [l1] } = await makePo();
    const busy = await issueToken(poId);
    const otherPo = await makePo();
    const calm = await issueToken(otherPo.poId);

    for (let i = 1; i <= RECEIVE_TOKEN_RATE_LIMIT.max; i++) {
      const res = await getContext(busy.token);
      expect([i, res.status]).toEqual([i, 200]);
    }
    const capped = await getContext(busy.token);
    expect(capped.status).toBe(429);
    expect(capped.body).toMatchObject({ status: 0, code: "RATE_LIMITED" });
    const retryAfter = Number(capped.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(600);

    // The same budget covers posting, attaching and the legacy token path.
    expect((await postReceipt(busy.token, receipt([line(l1, 1)]))).status).toBe(429);
    expect(await grnRows(poId)).toEqual([]);
    expect((await upload(busy.token, 1)).status).toBe(429);
    expect((await anon.get(`/api/v1/po/${poId}`).set("X-Receive-Token", busy.token)).status).toBe(429);
    expect((await anon.get(`/api/v1/po/${poId}`).query({ token: busy.token })).status).toBe(429);

    // Other links are unaffected; a malformed token is refused, not counted.
    expect((await getContext(calm.token)).status).toBe(200);
    expect((await getContext("abc")).status).toBe(401);
  });

  it("the window resets, and each key has its own budget", () => {
    let now = 0;
    const limiter = createRequestLimiter({ max: 2, windowMs: 1000, maxKeys: 2, now: () => now });
    expect(limiter.hit("a")).toEqual({ allowed: true, retryAfterS: 1 });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterS: 1 });
    expect(limiter.hit("b").allowed).toBe(true);
    now = 1000;
    expect(limiter.hit("a").allowed).toBe(true);

    // Bounded memory: past maxKeys the oldest key is dropped first.
    limiter.reset();
    now = 0;
    limiter.hit("x");
    limiter.hit("x");
    expect(limiter.hit("x").allowed).toBe(false);
    now = 10;
    limiter.hit("y");
    limiter.hit("z");
    expect(limiter.size()).toBe(2);
    expect(limiter.hit("x").allowed).toBe(true);
  });
});
