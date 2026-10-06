// Seed helpers for Vendor Network suites. Every row uses ids 95001..95999.
// (tests/fixtures/network.js is the BUYER hotel network and is unrelated.)

import { db } from "../setup/db.js";
import { VENDOR_MEMBER_USER_TYPE } from "../../app/constants/vendorNetwork.js";
import { IDS } from "../fixtures/ids.js";

export const FIXTURE_ID_MIN = 95001;
export const FIXTURE_ID_MAX = 95999;

/** End of the current Indian financial year (31 March), as YYYY-MM-DD. */
function fyEnd() {
  const now = new Date();
  const year = now.getUTCMonth() >= 3 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return `${year}-03-31`;
}

/** Vendor entity: tbl_company + tbl_users(user_type 3) [+ tbl_company_location]. */
export async function seedVendorEntity(
  { id, companyId, name, email, gstin = null, stateId = null, cityId = null, password = null, status = 1, runner = db }
) {
  await runner.none(
    `INSERT INTO tbl_company (id, company_name, gstin) VALUES ($1, $2, $3)`,
    [companyId, name, gstin]
  );
  await runner.none(
    `INSERT INTO tbl_users (id, name, email, user_type, company_id, status, password)
     VALUES ($1, $2, $3, 3, $4, $5, $6)`,
    [id, name, email, companyId, status, password]
  );
  if (stateId) {
    await runner.none(
      `INSERT INTO tbl_company_location (company_id, country_id, state_id, city_id) VALUES ($1, 1, $2, $3)`,
      [companyId, stateId, cityId]
    );
  }
  return { id, companyId };
}

/** Person login (user_type 11), no company. */
export async function seedPerson({ id, email, name, status = 1, runner = db }) {
  await runner.none(
    `INSERT INTO tbl_users (id, name, email, user_type, company_id, status)
     VALUES ($1, $2, $3, $4, NULL, $5)`,
    [id, name, email, VENDOR_MEMBER_USER_TYPE, status]
  );
  return { id };
}

async function insertSeat(runner, orgId, vendorId) {
  const today = new Date().toISOString().slice(0, 10);
  await runner.none(
    `INSERT INTO tbl_vendor_network_seats (org_id, entity_vendor_id, fee_amount, start_date, end_date, status)
     VALUES ($1, $2, 0, $3, $4, 'active')`,
    [orgId, vendorId, today, fyEnd()]
  );
}

/** Org + PRINCIPAL entity (ACTIVE, no seat: the principal needs none) + ORG_ADMIN membership for the principal. */
export async function seedOrg({ id, principalVendorId, name, routingMode = "ADMIN_ROUTES", runner = db }) {
  await runner.none(
    `INSERT INTO tbl_vendor_orgs (id, name, principal_vendor_id, routing_mode, created_by)
     VALUES ($1, $2, $3, $4, $3)`,
    [id, name, principalVendorId, routingMode]
  );
  await runner.none(
    `INSERT INTO tbl_vendor_org_entities (org_id, vendor_id, relationship, status, linked_at)
     VALUES ($1, $2, 'PRINCIPAL', 'ACTIVE', now())`,
    [id, principalVendorId]
  );
  await runner.none(
    `INSERT INTO tbl_vendor_org_members (org_id, person_user_id, entity_vendor_id, role, status)
     VALUES ($1, $2, NULL, 'ORG_ADMIN', 'ACTIVE')`,
    [id, principalVendorId]
  );
  return { orgId: id };
}

export async function addEntity(
  { orgId, vendorId, relationship = "BRANCH", status = "ACTIVE", withSeat = true, runner = db }
) {
  await runner.none(
    `INSERT INTO tbl_vendor_org_entities (org_id, vendor_id, relationship, status, linked_at)
     VALUES ($1, $2, $3, $4, now())`,
    [orgId, vendorId, relationship, status]
  );
  if (withSeat) await insertSeat(runner, orgId, vendorId);
}

export async function addMember({ orgId, personId, entityVendorId = null, role, status = "ACTIVE", runner = db }) {
  await runner.none(
    `INSERT INTO tbl_vendor_org_members (org_id, person_user_id, entity_vendor_id, role, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [orgId, personId, entityVendorId, role, status]
  );
}

/**
 * Buyer hotel (business unit) with explicit location ids: id in the fixture range, under
 * Hospitality A by default. state/city text and state_id/city_id are written as given
 * (no resolution), so a test can seed a hotel whose text and ids disagree or are NULL.
 */
export async function seedHotel(
  { id, name, state = null, city = null, stateId = null, cityId = null, hospitalityId = IDS.hospitality.A, runner = db }
) {
  await runner.none(
    `INSERT INTO tbl_hospitality_company_hotels (id, hospitality_company_id, name, state, city, state_id, city_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, hospitalityId, name, state, city, stateId, cityId]
  );
  return { id };
}

