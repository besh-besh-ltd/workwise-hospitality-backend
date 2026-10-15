import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, withTx, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { TEST_CATEGORIES } from "../fixtures/vendors.js";
import { makeRFQ } from "../factories/rfq.js";
import { seedVendorEntity, seedPerson, seedOrg, addEntity, addMember, cleanupVendorNetworkFixtures } from "../helpers/vendorNetworkSeed.js";

const NEW_TABLES = {
  tbl_vendor_orgs: ["id", "name", "principal_vendor_id", "routing_mode", "routing_timeout_hours", "created_by", "created_at", "updated_at"],
  tbl_vendor_org_entities: ["id", "org_id", "vendor_id", "relationship", "status", "preference_rank", "invited_by", "linked_at", "removed_at"],
  tbl_vendor_org_link_invites: ["id", "org_id", "target_vendor_id", "relationship", "addressed_by", "token_hash", "status", "expires_at", "created_by", "acted_at"],
  tbl_vendor_org_members: ["id", "org_id", "person_user_id", "entity_vendor_id", "role", "status", "invite_token_hash", "invite_expires_at", "invited_by"],
  tbl_vendor_coverage_rules: ["id", "entity_vendor_id", "scope_type", "scope_id", "mode", "category_id", "created_by"],
  tbl_vendor_routing_assignments: ["id", "org_id", "subject_type", "subject_id", "hotel_id", "assigned_vendor_id", "status", "decline_reason", "decline_note", "due_at", "auto_routed", "assigned_by_user_id", "acted_by_user_id", "acted_at"],
  tbl_vendor_network_seats: ["id", "org_id", "entity_vendor_id", "fee_amount", "start_date", "end_date", "status", "payment_id"],
};

// The network tables with a log_changes_direct row-audit trigger (spec §10.10), sorted.
const AUDITED = [
  "tbl_vendor_coverage_rules",
  "tbl_vendor_org_entities",
  "tbl_vendor_org_link_invites",
  "tbl_vendor_org_members",
  "tbl_vendor_orgs",
];

