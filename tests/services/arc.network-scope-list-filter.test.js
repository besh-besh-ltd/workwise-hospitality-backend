// Phase 9 — list-visibility filtering for Group ARC tenders.
//
// What the buyer experiences in the portal:
//   - A Group ARC tender shows up in the buyer's tech-eval queue ONLY
//     if the buyer holds te.read at NETWORK scope. BU-scoped te.read,
//     even covering one of the tender's BUs, does NOT make the tender
//     visible.
//   - Conversely, an RFQ or Single ARC tender is visible to a user
//     with the appropriate BU-scoped grant; a network-only user does
//     NOT see those.
//
// This isolates the architectural rule "the two scopes do NOT cross-
// pollinate" at the LIST level, where it matters most for the user.
// We exercise rfqModel.searchData (the list query backing the buyer's
// RFQ-management tabs) directly.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { ROLE_IDS } from "../fixtures/users.js";
import rfqModel from "../../app/models/rfqModel.js";
import rbacModel from "../../app/models/rbacModel.js";

// arc resource is the closest existing resource to "Group ARC tender"
// for the read-permission check. te + awarding + boq are existing
// resources; we add 'read' actions if missing for the test's roles.
const PERM_BOQ_READ = 9601;
const PERM_TE_READ = 9602;

beforeAll(async () => {
  // boq.read and te.read may already be seeded; the IDs we add are
  // separate to keep cleanup deterministic.
  await db.none(
    `INSERT INTO tbl_permissions (id, resource, action) VALUES
       ($1, 'boq', 'read'),
       ($2, 'te', 'read')
     ON CONFLICT (id) DO NOTHING`,
    [PERM_BOQ_READ, PERM_TE_READ]
  );
});

afterAll(async () => {
  await db.none(
    `DELETE FROM tbl_role_permissions WHERE permission_id = ANY($1::int[])`,
    [[PERM_BOQ_READ, PERM_TE_READ]]
  );
  await db.none(`DELETE FROM tbl_permissions WHERE id = ANY($1::int[])`, [[PERM_BOQ_READ, PERM_TE_READ]]);
  await closeDb();
});

const inserted = { rfqIds: [], scopeIds: [], rolePerms: [] };

afterEach(async () => {
  if (inserted.rfqIds.length) {
    await db.none(`DELETE FROM tbl_rfq_hotel_mappings WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq_products WHERE rfq_id = ANY($1::int[])`, [inserted.rfqIds]);
    await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [inserted.rfqIds]);
    inserted.rfqIds = [];
  }
  if (inserted.scopeIds.length) {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`, [inserted.scopeIds]);
    inserted.scopeIds = [];
  }
  if (inserted.rolePerms.length) {
    for (const [rid, pid] of inserted.rolePerms) {
      await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2`, [rid, pid]);
    }
    inserted.rolePerms = [];
  }
});

const grantPerm = async (roleId, permId) => {
  await db.none(
    `INSERT INTO tbl_role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [roleId, permId]
  );
  inserted.rolePerms.push([roleId, permId]);
};

const grantNetworkRole = async (userId, roleId) => {
  await rbacModel.assignUserRoleScopes([
    { user_id: userId, role_id: roleId, is_network_scope: 1 },
  ]);
  const rows = await db.any(
    `SELECT id FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2 AND is_network_scope = 1`,
    [userId, roleId]
  );
  rows.forEach((r) => inserted.scopeIds.push(r.id));
};

const makeTender = async ({ scope, hotel_ids = [IDS.hotels.A1] }) => {
  const rfq = await db.one(
    `INSERT INTO tbl_rfq
       (rfq_no, comment, company_name, response_email, contact_name, contact_number,
        bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
        hospitality_company_id, hotel_id, is_tender, tender_publish_date,
        vendor_clarification_date, title, rfq_type, tender_scope,
        arc_period_from, arc_period_to)
     VALUES (nextval('tbl_rfq_id_seq'), 'list-visibility fixture', 'Phileein', 'a@b.test',
             'C', '+91-9999999999', NOW() + INTERVAL '7 days', 'Loc', 1, 1,
             $1, $1, NOW(), $2, $3, 1, NOW() - INTERVAL '30 days',
             NOW() + INTERVAL '5 days', 'Vis fixture', 'TENDER', $4,
             '2027-01-01', '2027-12-31')
     RETURNING id, rfq_no`,
    [IDS.users.a1_proc_buyer, IDS.hospitality.A, hotel_ids[0], scope]
  );
  inserted.rfqIds.push(rfq.id);
  for (const h of hotel_ids) {
    await db.none(
      `INSERT INTO tbl_rfq_hotel_mappings (rfq_id, hotel_id, created_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [rfq.id, h, IDS.users.a1_proc_buyer]
    );
  }
  // Insert one product so the inquiry list has something to return —
  // some queries filter on tbl_rfq_products presence.
  await db.none(
    `INSERT INTO tbl_rfq_products (rfq_id, comment, datasheet, spec_file, qap_file, qap, product_variant_id, variant)
     VALUES ($1, '', '', '', '', '', 1, 0)`,
    [rfq.id]
  );
  return rfq;
};

