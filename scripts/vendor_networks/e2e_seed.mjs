// Vendor Networks: LOCAL end-to-end seed (Task 17).
//
// Seeds the world the Vendor Networks E2E scenarios run against, into a LOCAL
// database built by scripts/vendor_networks/e2e_prepare_db.mjs. See
// docs/vendor-networks/E2E_RUNBOOK.md.
//
//   node scripts/vendor_networks/e2e_seed.mjs                      (hospitality_test_e2e @ 127.0.0.1)
//   node scripts/vendor_networks/e2e_seed.mjs --db=hospitality_test_e2e --host=127.0.0.1
//
// SAFETY. This script never reads .env (which points at the shared stage
// database). Connection settings come from --db/--host or E2E_DB_* env vars
// only, and it refuses unless the database name looks local
// (/^hospitality_test_|local|dev/, and never prod/stage/main) AND the host is
// localhost / 127.0.0.1 / ::1.
//
// IDEMPOTENT. Every row it writes is in the id range 95801..95899 (the Vendor
// Networks fixture range is 95001..95999), or hangs off one of those rows. A
// re-run first deletes that whole world, including what the E2E run itself
// created on top of it (quotes, assignments, POs, MRs, call-offs,
// notifications ...), then seeds it again.
//
// The world:
//   buyer company + hospitality company + 3 hotels: Mumbai (MH, 27), Lucknow (UP, 09), Panaji (Goa, 30)
//   buyer login (employee code) with RFQ/PO/MR/ARC roles on all 3 hotels, and company-wide
//     one-step policies (RFQ, TECHNICAL, NEGOTIATION, NEGOTIATION_QUOTE, PO, MR) naming the buyer
//   Daikin HQ   principal vendor (MH GSTIN), category + hotel subscriptions, variant mappings
//   Daikin UP   BRANCH entity (UP GSTIN), ACTIVE in Daikin HQ's org, active seat, no password
//   person      type-11 ENTITY_MEMBER of Daikin UP, with a password
//   Daikin Goa  stand-alone vendor (Goa GSTIN, own password, in no network): for the link-invite flow
//   a published RFQ at the UP hotel, invited to Daikin HQ, bids open for 4 more days
//   a Group ARC (MH + UP), its Daikin HQ contract awaiting acceptance, with per-hotel lines

import os from "os";
import bcrypt from "bcryptjs";
import pgPromise from "pg-promise";
import { makeRFQ } from "../../tests/factories/rfq.js";