/**
 * Moves the tbl_company / tbl_users sequences above every fixture id range (>= 100000).
 * The test DB's company sequence starts low, and seed_reference has rows that reference
 * company ids no row holds yet (tbl_approval_processes.company_id 13): an API-created
 * company landing on such an id could never be cleaned up. Call from beforeAll of suites
 * that create companies/users through the API.
 */
export async function moveApiSequencesPastFixtures(runner = db) {
  for (const table of ["tbl_company", "tbl_users"]) {
    // Named directly: these sequences are not OWNED BY the column, so pg_get_serial_sequence is NULL.
    await runner.one(`SELECT setval('${table}_id_seq', GREATEST((SELECT last_value FROM ${table}_id_seq), 100000))`);
  }
}

/**
 * Deletes every fixture row (ids 95001..95999), network tables first. Rows the API
 * itself created under a fixture org (POST /org, POST /entities: serial ids) go too:
 * the org, its entity logins and member persons (POST /members), their companies,
 * locations, payments and notifications.
 */
export async function cleanupVendorNetworkFixtures(runner = db) {
  const lo = FIXTURE_ID_MIN;
  const hi = FIXTURE_ID_MAX;
  const fixtureOrgs = `SELECT id FROM tbl_vendor_orgs
                        WHERE id BETWEEN ${lo} AND ${hi} OR principal_vendor_id BETWEEN ${lo} AND ${hi}`;
  const apiUserIds = (
    await runner.any(
      `SELECT vendor_id AS id FROM tbl_vendor_org_entities
        WHERE org_id IN (${fixtureOrgs}) AND vendor_id NOT BETWEEN ${lo} AND ${hi}
       UNION
       SELECT person_user_id FROM tbl_vendor_org_members
        WHERE org_id IN (${fixtureOrgs}) AND person_user_id NOT BETWEEN ${lo} AND ${hi}`
    )
  ).map((r) => Number(r.id));
  const apiCompanyIds = apiUserIds.length
    ? (
        await runner.any(`SELECT company_id FROM tbl_users WHERE id = ANY($1::int[]) AND company_id IS NOT NULL`, [
          apiUserIds,
        ])
      ).map((r) => Number(r.company_id))
    : [];
  const apiUsers = apiUserIds.length ? apiUserIds.join(",") : "NULL";
  const apiCompanies = apiCompanyIds.length ? apiCompanyIds.join(",") : "NULL";

  const users = `SELECT id FROM tbl_users WHERE id BETWEEN ${lo} AND ${hi} OR id IN (${apiUsers})`;
  const orgs = `SELECT id FROM tbl_vendor_orgs WHERE id BETWEEN ${lo} AND ${hi} OR principal_vendor_id IN (${users})`;
  await runner.none(`DELETE FROM tbl_notifications WHERE recipient_user_id IN (${users})`);
  await runner.none(`DELETE FROM tbl_vendor_network_seats WHERE org_id IN (${orgs}) OR entity_vendor_id IN (${users})`);
  await runner.none(`DELETE FROM tbl_vendor_routing_assignments WHERE org_id IN (${orgs}) OR assigned_vendor_id IN (${users})`);
  await runner.none(`DELETE FROM tbl_vendor_coverage_rules WHERE entity_vendor_id IN (${users})`);
  await runner.none(`DELETE FROM tbl_vendor_org_members WHERE org_id IN (${orgs}) OR person_user_id IN (${users})`);
  await runner.none(`DELETE FROM tbl_vendor_org_link_invites WHERE org_id IN (${orgs}) OR target_vendor_id IN (${users})`);
  await runner.none(`DELETE FROM tbl_vendor_org_entities WHERE org_id IN (${orgs}) OR vendor_id IN (${users})`);
  await runner.none(`DELETE FROM tbl_vendor_orgs WHERE id IN (${orgs})`);
  await runner.none(`DELETE FROM tbl_vendor_payments WHERE vendor_id IN (${users})`);
  await runner.none(
    `DELETE FROM tbl_company_location WHERE company_id BETWEEN ${lo} AND ${hi} OR company_id IN (${apiCompanies})`
  );
  await runner.none(`DELETE FROM tbl_users WHERE id BETWEEN ${lo} AND ${hi} OR id IN (${apiUsers})`);
  await runner.none(`DELETE FROM tbl_hospitality_company_hotels WHERE id BETWEEN ${lo} AND ${hi}`);
  await runner.none(`DELETE FROM tbl_company WHERE id BETWEEN ${lo} AND ${hi} OR id IN (${apiCompanies})`);
}