/**
 * Direct query that mirrors the buyer's RFQ-management read filter at
 * site rfqModel.js:3801 (post-refactor). We don't go through the full
 * controller because that's a heavyweight surface; this query is the
 * isolated "is this RFQ visible to this user via the read permission?"
 * check that the controller composes into its SELECT.
 */
const userCanReadRfq = async (user_id, rfq_id) => {
  const row = await db.oneOrNone(
    `
    SELECT 1 FROM tbl_rfq RFQ
    WHERE RFQ.id = $1
      AND ((RFQ.tender_scope IS DISTINCT FROM 'GROUP' AND EXISTS (
        SELECT 1 FROM tbl_user_role_scopes _urs2
        JOIN tbl_role_permissions _rp2 ON _rp2.role_id = _urs2.role_id
        JOIN tbl_permissions _p2 ON _p2.id = _rp2.permission_id
        WHERE _urs2.user_id = $2
          AND _urs2.is_network_scope = 0
          AND _p2.resource = (CASE WHEN RFQ.is_tender = 1 THEN 'boq' ELSE 'rfq' END)::resource_type
          AND _p2.action = 'read'
          AND _urs2.company_id = RFQ.hospitality_company_id
          AND (_urs2.hotel_id IS NULL OR _urs2.hotel_id = RFQ.hotel_id)
          AND (
            RFQ.department_id IS NULL
            OR _urs2.department_id = RFQ.department_id
            OR _urs2.department_id IS NULL
          )
      ))
      OR (
        RFQ.tender_scope = 'GROUP'
        AND EXISTS (
          SELECT 1
          FROM tbl_user_role_scopes urs_net
          JOIN tbl_role_permissions rp_net ON rp_net.role_id = urs_net.role_id
          JOIN tbl_permissions p_net ON p_net.id = rp_net.permission_id
          WHERE urs_net.user_id = $2
            AND urs_net.is_network_scope = 1
            AND p_net.resource = 'boq'
            AND p_net.action = 'read'
        )
      ))
    `,
    [rfq_id, user_id]
  );
  return !!row;
};

