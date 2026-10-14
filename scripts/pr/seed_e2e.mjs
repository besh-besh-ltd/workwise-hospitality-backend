// Purchase Requisitions: LOCAL end-to-end seed (Task 19a).
//
// Seeds the PR world into a LOCAL database built by
//   E2E_RUN_ID=e2e_pr node scripts/vendor_networks/e2e_prepare_db.mjs
// (schema + reference seed + pendingMigrations incl. the PR migrations + the test
// fixtures: company A = hospitality 10001, hotel A1 = 10101, departments 10201..10204).
//
//   node scripts/pr/seed_e2e.mjs                                   (hospitality_test_e2e_pr @ 127.0.0.1)
//   node scripts/pr/seed_e2e.mjs --db=hospitality_test_e2e_pr --host=127.0.0.1
//
// SAFETY. Never reads .env (which points at the shared stage database). Connection
// settings come from --db/--host or E2E_DB_* env vars only. Refuses unless the
// database name matches ^hospitality_test_ (and never prod/stage/main), the host is
// localhost / 127.0.0.1 / ::1, AND the server answers on loopback.
//
// IDEMPOTENT. Every row it owns is in the id range 96001..96199 (users) or is
// hung off one of those users / the seeded role, policy and ARC. A re-run first
// deletes that world, including what an E2E run created on top of it (PRs raised
// by the personas, their approval instances, RFQ drafts made by the buyers, catalog
// requests, notifications), then seeds it again.
//
// The world (company A / hotel A1 / departments Engineering, Housekeeping, Procurement):
//   see the persona table printed at the end (also in task-19a-report.md).

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
  database: arg("db") || process.env.E2E_DB_NAME || "hospitality_test_e2e_pr",
  host: arg("host") || process.env.E2E_DB_HOST || "127.0.0.1",
  port: Number(arg("port") || process.env.E2E_DB_PORT || 5432),
  user: arg("user") || process.env.E2E_DB_USER || os.userInfo().username,
  password: process.env.E2E_DB_PASSWORD || undefined,
  ssl: false,
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_DB = /^hospitality_test_/;
const NEVER_DB = /prod|stage|staging|main/i;
const PR_DB = /_pr$/;

if (!LOCAL_DB.test(conn.database) || NEVER_DB.test(conn.database)) {
  console.error(`ABORT: '${conn.database}' does not look like a local database (need /^hospitality_test_/).`);
  process.exit(2);
}
// This seed WIPES the persona world it owns. Only a PR e2e database may take it:
// never hospitality_test_e2e (the Vendor Networks stack of another session) nor
// a jest test database.
if (!PR_DB.test(conn.database)) {
  console.error(`ABORT: '${conn.database}' is not a PR e2e database (the name must end in _pr, e.g. hospitality_test_e2e_pr).`);
  process.exit(2);
}
if (!LOCAL_HOSTS.has(conn.host)) {
  console.error(`ABORT: host '${conn.host}' is not local (localhost / 127.0.0.1 / ::1).`);
  process.exit(2);
}

const pgp = pgPromise();
pgp.pg.types.setTypeParser(1114, (s) => s);
const db = pgp(conn);

// ---------------------------------------------------------------------------
// Fixture ids (from tests/fixtures/ids.js + seed_reference.sql) and our own range
// ---------------------------------------------------------------------------
const PASSWORD = "PrE2e@12345";
const COMPANY = 10001; // hospitality company A
const BUYER_COMPANY = 90001; // tbl_company of company A
const HOTEL = 10101; // A1
const DEPT = { proc: 10201, eng: 10202, fb: 10203, hk: 10204 };
const CAT_KITCHEN = 284; // KITCHEN EQUIPMENTS (child of KST 235)
const CAT_KST = 235; // KST: the category the catalog actually files the kitchen variants under (lowest category id of their product)
const ROLE = { companyAdmin: "Company Administrator", requester: "PR Requester", reviewer: "PR Technical Reviewer", approver: "PR Approver", buyer: "PR Buyer" };
const RFQ_CREATOR_ROLE = "RFQ Creator";
const HOD_ROLE_TITLE = "HOD (PR E2E)";
const FIXTURE_ADMIN = 80001; // fixture Super Admin: created_by for the policy/routing rows

