import { db, withTx } from "../setup/db.js";
import { seedVendorEntity, seedPerson, seedOrg, addEntity, addMember, cleanupVendorNetworkFixtures } from "../helpers/vendorNetworkSeed.js";

const NEW_TABLES = {
  tbl_vendor_orgs: ["id", "name", "principal_vendor_id", "routing_mode", "routing_timeout_hours", "created_by", "created_at", "updated_at"],
  tbl_vendor_org_entities: ["id", "org_id", "vendor_id", "relationship", "status", "preference_rank", "invited_by", "linked_at", "removed_at"],
  tbl_vendor_org_link_invites: ["id", "org_id", "target_vendor_id", "relationship", "token_hash", "status", "expires_at", "created_by", "acted_at"],
  tbl_vendor_org_members: ["id", "org_id", "person_user_id", "entity_vendor_id", "role", "status", "invite_token_hash", "invite_expires_at", "invited_by"],
  tbl_vendor_coverage_rules: ["id", "entity_vendor_id", "scope_type", "scope_id", "mode", "category_id", "created_by"],
  tbl_vendor_routing_assignments: ["id", "org_id", "subject_type", "subject_id", "hotel_id", "assigned_vendor_id", "status", "decline_reason", "decline_note", "due_at", "auto_routed", "assigned_by_user_id", "acted_by_user_id", "acted_at"],
  tbl_vendor_network_seats: ["id", "org_id", "entity_vendor_id", "fee_amount", "start_date", "end_date", "status", "payment_id"],
};

// Each violation runs in its own savepoint so the outer transaction survives.
const rejects = (t, sql, params, re = /unique|check/i) =>
  expect(t.tx((s) => s.none(sql, params))).rejects.toThrow(re);

async function world(t) {
  await seedVendorEntity({ id: 95001, companyId: 95001, name: "VN HQ", email: "vn-hq@test.local", runner: t });
  await seedVendorEntity({ id: 95002, companyId: 95002, name: "VN Branch", email: "vn-br@test.local", runner: t });
  await seedOrg({ id: 95001, principalVendorId: 95001, name: "VN Org", runner: t });
  await addEntity({ orgId: 95001, vendorId: 95002, runner: t });
}

describe("vendor network schema", () => {
  it("creates every table and column", async () => {
    await withTx(async (t) => {
      for (const [table, cols] of Object.entries(NEW_TABLES)) {
        const rows = await t.any(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
          [table]
        );
        const have = rows.map((r) => r.column_name);
        expect({ table, missing: cols.filter((c) => !have.includes(c)) }).toEqual({ table, missing: [] });
      }
      const extra = await t.any(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE (table_name='tbl_hospitality_company_hotels' AND column_name IN ('state_id','city_id'))
             OR (table_name='tbl_rfq_product_vendors' AND column_name='routed_from_vendor_id')`
      );
      expect(extra).toHaveLength(3);
    });
  });

  it("rejects a second live org membership of one entity", async () => {
    await withTx(async (t) => {
      await world(t);
      await seedVendorEntity({ id: 95003, companyId: 95003, name: "VN HQ2", email: "vn-hq2@test.local", runner: t });
      await seedOrg({ id: 95002, principalVendorId: 95003, name: "VN Org2", runner: t });
      await rejects(
        t,
        `INSERT INTO tbl_vendor_org_entities (org_id, vendor_id, relationship, status) VALUES (95002, 95002, 'BRANCH', 'ACTIVE')`
      );
      // a REMOVED row does not count as live
      await t.none(`UPDATE tbl_vendor_org_entities SET status='REMOVED' WHERE vendor_id=95002`);
      await t.none(
        `INSERT INTO tbl_vendor_org_entities (org_id, vendor_id, relationship, status) VALUES (95002, 95002, 'BRANCH', 'ACTIVE')`
      );
    });
  });

  it("rejects a second PRINCIPAL per org", async () => {
    await withTx(async (t) => {
      await world(t);
      await seedVendorEntity({ id: 95004, companyId: 95004, name: "VN Other", email: "vn-o@test.local", runner: t });
      await rejects(
        t,
        `INSERT INTO tbl_vendor_org_entities (org_id, vendor_id, relationship, status) VALUES (95001, 95004, 'PRINCIPAL', 'ACTIVE')`
      );
    });
  });

  it("rejects ORG_ADMIN with an entity and ENTITY_MEMBER without one", async () => {
    await withTx(async (t) => {
      await world(t);
      await seedPerson({ id: 95010, email: "vn-p@test.local", name: "VN P", runner: t });
      await rejects(
        t,
        `INSERT INTO tbl_vendor_org_members (org_id, person_user_id, entity_vendor_id, role, status)
         VALUES (95001, 95010, 95002, 'ORG_ADMIN', 'ACTIVE')`,
        [],
        /check/i
      );
      await rejects(
        t,
        `INSERT INTO tbl_vendor_org_members (org_id, person_user_id, entity_vendor_id, role, status)
         VALUES (95001, 95010, NULL, 'ENTITY_MEMBER', 'ACTIVE')`,
        [],
        /check/i
      );
    });
  });

  it.each(["PENDING", "ACCEPTED"])("rejects a second %s assignment per subject+hotel", async (status) => {
    await withTx(async (t) => {
      await world(t);
      const ins = `INSERT INTO tbl_vendor_routing_assignments
        (org_id, subject_type, subject_id, hotel_id, assigned_vendor_id, status)
        VALUES (95001, 'RFQ', 95001, NULL, $1, '${status}')`;
      await t.none(ins, [95001]);
      await rejects(t, ins, [95002]);
      // a different state for the same subject is fine
      await t.none(
        `INSERT INTO tbl_vendor_routing_assignments (org_id, subject_type, subject_id, assigned_vendor_id, status)
         VALUES (95001, 'RFQ', 95001, 95002, 'DECLINED')`
      );
    });
  });

  it("allows payment_type network_seat", async () => {
    await withTx(async (t) => {
      await world(t);
      await t.none(
        `INSERT INTO tbl_vendor_payments (vendor_id, amount, payment_type) VALUES (95001, 0, 'network_seat')`
      );
      await rejects(t, `INSERT INTO tbl_vendor_payments (vendor_id, amount, payment_type) VALUES (95001, 0, 'bogus')`);
    });
  });

  it("cleanupVendorNetworkFixtures removes every committed fixture row", async () => {
    await cleanupVendorNetworkFixtures();
    try {
      await world(db);
      await seedPerson({ id: 95010, email: "vn-p@test.local", name: "VN P", runner: db });
      await addMember({ orgId: 95001, personId: 95010, entityVendorId: 95002, role: "ENTITY_MEMBER", runner: db });
    } finally {
      await cleanupVendorNetworkFixtures();
    }
    const left = await db.one(
      `SELECT (SELECT count(*) FROM tbl_users WHERE id BETWEEN 95001 AND 95999)::int
            + (SELECT count(*) FROM tbl_company WHERE id BETWEEN 95001 AND 95999)::int
            + (SELECT count(*) FROM tbl_vendor_orgs WHERE id BETWEEN 95001 AND 95999)::int
            + (SELECT count(*) FROM tbl_vendor_network_seats)::int AS n`
    );
    expect(left.n).toBe(0);
  });
});