// ---------------------------------------------------------------------------
// Connection + guard
// ---------------------------------------------------------------------------

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const conn = {
  database: arg("db") || process.env.E2E_DB_NAME || "hospitality_test_e2e",
  host: arg("host") || process.env.E2E_DB_HOST || "127.0.0.1",
  port: Number(arg("port") || process.env.E2E_DB_PORT || 5432),
  user: arg("user") || process.env.E2E_DB_USER || os.userInfo().username,
  password: process.env.E2E_DB_PASSWORD || undefined,
  ssl: false,
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const LOCAL_DB = /^hospitality_test_|local|dev/;
const NEVER_DB = /prod|stage|staging|main/i;

if (!LOCAL_DB.test(conn.database) || NEVER_DB.test(conn.database)) {
  console.error(`ABORT: '${conn.database}' does not look like a local database (need /^hospitality_test_|local|dev/).`);
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
// The world's ids. Range 95801..95899.
// ---------------------------------------------------------------------------

const RANGE = [95801, 95899];
const PASSWORD = "E2e@12345";
// Logins an E2E run creates through the API with this email shape are cleaned up with the seed.
const SEED_EMAIL_MARKER = "e2e.%@example.com";

const ID = Object.freeze({
  buyerCompany: 95801, // tbl_company (buyer parent)
  hospitality: 95801, // tbl_hospitality_companies
  process: 95801, // tbl_approval_processes
  hotels: { MH: 95801, UP: 95802, GOA: 95803 },
  buyer: 95801, // tbl_users, user_type 2
  hq: 95811, // Daikin HQ: tbl_users + tbl_company
  up: 95812, // Daikin UP
  goa: 95813, // Daikin Goa (stand-alone)
  person: 95821, // type-11 person
  org: 95811, // tbl_vendor_orgs
});

// Reference data (seed_reference.sql): states/cities, departments, roles, a product category.
const STATE = { MH: 116, UP: 108, GOA: 115 };
const CITY = { MUMBAI: 1056, LUCKNOW: 745, PANAJI: 1051 };
const DEPT_PROCUREMENT = 10201;
const CATEGORY_ENGINEERING = 237; // parent of 288
const SUBCATEGORY_AC = 288; // AIR CONDITIONING ITEMS
// Buyer roles, all at company scope (every hotel, department and process):
// 1 Company CEO (RFQ chain + awarding), 13 Final Awarding P1, 16 ARC Approver,
// 17 RFQ Observer, 21 PO Regenerator, 22 ARC Creator, 26 ARC Admin, 27 MR Raiser, 28 MR Approver.
const BUYER_ROLES = [1, 13, 16, 17, 21, 22, 26, 27, 28];
const POLICY_ENTITIES = ["RFQ", "TECHNICAL", "NEGOTIATION", "NEGOTIATION_QUOTE", "PO", "MR"];

const GSTIN = {
  buyer: "27AAACW1001H1ZQ",
  hotelMH: "27AAACW1001H1ZQ",
  hotelUP: "09AAACW1001H2ZR",
  hotelGOA: "30AAACW1001H3ZS",
  hq: "27AADCD1234F1ZW",
  up: "09AADCD1234F1Z3",
  goa: "30AAECD5678F1Z5",
};

const HOUR = 3600_000;
/** "YYYY-MM-DD HH:mm:ss" IST wall clock `offsetMs` from now: how bid_end_date is stored. */
const istString = (offsetMs) =>
  new Date(Date.now() + offsetMs + 5.5 * HOUR).toISOString().replace("T", " ").slice(0, 19);
const utcString = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().replace("T", " ").slice(0, 19);
const isoDate = (days) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Cleanup: the whole world, including rows the E2E run created on top of it.
// ---------------------------------------------------------------------------

/**
 * After the seed orgs are gone, an owned login can only still appear in the network tables
 * through ANOTHER org. Those rows are not ours to delete, and they would block deleting the
 * login, so stop with a message that says which org holds it.
 */
async function assertNoForeignNetworkRows(t, userIds) {
  const held = await t.any(
    `SELECT 'entity' AS kind, org_id, vendor_id AS user_id FROM tbl_vendor_org_entities WHERE vendor_id = ANY($1::int[])
     UNION ALL SELECT 'member', org_id, person_user_id FROM tbl_vendor_org_members WHERE person_user_id = ANY($1::int[])
     UNION ALL SELECT 'member-entity', org_id, entity_vendor_id FROM tbl_vendor_org_members WHERE entity_vendor_id = ANY($1::int[])
     UNION ALL SELECT 'seat', org_id, entity_vendor_id FROM tbl_vendor_network_seats WHERE entity_vendor_id = ANY($1::int[])
     UNION ALL SELECT 'invite', org_id, target_vendor_id FROM tbl_vendor_org_link_invites WHERE target_vendor_id = ANY($1::int[])
     UNION ALL SELECT 'assignment', org_id, assigned_vendor_id FROM tbl_vendor_routing_assignments WHERE assigned_vendor_id = ANY($1::int[])
     UNION ALL SELECT 'org-creator', id, created_by FROM tbl_vendor_orgs WHERE created_by = ANY($1::int[])`,
    [userIds]
  );
  if (held.length) {
    const list = held.map((h) => `${h.kind} user ${h.user_id} in org ${h.org_id}`).join("; ");
    throw new Error(
      `seed-owned logins are still linked into non-seed orgs (${list}). Unlink them in that org, or rebuild the database.`
    );
  }
}

async function cleanup(t) {
  const [lo, hi] = RANGE;
  const inRange = (col) => `${col} BETWEEN ${lo} AND ${hi}`;

  // OWNED users: the seed's own range, plus logins an E2E run created with the seed's email
  // marker (e2e.<anything>@example.com, see the runbook). Only owned users, and what hangs off
  // them, are ever deleted. Any OTHER login merely linked into the seed org (a pre-existing
  // vendor HQ invited, say) only loses its org edges: entity, member, seat and invite rows.
  const userIds = (
    await t.any(
      `SELECT id FROM tbl_users WHERE ${inRange("id")} OR email LIKE $1`,
      [SEED_EMAIL_MARKER]
    )
  ).map((r) => Number(r.id));
  const companyIds = [
    ...new Set([
      ...(await t.any(`SELECT id FROM tbl_company WHERE ${inRange("id")}`)).map((r) => Number(r.id)),
      ...(await t.any(`SELECT company_id FROM tbl_users WHERE id = ANY($1::int[]) AND company_id IS NOT NULL`, [userIds])).map(
        (r) => Number(r.company_id)
      ),
    ]),
  ];
  const hotelIds = Object.values(ID.hotels);
  const orgIds = (
    await t.any(`SELECT id FROM tbl_vendor_orgs WHERE ${inRange("id")} OR principal_vendor_id = ANY($1::int[])`, [userIds])
  ).map((r) => Number(r.id));

  const rfqIds = (
    await t.any(
      `SELECT id FROM tbl_rfq WHERE hospitality_company_id = $1 OR hotel_id = ANY($2::int[]) OR created_by = ANY($3::int[])`,
      [ID.hospitality, hotelIds, userIds]
    )
  ).map((r) => Number(r.id));
  const arcIds = (
    await t.any(`SELECT id FROM tbl_arc WHERE hospitality_company_id = $1 OR created_by = ANY($2::int[])`, [
      ID.hospitality,
      userIds,
    ])
  ).map((r) => Number(r.id));
  const contractIds = (
    await t.any(`SELECT id FROM tbl_arc_contract WHERE arc_id = ANY($1::bigint[]) OR vendor_id = ANY($2::int[])`, [
      arcIds,
      userIds,
    ])
  ).map((r) => Number(r.id));
  const mrIds = (
    await t.any(`SELECT id FROM tbl_material_requisition WHERE hospitality_company_id = $1 OR raised_by = ANY($2::int[])`, [
      ID.hospitality,
      userIds,
    ])
  ).map((r) => Number(r.id));
  const poIds = (
    await t.any(
      `SELECT id FROM tbl_rfq_purchase_order
        WHERE rfq_id = ANY($1::int[]) OR arc_contract_id = ANY($2::bigint[]) OR source_mr_id = ANY($3::bigint[])
           OR finalized_vendor_id = ANY($4::int[])`,
      [rfqIds, contractIds, mrIds, userIds]
    )
  ).map((r) => Number(r.id));

  // Approval instances are polymorphic (entity_type, entity_id). Every instance this world
  // produces carries the seed's hospitality company; the id-based branches are limited to the
  // types whose entity_id IS an RFQ / ARC id (TECHNICAL, NEGOTIATION, ARC_* use round or
  // amendment ids, which could collide with unrelated rows).
  const instanceIds = (
    await t.any(
      `SELECT id FROM tbl_approval_instances
        WHERE hospitality_company_id = $1
           OR (entity_type = 'RFQ' AND entity_id = ANY($2::int[]))
           OR (entity_type = 'ARC' AND entity_id = ANY($3::int[]))`,
      [ID.hospitality, rfqIds, arcIds]
    )
  ).map((r) => Number(r.id));

  const del = (sql, params) => t.none(sql, params);

  // Notifications and routing (by recipient / org / subject).
  await del(`DELETE FROM tbl_notifications WHERE recipient_user_id = ANY($1::int[]) OR sender_user_id = ANY($1::int[])`, [userIds]);
  await del(
    // Bounded to the seed orgs: another org's assignments are that org's rows, even when
    // they name an owned entity or a seed subject.
    `DELETE FROM tbl_vendor_routing_assignments WHERE org_id = ANY($1::int[])`,
    [orgIds]
  );

  // Purchase orders (RFQ awards and call-offs).
  await del(`DELETE FROM tbl_arc_callof_po WHERE po_id = ANY($1::int[]) OR mr_id = ANY($2::bigint[]) OR arc_contract_id = ANY($3::bigint[])`, [
    poIds,
    mrIds,
    contractIds,
  ]);
  await del(
    `DELETE FROM tbl_lifecycle_history
      WHERE (entity_type = 'PO' AND entity_id = ANY($1::int[]))
         OR (entity_type IN ('RFQ', 'TENDER') AND entity_id = ANY($2::int[]))
         OR (entity_type = 'ARC' AND entity_id = ANY($3::int[]))`,
    [poIds, rfqIds, arcIds]
  );
  await del(`DELETE FROM tbl_purchase_order_product WHERE purchase_order_id = ANY($1::int[])`, [poIds]);
  await del(`DELETE FROM tbl_purchase_order_tasks WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await del(`DELETE FROM tbl_payment_milestone WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await del(`DELETE FROM tbl_rfq_purchase_order WHERE id = ANY($1::int[])`, [poIds]);

  // Material requisitions.
  await del(`DELETE FROM tbl_material_requisition_item WHERE mr_id = ANY($1::bigint[]) OR arc_contract_id = ANY($2::bigint[])`, [mrIds, contractIds]);
  await del(`DELETE FROM tbl_material_requisition WHERE id = ANY($1::bigint[])`, [mrIds]);

  // Approval instances (steps/actions cascade; step approvers hang off steps).
  await del(
    `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
       (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
    [instanceIds]
  );
  await del(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [instanceIds]);

  // RFQs: the FK-less children first, then the rows with FKs (most cascade).
  const rfqChildren = [
    "tbl_quote_activity",
    "tbl_quote_finalization_history",
    "tbl_quote_finalization",
    "tbl_rfq_product_tech_eval_vendor_replacements",
    "tbl_rfq_product_tech_evaluation",
    "tbl_rfq_quote_excel",
    "tbl_rfq_terms_map",
    "tbl_rfq_filters",
    "tbl_rfq_draft_sheets",
    "tbl_rfq_activity",
    "tbl_rfq_clarifications",
    "tbl_admin_rfq_service",
  ];
  await del(`DELETE FROM tbl_vendor_payments WHERE rfq_id = ANY($1::int[]) OR vendor_id = ANY($2::int[])`, [rfqIds, userIds]);
  await del(`DELETE FROM tbl_quotes_payment_terms WHERE quote_id IN (SELECT id FROM tbl_quotes WHERE rfq_id = ANY($1::int[]))`, [rfqIds]);
  await del(`DELETE FROM tbl_quote_item_history WHERE quote_item_id IN (SELECT id FROM tbl_quote_items WHERE rfq_id = ANY($1::int[]))`, [rfqIds]);
  await del(`DELETE FROM tbl_quote_items WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await del(`DELETE FROM tbl_quotes WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  for (const table of rfqChildren) await del(`DELETE FROM ${table} WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await del(`DELETE FROM tbl_vendor_rfq_tokens_non_login WHERE vendor_id = ANY($1::int[])`, [userIds]);
  await del(`DELETE FROM tbl_rfq_product_vendors WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await del(`DELETE FROM tbl_rfq_products_specs WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await del(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [rfqIds]);
  await del(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds]);

  // ARCs (the order arcGroupSeed.deleteArcs uses), then the contract-level rows.
  await del(`DELETE FROM tbl_arc_amendment WHERE arc_contract_id = ANY($1::bigint[])`, [contractIds]);
  await del(`DELETE FROM tbl_arc_contract_signature_otp WHERE arc_contract_id = ANY($1::bigint[])`, [contractIds]);
  await del(
    `DELETE FROM tbl_arc_contract_line_hotel WHERE arc_contract_line_id IN
       (SELECT id FROM tbl_arc_contract_line WHERE arc_contract_id = ANY($1::bigint[]))`,
    [contractIds]
  );
  await del(`DELETE FROM tbl_arc_contract_line WHERE arc_contract_id = ANY($1::bigint[])`, [contractIds]);
  await del(`DELETE FROM tbl_arc_contract WHERE id = ANY($1::bigint[])`, [contractIds]);
  await del(`DELETE FROM tbl_arc_comm_evaluation WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
  await del(`DELETE FROM tbl_arc_quote_line WHERE arc_quote_id IN (SELECT id FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[]))`, [arcIds]);
  await del(`DELETE FROM tbl_arc_quote_version WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
  await del(`DELETE FROM tbl_arc_quote WHERE arc_id = ANY($1::bigint[])`, [arcIds]);
  await del(`DELETE FROM tbl_arc WHERE id = ANY($1::bigint[])`, [arcIds]);

  // Vendor network. Every row is bounded to the SEED orgs: an owned entity or person that is
  // also linked into another org keeps that org's rows (and the user delete below then refuses,
  // see assertNoForeignNetworkRows).
  //
  // Coverage has no org_id. A rule goes when its entity is in a seed org and the entity is
  // owned or the rule was authored by an owned (seed org admin) login, or when it belongs to an
  // owned entity that sits in no other org. Runs BEFORE the entity rows go, since it reads them.
  await del(
    `DELETE FROM tbl_vendor_coverage_rules r
      WHERE (r.entity_vendor_id = ANY($1::int[])
             OR (r.created_by = ANY($1::int[])
                 AND r.entity_vendor_id IN (SELECT vendor_id FROM tbl_vendor_org_entities WHERE org_id = ANY($2::int[]))))
        AND (r.entity_vendor_id IN (SELECT vendor_id FROM tbl_vendor_org_entities WHERE org_id = ANY($2::int[]))
             OR NOT EXISTS (SELECT 1 FROM tbl_vendor_org_entities e
                             WHERE e.vendor_id = r.entity_vendor_id AND NOT (e.org_id = ANY($2::int[]))))`,
    [userIds, orgIds]
  );
  await del(`DELETE FROM tbl_vendor_network_seats WHERE org_id = ANY($1::int[])`, [orgIds]);
  await del(`DELETE FROM tbl_vendor_org_members WHERE org_id = ANY($1::int[])`, [orgIds]);
  await del(`DELETE FROM tbl_vendor_org_link_invites WHERE org_id = ANY($1::int[])`, [orgIds]);
  await del(`DELETE FROM tbl_vendor_org_entities WHERE org_id = ANY($1::int[])`, [orgIds]);
  await del(`DELETE FROM tbl_vendor_orgs WHERE id = ANY($1::int[])`, [orgIds]);
  await assertNoForeignNetworkRows(t, userIds);

  // Vendor subscriptions and catalogue mappings.
  await del(`DELETE FROM tbl_vendor_hotel_category_subscription WHERE vendor_id = ANY($1::int[])`, [userIds]);
  await del(`DELETE FROM tbl_product_variant_vendor_mapping WHERE vendor_id = ANY($1::int[])`, [userIds]);

  // Buyer configuration.
  await del(`DELETE FROM tbl_approval_policies WHERE hospitality_company_id = $1`, [ID.hospitality]);
  await del(`DELETE FROM tbl_approval_processes WHERE company_id = ANY($1::int[])`, [companyIds]);
  await del(`DELETE FROM tbl_approval_hierarchy WHERE company_id = ANY($1::int[]) OR user_id = ANY($2::int[])`, [companyIds, userIds]);
  await del(`DELETE FROM tbl_user_role_scopes WHERE user_id = ANY($1::int[])`, [userIds]);
  await del(`DELETE FROM tbl_user_department WHERE user_id = ANY($1::int[])`, [userIds]);
  await del(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id = ANY($1::int[])`, [userIds]);
  await del(`DELETE FROM tbl_arc_hotel_mappings WHERE hotel_id = ANY($1::int[])`, [hotelIds]);
  await del(`DELETE FROM tbl_rfq_hotel_mappings WHERE hotel_id = ANY($1::int[])`, [hotelIds]);

  // Identities.
  await del(`DELETE FROM tbl_users WHERE id = ANY($1::int[])`, [userIds]);
  await del(`DELETE FROM tbl_hospitality_company_hotels WHERE id = ANY($1::int[])`, [hotelIds]);
  await del(`DELETE FROM tbl_hospitality_companies WHERE id = $1`, [ID.hospitality]);
  await del(`DELETE FROM tbl_company_location WHERE company_id = ANY($1::int[])`, [companyIds]);
  await del(`DELETE FROM tbl_company WHERE id = ANY($1::int[])`, [companyIds]);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function seedBuyer(t, hash) {
  await t.none(
    `INSERT INTO tbl_company (id, company_name, is_hospitality, gstin, "createdAt")
     VALUES ($1, 'E2E Westwind Hospitality Group', 1, $2, now())`,
    [ID.buyerCompany, GSTIN.buyer]
  );
  await t.none(
    `INSERT INTO tbl_hospitality_companies (id, buyer_company_id, name, gst, registered_office_address)
     VALUES ($1, $2, 'E2E Westwind Hotels', $3, 'Nariman Point, Mumbai 400021')`,
    [ID.hospitality, ID.buyerCompany, GSTIN.buyer]
  );
  const hotels = [
    [ID.hotels.MH, "E2E Westwind Mumbai", "Mumbai", "Maharashtra", STATE.MH, CITY.MUMBAI, GSTIN.hotelMH, "Marine Drive, Mumbai 400020"],
    [ID.hotels.UP, "E2E Westwind Lucknow", "Lucknow", "Uttar Pradesh", STATE.UP, CITY.LUCKNOW, GSTIN.hotelUP, "Gomti Nagar, Lucknow 226010"],
    [ID.hotels.GOA, "E2E Westwind Panaji", "Panaji", "Goa", STATE.GOA, CITY.PANAJI, GSTIN.hotelGOA, "Miramar, Panaji 403001"],
  ];
  for (const [id, name, city, state, stateId, cityId, gst, address] of hotels) {
    await t.none(
      `INSERT INTO tbl_hospitality_company_hotels
         (id, hospitality_company_id, name, city, state, state_id, city_id, gst, status, full_address, delivery_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Active', $9, $9)`,
      [id, ID.hospitality, name, city, state, stateId, cityId, gst, address]
    );
  }

  await t.none(
    `INSERT INTO tbl_users (id, name, email, mobile, user_type, status, is_deleted, company_id, employee_code, designation, password)
     VALUES ($1, 'Priya Buyer (E2E)', 'e2e.buyer@example.com', '9000095801', 2, 1, 0, $2, 'E2EBUY01', 'Procurement Head', $3)`,
    [ID.buyer, ID.buyerCompany, hash]
  );
  await t.none(
    `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
     VALUES ($1, $2, NULL, 0)`,
    [ID.buyer, ID.hospitality]
  );
  for (const hotelId of Object.values(ID.hotels)) {
    await t.none(
      `INSERT INTO tbl_hospitality_user_mappings (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type)
       VALUES ($1, $2, $3, 1)`,
      [ID.buyer, ID.hospitality, hotelId]
    );
  }
  for (const roleId of BUYER_ROLES) {
    await t.none(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id, process_id)
       VALUES ($1, $2, $3, NULL, NULL, NULL)`,
      [ID.buyer, roleId, ID.hospitality]
    );
  }
  await t.none(`INSERT INTO tbl_user_department (user_id, department_id) VALUES ($1, $2)`, [ID.buyer, DEPT_PROCUREMENT]);

  await t.none(
    `INSERT INTO tbl_approval_processes (id, company_id, name, description, is_active, created_by, process_type)
     VALUES ($1, $2, 'E2E Standard Procurement', 'Vendor Networks E2E', true, $3, 'RFQ')`,
    [ID.process, ID.buyerCompany, ID.buyer]
  );
  // Company-wide (hotel NULL, process NULL) policies: one ANY step naming the buyer. The buyer
  // holds read+approve for each resource, so the step survives the permission gate, and as the
  // sole approver of what they submit, their MRs and POs approve on submission.
  let policyId = RANGE[0];
  const policies = {};
  for (const entity of POLICY_ENTITIES) {
    await t.none(
      `INSERT INTO tbl_approval_policies
         (id, entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by,
          process_id, is_master, is_department_scoped, version)
       VALUES ($1, $2, $3, NULL, NULL, true, $4, NULL, false, false, 1)`,
      [policyId, entity, ID.hospitality, ID.buyer]
    );
    await t.none(
      `INSERT INTO tbl_approval_policy_steps (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'ANY', 'USER', $2)`,
      [policyId, ID.buyer]
    );
    policies[entity] = policyId;
    policyId += 1;
  }
  return policies;
}

async function seedVendor(t, { id, name, email, gstin, stateId, cityId, address, password }) {
  await t.none(`INSERT INTO tbl_company (id, company_name, gstin, location, "createdAt") VALUES ($1, $2, $3, $4, now())`, [
    id,
    name,
    gstin,
    address,
  ]);
  await t.none(
    `INSERT INTO tbl_users (id, name, email, mobile, user_type, status, is_deleted, company_id, password)
     VALUES ($1, $2, $3, $4, 3, 1, 0, $1, $5)`,
    [id, name, email, `90000${id}`, password]
  );
  await t.none(
    `INSERT INTO tbl_company_location (company_id, country_id, state_id, city_id, address) VALUES ($1, 1, $2, $3, $4)`,
    [id, stateId, cityId, address]
  );
}

async function subscribe(t, vendorId, items) {
  for (const [itemType, itemId] of items) {
    await t.none(
      `INSERT INTO tbl_vendor_hotel_category_subscription (vendor_id, item_type, item_id, fee_amount, start_date, end_date, status)
       VALUES ($1, $2, $3, 0, $4, $5, 'active')`,
      [vendorId, itemType, itemId, isoDate(-30), isoDate(335)]
    );
  }
}

async function mapVariants(t, vendorId, variantIds) {
  for (const variantId of variantIds) {
    await t.none(
      `INSERT INTO tbl_product_variant_vendor_mapping
         (product_variant_id, vendor_id, status, is_approved, approved_at, created_at, updated_at)
       VALUES ($1, $2, true, true, now(), now(), now())`,
      [variantId, vendorId]
    );
  }
}

async function seedVendors(t, hash, variants) {
  await seedVendor(t, {
    id: ID.hq,
    name: "Daikin HQ (E2E)",
    email: "e2e.daikin.hq@example.com",
    gstin: GSTIN.hq,
    stateId: STATE.MH,
    cityId: CITY.MUMBAI,
    address: "Andheri East, Mumbai 400093",
    password: hash,
  });
  // A network-created branch: no password of its own, reached through its people.
  await seedVendor(t, {
    id: ID.up,
    name: "Daikin UP (E2E)",
    email: "e2e.daikin.up@example.com",
    gstin: GSTIN.up,
    stateId: STATE.UP,
    cityId: CITY.LUCKNOW,
    address: "Hazratganj, Lucknow 226001",
    password: null,
  });
  // A stand-alone legacy vendor HQ can invite into the network (link flow).
  await seedVendor(t, {
    id: ID.goa,
    name: "Daikin Goa (E2E)",
    email: "e2e.daikin.goa@example.com",
    gstin: GSTIN.goa,
    stateId: STATE.GOA,
    cityId: CITY.PANAJI,
    address: "Porvorim, Goa 403521",
    password: hash,
  });

  const hotelSubs = Object.values(ID.hotels).map((h) => ["hotel", h]);
  await subscribe(t, ID.hq, [["category", CATEGORY_ENGINEERING], ["subcategory", SUBCATEGORY_AC], ...hotelSubs]);
  await subscribe(t, ID.goa, [["category", CATEGORY_ENGINEERING], ["subcategory", SUBCATEGORY_AC], ["hotel", ID.hotels.GOA]]);
  await mapVariants(t, ID.hq, variants.map((v) => v.id));
  await mapVariants(t, ID.goa, variants.map((v) => v.id));

  // Daikin HQ's network: the org, HQ as PRINCIPAL + ORG_ADMIN, Daikin UP as an ACTIVE seated BRANCH.
  await t.none(
    `INSERT INTO tbl_vendor_orgs (id, name, principal_vendor_id, routing_mode, created_by)
     VALUES ($1, 'Daikin Network (E2E)', $2, 'ADMIN_ROUTES', $2)`,
    [ID.org, ID.hq]
  );
  await t.none(
    `INSERT INTO tbl_vendor_org_entities (org_id, vendor_id, relationship, status, linked_at)
     VALUES ($1, $2, 'PRINCIPAL', 'ACTIVE', now()), ($1, $3, 'BRANCH', 'ACTIVE', now())`,
    [ID.org, ID.hq, ID.up]
  );
  await t.none(
    `INSERT INTO tbl_vendor_org_members (org_id, person_user_id, entity_vendor_id, role, status)
     VALUES ($1, $2, NULL, 'ORG_ADMIN', 'ACTIVE')`,
    [ID.org, ID.hq]
  );
  const fyEndYear = new Date().getUTCMonth() >= 3 ? new Date().getUTCFullYear() + 1 : new Date().getUTCFullYear();
  await t.none(
    `INSERT INTO tbl_vendor_network_seats (org_id, entity_vendor_id, fee_amount, start_date, end_date, status)
     VALUES ($1, $2, 0, CURRENT_DATE, $3, 'active')`,
    [ID.org, ID.up, `${fyEndYear}-03-31`]
  );

  // The person: type 11, no company, ENTITY_MEMBER of Daikin UP.
  await t.none(
    `INSERT INTO tbl_users (id, name, email, mobile, user_type, status, is_deleted, company_id, password)
     VALUES ($1, 'Ravi Verma (Daikin UP, E2E)', 'e2e.daikin.person@example.com', '9000095821', 11, 1, 0, NULL, $2)`,
    [ID.person, hash]
  );
  await t.none(
    `INSERT INTO tbl_vendor_org_members (org_id, person_user_id, entity_vendor_id, role, status)
     VALUES ($1, $2, $3, 'ENTITY_MEMBER', 'ACTIVE')`,
    [ID.org, ID.person, ID.up]
  );
}

async function seedRfq(t, variants) {
  const { rfq_id, rfq_no } = await makeRFQ(t, {
    createdBy: ID.buyer,
    status: 1,
    is_published: 1,
    tender_publish_date: utcString(-2 * 24 * HOUR),
    vendor_clarification_date: utcString(-24 * HOUR),
    bid_end_date: istString(4 * 24 * HOUR),
    hospitality: ID.hospitality,
    hotel: ID.hotels.UP,
    department: DEPT_PROCUREMENT,
    process: ID.process,
    title: "[E2E-VN] Split AC units for Lucknow",
    comment: "Supply and installation of split AC units, Lucknow property.",
    company_name: "E2E Westwind Hotels",
    response_email: "e2e.buyer@example.com",
    contact_name: "Priya Buyer (E2E)",
    contact_number: "9000095801",
    location: "Lucknow, Uttar Pradesh",
  });
  for (const [i, v] of variants.entries()) {
    const qty = i === 0 ? "12" : "6";
    await t.none(
      `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
       VALUES ($1, '', '', '', '', '', $2, 0)`,
      [rfq_id, v.id]
    );
    await t.none(
      `INSERT INTO tbl_rfq_products_specs (rfq_id, product_variant_id, title, value, variant)
       VALUES ($1, $2, 'Quantity', $3, 0), ($1, $2, 'Unit', 'NOS', 0)`,
      [rfq_id, v.id, qty]
    );
    // Invited at the principal: routing hands it to a branch from here.
    await t.none(`INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant) VALUES ($1, $2, $3, 0)`, [
      rfq_id,
      v.id,
      ID.hq,
    ]);
  }
  const bidEnd = (await t.one(`SELECT bid_end_date FROM tbl_rfq WHERE id = $1`, [rfq_id])).bid_end_date;
  return { rfq_id, rfq_no, bid_end_date: bidEnd };
}

async function seedGroupArc(t, variants) {
  const arc = await t.one(
    `INSERT INTO tbl_arc (arc_number, title, description, category_id, hospitality_company_id, hotel_id, department_id,
                          status, is_group, submission_start_at, submission_end_at, contract_start_at, contract_end_at,
                          payment_terms_expected, delivery_expected, created_by)
     VALUES ('ARC-E2E-VN-0001', '[E2E-VN] Group AC supply, Mumbai + Lucknow', 'Annual rate contract for split AC units.',
             $1, $2, $3, $4, 'awaiting_vendor_acceptance', true,
             NOW() - INTERVAL '20 days', NOW() - INTERVAL '10 days', NOW() - INTERVAL '1 day', NOW() + INTERVAL '364 days',
             '30 days from invoice', 'Within 7 days of call-off', $5)
     RETURNING id, arc_number`,
    [SUBCATEGORY_AC, ID.hospitality, ID.hotels.MH, DEPT_PROCUREMENT, ID.buyer]
  );
  await t.none(`INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id, created_by) VALUES ($1, $2, $4), ($1, $3, $4)`, [
    arc.id,
    ID.hotels.MH,
    ID.hotels.UP,
    ID.buyer,
  ]);
  // Every product path that ends in a contract (award, manual entry) has invited the
  // contract vendor first. The coverage preview hotel set reads this invitation, so
  // without it Mumbai (an ARC-only hotel) could not take a HOTEL coverage rule.
  await t.none(
    `INSERT INTO tbl_arc_invitation (arc_id, vendor_id, status, responded_at) VALUES ($1, $2, 'submitted', NOW() - INTERVAL '12 days')`,
    [arc.id, ID.hq]
  );
  const contract = await t.one(
    `INSERT INTO tbl_arc_contract (arc_id, vendor_id, status, generated_at, awaiting_until)
     VALUES ($1, $2, 'awaiting_acceptance', NOW(), NOW() + INTERVAL '7 days')
     RETURNING id`,
    [arc.id, ID.hq]
  );
  // [unit rate, committed qty, Mumbai share, Lucknow share]
  const terms = [
    [42000, 100, 60, 40],
    [18000, 50, 30, 20],
  ];
  const lines = [];
  for (const [i, v] of variants.entries()) {
    const [rate, qty, mh, up] = terms[i];
    const item = await t.one(
      `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, $3, 'NOS') RETURNING id`,
      [arc.id, v.id, qty]
    );
    const line = await t.one(
      `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty, payment_terms, delivery_terms)
       VALUES ($1, $2, $3, 18, $4, '30 days from invoice', 'Within 7 days of call-off') RETURNING id`,
      [contract.id, item.id, rate, qty]
    );
    await t.none(
      `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty) VALUES ($1, $2, $3), ($1, $4, $5)`,
      [line.id, ID.hotels.MH, mh, ID.hotels.UP, up]
    );
    lines.push({ line_id: Number(line.id), variant_id: v.id, product: v.name, unit_rate: rate, committed_qty: qty, MH: mh, UP: up });
  }
  return { arc_id: Number(arc.id), arc_number: arc.arc_number, contract_id: Number(contract.id), lines };
}

async function main() {
  const where = await db.one(`SELECT current_database() AS db, host(inet_server_addr()) AS addr`);
  if (where.db !== conn.database) throw new Error(`connected to '${where.db}', expected '${conn.database}'`);
  // Belt and braces on top of the host-name check: the server we reached must answer on loopback.
  if (!["127.0.0.1", "::1"].includes(where.addr)) {
    throw new Error(`server address is '${where.addr}', not loopback: refusing to seed`);
  }

  const variants = await db.any(
    `SELECT pv.id, pv.name
       FROM tbl_product_variant pv
       JOIN tbl_product_categories pc ON pc.product_id = pv.product_id
      WHERE pc.category_id = $1 AND pv.name IN ('AC INDOOR COOLING UNIT', 'AC CONDENSOR UNIT')
      ORDER BY CASE pv.name WHEN 'AC INDOOR COOLING UNIT' THEN 0 ELSE 1 END`,
    [SUBCATEGORY_AC]
  );
  if (variants.length !== 2) {
    throw new Error(`expected the two AC variants of category ${SUBCATEGORY_AC} in the reference data, found ${variants.length}`);
  }

  const hash = bcrypt.hashSync(PASSWORD, 10);
  const out = await db.tx(async (t) => {
    await cleanup(t);
    const policies = await seedBuyer(t, hash);
    await seedVendors(t, hash, variants);
    const rfq = await seedRfq(t, variants);
    const arc = await seedGroupArc(t, variants);
    return { policies, rfq, arc };
  });

  const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
  console.log(`\nVendor Networks E2E world seeded into ${conn.database} @ ${conn.host}:${conn.port}\n`);
  console.log("LOGINS (POST /api/v1/users/login?conform=true)  password for all: " + PASSWORD);
  line("Buyer (employee code)", `employee_code=E2EBUY01            user ${ID.buyer}  Priya Buyer`);
  line("Daikin HQ (principal)", `email=e2e.daikin.hq@example.com     user ${ID.hq}  ORG_ADMIN`);
  line("Person (type 11)", `email=e2e.daikin.person@example.com user ${ID.person}  ENTITY_MEMBER of Daikin UP`);
  line("Daikin Goa (stand-alone)", `email=e2e.daikin.goa@example.com    user ${ID.goa}  in no network`);
  line("Daikin UP (branch)", `no password (network-managed)      user ${ID.up}`);
  console.log("\nBUYER SIDE");
  line("tbl_company", ID.buyerCompany);
  line("hospitality company", `${ID.hospitality}  E2E Westwind Hotels`);
  line("hotel Mumbai (MH 27)", `${ID.hotels.MH}  state_id ${STATE.MH} city_id ${CITY.MUMBAI} gst ${GSTIN.hotelMH}`);
  line("hotel Lucknow (UP 09)", `${ID.hotels.UP}  state_id ${STATE.UP} city_id ${CITY.LUCKNOW} gst ${GSTIN.hotelUP}`);
  line("hotel Panaji (Goa 30)", `${ID.hotels.GOA}  state_id ${STATE.GOA} city_id ${CITY.PANAJI} gst ${GSTIN.hotelGOA}`);
  line("department", `${DEPT_PROCUREMENT}  Procurement`);
  line("approval process", ID.process);
  line("buyer roles (company scope)", BUYER_ROLES.join(", "));
  line("policies (1 step: buyer)", Object.entries(out.policies).map(([k, v]) => `${k}=${v}`).join(" "));
  console.log("\nVENDOR SIDE");
  line("Daikin HQ", `${ID.hq}  gstin ${GSTIN.hq}  subs: category ${CATEGORY_ENGINEERING}, subcategory ${SUBCATEGORY_AC}, hotels ${Object.values(ID.hotels).join("/")}`);
  line("Daikin UP", `${ID.up}  gstin ${GSTIN.up}  BRANCH, ACTIVE, seat active`);
  line("Daikin Goa", `${ID.goa}  gstin ${GSTIN.goa}  subs: category ${CATEGORY_ENGINEERING}, subcategory ${SUBCATEGORY_AC}, hotel ${ID.hotels.GOA}`);
  line("org", `${ID.org}  Daikin Network (E2E), ADMIN_ROUTES`);
  line("person", `${ID.person}  ENTITY_MEMBER of ${ID.up}`);
  line("variants (mapped HQ + Goa)", variants.map((v) => `${v.id} ${v.name}`).join(", "));
  console.log("\nRFQ");
  line("rfq_id / rfq_no", `${out.rfq.rfq_id} / ${out.rfq.rfq_no}  hotel ${ID.hotels.UP} (Lucknow), invited: Daikin HQ`);
  line("bid_end_date (IST)", out.rfq.bid_end_date);
  console.log("\nGROUP ARC");
  line("arc_id / number", `${out.arc.arc_id} / ${out.arc.arc_number}  hotels ${ID.hotels.MH} (lead) + ${ID.hotels.UP}`);
  line("contract_id", `${out.arc.contract_id}  Daikin HQ, awaiting_acceptance`);
  for (const l of out.arc.lines) {
    line(`line ${l.line_id}`, `variant ${l.variant_id} ${l.product} @ ${l.unit_rate} +18% GST, qty ${l.committed_qty} (MH ${l.MH}, UP ${l.UP})`);
  }
  console.log("");
}

main()
  .catch((err) => {
    console.error(`SEED FAILED: ${err.message}`);
    console.error("If an earlier E2E run left rows this cleanup does not know about, rebuild the database:");
    console.error("  node scripts/vendor_networks/e2e_prepare_db.mjs && node scripts/vendor_networks/e2e_seed.mjs");
    process.exitCode = 1;
  })
  .finally(() => pgp.end());