const ID = Object.freeze({
  platformAdmin: 96001,
  req_hk: 96011,
  req_eng: 96012,
  rv_eng: 96013,
  hod_hk: 96014,
  hod_eng: 96015,
  fc: 96016,
  gm: 96017,
  buy1: 96018,
  buy2: 96019,
  company_admin: 96020,
  vendorA: 96101,
  vendorB: 96102,
});
const RANGE = [96001, 96199];

// Catalog (KITCHEN EQUIPMENTS): usable variants + the one that goes on contract.
const VARIANTS = { teaMaker: 1445, grinder: 1446, foodWarmer: 1449, onContract: 1452 };

const PERSONAS = [
  // key, id, name, email, employee_code, designation, departments for tbl_user_department
  ["REQ_HK", ID.req_hk, "Hema Requester (HK)", "pr.req.hk@example.com", "PRREQHK", "Housekeeping Supervisor", [DEPT.hk]],
  ["REQ_ENG", ID.req_eng, "Ravi Requester (Eng)", "pr.req.eng@example.com", "PRREQENG", "Engineering Executive", [DEPT.eng]],
  ["RV_ENG", ID.rv_eng, "Rohit Reviewer (Eng)", "pr.rv.eng@example.com", "PRRVENG", "Chief Engineer", [DEPT.eng]],
  ["HOD_HK", ID.hod_hk, "Hari HOD (HK)", "pr.hod.hk@example.com", "PRHODHK", "Executive Housekeeper", [DEPT.hk]],
  ["HOD_ENG", ID.hod_eng, "Hira HOD (Eng)", "pr.hod.eng@example.com", "PRHODENG", "Engineering Manager", [DEPT.eng]],
  ["FC", ID.fc, "Farah Finance Controller", "pr.fc@example.com", "PRFC", "Financial Controller", []],
  ["GM", ID.gm, "Gopal General Manager", "pr.gm@example.com", "PRGM", "General Manager", []],
  ["BUY1", ID.buy1, "Bina Buyer One", "pr.buy1@example.com", "PRBUY1", "Purchase Executive", [DEPT.proc]],
  ["BUY2", ID.buy2, "Bhanu Buyer Two", "pr.buy2@example.com", "PRBUY2", "Purchase Executive", [DEPT.proc]],
  ["COMPANY_ADMIN", ID.company_admin, "Chitra Company Admin", "pr.admin@example.com", "PRCADMIN", "Company Administrator", []],
];

