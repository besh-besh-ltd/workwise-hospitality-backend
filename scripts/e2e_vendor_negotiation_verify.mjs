// End-to-end verification of the vendor negotiation deadlock fix.
//
// Not a unit test and not supertest: this drives the REAL server process over
// real HTTP (default http://localhost:8099) against a real Postgres database,
// through the full middleware chain — auth, subscription, controller.
//
// Every scenario is seeded to the exact shape production holds, verified
// read-only against hospitality_main beforehand:
//   * delivery_period '' (text NOT NULL — 5,264 items are like this)
//   * tax_mode NULL      (330 items are like this)
//   * an ACTIVE round opening base_price only, as RFQ 560's round 906 did
//
// Usage:  node scripts/e2e_vendor_negotiation_verify.mjs
// Env:    E2E_BASE (default http://localhost:8099)

import JWT from "jsonwebtoken";
import Cryptr from "cryptr";
import pgPromise from "pg-promise";
import Config from "../app/config/app.config.js";
import { IDS } from "../tests/fixtures/ids.js";

const BASE = process.env.E2E_BASE || "http://localhost:8099";
const DB_NAME = process.env.DATABASE_NAME || "hospitality_test_e2evq";
const UA = "e2e-vendor-agent";

const pgp = pgPromise();
const db = pgp({
  host: "localhost",
  port: 5432,
  database: DB_NAME,
  user: process.env.DATABASE_USERNAME || "apple",
});

const cryptr = new Cryptr(Config.cryptR.secret);

// Imported, not hardcoded — the fixture ids are the source of truth.
const VENDOR = IDS.users.vendor_alpha;
const VENDOR_OTHER = IDS.users.vendor_beta;
const BUYER = IDS.users.a1_proc_buyer;
const HOSPITALITY = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const PROCESS = IDS.processes.A_P1;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

async function token(userId) {
  await db.none(`UPDATE tbl_users SET user_agent = $1 WHERE id = $2`, [UA, userId]);
  const u = await db.one(`SELECT id, name FROM tbl_users WHERE id = $1`, [userId]);
  const now = Math.round(Date.now() / 1000);
  return JWT.sign(
    {
      iss: "Des Technico",
      sub: cryptr.encrypt(String(u.id)),
      name: u.name,
      session: "",
      user: true,
      ag: cryptr.encrypt(UA),
      iat: now,
      exp: now + 3600,
    },
    Config.jwt.secret
  );
}

async function api(method, path, { userId, body } = {}) {
  const headers = { "Content-Type": "application/json", "User-Agent": UA };
  if (userId) headers.Authorization = `Bearer ${await token(userId)}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

const ts = (ms) => new Date(Date.now() + ms).toISOString().replace("T", " ").slice(0, 19);

/** Build an RFQ whose bid window has CLOSED — the only state a round applies in. */
async function seedScenario({ deliveryPeriod = "", taxMode = "percentage", charges = "[]" } = {}) {
  const rfq = await db.one(
    `INSERT INTO tbl_rfq (rfq_no, comment, company_name, response_email, contact_name,
        contact_number, bid_end_date, location, is_published, created_by, updated_by,
        status, hospitality_company_id, hotel_id, process_id, title, publish_attempts)
     VALUES ((SELECT COALESCE(MAX(rfq_no),500000)+1 FROM tbl_rfq), '', 'E2E Co', 'e2e@x.com',
        'E2E', '9999999999', $1, 'Pune', 1, $2, $2, 1, $3, $4, $5, 'E2E deadlock check', 0)
     RETURNING id, rfq_no`,
    [ts(-86400_000), BUYER, HOSPITALITY, HOTEL, PROCESS]   // bid window CLOSED
  );
  const rp = await db.one(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap,
        product_variant_id, variant)
     VALUES ($1,'','','','','',1,0) RETURNING id`,
    [rfq.id]
  );
  await db.none(
    `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant)
     VALUES ($1, 1, $2, 0)`,
    [rfq.id, VENDOR]
  );
  const quote = await db.one(
    `INSERT INTO tbl_quotes (rfq_id, rfq_no, status, created_by, updated_by, is_regret,
        global_payment_term, global_comment, global_charges, pricing_method)
     VALUES ($1,$2,1,$3,$3,0,'Net 30','','[]'::jsonb,'TRADITIONAL') RETURNING id`,
    [rfq.id, rfq.rfq_no, VENDOR]
  );
  await db.none(
    `INSERT INTO tbl_quote_items (rfq_id, rfq_no, quote_id, product_variant_id, unit_price,
        tax, total_price, comment, delivery_period, quantity, variant, tax_mode,
        other_charges, pricing_method)
     VALUES ($1,$2,$3,1,500,18,5900,'',$4,'10',0,$5,$6::jsonb,'TRADITIONAL')`,
    [rfq.id, rfq.rfq_no, quote.id, deliveryPeriod, taxMode, charges]
  );
  return { rfq, rp, quoteId: quote.id };
}

