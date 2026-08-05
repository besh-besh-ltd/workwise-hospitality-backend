/**
 * The RBAC seed has TWO sources of truth. This suite is the thing that notices
 * when they drift.
 *
 * ── THE HAZARD ────────────────────────────────────────────────────────────
 * Real environments get their permission keys, system roles and grants from
 * `migrations/`. Test databases NEVER run migrations — `tests/setup/prepareTestDb.js`
 * builds them from `schema.sql` + `seed_reference.sql` + JS fixtures. Nothing
 * links the two: no checksum, no constraint, no test. The only mechanism keeping
 * them equal has been a person remembering.
 *
 * It had already failed badly. `seed_reference.sql` is a pg_dump that predates
 * ARC v2 entirely — 31 permission rows ending at `arc.approve`, 21 roles ending
 * at `PO Regenerator`. It carried NONE of 20260608100800 (the ARC/MR permission
 * keys and seven system roles) and none of 20260611100000 (arc-tech.read /
 * arc-comm.read). Four separate suites had independently re-implemented pieces
 * of that seed inline with private 95xxx ids, each free to disagree with
 * production, and `tbl_permissions` has no unique constraint on
 * `(resource, action)` so the duplicates were invisible.
 *
 * The practical cost: on that database, the assertion "an ARC Tech Evaluator
 * cannot approve a technical evaluation" could not be made against the real
 * system role, because the real system role did not exist.
 *
 * ── HOW THIS CHECKS IT ────────────────────────────────────────────────────
 * Builds a THROWAWAY database from `schema.sql`, applies the three RBAC
 * migrations in dependency order, and reads back what production would actually
 * have. Then asserts every one of those rows is present in the live test
 * database — which came from `seed_reference.sql`. Migration is the authority;
 * the seed must contain it.
 *
 * Direction is deliberate: SUBSET, not equality. The live DB legitimately holds
 * extra rows — fixture permissions from other suites, custom roles created
 * through the API by tests that ran earlier in the same Jest process. Demanding
 * equality would make this suite fail for reasons that have nothing to do with
 * drift, and a check that cries wolf gets deleted.
 *
 * Scope is the ARC/MR families only. The rest of `seed_reference.sql` still
 * predates several unrelated migrations (dashboard permissions, ABC analysis);
 * widening this to the whole catalogue would fail on day one for known, separate
 * reasons. Widen it when those are closed, not before.
 */

import fs from "fs";
import path from "path";
import pg from "pg";
import { db } from "../setup/db.js";
import { getTestDbConfig } from "../setup/envguard.js";

// The migrations that own ARC/MR RBAC, in dependency order. 20260611100000
// grants arc-tech.read to roles created by 20260608100800; 20260803110000 grants
// arc-tech.approve alongside it.
const RBAC_MIGRATIONS = [
  "20260608100800_permissions_seed.sql",
  "20260611100000_arc_eval_read_permissions.sql",
  "20260803110000_arc_stage_approver_permissions.sql",
];

// Resource families these migrations own. Anything outside is out of scope.
const OWNED_RESOURCES = ["arc", "arc-tech", "arc-comm", "arc-committee", "mr"];

const RESTRICT_LINE = /^\\(restrict|unrestrict)\b.*$/gm;

const cfg = getTestDbConfig();
// Same prefix, so envguard's safe-name pattern still covers it and it can never
// be confused with a real database.
const SCRATCH_DB = `${cfg.dbName}_seedparity`;

function connConfig(database) {
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database,
    ssl: process.env.TEST_DB_NO_SSL === "1" ? false : { rejectUnauthorized: false },
  };
}

async function withClient(database, fn) {
  const client = new pg.Client(connConfig(database));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** (resource, action) keys, restricted to the families these migrations own. */
const PERMISSION_SQL = `
  SELECT DISTINCT p.resource::text || '.' || p.action::text AS key
    FROM tbl_permissions p
   WHERE p.resource::text = ANY($1::text[])
   ORDER BY 1`;

/** systemRoleTitle -> sorted permission keys, for system roles only. */
const ROLE_GRANT_SQL = `
  SELECT r.title, p.resource::text || '.' || p.action::text AS key
    FROM tbl_roles r
    JOIN tbl_role_permissions rp ON rp.role_id = r.id
    JOIN tbl_permissions p ON p.id = rp.permission_id
   WHERE r.created_by IS NULL
     AND r.title = ANY($1::text[])`;

function groupGrants(rows) {
  const out = new Map();
  for (const { title, key } of rows) {
    if (!out.has(title)) out.set(title, new Set());
    out.get(title).add(key);
  }
  return out;
}

let migrationPermissions = [];
let migrationRoleTitles = [];
let migrationGrants = new Map();

beforeAll(async () => {
  if (!/^hospitality_test(_[a-zA-Z0-9_-]+)?$/.test(SCRATCH_DB)) {
    throw new Error(`refusing to create '${SCRATCH_DB}'`);
  }

  await withClient(cfg.maintenanceDb, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
  });

  await withClient(SCRATCH_DB, async (client) => {
    const schema = fs
      .readFileSync(path.join(cfg.setupDir, "schema.sql"), "utf8")
      .replace(RESTRICT_LINE, "");
    await client.query(schema);
    // schema.sql sets search_path = '' — the migrations reference public.* but
    // also read pg_enum via regtype casts, so restore a usable path.
    await client.query("SET search_path = public, pg_catalog");

    for (const file of RBAC_MIGRATIONS) {
      const sql = fs.readFileSync(path.join(cfg.backendDir, "migrations", file), "utf8");
      await client.query(sql);
    }

    migrationPermissions = (await client.query(PERMISSION_SQL, [OWNED_RESOURCES])).rows.map((r) => r.key);
    const titles = (
      await client.query(`SELECT title FROM tbl_roles WHERE created_by IS NULL ORDER BY id`)
    ).rows.map((r) => r.title);
    migrationRoleTitles = titles;
    migrationGrants = groupGrants((await client.query(ROLE_GRANT_SQL, [titles])).rows);
  });
}, 60000);

