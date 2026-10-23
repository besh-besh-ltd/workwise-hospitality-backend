// PO Oct-22 tickets (T1 initiate guide, T2 vendor PO reference, T3 hold / reject):
// LOCAL end-to-end seed. See scripts/po_oct22/E2E_RUNBOOK.md.
//
//   node scripts/po_oct22/e2e_seed.mjs                    (hospitality_test_e2e_po22, API http://127.0.0.1:8125)
//   node scripts/po_oct22/e2e_seed.mjs --db=hospitality_test_e2e_po22 --api=http://127.0.0.1:8125/api/v1
//
// PRECONDITIONS. The DB was built by scripts/vendor_networks/e2e_prepare_db.mjs
// (E2E_RUN_ID=e2e_po22) and the backend is running against it
// (scripts/vendor_networks/e2e_server.sh). The seed talks to that server over HTTP.
//
// SAFETY. Never reads .env. Refuses unless the DB name is local-looking and the host is loopback,
// and the API URL must be loopback. Never imports app code (that would load .env = stage creds).
//
// NOT RE-RUNNABLE. It refuses when the world already exists (marker: tbl_rfq.title '[PO22] ...').
// To start over: re-run e2e_prepare_db.mjs (drops + rebuilds the DB), then this seed.
//
// WORLD. Built on the test-fixture company (hospitality 10001, hotel A1 10101, dept Procurement).
// The fixture users are re-used (they already hold the right role scopes) and given logins:
//   RFQ creator            80011  TENDER_CREATOR        (no awarding.* => CANNOT initiate)
//   Commercial evaluator   80014  COMM_NEGO_N1          (raises the award)
//   Award approver         80015  COMM_APPROVER         (approves the award; needed by the flow)
//   PO initiator (CA)      80002  Company CEO           (awarding.create at the hotel => CAN initiate)
//   P1                     80016  Final Awarding P1     PO policy step 1
//   P2a, P2b               80017, 80013  Final Awarding P2  PO policy step 2 (ROLE 14, rule ANY)
//   P3                     80012  Final Awarding P3     PO policy step 3
//   V-A, V-B               80101, 80102 (vendor_alpha / vendor_beta)

import os from "os";
import bcrypt from "bcryptjs";
import pgPromise from "pg-promise";

// ---------------------------------------------------------------------------
// Connection + guard
// ---------------------------------------------------------------------------
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const conn = {
  database: arg("db") || process.env.E2E_DB_NAME || "hospitality_test_e2e_po22",
  host: arg("host") || process.env.E2E_DB_HOST || "127.0.0.1",
  port: Number(arg("port") || process.env.E2E_DB_PORT || 5432),
  user: arg("user") || process.env.E2E_DB_USER || os.userInfo().username,
  password: process.env.E2E_DB_PASSWORD || undefined,
  ssl: false,
};
const API = (arg("api") || process.env.E2E_API || "http://127.0.0.1:8125/api/v1").replace(/\/+$/, "");
const FE = arg("fe") || process.env.E2E_FE || "http://localhost:3105";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
if (!/^hospitality_test_|local|dev/.test(conn.database) || /prod|stage|staging|main/i.test(conn.database)) {
  console.error(`ABORT: '${conn.database}' does not look like a local database.`);
  process.exit(2);
}
if (!LOCAL_HOSTS.has(conn.host)) {
  console.error(`ABORT: host '${conn.host}' is not local.`);
  process.exit(2);
}
if (!LOCAL_HOSTS.has(new URL(API).hostname.replace(/^\[|\]$/g, ""))) {
  console.error(`ABORT: API '${API}' is not loopback.`);
  process.exit(2);
}

const pgp = pgPromise();
pgp.pg.types.setTypeParser(1114, (s) => s);
const db = pgp(conn);

// ---------------------------------------------------------------------------
// Cast (fixture ids from tests/fixtures/ids.js)
// ---------------------------------------------------------------------------
const PASSWORD = "E2e@12345";
const HC = 10001; // hospitality company A
const HOTEL = 10101; // hotel A-1
const DEPT = 10201; // Procurement
const PROCESS = 70001; // Company A, Standard Procurement
const PO_POLICY = 60005; // A1_P1_PO
const ROLE = { P1: 13, P2: 14, P3: 15 }; // Final Awarding P1/P2/P3: awarding read+create+approve