// Release the harness pool so teardown's DROP DATABASE does not kill idle clients mid-log
// ("Cannot log after tests are done").
afterAll(closeDb);

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

  it("allows one PENDING link invite per org and target, and only ID/EMAIL addressing", async () => {
    await withTx(async (t) => {
      await world(t);
      await seedVendorEntity({ id: 95004, companyId: 95004, name: "VN Target", email: "vn-tg@test.local", runner: t });
      const ins = (hash, extra = "") =>
        `INSERT INTO tbl_vendor_org_link_invites (org_id, target_vendor_id, relationship, token_hash, status, expires_at, created_by${extra ? ", addressed_by" : ""})
         VALUES (95001, 95004, 'BRANCH', '${hash}', 'PENDING', now() + interval '7 days', 95001${extra})`;
      await t.none(ins("h1"));
      await rejects(t, ins("h2"));
      await rejects(t, ins("h3", ", 'PHONE'"));
      await t.none(`UPDATE tbl_vendor_org_link_invites SET status = 'EXPIRED' WHERE token_hash = 'h1'`);
      await t.none(ins("h4", ", 'EMAIL'"));
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

  it.each(["PENDING", "ACCEPTED"])("rejects a second %s assignment per org+subject+hotel; another org may hold its own", async (status) => {
    await withTx(async (t) => {
      await world(t);
      await seedVendorEntity({ id: 95003, companyId: 95003, name: "VN Other HQ", email: "vn-ohq@test.local", runner: t });
      await seedVendorEntity({ id: 95004, companyId: 95004, name: "VN Other Br", email: "vn-obr@test.local", runner: t });
      await seedOrg({ id: 95002, principalVendorId: 95003, name: "VN Other Org", runner: t });
      await addEntity({ orgId: 95002, vendorId: 95004, runner: t });
      await t.none(
        `INSERT INTO tbl_vendor_routing_assignments (org_id, subject_type, subject_id, hotel_id, assigned_vendor_id, status)
         VALUES (95002, 'RFQ', 95001, NULL, 95004, '${status}')`
      );
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

  // The engine maps a 23505 to 409 only for these index NAMES (ROUTING_UNIQUE_INDEXES),
  // and they must be per org (several orgs may route the same RFQ).
  it("names the routing unique indexes as the engine expects, keyed by org_id", async () => {
    const { ROUTING_UNIQUE_INDEXES } = await import("../../app/models/vendorRoutingModel.js");
    expect([...ROUTING_UNIQUE_INDEXES].sort()).toEqual(["ix_vn_assign_org_one_accepted", "ix_vn_assign_org_one_pending"]);
    const rows = await db.any(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'tbl_vendor_routing_assignments'
          AND indexname = ANY($1::text[])
        ORDER BY indexname`,
      [["ix_vn_assign_org_one_pending", "ix_vn_assign_org_one_accepted"]]
    );
    expect(rows.map((r) => r.indexname)).toEqual(["ix_vn_assign_org_one_accepted", "ix_vn_assign_org_one_pending"]);
    for (const { indexdef } of rows) {
      expect(indexdef).toMatch(/^CREATE UNIQUE INDEX/);
      expect(indexdef).toMatch(/\(org_id, subject_type, subject_id, COALESCE\(hotel_id, 0\)\)/);
    }
    expect(rows[0].indexdef).toContain("'ACCEPTED'");
    expect(rows[1].indexdef).toContain("'PENDING'");
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

  it("hotel backfill leaves ambiguous city names NULL but sets the state", async () => {
    await withTx(async (t) => {
      const st = await t.one(`INSERT INTO tbl_location_states (id, state_name, country_id) VALUES (95001, 'VN Testland', 1) RETURNING id`);
      await t.none(`INSERT INTO tbl_location_cities (id, city_name, state_id) VALUES (95001, 'Dupville', $1), (95002, ' dupville ', $1), (95003, 'Uniqton', $1)`, [st.id]);
      const co = await t.one(`SELECT id FROM tbl_hospitality_companies LIMIT 1`);
      const mk = (name, city) => t.one(
        `INSERT INTO tbl_hospitality_company_hotels (hospitality_company_id, name, city, state)
         VALUES ($1, $2, $3, 'vn testland') RETURNING id`, [co.id, name, city]);
      const dup = await mk("VN Dup Hotel", "Dupville");
      const uni = await mk("VN Uni Hotel", "Uniqton");
      await t.any(`SELECT vn_backfill_hotel_location_ids()`);
      const rows = await t.any(
        `SELECT id, state_id, city_id FROM tbl_hospitality_company_hotels WHERE id IN ($1, $2)`, [dup.id, uni.id]);
      const by = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(by[dup.id].state_id).toBe(st.id);
      expect(by[dup.id].city_id).toBeNull();
      expect(by[uni.id].state_id).toBe(st.id);
      expect(by[uni.id].city_id).not.toBeNull();
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
            + (SELECT count(*) FROM tbl_vendor_network_seats WHERE org_id BETWEEN 95001 AND 95999)::int AS n`
    );
    expect(left.n).toBe(0);
  });

  // up → down → up on a seeded world, inside one rolled-back transaction (PG DDL is
  // transactional), so the shared test DB is never left without the network schema.
  it("down migration drops unquoted routed copies, keeps quoted ones as plain invites, resets call-off fulfilment; up re-applies", async () => {
    const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
    const sql = (f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    await withTx(async (t) => {
      await world(t); // HQ 95001 principal, B 95002 branch
      await seedVendorEntity({ id: 95003, companyId: 95003, name: "VN C", email: "vn-c@test.local", runner: t });
      await addEntity({ orgId: 95001, vendorId: 95003, runner: t });
      const BUYER = IDS.users.a1_proc_buyer;
      const variant = (await t.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`)).id;
      const { rfq_id, rfq_no } = await makeRFQ(t, { createdBy: BUYER, status: 1, is_published: 1 });
      const rpv = (user, routedFrom) =>
        t.none(
          `INSERT INTO tbl_rfq_product_vendors (rfq_id, product_variant_id, user_id, variant, routed_from_vendor_id)
           VALUES ($1, $2, $3, 0, $4)`,
          [rfq_id, variant, user, routedFrom]
        );
      await rpv(95001, null); // the principal's real invite
      await rpv(95002, 95001); // routed to B, B never quoted
      await rpv(95003, 95001); // routed to C, C quoted
      await t.none(
        `INSERT INTO tbl_quotes (rfq_id, rfq_no, created_by, updated_by, status) VALUES ($1, $2, 95003, 95003, 1)`,
        [rfq_id, rfq_no]
      );

      const arcId = (
        await t.one(
          `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
                                status, is_group, contract_start_at, contract_end_at, created_by)
           VALUES ('ARC-VN-DOWN-' || floor(random() * 1e9)::text, 'Down', $1, $2, $3, $4,
                   'contract_active', true, NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', $5)
           RETURNING id`,
          [TEST_CATEGORIES.beverages, IDS.hospitality.A, IDS.hotels.A1, IDS.departments.proc, BUYER]
        )
      ).id;
      const itemId = (
        await t.one(
          `INSERT INTO tbl_arc_item (arc_id, product_variant_id, indicative_qty, uom) VALUES ($1, $2, 10, 'pcs') RETURNING id`,
          [arcId, variant]
        )
      ).id;
      const contractId = (
        await t.one(`INSERT INTO tbl_arc_contract (arc_id, vendor_id, status) VALUES ($1, 95001, 'active') RETURNING id`, [arcId])
      ).id;
      const lineId = (
        await t.one(
          `INSERT INTO tbl_arc_contract_line (arc_contract_id, arc_item_id, unit_rate, gst_pct, committed_qty)
           VALUES ($1, $2, 90, 5, 10) RETURNING id`,
          [contractId, itemId]
        )
      ).id;
      await t.none(
        `INSERT INTO tbl_arc_contract_line_hotel (arc_contract_line_id, hotel_id, committed_qty, fulfilling_vendor_id)
         VALUES ($1, $2, 6, 95002), ($1, $3, 4, NULL)`,
        [lineId, IDS.hotels.A1, IDS.hotels.A2]
      );

      // F4: a network person, a paid seat payment and an unrelated payment.
      await seedPerson({ id: 95004, email: "vn-down-person@test.local", name: "VN Down Person", runner: t });
      await t.none(
        `INSERT INTO tbl_vendor_payments (vendor_id, amount, payment_type) VALUES (95001, 500, 'network_seat'), (95001, 700, 'hospitality')`
      );

      await t.multi(sql("20261006100000_vendor_networks.down.sql"));
      // Idempotent: a second run is a no-op, never an error.
      await t.multi(sql("20261006100000_vendor_networks.down.sql"));

      // Type-11 persons can no longer log in anywhere (the old admin gate admits NOT IN (2,3,4)).
      expect(await t.one(`SELECT status, is_deleted FROM tbl_users WHERE id = 95004`)).toEqual({ status: 0, is_deleted: 1 });
      // Seat payments are gone, so the restored CHECK applied; other payments stay.
      expect((await t.any(`SELECT payment_type FROM tbl_vendor_payments WHERE vendor_id = 95001`)).map((r) => r.payment_type)).toEqual(["hospitality"]);
      await expect(
        t.tx((s2) => s2.none(`INSERT INTO tbl_vendor_payments (vendor_id, amount, payment_type) VALUES (95001, 1, 'network_seat')`))
      ).rejects.toThrow(/check/i);

      const invites = await t.any(
        `SELECT user_id FROM tbl_rfq_product_vendors WHERE rfq_id = $1 ORDER BY user_id`,
        [rfq_id]
      );
      expect(invites.map((r) => r.user_id)).toEqual([95001, 95003]);
      const fulfil = await t.any(
        `SELECT fulfilling_vendor_id FROM tbl_arc_contract_line_hotel WHERE arc_contract_line_id = $1`,
        [lineId]
      );
      expect(fulfil.map((r) => r.fulfilling_vendor_id)).toEqual([null, null]);
      const left = await t.one(
        `SELECT to_regclass('public.tbl_vendor_orgs') AS orgs,
                EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tbl_rfq_product_vendors'
                          AND column_name = 'routed_from_vendor_id') AS routed_col`
      );
      expect(left).toEqual({ orgs: null, routed_col: false });

      await t.multi(sql("20261006100000_vendor_networks.sql"));
      for (const table of Object.keys(NEW_TABLES)) {
        expect((await t.one(`SELECT to_regclass($1) AS r`, [`public.${table}`])).r).not.toBeNull();
      }
      // F5: the row-audit triggers come back with the tables, exactly once each.
      const triggers = await t.any(
        `SELECT c.relname AS tbl, t.tgname AS trg FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND t.tgfoid = 'public.log_changes_direct'::regproc AND c.relname LIKE 'tbl_vendor_%'
          ORDER BY 1`
      );
      expect(triggers.map((r) => [r.tbl, r.trg])).toEqual(AUDITED.map((x) => [x, `${x}_audit`]));
      const back = await t.any(
        `SELECT user_id, routed_from_vendor_id FROM tbl_rfq_product_vendors WHERE rfq_id = $1 ORDER BY user_id`,
        [rfq_id]
      );
      expect(back).toEqual([
        { user_id: 95001, routed_from_vendor_id: null },
        { user_id: 95003, routed_from_vendor_id: null },
      ]);
    });
  });
});
