/**
 * A new approval policy saves on a database that carries feat/arc's
 * chk_arc_policy_global_scope.
 *
 * The unmerged feat/arc branch added tbl_approval_policies.company_id and
 * .is_global, plus a CHECK that requires company_id on every row. It was
 * applied to staging by hand. Our schema has neither column and
 * createApprovalPolicy never writes company_id, so on staging every new policy
 * was refused (QA, 2026-11-04: Unit ARC · Publish Approval and Unit ARC ·
 * Negotiation Round Approval).
 *
 * The test schema doesn't carry that drift, so this suite recreates it as
 * staging has it, shows the save failing over HTTP, runs the real migration
 * files and shows the save succeeding. Commit + cleanup: the drift is DDL the
 * app's own connections must see. afterAll removes it whatever happened.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION = "migrations/20261104100000_drop_stale_arc_policy_global_scope";
const UP = fs.readFileSync(path.join(ROOT, `${MIGRATION}.sql`), "utf8");
const DOWN = fs.readFileSync(path.join(ROOT, `${MIGRATION}.down.sql`), "utf8");

const ADMIN = 89095; // user_type 7 under buyer company A: policy writes are company-admin only
const HOTEL = IDS.hotels.A3;
const DEPT = IDS.departments.fb;
const QA_TYPES = ["ARC_PUBLISH", "ARC_NEGOTIATION"]; // the two stages QA could not save

// feat/arc's app/migrations/002-arc-global-hierarchy.sql, as staging carries it.
// The check is added NOT VALID only so that fixture rows don't have to satisfy
// it; new rows are checked exactly as on staging.
const STAGING_DRIFT = `
  ALTER TABLE public.tbl_approval_policies ADD COLUMN company_id integer;
  ALTER TABLE public.tbl_approval_policies ADD COLUMN is_global smallint NOT NULL DEFAULT 0;
  UPDATE public.tbl_approval_policies p
     SET company_id = hc.buyer_company_id
    FROM public.tbl_hospitality_companies hc
   WHERE p.hospitality_company_id = hc.id AND p.company_id IS NULL;
  ALTER TABLE public.tbl_approval_policies
    ADD CONSTRAINT chk_arc_policy_global_scope
    CHECK (
      (is_global = 1
         AND hospitality_company_id IS NULL
         AND hotel_id IS NULL
         AND department_id IS NULL
         AND process_id IS NULL
         AND company_id IS NOT NULL)
      OR
      (is_global = 0
         AND hospitality_company_id IS NOT NULL
         AND company_id IS NOT NULL)
    ) NOT VALID;
`;

const REMOVE_DRIFT = `
  ALTER TABLE public.tbl_approval_policies DROP CONSTRAINT IF EXISTS chk_arc_policy_global_scope;
  ALTER TABLE public.tbl_approval_policies DROP COLUMN IF EXISTS company_id;
  ALTER TABLE public.tbl_approval_policies DROP COLUMN IF EXISTS is_global;
`;

const hasColumn = async (name) =>
  (await db.one(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tbl_approval_policies' AND column_name = $1
     ) AS present`,
    [name]
  )).present;

const checkState = async () => {
  const row = await db.oneOrNone(
    `SELECT convalidated FROM pg_constraint
      WHERE conrelid = 'public.tbl_approval_policies'::regclass
        AND conname = 'chk_arc_policy_global_scope'`
  );
  return row ? { present: true, validated: row.convalidated } : { present: false };
};

const createdPolicies = () =>
  db.any(
    `SELECT id, entity_type FROM tbl_approval_policies
      WHERE hospitality_company_id = $1 AND hotel_id = $2 AND department_id = $3 AND created_by = $4
      ORDER BY entity_type`,
    [IDS.hospitality.A, HOTEL, DEPT, ADMIN]
  );

async function sweepCreatedPolicies() {
  const ids = (await createdPolicies()).map((p) => p.id);
  if (!ids.length) return;
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [ids]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [ids]);
}

/** The payload shape the Approval Wizard posts for a one-level policy. */
async function savePolicy(entityType) {
  const client = await httpClient(ADMIN);
  return client.post("/api/v1/general/hospitality/approval/policies").send({
    entity_type: entityType,
    hospitality_company_id: IDS.hospitality.A,
    hotel_id: HOTEL,
    department_id: DEPT,
    is_active: true,
    confirmed_approval_impact: true,
    steps: [{
      step_order: 1,
      decision_rule: "ANY",
      approval_type: "STANDARD",
      approver_source_type: "USER",
      approver_source_id: ADMIN,
    }],
  });
}

