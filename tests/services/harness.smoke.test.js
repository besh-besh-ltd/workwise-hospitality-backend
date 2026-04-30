// Smoke test for the test harness itself.
// Verifies that:
//   1. The test DB is reachable via the same connection model as production.
//   2. Reference data was seeded (sanity row counts).
//   3. withTx rolls back uncommitted writes.
//   4. withTx re-throws errors raised inside the body.
//   5. truncateDynamic empties dynamic tables without touching reference data.

import { describe, it, expect, afterAll } from "@jest/globals";
import { db, withTx, truncateDynamic, closeDb } from "../setup/db.js";

describe("test harness", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("connects to hospitality_test_<runId>", async () => {
    const { current_database } = await db.one("SELECT current_database()");
    expect(current_database).toMatch(/^hospitality_test(_[a-zA-Z0-9_-]+)?$/);
  });

  it("has reference data seeded", async () => {
    const counts = await db.one(`
      SELECT
        (SELECT count(*)::int FROM tbl_roles) AS roles,
        (SELECT count(*)::int FROM tbl_permissions) AS permissions,
        (SELECT count(*)::int FROM tbl_role_permissions) AS role_permissions,
        (SELECT count(*)::int FROM tbl_approval_processes) AS approval_processes,
        (SELECT count(*)::int FROM tbl_category) AS category,
        (SELECT count(*)::int FROM tbl_country_code) AS country_code
    `);
    expect(counts.roles).toBeGreaterThanOrEqual(21);
    expect(counts.permissions).toBeGreaterThanOrEqual(31);
    expect(counts.role_permissions).toBeGreaterThanOrEqual(138);
    expect(counts.approval_processes).toBeGreaterThanOrEqual(3);
    expect(counts.category).toBeGreaterThanOrEqual(188);
    expect(counts.country_code).toBeGreaterThanOrEqual(247);
  });

  it("withTx rolls back writes on success", async () => {
    // Create a real table inside the transaction and insert into it. After the
    // tx rolls back the table must not exist.
    const tableName = `_harness_${Date.now()}`;
    await withTx(async (t) => {
      await t.none(`CREATE TABLE public.${tableName} (id int PRIMARY KEY, v text)`);
      await t.none(`INSERT INTO public.${tableName} VALUES (1, 'hello'), (2, 'world')`);
      const inside = await t.one(`SELECT count(*)::int AS n FROM public.${tableName}`);
      expect(inside.n).toBe(2);
    });
    const exists = await db.oneOrNone(
      `SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1`,
      [tableName]
    );
    expect(exists).toBeNull();
  });

  it("withTx still rolls back on error inside fn (and re-throws the error)", async () => {
    const tableName = `_harness_err_${Date.now()}`;
    await expect(
      withTx(async (t) => {
        await t.none(`CREATE TABLE public.${tableName} (id int)`);
        throw new Error("simulated test failure");
      })
    ).rejects.toThrow("simulated test failure");
    const exists = await db.oneOrNone(
      `SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1`,
      [tableName]
    );
    expect(exists).toBeNull();
  });

  it("truncateDynamic empties dynamic tables AND auto-restores fixture data nuked by CASCADE", async () => {
    // CONTEXT: `TRUNCATE tbl_rfq … CASCADE` chains through
    // `tbl_vendor_payments` → `tbl_vendor_hotel_category_subscription`
    // (Postgres cascades on every FK referencing the truncated table). That
    // wipes the vendor-subscription fixtures other suites depend on. The
    // helper compensates by re-seeding subscriptions immediately after the
    // truncate. This smoke test asserts ALL THREE invariants:
    //   1. dynamic tables ARE emptied (the helper's primary job)
    //   2. reference data (tbl_roles, tbl_permissions, tbl_category) unchanged
    //   3. vendor fixture subscriptions ARE restored after the cascade
    //
    // If a future fix changes truncateDynamic to avoid the cascade entirely
    // (e.g. by drop-FK / restore-FK around the truncate), invariants 2 and 3
    // still hold; the test stays green.

    const refBefore = await db.one(`
      SELECT
        (SELECT count(*)::int FROM tbl_roles)             AS roles,
        (SELECT count(*)::int FROM tbl_permissions)       AS permissions,
        (SELECT count(*)::int FROM tbl_category)          AS category,
        (SELECT count(*)::int FROM tbl_vendor_hotel_category_subscription) AS vendor_subs
    `);

    await truncateDynamic();

    const refAfter = await db.one(`
      SELECT
        (SELECT count(*)::int FROM tbl_roles)             AS roles,
        (SELECT count(*)::int FROM tbl_permissions)       AS permissions,
        (SELECT count(*)::int FROM tbl_category)          AS category,
        (SELECT count(*)::int FROM tbl_vendor_hotel_category_subscription) AS vendor_subs
    `);

    // Reference data untouched.
    expect(refAfter.roles).toBe(refBefore.roles);
    expect(refAfter.permissions).toBe(refBefore.permissions);
    expect(refAfter.category).toBe(refBefore.category);

    // Vendor subscriptions: nuked by CASCADE then restored. Count is the
    // same as before (assertion #3).
    expect(refAfter.vendor_subs).toBe(refBefore.vendor_subs);

    // Dynamic tables emptied.
    const dynCount = await db.one(`
      SELECT
        (SELECT count(*)::int FROM tbl_rfq)                  AS rfq,
        (SELECT count(*)::int FROM tbl_quotes)               AS quotes,
        (SELECT count(*)::int FROM tbl_approval_instances)   AS approval_instances,
        (SELECT count(*)::int FROM tbl_notifications)        AS notifications
    `);
    expect(dynCount.rfq).toBe(0);
    expect(dynCount.quotes).toBe(0);
    expect(dynCount.approval_instances).toBe(0);
    expect(dynCount.notifications).toBe(0);
  });
});