afterAll(async () => {
  await withClient(cfg.maintenanceDb, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  });
}, 30000);

describe("seed_reference.sql must contain everything the RBAC migrations create", () => {
  it("builds a real migration-derived baseline (guards against a vacuous pass)", () => {
    // If the scratch DB failed to build, every subset assertion below would pass
    // trivially against empty sets. Pin the shape first.
    expect(migrationPermissions.length).toBeGreaterThanOrEqual(12);
    expect(migrationRoleTitles).toEqual(
      expect.arrayContaining([
        "ARC Creator",
        "ARC Tech Evaluator",
        "ARC Commercial Evaluator",
        "ARC Committee Member",
        "ARC Admin",
        "MR Raiser",
        "MR Approver",
        "ARC Technical Approver",
        "ARC Negotiation Approver",
      ])
    );
  });

  it("every ARC/MR permission key the migrations create exists in the seeded test DB", async () => {
    const seeded = new Set(
      (await db.any(PERMISSION_SQL, [OWNED_RESOURCES])).map((r) => r.key)
    );
    const missing = migrationPermissions.filter((k) => !seeded.has(k));
    expect(missing).toEqual([]);
  });

  it("every system role the migrations create exists in the seeded test DB", async () => {
    const seeded = new Set(
      (
        await db.any(
          `SELECT title FROM tbl_roles WHERE created_by IS NULL AND title = ANY($1::text[])`,
          [migrationRoleTitles]
        )
      ).map((r) => r.title)
    );
    const missing = migrationRoleTitles.filter((t) => !seeded.has(t));
    expect(missing).toEqual([]);
  });

  it("every role→permission grant the migrations create exists in the seeded test DB", async () => {
    const seeded = groupGrants(await db.any(ROLE_GRANT_SQL, [migrationRoleTitles]));

    // Reported as one flat list of "Role → key" strings: a diff of two Maps is
    // unreadable in Jest output, and the whole point of this test is that the
    // failure tells you exactly which line to add to seed_reference.sql.
    const missing = [];
    for (const [title, keys] of migrationGrants) {
      const have = seeded.get(title) || new Set();
      for (const key of keys) {
        if (!have.has(key)) missing.push(`${title} → ${key}`);
      }
    }
    expect(missing.sort()).toEqual([]);
  });

  it("the separation-of-duties omissions hold in BOTH sources", async () => {
    // The one place where the absence of a grant is load-bearing, so it is
    // asserted rather than left to the subset check (which cannot see absences).
    for (const [source, grants] of [
      ["migrations", migrationGrants],
      ["seed_reference", groupGrants(await db.any(ROLE_GRANT_SQL, [migrationRoleTitles]))],
    ]) {
      for (const role of ["ARC Tech Evaluator", "ARC Commercial Evaluator", "ARC Admin"]) {
        const keys = grants.get(role) || new Set();
        expect(`${source}: ${role} arc-tech.approve = ${keys.has("arc-tech.approve")}`)
          .toBe(`${source}: ${role} arc-tech.approve = false`);
        expect(`${source}: ${role} arc-comm.approve = ${keys.has("arc-comm.approve")}`)
          .toBe(`${source}: ${role} arc-comm.approve = false`);
      }

      // And the KNOWN GAP, pinned in both sources so neither can quietly change:
      // ARC Admin DOES hold arc-committee.approve, and arc-comm.evaluate (which
      // gates finalizeCommEval, the handler that spawns the ARC_COMMITTEE
      // instance as initiator). See arc.approvers.stageRoles.test.js.
      const admin = grants.get("ARC Admin") || new Set();
      expect(`${source}: ARC Admin arc-committee.approve = ${admin.has("arc-committee.approve")}`)
        .toBe(`${source}: ARC Admin arc-committee.approve = true`);
      expect(`${source}: ARC Admin arc-comm.evaluate = ${admin.has("arc-comm.evaluate")}`)
        .toBe(`${source}: ARC Admin arc-comm.evaluate = true`);
    }
  });
});