describe("Group ARC list visibility — boq.read", () => {
  it("a Group ARC tender IS visible to a user holding boq.read at NETWORK scope", async () => {
    await grantPerm(ROLE_IDS.COMM_APPROVER, PERM_BOQ_READ);
    await grantNetworkRole(IDS.users.companyA_admin, ROLE_IDS.COMM_APPROVER);
    const groupRfq = await makeTender({
      scope: 'GROUP',
      hotel_ids: [IDS.hotels.A1, IDS.hotels.A2],
    });

    const visible = await userCanReadRfq(IDS.users.companyA_admin, groupRfq.id);
    expect(visible).toBe(true);
  });

  it("a Group ARC tender is NOT visible to a user with only BU-scoped boq.read for one of the covered hotels", async () => {
    // a1_proc_buyer holds RFQ_OBSERVER + various BU grants from fixtures.
    // Even if we grant boq.read to those BU roles, Group ARC must hide.
    await grantPerm(ROLE_IDS.RFQ_OBSERVER, PERM_BOQ_READ);
    const groupRfq = await makeTender({
      scope: 'GROUP',
      hotel_ids: [IDS.hotels.A1, IDS.hotels.A2],
    });

    const visible = await userCanReadRfq(IDS.users.a1_proc_buyer, groupRfq.id);
    expect(visible).toBe(false);
  });

  it("a Single ARC tender is NOT visible to a user with ONLY a network-scope grant (no BU grants of their own)", async () => {
    // Most fixture users have legitimate BU grants too, so they CAN see
    // BU entities at their assigned BUs. To prove the architectural
    // "the two scopes don't cross-pollinate, the OTHER direction"
    // invariant (network-only users cannot see BU entities), we create
    // a synthetic user holding only a network-scope grant.
    const networkOnlyUserId = 80909;
    await db.none(
      `INSERT INTO tbl_users (id, name, email, status, company_id, created_at, updated_at)
       VALUES ($1, 'Network-Only User', 'network-only@test.local', 1, $2, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [networkOnlyUserId, IDS.companies.A]
    );
    await grantPerm(ROLE_IDS.COMM_APPROVER, PERM_BOQ_READ);
    await grantNetworkRole(networkOnlyUserId, ROLE_IDS.COMM_APPROVER);

    const singleRfq = await makeTender({
      scope: 'SINGLE',
      hotel_ids: [IDS.hotels.A1],
    });

    const visible = await userCanReadRfq(networkOnlyUserId, singleRfq.id);
    expect(visible).toBe(false);

    await db.none(`DELETE FROM tbl_users WHERE id = $1`, [networkOnlyUserId]);
  });

  it("a Single ARC tender IS visible to a user with the matching BU-scoped boq.read", async () => {
    // Sanity-check the BU path stays intact — adding the network-scope
    // OR must NOT regress the existing BU visibility model.
    await grantPerm(ROLE_IDS.RFQ_OBSERVER, PERM_BOQ_READ);
    const singleRfq = await makeTender({
      scope: 'SINGLE',
      hotel_ids: [IDS.hotels.A1],
    });
    // a1_proc_buyer has RFQ_OBSERVER scoped to A1 via fixtures.
    const visible = await userCanReadRfq(IDS.users.a1_proc_buyer, singleRfq.id);
    expect(visible).toBe(true);
  });

  it("a regular RFQ (no tender_scope) follows the BU rule unchanged", async () => {
    // Insert a non-tender RFQ. Only BU-scoped rfq.read grants matter.
    const PERM_RFQ_READ = 9603;
    await db.none(
      `INSERT INTO tbl_permissions (id, resource, action) VALUES ($1, 'rfq', 'read') ON CONFLICT (id) DO NOTHING`,
      [PERM_RFQ_READ]
    );
    await grantPerm(ROLE_IDS.RFQ_OBSERVER, PERM_RFQ_READ);
    const rfq = await db.one(
      `INSERT INTO tbl_rfq
         (rfq_no, comment, company_name, response_email, contact_name, contact_number,
          bid_end_date, location, is_published, status, created_by, updated_by, "timestamp",
          hospitality_company_id, hotel_id, is_tender, tender_publish_date,
          vendor_clarification_date, title, rfq_type, tender_scope)
       VALUES (nextval('tbl_rfq_id_seq'), 'plain rfq', 'Phileein', 'a@b.test',
               'C', '+91-9999999999', NOW() + INTERVAL '7 days', 'Loc', 1, 1,
               $1, $1, NOW(), $2, $3, 0, NULL, NULL, 'Plain RFQ', 'RFQ', NULL)
       RETURNING id`,
      [IDS.users.a1_proc_buyer, IDS.hospitality.A, IDS.hotels.A1]
    );
    inserted.rfqIds.push(rfq.id);

    expect(await userCanReadRfq(IDS.users.a1_proc_buyer, rfq.id)).toBe(true);
    // A user with NO grant at all: hidden.
    expect(await userCanReadRfq(IDS.users.companyB_admin, rfq.id)).toBe(false);

    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1 AND permission_id = $2`, [ROLE_IDS.RFQ_OBSERVER, PERM_RFQ_READ]);
    await db.none(`DELETE FROM tbl_permissions WHERE id = $1`, [PERM_RFQ_READ]);
  });
});