// ---------------------------------------------------------------------------
// Cleanup: the whole world, including what an E2E run created on top of it.
// ---------------------------------------------------------------------------
async function tablesWithColumn(t, column) {
  return t.map(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = $1`, [column], (r) => r.table_name);
}

async function cleanup(t) {
  const [lo, hi] = RANGE;
  const userIds = (await t.any(`SELECT id FROM tbl_users WHERE id BETWEEN $1 AND $2`, [lo, hi])).map((r) => Number(r.id));
  const hodRoleIds = (await t.any(`SELECT id FROM tbl_roles WHERE title = $1`, [HOD_ROLE_TITLE])).map((r) => Number(r.id));

  // PRs raised by the personas (lines, events, reviews, clauses, attachments, comments, catalog requests cascade).
  const prIds = (await t.any(`SELECT id FROM tbl_purchase_requisition WHERE raised_by = ANY($1::int[])`, [userIds])).map((r) => Number(r.id));
  const rfqIds = new Set((await t.any(`SELECT id FROM tbl_rfq WHERE created_by = ANY($1::int[])`, [userIds])).map((r) => Number(r.id)));
  if (prIds.length) {
    for (const r of await t.any(
      `SELECT DISTINCT lr.rfq_id FROM tbl_pr_line_rfq lr JOIN tbl_purchase_requisition_line l ON l.id = lr.pr_line_id WHERE l.pr_id = ANY($1::int[])`, [prIds])) {
      rfqIds.add(Number(r.rfq_id));
    }
  }
  const rfqList = [...rfqIds];

  const instanceIds = (await t.any(
    `SELECT id FROM tbl_approval_instances WHERE (entity_type = 'PR' AND entity_id = ANY($1::int[])) OR initiated_by = ANY($2::int[])`,
    [prIds, userIds])).map((r) => Number(r.id));
  const policyIds = (await t.any(`SELECT id FROM tbl_approval_policies WHERE entity_type = 'PR' AND hospitality_company_id = $1 AND created_by = $2`, [COMPANY, FIXTURE_ADMIN])).map((r) => Number(r.id));
  const policyInst = policyIds.length
    ? (await t.any(`SELECT id FROM tbl_approval_instances WHERE approval_policy_id = ANY($1::int[])`, [policyIds])).map((r) => Number(r.id)) : [];
  const allInst = [...new Set([...instanceIds, ...policyInst])];

  // Lines of PRs may link to RFQ products: unlink first.
  if (prIds.length) {
    await t.none(`DELETE FROM tbl_pr_line_rfq WHERE pr_line_id IN (SELECT id FROM tbl_purchase_requisition_line WHERE pr_id = ANY($1::int[]))`, [prIds]);
  }
  if (rfqList.length) {
    // RFQ drafts made by POST /pr/convert (and anything hanging off them): FK-less children first, then the rest.
    const rfqCols = await tablesWithColumn(t, "rfq_id");
    for (const table of rfqCols) {
      if (["tbl_rfq", "tbl_pr_line_rfq"].includes(table)) continue;
      await t.none(`DELETE FROM ${table} WHERE rfq_id = ANY($1::int[])`, [rfqList]);
    }
    await t.none(`DELETE FROM tbl_rfq_product_tech_evaluation_clauses WHERE tbl_rfq_product_tech_evaluation_id IN (SELECT id FROM tbl_rfq_product_tech_evaluation WHERE rfq_id = ANY($1::int[]))`, [rfqList]).catch(() => {});
    // A draft the browser pass submitted also has RFQ lifecycle rows (entity_id, not rfq_id).
    await t.none(`DELETE FROM tbl_lifecycle_history WHERE entity_type = 'RFQ' AND entity_id = ANY($1::int[])`, [rfqList]);
    await t.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqList]);
  }
  if (allInst.length) {
    await t.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [allInst]);
    await t.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
         (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [allInst]);
    await t.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [allInst]);
    await t.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [allInst]);
  }
  if (prIds.length) await t.none(`DELETE FROM tbl_purchase_requisition WHERE id = ANY($1::int[])`, [prIds]);

  // Policies, review routing.
  if (policyIds.length) {
    await t.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [policyIds]);
    await t.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [policyIds]);
  }
  await t.none(`DELETE FROM tbl_pr_review_category_map WHERE hospitality_company_id = $1 AND created_by = $2`, [COMPANY, FIXTURE_ADMIN]);

  // ARC (the seeded contract at A1 x HK) and the vendors' catalogue wiring.
  const arcIds = (await t.any(`SELECT id FROM tbl_arc WHERE arc_number = 'ARC-E2E-PR-0001'`)).map((r) => Number(r.id));
  if (arcIds.length) {
    await t.none(`DELETE FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[])`, [arcIds]); // lines cascade
    await t.none(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [arcIds]); // items cascade
  }
  await t.none(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = ANY($1::int[])`, [userIds]);
  await t.none(`DELETE FROM tbl_product_variant_vendor_mapping WHERE vendor_id = ANY($1::int[])`, [userIds]);

  // Users and everything keyed on them.
  await t.none(`DELETE FROM tbl_notifications WHERE recipient_user_id = ANY($1::int[]) OR sender_user_id = ANY($1::int[])`, [userIds]);
  await t.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [userIds]);
  await t.none(`DELETE FROM tbl_user_department WHERE user_id = ANY($1::int[])`, [userIds]);
  await t.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [userIds]);
  if (hodRoleIds.length) {
    await t.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = ANY($1::int[])`, [hodRoleIds]);
    await t.none(`DELETE FROM tbl_role_permissions WHERE role_id = ANY($1::int[])`, [hodRoleIds]);
    await t.none(`DELETE FROM tbl_roles WHERE id = ANY($1::int[])`, [hodRoleIds]);
  }
  // Remaining FK-by-user rows an E2E run can create: clear any nullable/audit-ish reference tables we know of.
  // The RFQ wizard auto-creates an "Auto Project - Hotel N" for the buyer; any other lifecycle row they performed.
  await t.none(`DELETE FROM tbl_lifecycle_history WHERE performed_by = ANY($1::int[])`, [userIds]);
  const projectIds = (await t.any(`SELECT id FROM tbl_projects WHERE user_id = ANY($1::int[])`, [userIds])).map((r) => Number(r.id));
  if (projectIds.length) {
    for (const table of ["tbl_project_team", "tbl_project_files", "tbl_hospitality_project_mappings"]) {
      await t.none(`DELETE FROM ${table} WHERE project_id = ANY($1::int[])`, [projectIds]);
    }
    await t.none(`DELETE FROM tbl_projects WHERE id = ANY($1::int[])`, [projectIds]);
  }
  await t.none(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [userIds]);
  await t.none(`DELETE FROM tbl_company WHERE id = ANY($1::int[])`, [[ID.vendorA, ID.vendorB]]);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
const roleId = async (t, title) => Number((await t.one(`SELECT id FROM tbl_roles WHERE title = $1 AND created_by IS NULL`, [title])).id);

async function grant(t, userId, role, { hotel = HOTEL, dept = null } = {}) {
  await t.none(
    `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
     VALUES ($1, $2, $3, $4, $5, NULL)`,
    [userId, role, COMPANY, hotel, dept]);
}

async function seedUsers(t, hash) {
  await t.none(
    `INSERT INTO tbl_users (id, name, email, mobile, user_type, status, is_deleted, password, employee_code, designation)
     VALUES ($1, 'PR Platform Admin (E2E)', 'pr.platform.admin@example.com', '9000096001', 1, 1, 0, $2, NULL, 'Workwise Admin')`,
    [ID.platformAdmin, hash]);
  for (const [, id, name, email, code, designation, depts] of PERSONAS) {
    await t.none(
      `INSERT INTO tbl_users (id, name, email, mobile, user_type, status, is_deleted, company_id, employee_code, designation, password)
       VALUES ($1, $2, $3, $4, 2, 1, 0, $5, $6, $7, $8)`,
      [id, name, email, `90000${id}`, BUYER_COMPANY, code, designation, hash]);
    await t.none(
      `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
       VALUES ($1, $2, NULL, 0, $3), ($1, $2, $4, 1, $3)`,
      [id, COMPANY, FIXTURE_ADMIN, HOTEL]);
    for (const d of depts) await t.none(`INSERT INTO tbl_user_department (user_id, department_id) VALUES ($1, $2)`, [id, d]);
  }
}

async function seedRoles(t) {
  const r = {
    requester: await roleId(t, ROLE.requester), reviewer: await roleId(t, ROLE.reviewer), approver: await roleId(t, ROLE.approver),
    buyer: await roleId(t, ROLE.buyer), companyAdmin: await roleId(t, ROLE.companyAdmin), rfqCreator: await roleId(t, RFQ_CREATOR_ROLE),
  };
  // A custom role belongs to the company that made it: rbac getRoles lists a
  // role to users of its creator's company only. Owned by the fixture Super
  // Admin (no company) the company admin could not see it, so the PR approval
  // flow wizard showed level 1 as "Unknown Role" (browser pass 19b).
  const hod = await t.one(
    `INSERT INTO tbl_roles (title, description, created_by) VALUES ($1, 'Head of department: PR read + approve (custom role)', $2) RETURNING id`,
    [HOD_ROLE_TITLE, ID.company_admin]);
  r.hod = Number(hod.id);
  await t.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id)
     SELECT $1, id FROM tbl_permissions WHERE resource::text = 'pr' AND action::text IN ('read', 'approve')`, [r.hod]);

  await grant(t, ID.req_hk, r.requester, { dept: DEPT.hk });
  await grant(t, ID.req_eng, r.requester, { dept: DEPT.eng });
  await grant(t, ID.req_eng, r.reviewer, { dept: DEPT.eng });
  await grant(t, ID.rv_eng, r.reviewer, { dept: DEPT.eng });
  await grant(t, ID.hod_hk, r.hod, { dept: DEPT.hk });
  await grant(t, ID.hod_eng, r.hod, { dept: DEPT.eng });
  await grant(t, ID.fc, r.approver, { dept: null });
  await grant(t, ID.gm, r.approver, { dept: null });
  for (const b of [ID.buy1, ID.buy2]) {
    await grant(t, b, r.buyer, { dept: null });
    await grant(t, b, r.rfqCreator, { dept: DEPT.proc }); // convert needs rfq.create at the RFQ's department
  }
  await grant(t, ID.company_admin, r.companyAdmin, { hotel: null, dept: null });
  return r;
}

