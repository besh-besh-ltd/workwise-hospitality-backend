/**
 * A company can be granted to a user once.
 *
 * Production held the same company-level grant two to five times for four
 * buyers: the unique key compared hospitality_hotel_id, which is NULL for a
 * company-level grant, and Postgres treats NULLs as distinct. The migration
 * collapses each duplicated grant to its oldest row and re-creates the key as
 * NULLS NOT DISTINCT. These run the real files against the test database.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import {
  dropUserMappingUnique,
  userMappingUniqueDef,
} from "../helpers/userMappingConstraint.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UP = fs.readFileSync(path.join(ROOT, "migrations/20261024120000_user_mapping_nulls_not_distinct.sql"), "utf8");
const DOWN = fs.readFileSync(path.join(ROOT, "migrations/20261024120000_user_mapping_nulls_not_distinct.down.sql"), "utf8");

// A user with no grant in Company B, so every row for this key is the test's own.
const USER = IDS.users.a1_eng_buyer;
const COMPANY = IDS.hospitality.B;

const projectKeyDef = async () =>
  (await db.one(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'public.tbl_hospitality_project_mappings'::regclass
        AND conname = 'uq_hospitality_project_mapping'`
  )).def;

const grantRows = () =>
  db.any(
    `SELECT id, auto_map_projects
       FROM tbl_hospitality_user_mappings
      WHERE user_id = $1 AND hospitality_company_id = $2 AND mapping_type = 0
      ORDER BY id`,
    [USER, COMPANY]
  );

const grant = (autoMap) =>
  db.one(
    `INSERT INTO tbl_hospitality_user_mappings
       (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, auto_map_projects, created_by)
     VALUES ($1, $2, NULL, 0, $3, $4)
     RETURNING id`,
    [USER, COMPANY, autoMap, IDS.users.superAdmin]
  );

afterAll(async () => {
  // Whatever happened above, leave the schema migrated for the suites after.
  await db.none(
    `DELETE FROM tbl_hospitality_user_mappings WHERE user_id = $1 AND hospitality_company_id = $2`,
    [USER, COMPANY]
  );
  await db.none(UP);
  await closeDb();
});

describe("20261024120000_user_mapping_nulls_not_distinct", () => {
  it("collapses a duplicated company grant to its oldest row, keeping auto-map if any copy had it", async () => {
    await dropUserMappingUnique();
    const first = await grant(false);
    await grant(true);
    await grant(false);
    const hotelGrant = await db.one(
      `INSERT INTO tbl_hospitality_user_mappings
         (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, auto_map_projects, created_by)
       VALUES ($1, $2, $3, 1, false, $4)
       RETURNING id`,
      [USER, COMPANY, IDS.hotels.B1, IDS.users.superAdmin]
    );

    await db.none(UP);

    expect(await grantRows()).toEqual([{ id: first.id, auto_map_projects: true }]);
    // The business-unit grant for the same company is a different grant.
    const kept = await db.oneOrNone(`SELECT id FROM tbl_hospitality_user_mappings WHERE id = $1`, [hotelGrant.id]);
    expect(kept).toEqual({ id: hotelGrant.id });
  });

  it("refuses a second company-level grant afterwards", async () => {
    expect(await userMappingUniqueDef()).toMatch(/NULLS NOT DISTINCT/);
    expect(await projectKeyDef()).toMatch(/NULLS NOT DISTINCT/);

    await expect(grant(true)).rejects.toMatchObject({ code: "23505" });
    expect(await grantRows()).toHaveLength(1);
  });

  it("re-running it changes nothing", async () => {
    const before = await grantRows();
    await db.none(UP);
    expect(await grantRows()).toEqual(before);
    expect(await userMappingUniqueDef()).toMatch(/NULLS NOT DISTINCT/);
  });

  it("reverses to the plain key, and re-applies cleanly", async () => {
    await db.none(DOWN);
    expect(await userMappingUniqueDef()).not.toMatch(/NULLS NOT DISTINCT/);
    expect(await projectKeyDef()).not.toMatch(/NULLS NOT DISTINCT/);

    await db.none(UP);
    expect(await userMappingUniqueDef()).toMatch(/NULLS NOT DISTINCT/);
    expect(await projectKeyDef()).toMatch(/NULLS NOT DISTINCT/);
  });

  // Rebuilding a key takes an exclusive lock, and nearly every request reads
  // tbl_hospitality_user_mappings (the hospitality-context check). If a long
  // transaction holds the project table, the migration must give up — and
  // leave nothing half-applied — rather than hold the user table locked while
  // it waits, queueing every request behind it.
  it("gives up rather than wait behind a long transaction, changing nothing", async () => {
    await db.none(DOWN); // so the keys need rebuilding
    const holder = await db.connect();
    const runner = await db.connect();
    let timer;
    try {
      await holder.none("BEGIN");
      await holder.any("SELECT 1 FROM tbl_hospitality_project_mappings LIMIT 1");

      const outcome = await Promise.race([
        runner.none(UP).then(() => "applied", (e) => e),
        new Promise((resolve) => { timer = setTimeout(() => resolve("still waiting"), 15000); }),
      ]);
      expect(outcome).toMatchObject({ code: "55P03" }); // lock_not_available
    } finally {
      clearTimeout(timer);
      await holder.none("ROLLBACK").catch(() => {});
      holder.done();
      await runner.none("ROLLBACK").catch(() => {});
      runner.done();
    }

    expect(await userMappingUniqueDef()).not.toMatch(/NULLS NOT DISTINCT/);
    await db.none(UP);
    expect(await userMappingUniqueDef()).toMatch(/NULLS NOT DISTINCT/);
    expect(await projectKeyDef()).toMatch(/NULLS NOT DISTINCT/);
  }, 40000);
});