beforeAll(async () => {
  if ((await hasColumn("company_id")) || (await hasColumn("is_global"))) {
    throw new Error(
      "The test schema now has tbl_approval_policies.company_id/is_global (feat/arc's columns). " +
      "This suite recreates them itself and drops them afterwards: revisit it before relying on it."
    );
  }
  await db.none(
    `INSERT INTO tbl_users (id, name, email, mobile, password, user_type, status, company_id)
     VALUES ($1, 'Stale ARC Check Admin', 'stalearccheck.admin@test.local', '9000089095', 'x', 7, 1, $2)
     ON CONFLICT (id) DO UPDATE SET user_type = 7, status = 1, company_id = EXCLUDED.company_id`,
    [ADMIN, IDS.companies.A]
  );
  await sweepCreatedPolicies();
  await db.none(STAGING_DRIFT);
});

afterEach(sweepCreatedPolicies);

afterAll(async () => {
  try {
    await sweepCreatedPolicies();
    await db.none(REMOVE_DRIFT);
    await db.none(`DELETE FROM tbl_users WHERE id = $1`, [ADMIN]);
  } finally {
    await closeDb();
  }
});

describe("20261104100000_drop_stale_arc_policy_global_scope", () => {
  it.each(QA_TYPES)("with feat/arc's check in place, a new %s policy is refused (the staging failure)", async (entityType) => {
    const res = await savePolicy(entityType);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('violates check constraint "chk_arc_policy_global_scope"');
    expect(await createdPolicies()).toHaveLength(0);
  });

  it("after the migration, both policies save", async () => {
    await db.none(UP);
    expect(await checkState()).toEqual({ present: false });

    for (const entityType of QA_TYPES) {
      const res = await savePolicy(entityType);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe(1);
      expect(res.body.data.entity_type).toBe(entityType);
    }
    expect((await createdPolicies()).map((p) => p.entity_type)).toEqual(["ARC_NEGOTIATION", "ARC_PUBLISH"]);
  });

  it("re-running it changes nothing", async () => {
    await db.none(UP);
    expect(await checkState()).toEqual({ present: false });
    expect((await savePolicy("ARC_PUBLISH")).status).toBe(201);
  });

  it("reverses to feat/arc's check (not validated against rows saved meanwhile), and re-applies cleanly", async () => {
    // A policy saved while the check was gone has no company_id. The down file
    // must still restore the check, which it can only do NOT VALID.
    expect((await savePolicy("ARC_NEGOTIATION")).status).toBe(201);

    await db.none(DOWN);
    expect(await checkState()).toEqual({ present: true, validated: false });
    const refused = await savePolicy("ARC_PUBLISH");
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("chk_arc_policy_global_scope");

    await db.none(DOWN); // already restored: changes nothing
    expect(await checkState()).toEqual({ present: true, validated: false });

    await db.none(UP);
    expect(await checkState()).toEqual({ present: false });
    expect((await savePolicy("ARC_PUBLISH")).status).toBe(201);
  });

  it("on a schema feat/arc never touched, both files change nothing", async () => {
    await db.none(REMOVE_DRIFT);
    expect(await hasColumn("company_id")).toBe(false);

    await db.none(UP);
    await db.none(DOWN); // nothing to restore without feat/arc's columns
    expect(await checkState()).toEqual({ present: false });
    expect((await savePolicy("ARC_PUBLISH")).status).toBe(201);
  });
});