async function seedPolicy(t, roles) {
  const p = await t.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by, process_id, is_master, is_department_scoped, version)
     VALUES ('PR', $1, $2, NULL, true, $3, NULL, false, false, 1) RETURNING id`,
    [COMPANY, HOTEL, FIXTURE_ADMIN]);
  const steps = [
    [1, "ROLE", roles.hod, null],
    [2, "USER", ID.fc, null],
    [3, "USER", ID.gm, "100000.00"],
  ];
  for (const [order, type, src, min] of steps) {
    await t.none(
      `INSERT INTO tbl_approval_policy_steps (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id, min_amount)
       VALUES ($1, $2, 'ANY', $3, $4, $5)`, [p.id, order, type, src, min]);
  }
  return Number(p.id);
}

async function seedVendors(t, hash) {
  const vendors = [
    [ID.vendorA, "Kitchenworks Supplies (PR E2E)", "pr.vendor.a@example.com", "27AAPCK1111A1ZA"],
    [ID.vendorB, "Gastro Equip Traders (PR E2E)", "pr.vendor.b@example.com", "27AAPCG2222B1ZB"],
  ];
  for (const [id, name, email, gstin] of vendors) {
    await t.none(`INSERT INTO tbl_company (id, company_name, gstin, location, "createdAt") VALUES ($1, $2, $3, 'Mumbai', now())`, [id, name, gstin]);
    await t.none(
      `INSERT INTO tbl_users (id, name, email, mobile, user_type, status, is_deleted, company_id, password)
       VALUES ($1, $2, $3, $4, 3, 1, 0, $1, $5)`, [id, name, email, `90000${id}`, hash]);
    for (const [type, item] of [["category", CAT_KITCHEN], ["hotel", HOTEL]]) {
      await t.none(
        `INSERT INTO tbl_vendor_hotel_category_subscription (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
         VALUES ($1, $2, $3, 0, CURRENT_DATE - 30, CURRENT_DATE + 335, 'active')`, [id, type, item]);
    }
  }
  // Vendor A supplies all four; Vendor B only tea maker + grinder.
  const map = [[ID.vendorA, Object.values(VARIANTS)], [ID.vendorB, [VARIANTS.teaMaker, VARIANTS.grinder]]];
  for (const [vendor, variants] of map) {
    for (const v of variants) {
      await t.none(
        `INSERT INTO tbl_product_variant_vendor_mapping (product_variant_id, vendor_id, status, is_approved, approved_at, created_at, updated_at)
         VALUES ($1, $2, true, true, now(), now(), now())`, [v, vendor]);
    }
  }
}

async function seedArc(t) {
  const arc = await t.one(
    `INSERT INTO tbl_arc (arc_number, title, description, category_id, hospitality_company_id, hotel_id, department_id,
                          status, is_group, submission_start_at, submission_end_at, contract_start_at, contract_end_at,
                          payment_terms_expected, delivery_expected, created_by)
     VALUES ('ARC-E2E-PR-0001', '[E2E-PR] Gas lighters annual rate contract (A1 x Housekeeping)', 'Seeded to demo the PR -> MR redirect.',
             $1, $2, $3, $4, 'contract_active', false,
             NOW() - INTERVAL '40 days', NOW() - INTERVAL '30 days', NOW() - INTERVAL '10 days', NOW() + INTERVAL '355 days',
             '30 days from invoice', 'Within 7 days of call-off', $5)
     RETURNING id`,
    [CAT_KITCHEN, COMPANY, HOTEL, DEPT.hk, ID.buy1]);
  const item = await t.one(
    `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 500, 'NOS') RETURNING id`, [arc.id, VARIANTS.onContract]);
  const contract = await t.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, generated_at, signed_by_vendor_at)
     VALUES ($1, $2, 'active', NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days') RETURNING id`, [arc.id, ID.vendorA]);
  await t.none(
    `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty, payment_terms, delivery_terms)
     VALUES ($1, $2, 85.00, 18, 500, '30 days from invoice', 'Within 7 days of call-off')`, [contract.id, item.id]);
  return { arc_id: Number(arc.id), contract_id: Number(contract.id) };
}