async function openRound(rfqId, rfqProductId, fields) {
  await db.none(
    `INSERT INTO tbl_negotiation_rounds (rfq_id, round_number, end_date, status, created_by,
        source_type, source_id, rfq_product_id, vendor_ids, vendor_approvals, published_at, approved_at)
     VALUES ($1, 1, NOW() + interval '2 days', 'ACTIVE', $2, 'RFQ', $1, $3, $4::int[], $5::jsonb, NOW(), NOW())`,
    [rfqId, BUYER, rfqProductId, [VENDOR],
     JSON.stringify([{ vendor_id: VENDOR, negotiation_fields: fields }])]
  );
}

const line = (over = {}) => ({
  product_id: 1, variant: 0, unit_price: 450, tax: 18, tax_mode: "percentage",
  total_price: 5310, comment: "", delivery_period: 0, quantity: "10",
  other_charges: [], document_files: [], ...over,
});

const payload = (rfq, products) => ({
  rfq_id: rfq.id, rfq_no: rfq.rfq_no, products,
  globalPaymentTerms: "Net 30", globalComment: "",
  global_payment_term_list: { createdTerms: [], updatedTerms: [], deletedTerms: [] },
  global_charges: [],
});

const storedPrice = (quoteId) =>
  db.one(`SELECT unit_price, delivery_period FROM tbl_quote_items WHERE quote_id=$1`, [quoteId]);