const CAST = {
  creator: { id: 80011, name: "Rhea RFQ Creator", code: "PO22CRT", kind: "buyer", note: "raised the RFQs; NO awarding permission, cannot initiate" },
  evaluator: { id: 80014, name: "Eva Commercial Evaluator", code: "PO22EVL", kind: "buyer", note: "raises the award; re-finalizes after a re-negotiate" },
  awardApprover: { id: 80015, name: "Arun Award Approver", code: "PO22AWD", kind: "buyer", note: "approves the award (flow prerequisite)" },
  initiator: { id: 80002, name: "Cara PO Initiator (CA)", code: "PO22INI", kind: "buyer", note: "Company CEO: awarding.create at the hotel, CAN initiate" },
  p1: { id: 80016, name: "Priya P1 Approver", code: "PO22AP1", kind: "buyer", note: "PO step 1" },
  p2a: { id: 80017, name: "Pavan P2a Approver", code: "PO22A2A", kind: "buyer", note: "PO step 2 (ANY of P2a/P2b); asks for information in the hold script" },
  p2b: { id: 80013, name: "Pooja P2b Approver", code: "PO22A2B", kind: "buyer", note: "PO step 2 (ANY of P2a/P2b); blocked while P2a's hold is open" },
  p3: { id: 80012, name: "Param P3 Approver", code: "PO22AP3", kind: "buyer", note: "PO step 3" },
  vA: { id: 80101, name: "Alpha Vendor (V-A)", email: "po22.alpha@example.com", kind: "vendor", note: "vendor_alpha" },
  vB: { id: 80102, name: "Beta Vendor (V-B)", email: "po22.beta@example.com", kind: "vendor", note: "vendor_beta" },
};
const BUYER_KEYS = Object.keys(CAST).filter((k) => CAST[k].kind === "buyer");

const istString = (offsetMs) =>
  new Date(Date.now() + offsetMs + 5.5 * 3600_000).toISOString().replace("T", " ").slice(0, 19);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const tokens = {};
async function http(key, method, path, body) {
  const headers = { "User-Agent": `po22-e2e-${key}`, "Content-Type": "application/json" };
  if (tokens[key]) headers.Authorization = `Bearer ${tokens[key]}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}
async function ok(label, key, method, path, body) {
  const r = await http(key, method, path, body);
  if (r.status !== 200) {
    throw new Error(`${label}: ${method} ${path} as ${key} -> HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
  }
  return r.json;
}
async function login(key) {
  const u = CAST[key];
  const body = u.kind === "buyer" ? { employee_code: u.code, password: PASSWORD } : { email: u.email, password: PASSWORD };
  const r = await http(key, "POST", "/users/login?conform=true", body);
  if (r.status !== 200 || !r.json.token) {
    throw new Error(`login ${key} failed: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}. Is the server running against ${conn.database}?`);
  }
  tokens[key] = r.json.token;
}