async function main() {
  const where = await db.one(`SELECT current_database() AS db, host(inet_server_addr()) AS addr`);
  if (where.db !== conn.database) throw new Error(`connected to '${where.db}', expected '${conn.database}'`);
  if (!["127.0.0.1", "::1"].includes(where.addr)) throw new Error(`server address is '${where.addr}', not loopback: refusing to seed`);

  // Reference data this seed relies on (from the test fixtures + seed_reference.sql).
  const need = await db.one(
    `SELECT (SELECT count(*) FROM tbl_hospitality_company_hotels WHERE id = $1) AS hotel,
            (SELECT count(*) FROM tbl_department WHERE id = ANY($2::int[])) AS depts,
            (SELECT count(*) FROM tbl_product_variant WHERE id = ANY($3::int[])) AS variants,
            (SELECT count(*) FROM tbl_users WHERE id = $4) AS fixture_admin`,
    [HOTEL, Object.values(DEPT), Object.values(VARIANTS), FIXTURE_ADMIN]);
  if (Number(need.hotel) !== 1 || Number(need.depts) !== 4 || Number(need.variants) !== 4 || Number(need.fixture_admin) !== 1) {
    throw new Error(`database was not prepared with scripts/vendor_networks/e2e_prepare_db.mjs (fixtures missing: ${JSON.stringify(need)})`);
  }

  const hash = bcrypt.hashSync(PASSWORD, 10);
  const out = await db.tx(async (t) => {
    await cleanup(t);
    await seedUsers(t, hash);
    const roles = await seedRoles(t);
    const policyId = await seedPolicy(t, roles);
    await seedVendors(t, hash);
    // Catalog lines are filed under the product's FIRST category (KST 235 for every kitchen variant),
    // free-text lines under the category the requester picks (KITCHEN EQUIPMENTS 284): route both to Engineering.
    const map = await t.any(
      `INSERT INTO tbl_pr_review_category_map (hospitality_company_id, category_id, department_id, created_by)
       VALUES ($1, $2, $3, $4), ($1, $5, $3, $4) RETURNING id`, [COMPANY, CAT_KITCHEN, DEPT.eng, FIXTURE_ADMIN, CAT_KST]);
    const arc = await seedArc(t);
    return { roles, policyId, mapIds: map.map((m) => Number(m.id)), arc };
  });

  // Make the planner see the catalog (the test DB is never ANALYZEd; first PR search can crawl otherwise).
  await db.none(`ANALYZE tbl_product, tbl_product_variant, tbl_product_categories, tbl_category`);

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nPR E2E world seeded into ${conn.database} @ ${conn.host}:${conn.port}\n`);
  console.log(`BUYER APP LOGIN  POST /api/v1/users/login?conform=true  {"employee_code": "<code>", "password": "${PASSWORD}"}`);
  console.log(`${pad("persona", 14)}${pad("user", 7)}${pad("employee_code", 11)}${pad("email", 26)}roles @ A1`);
  const rolesOf = {
    REQ_HK: "PR Requester @ Housekeeping", REQ_ENG: "PR Requester + PR Technical Reviewer @ Engineering",
    RV_ENG: "PR Technical Reviewer @ Engineering", HOD_HK: `${HOD_ROLE_TITLE} (pr.read+pr.approve) @ Housekeeping`,
    HOD_ENG: `${HOD_ROLE_TITLE} @ Engineering`, FC: "PR Approver, hotel-wide", GM: "PR Approver, hotel-wide",
    BUY1: "PR Buyer (hotel-wide) + RFQ Creator @ Procurement", BUY2: "PR Buyer (hotel-wide) + RFQ Creator @ Procurement",
    COMPANY_ADMIN: "Company Administrator (company-wide)",
  };
  for (const [key, id, , email, code] of PERSONAS) console.log(`${pad(key, 14)}${pad(id, 7)}${pad(code, 11)}${pad(email, 26)}${rolesOf[key]}`);
  console.log(`\nADMIN PANEL LOGIN  POST /api/v1/admin/auth/login  {"username": "pr.platform.admin@example.com", "password": "${PASSWORD}"}  (user ${ID.platformAdmin}, user_type 1)`);
  console.log(`VENDORS (user_type 3)  pr.vendor.a@example.com (${ID.vendorA}) all four variants, pr.vendor.b@example.com (${ID.vendorB}) tea maker + grinder`);
  console.log("\nIDS");
  console.log(`  hospitality company ${COMPANY}   hotel A1 ${HOTEL}   departments: Procurement ${DEPT.proc}, Engineering ${DEPT.eng}, F&B ${DEPT.fb}, Housekeeping ${DEPT.hk}`);
  console.log(`  review routing -> Engineering: category KITCHEN EQUIPMENTS ${CAT_KITCHEN} (free-text lines) and its parent KST ${CAT_KST} (where the catalog files the 4 kitchen variants)`);
  console.log(`  variants (usable, eligible vendors): TEA MAKER ${VARIANTS.teaMaker}, GRINDER ${VARIANTS.grinder}, FOOD WARMER LAMP ${VARIANTS.foodWarmer}`);
  console.log(`  variant ON CONTRACT at (A1, Housekeeping): GAS LIGHTER 12" ${VARIANTS.onContract}  (ARC ${out.arc.arc_id} ARC-E2E-PR-0001, contract ${out.arc.contract_id}) -> PR refuses, raise an MR`);
  console.log(`  PR approval policy ${out.policyId}: 1 ROLE ${out.roles.hod} (${HOD_ROLE_TITLE}) -> 2 USER FC ${ID.fc} -> 3 USER GM ${ID.gm} (only from Rs 1,00,000)`);
  console.log("  NOTE: HOD_HK only approves Housekeeping PRs, HOD_ENG only Engineering ones (the role is scoped per department).");
}

main()
  .then(() => pgp.end())
  .catch((err) => {
    console.error(err);
    pgp.end();
    process.exit(1);
  });