async function main() {
  console.log(`\nE2E vendor negotiation verification — ${BASE} / ${DB_NAME}\n`);

  // ── 1. THE REPORTED DEADLOCK ────────────────────────────────────────────
  console.log("1. Reported deadlock — RFQ 560 shape (delivery_period '')");
  {
    const { rfq, rp, quoteId } = await seedScenario();
    await openRound(rfq.id, rp.id, [{ name: "base_price", target: "450" }]);
    const res = await api("PUT", `/api/v1/rfq/quote/update/${quoteId}`, {
      userId: VENDOR, body: payload(rfq, [line()]),
    });
    const after = await storedPrice(quoteId);
    record("vendor can submit a price revision", res.status === 200,
      `HTTP ${res.status} — ${res.body?.message || ""}`);
    record("the new price actually persisted", Number(after.unit_price) === 450,
      `unit_price = ${after.unit_price}`);
  }

  // ── 2. FILL-A-GAP ───────────────────────────────────────────────────────
  console.log("\n2. Fill-a-gap — vendor volunteers a delivery period");
  {
    const { rfq, rp, quoteId } = await seedScenario();
    await openRound(rfq.id, rp.id, [{ name: "base_price", target: "450" }]);
    const res = await api("PUT", `/api/v1/rfq/quote/update/${quoteId}`, {
      userId: VENDOR, body: payload(rfq, [line({ delivery_period: 7 })]),
    });
    const after = await storedPrice(quoteId);
    record("filling a never-set delivery period is accepted", res.status === 200,
      `HTTP ${res.status}`);
    record("it was stored", String(after.delivery_period) === "7",
      `delivery_period = '${after.delivery_period}'`);
  }

  // ── 3. THE tax_mode LANDMINE ────────────────────────────────────────────
  console.log("\n3. NULL tax_mode — 330 production items, previously unfixable forever");
  {
    const { rfq, rp, quoteId } = await seedScenario({ deliveryPeriod: "7", taxMode: null });
    await openRound(rfq.id, rp.id, [{ name: "base_price", target: "450" }]);
    const res = await api("PUT", `/api/v1/rfq/quote/update/${quoteId}`, {
      userId: VENDOR, body: payload(rfq, [line({ delivery_period: 7 })]),
    });
    record("no phantom `gst` violation", res.status === 200 && !JSON.stringify(res.body).includes("gst"),
      `HTTP ${res.status} — ${res.body?.message || ""}`);
  }

  // ── 4. ZERO CHARGE (the other reported issue) ───────────────────────────
  console.log("\n4. Zero-amount charge — buyer negotiated freight to 0");
  {
    const existing = JSON.stringify([
      { name: "Freight", slug: "freight", amount: 500, amount_mode: "absolute",
        tax: 0, tax_mode: "percentage", comment: "trucking" },
    ]);
    const { rfq, rp, quoteId } = await seedScenario({ deliveryPeriod: "7", charges: existing });
    await openRound(rfq.id, rp.id, [{ name: "freight", target: "0" }]);
    const zeroed = [{ name: "Freight", slug: "freight", amount: 0, amount_mode: "absolute",
                      tax: 0, tax_mode: "percentage", comment: "waived as agreed" }];
    const res = await api("PUT", `/api/v1/rfq/quote/update/${quoteId}`, {
      userId: VENDOR,
      body: payload(rfq, [line({ unit_price: 500, delivery_period: 7, other_charges: zeroed })]),
    });
    const row = await db.one(`SELECT other_charges FROM tbl_quote_items WHERE quote_id=$1`, [quoteId]);
    const oc = Array.isArray(row.other_charges) ? row.other_charges : JSON.parse(row.other_charges);
    const freight = oc.find((c) => (c.slug || c.name || "").toLowerCase() === "freight");
    record("vendor may set a charge to exactly 0", res.status === 200,
      `HTTP ${res.status} — ${res.body?.message || ""}`);
    record("the zero persisted (not dropped)", freight && Number(freight.amount) === 0,
      `stored freight amount = ${freight ? freight.amount : "MISSING"}`);
  }

  // ── 5. THE ALLOWLIST MUST STILL BITE ────────────────────────────────────
  console.log("\n5. Guards — enforcement must NOT have loosened");
  {
    const { rfq, rp, quoteId } = await seedScenario({ deliveryPeriod: "7" });
    await openRound(rfq.id, rp.id, [{ name: "base_price", target: "450" }]);
    const res = await api("PUT", `/api/v1/rfq/quote/update/${quoteId}`, {
      userId: VENDOR, body: payload(rfq, [line({ delivery_period: 21 })]),
    });
    const after = await storedPrice(quoteId);
    record("changing a STATED delivery period is still refused",
      res.status === 400 && JSON.stringify(res.body).includes("delivery_period"),
      `HTTP ${res.status} — ${res.body?.message || ""}`);
    record("nothing leaked through on the refused call", Number(after.unit_price) === 500,
      `unit_price = ${after.unit_price}`);
  }
  {
    const { rfq, rp, quoteId } = await seedScenario();   // empty delivery period
    await openRound(rfq.id, rp.id, [{ name: "freight", target: "10" }]);
    const res = await api("PUT", `/api/v1/rfq/quote/update/${quoteId}`, {
      userId: VENDOR, body: payload(rfq, [line()]),      // tries to move the PRICE
    });
    record("the delivery gap did NOT become a general allowlist bypass",
      res.status === 400 && JSON.stringify(res.body).includes("base_price"),
      `HTTP ${res.status} — ${res.body?.message || ""}`);
  }
  {
    const { rfq, rp, quoteId } = await seedScenario({ deliveryPeriod: "7" });
    await openRound(rfq.id, rp.id, [{ name: "base_price", target: "450" }]);
    const res = await api("PUT", `/api/v1/rfq/quote/update/${quoteId}`, {
      userId: VENDOR, body: payload(rfq, [line({ delivery_period: 7, tax: 12 })]),
    });
    record("a real GST change is still refused", res.status === 400,
      `HTTP ${res.status} — ${res.body?.message || ""}`);
  }

  // ── 6. TENANT ISOLATION (unchanged, but this endpoint handles money) ────
  console.log("\n6. Security — IDOR on the same endpoint");
  {
    const { rfq, rp, quoteId } = await seedScenario();
    await openRound(rfq.id, rp.id, [{ name: "base_price", target: "450" }]);
    const other = await api("PUT", `/api/v1/rfq/quote/update/${quoteId}`, {
      userId: VENDOR_OTHER, body: payload(rfq, [line()]),
    });
    const after = await storedPrice(quoteId);
    record("another vendor cannot rewrite this quote", other.status !== 200,
      `HTTP ${other.status}`);
    record("the price is untouched after the IDOR attempt", Number(after.unit_price) === 500,
      `unit_price = ${after.unit_price}`);
    const anon = await api("PUT", `/api/v1/rfq/quote/update/${quoteId}`, {
      body: payload(rfq, [line()]),
    });
    record("unauthenticated write is rejected", anon.status === 401, `HTTP ${anon.status}`);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${"=".repeat(60)}\nE2E RESULT: ${passed}/${results.length} passed`);
  if (passed !== results.length) {
    console.log("FAILED:");
    results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name} :: ${r.detail}`));
  }
  console.log("=".repeat(60));
  await pgp.end();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await pgp.end(); process.exit(1); });