// ---------------------------------------------------------------------------
// Step 1: users, role scopes, 3-step PO policy (SQL: no endpoint for a fixture-level setup)
// ---------------------------------------------------------------------------
async function seedPeople(t) {
  const hash = bcrypt.hashSync(PASSWORD, 10);
  for (const u of Object.values(CAST)) {
    // SQL SHORTCUT: fixture users have no password/login; users are created through the admin UI in
    // real life. Names are rewritten so each screen shows who is who.
    await t.none(
      `UPDATE tbl_users SET name = $2, password = $3, status = 1, is_deleted = 0, user_type = $4,
              employee_code = $5, email = COALESCE($6, email)
        WHERE id = $1`,
      [u.id, u.name, hash, u.kind === "buyer" ? 2 : 3, u.code || null, u.email || null]
    );
  }
  // SQL SHORTCUT: role scopes (admin RBAC UI has endpoints, but this is fixture setup).
  // A step-2 ROLE source resolves to everyone holding role 14 at the hotel: exactly P2a + P2b.
  const grants = [
    [CAST.p1.id, ROLE.P1], // already holds 13 in the fixture; ON CONFLICT keeps it idempotent
    [CAST.p2a.id, ROLE.P2],
    [CAST.p2b.id, ROLE.P2],
    [CAST.p3.id, ROLE.P3],
    // RFQ Observer (17: rfq.read + awarding.read, no awarding.create): the creator can see the PO
    // stage but not initiate, which is the "Waiting for a PO initiator" view T1 checks.
    [CAST.creator.id, 17],
    // Role 8 (Commercial Evaluator) has no rfq.read; on prod every role-8 holder also has rfq.read
    // through another role (54/54), so give the evaluator the same reach to open the RFQ page.
    [CAST.evaluator.id, 17],
  ];
  for (const [uid, role] of grants) {
    await t.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [uid, role, HC, HOTEL, DEPT]
    );
  }
  // SQL SHORTCUT: the fixture PO policy (A1_P1_PO) is USER p1 / ROLE 12 / USER finance. Rewrite it to the
  // 3-step shape of this world. (policy admin UI endpoint exists; SQL is simpler for a one-off.)
  //   step 1 ALL USER P1 | step 2 ANY ROLE 14 (P2a, P2b) | step 3 ALL USER P3
  await t.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [PO_POLICY]);
  const steps = [
    [1, "ANY", "USER", CAST.p1.id],
    [2, "ANY", "ROLE", ROLE.P2],
    [3, "ANY", "USER", CAST.p3.id],
  ];
  for (const [order, rule, type, src] of steps) {
    await t.none(
      `INSERT INTO tbl_approval_policy_steps (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [PO_POLICY, order, rule, type, src]
    );
  }
}

// ---------------------------------------------------------------------------
// Step 2: RFQ + quotes (SQL: the RFQ wizard + vendor quote wizard need publish approvals, uploads, OTP-less
// vendor sessions; the helper tests/helpers/poRejectWorld.js stageRfq does the same)
// ---------------------------------------------------------------------------
async function stageRfq(t, { title, variants, vendors, unitPrice }) {
  const rfq = await t.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, department_id, process_id, is_tender, title)
     VALUES ((SELECT COALESCE(MAX(rfq_no), 8000000) + 1 FROM tbl_rfq), '<p>PO22 e2e</p>', '', 'creator@e2e.local', 'Rhea', '+91',
             $1, 'Mumbai', 1, 1, $2, $2, NOW(), $3, $4, $5, $6, 0, $7)
     RETURNING id, rfq_no`,
    [istString(-24 * 3600_000), CAST.creator.id, HC, HOTEL, DEPT, PROCESS, title]
  );
  const quotes = {};
  for (const v of vendors) {
    quotes[v] = (await t.one(
      `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status, "timestamp")
       VALUES ($1, $2, $3, $3, 1, NOW()) RETURNING id`,
      [rfq.id, rfq.rfq_no, CAST[v].id]
    )).id;
  }
  const products = [];
  for (const [i, variantId] of variants.entries()) {
    const p = await t.one(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0) RETURNING id, product_variant_id`,
      [rfq.id, variantId]
    );
    products.push({ id: Number(p.id), variant: variantId });
    for (const v of vendors) {
      await t.none(
        `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, 0)`,
        [rfq.id, variantId, CAST[v].id]
      );
      const price = unitPrice + (v === "vB" ? 10 : 0) + i * 5;
      await t.none(
        `INSERT INTO tbl_quote_items
           (rfq_id, rfq_no, quote_id, product_variant_id, unit_price, total_price, package_price, tax,
            freight_price, variant, comment, delivery_period, quantity, tax_mode, other_charges)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, '', '15', '50', 'absolute', '[]'::jsonb)`,
        [rfq.id, rfq.rfq_no, quotes[v], variantId, price, price * 50]
      );
    }
  }
  return { id: Number(rfq.id), rfq_no: Number(rfq.rfq_no), title, products, quotes };
}

// ---------------------------------------------------------------------------
// Step 3: award over HTTP (evaluator submits, award approver approves => vendor finalized + draft POs)
// ---------------------------------------------------------------------------
async function award(rfq, product, vendors) {
  await ok("submit award", "evaluator", "POST", "/negotiation/quotes/submit-for-approval", {
    rfq_id: rfq.id,
    rfq_product_id: product.id,
    quote_ids: vendors.map((v) => Number(rfq.quotes[v])),
    quote_source: "regular",
    remarks: "PO22 e2e award",
  });
  await ok("approve award", "awardApprover", "POST", `/negotiation/quotes/${product.id}/approve`, {});
}
const draftPos = (rfqId) =>
  db.any(
    `SELECT id, po_number, status, finalized_vendor_id AS vendor_id, approval_instance_id
       FROM tbl_rfq_purchase_order WHERE rfq_id = $1 ORDER BY id`,
    [rfqId]
  );
const initiate = (poId) => ok("initiate", "initiator", "POST", `/po/initiate/${poId}`, {});
const approve = (key, poId) => ok("approve", key, "POST", `/po/approve/${poId}`, { decision: "approved", remarks: "e2e ok" });
const poOf = (pos, vendorKey) => {
  const po = pos.find((p) => Number(p.vendor_id) === CAST[vendorKey].id);
  if (!po) throw new Error(`no PO for ${vendorKey} in ${JSON.stringify(pos)}`);
  return po;
};

// ---------------------------------------------------------------------------
// Step 4: call-off PO for V-A (SQL: the real path is MR submit -> MR approval policy -> handleMrPostApproval ->
// releaseForMr, which needs an MR policy + approver + PDF render. Rows mirror app/services/callOffPoService.js
// and tests/services/vendor.poOrdersReference.test.js.)
// ---------------------------------------------------------------------------
async function seedCallOff(t) {
  const vendorCompany = (await t.one(`SELECT company_id FROM tbl_users WHERE id = $1`, [CAST.vA.id])).company_id;
  const buyerCompany = (await t.one(`SELECT buyer_company_id FROM tbl_hospitality_companies WHERE id = $1`, [HC])).buyer_company_id;
  const category = (await t.one(
    `SELECT pc.category_id FROM tbl_product_categories pc JOIN tbl_product_variant pv ON pv.product_id = pc.product_id WHERE pv.id = 1 LIMIT 1`
  )).category_id;
  const arc = await t.one(
    `INSERT INTO tbl_arc
       (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id, process_id, status,
        submission_start_at, submission_end_at, contract_start_at, contract_end_at, created_by)
     VALUES ('ARC-PO22-0001', 'PO22 Beverage Rate Contract', $1, $2, $3, $4, $5, 'contract_active',
             NOW() - INTERVAL '30 days', NOW() - INTERVAL '20 days', NOW() - INTERVAL '10 days', NOW() + INTERVAL '180 days', $6)
     RETURNING id`,
    [category, HC, HOTEL, DEPT, PROCESS, CAST.creator.id]
  );
  const item = await t.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, 1, 1000, 'litre') RETURNING id`, [arc.id]);
  const contract = await t.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, $2, 'active') RETURNING id`, [arc.id, CAST.vA.id]);
  const line = await t.one(
    `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
     VALUES ($1, $2, 90, 5, 1000) RETURNING id`, [contract.id, item.id]);
  const mr = await t.one(
    `INSERT INTO tbl_material_requisition
       (mr_number, title, hospitality_company_id, hotel_id, department_id, urgency, raised_by, status, submitted_at)
     VALUES ('MR-PO22-0001', 'PO22 pool bar restock', $1, $2, $3, 'normal', $4, 'po_released', NOW()) RETURNING id`,
    [HC, HOTEL, DEPT, CAST.creator.id]);
  await t.none(
    `INSERT INTO tbl_material_requisition_item (mr_id, product_variant_id, quantity, uom, arc_contract_id, arc_contract_line_id, matched_unit_rate)
     VALUES ($1, 1, 100, 'litre', $2, $3, 90)`, [mr.id, contract.id, line.id]);
  const po = await t.one(
    `INSERT INTO tbl_rfq_purchase_order
       (rfq_id, project_id, company_id, po_number, status, rfq_product_id, quantity, unit_price, finalized_vendor_id,
        total_value, quote_id, initiated_by, created_at, updated_at, arc_contract_id, source_mr_id, is_call_off)
     VALUES (NULL, NULL, $1, 'CO-PO22-0001', 'acceptance_pending'::public.po_status, '{}'::integer[], 100, 90, $2,
             9450, '{}'::integer[], NULL, NOW(), NOW(), $3, $4, TRUE)
     RETURNING id, po_number`,
    [buyerCompany || HC, CAST.vA.id, contract.id, mr.id]);
  await t.none(
    `INSERT INTO tbl_purchase_order_product
       (purchase_order_id, rfq_product_id, quote_id, quantity, unit, unit_price, charges_meta, total_price, product_variant_id, arc_contract_line_id)
     VALUES ($1, NULL, NULL, 100, 'litre', 90, $2, 9450, 1, $3)`,
    [po.id, { tax: 5, tax_mode: "percentage", other_charges: [] }, line.id]);
  await t.none(
    `INSERT INTO tbl_arc_callof_po (po_id, mr_id, arc_contract_id, arc_contract_line_id, quantity, price_applied, released_at)
     VALUES ($1, $2, $3, $4, 100, 90, NOW())`, [po.id, mr.id, contract.id, line.id]);
  await t.none(`UPDATE tbl_arc_contract_line SET consumed_qty = 100 WHERE id = $1`, [line.id]);
  return { po_id: Number(po.id), po_number: po.po_number, arc_id: Number(arc.id), arc_number: "ARC-PO22-0001", contract_id: Number(contract.id), mr_id: Number(mr.id) };
}

// ---------------------------------------------------------------------------
async function main() {
  const where = await db.one(`SELECT current_database() AS db, host(inet_server_addr()) AS addr`);
  if (where.db !== conn.database) throw new Error(`connected to '${where.db}', expected '${conn.database}'`);
  if (!["127.0.0.1", "::1"].includes(where.addr)) throw new Error(`server address '${where.addr}' is not loopback`);

  const existing = await db.one(`SELECT count(*)::int AS n FROM tbl_rfq WHERE title LIKE '[PO22]%'`);
  if (existing.n > 0) {
    throw new Error(
      `the PO22 world already exists in ${conn.database} (${existing.n} RFQs). This seed is not re-runnable. ` +
      `Rebuild: E2E_RUN_ID=e2e_po22 node scripts/vendor_networks/e2e_prepare_db.mjs, then re-run this seed.`
    );
  }

  await db.tx(seedPeople);
  for (const k of Object.keys(CAST)) await login(k);

  const W = {};
  const VARIANTS = [1, 2, 3, 4];

  // RFQ A: one product, fully awarded to V-A, DRAFT PO left uninitiated.
  W.A = await db.tx((t) => stageRfq(t, { title: "[PO22] RFQ A - full award, draft PO", variants: [VARIANTS[0]], vendors: ["vA"], unitPrice: 500 }));
  await award(W.A, W.A.products[0], ["vA"]);
  W.A.pos = await draftPos(W.A.id);

  // RFQ B: three products quoted by both vendors; product 1 -> V-A, product 2 -> V-B (two drafts on the SAME RFQ,
  // so "Next draft" has somewhere to go), product 3 not awarded (partial award). Both drafts stay uninitiated.
  W.B = await db.tx((t) => stageRfq(t, { title: "[PO22] RFQ B - partial award, 2 draft POs", variants: [1, 2, 3], vendors: ["vA", "vB"], unitPrice: 400 }));
  await award(W.B, W.B.products[0], ["vA"]);
  await award(W.B, W.B.products[1], ["vB"]);
  W.B.pos = await draftPos(W.B.id);

  // RFQ C and D: split BY PRODUCT, as prod does: product 1 -> V-A, product 2 -> V-B, each its own award submit +
  // approve (sequential). Initiate both; approve step 1 of V-A's PO as P1.
  for (const [k, title, v0] of [["C", "[PO22] RFQ C - split, ask-for-information script", 1], ["D", "[PO22] RFQ D - split, reject/re-negotiate script", 5]]) {
    W[k] = await db.tx((t) => stageRfq(t, { title, variants: [v0, v0 + 1], vendors: ["vA", "vB"], unitPrice: 600 }));
    await award(W[k], W[k].products[0], ["vA"]);
    await award(W[k], W[k].products[1], ["vB"]);
    const drafts = await draftPos(W[k].id);
    for (const p of drafts) await initiate(p.id);
    await approve("p1", poOf(drafts, "vA").id);
    W[k].pos = await draftPos(W[k].id);
  }

  // RFQ E (extra, for the T2 accept dialog): V-A only, taken through all 3 steps so the PO waits for the
  // vendor to accept. The call-off below is also acceptance_pending, but only an RFQ PO names an RFQ.
  W.E = await db.tx((t) => stageRfq(t, { title: "[PO22] RFQ E - approved, awaiting vendor acceptance", variants: [VARIANTS[3]], vendors: ["vA"], unitPrice: 300 }));
  await award(W.E, W.E.products[0], ["vA"]);
  const eDrafts = await draftPos(W.E.id);
  await initiate(eDrafts[0].id);
  await approve("p1", eDrafts[0].id);
  await approve("p2a", eDrafts[0].id);
  await approve("p3", eDrafts[0].id);
  W.E.pos = await draftPos(W.E.id);

  const callOff = await db.tx(seedCallOff);

  // ---- every PO number must be distinct ----
  const allPos = await db.any(`SELECT id, po_number FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`,
    [[...["A", "B", "C", "D", "E"].flatMap((k) => W[k].pos.map((p) => p.id)), callOff.po_id]]);
  const dup = allPos.filter((p, i) => allPos.findIndex((q) => q.po_number === p.po_number) !== i);
  if (dup.length) throw new Error(`DUPLICATE PO NUMBERS: ${JSON.stringify(allPos)}`);

  // ---- confirm states ----
  const insts = {};
  for (const k of ["C", "D"]) {
    for (const vk of ["vA", "vB"]) {
      const po = poOf(W[k].pos, vk);
      insts[`${k}-${vk}`] = await db.one(
        `SELECT po.status, i.status AS inst, i.current_step FROM tbl_rfq_purchase_order po
           JOIN tbl_approval_instances i ON i.id = po.approval_instance_id WHERE po.id = $1`, [po.id]);
    }
  }

  const line = (k, v) => console.log(`  ${k.padEnd(30)} ${v}`);
  console.log(`\nPO22 E2E world seeded into ${conn.database}; API ${API}\n`);
  console.log(`LOGINS (password for all: ${PASSWORD})   POST /users/login?conform=true`);
  for (const [k, u] of Object.entries(CAST)) {
    const who = u.kind === "buyer" ? `employee_code=${u.code}` : `email=${u.email}`;
    console.log(`  ${k.padEnd(14)} ${who.padEnd(28)} user ${u.id}  ${u.name} -- ${u.note}`);
  }
  console.log("\nCOMPANY / HOTEL");
  line("hospitality company / hotel", `${HC} / ${HOTEL}   dept ${DEPT}   process ${PROCESS}   PO policy ${PO_POLICY} (3 steps)`);
  console.log("\nRFQs (id, rfq_no) and POs (id, po_number, status)");
  const dump = (k) => {
    line(`RFQ ${k}`, `id ${W[k].id}  rfq_no ${W[k].rfq_no}  ${W[k].title}`);
    for (const p of W[k].pos) {
      const vk = Number(p.vendor_id) === CAST.vA.id ? "V-A" : "V-B";
      line(`  PO (${vk})`, `id ${p.id}  ${p.po_number}  ${p.status}`);
    }
  };
  ["A", "B", "C", "D", "E"].forEach(dump);
  line("call-off PO (V-A)", `id ${callOff.po_id}  ${callOff.po_number}  acceptance_pending  ARC ${callOff.arc_number} (id ${callOff.arc_id}, contract ${callOff.contract_id})  MR id ${callOff.mr_id}`);
  console.log("\nAPPROVAL STATE (C/D)");
  for (const [k, v] of Object.entries(insts)) line(k, `po=${v.status} instance=${v.inst} current_step=${v.current_step}`);

  const rfqUrl = (k, stage = "purchase-order") => `${FE}/dashboard/buyer/rfq-management-details?id=${W[k].id}&stage=${stage}`;
  console.log("\nSTART URLS (frontend)");
  line("T1 initiator, RFQ B", rfqUrl("B"));
  line("T1 initiator, RFQ A (extra)", rfqUrl("A"));
  line("T1 no-permission, RFQ B", `${rfqUrl("B")}   (log in as creator)`);
  line("T3 hold, P2a opens PO", `${FE}/dashboard/buyer/purchase-orders/${poOf(W.C.pos, "vA").id}`);
  line("T3 hold, RFQ C", rfqUrl("C"));
  line("T3 reject, P2a opens PO", `${FE}/dashboard/buyer/purchase-orders/${poOf(W.D.pos, "vA").id}`);
  line("T3 reject, RFQ D", rfqUrl("D"));
  line("T3 re-finalize (round create)", `${FE}/dashboard/buyer/negotiation/${W.D.id}/create`);
  line("T2 vendor V-A Orders", `${FE}/dashboard/vendor/purchase-orders/orders   search: #${W.C.rfq_no}`);
  line("T2 accept dialog (RFQ E)", `${FE}/dashboard/vendor/purchase-orders/${poOf(W.E.pos, "vA").id}`);
  line("T2 call-off detail", `${FE}/dashboard/vendor/purchase-orders/${callOff.po_id}`);
  console.log("\nMail sink: $E2E_MAIL_DIR   S3 sink: $E2E_AWS_SINK_DIR (see runbook)\n");
}

main()
  .catch((err) => {
    console.error(`SEED FAILED: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pgp.end());
