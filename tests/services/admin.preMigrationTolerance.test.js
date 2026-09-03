/**
 * The module must survive being deployed before its migrations are applied.
 *
 * Deploys land ahead of migrations here — that is the established order, and
 * poDocumentService already carries the same accommodation ("the watchdog is
 * inert until migration X"). So "correct once the database catches up" is not
 * a sufficient standard: there is a window, as long as it takes someone to run
 * the SQL, where new code is live against the old schema.
 *
 * The trap this guards is enum validation. Postgres validates an enum literal
 * at PARSE time, so `p.resource = 'company'` does not return zero rows on a
 * database without that value — it fails the whole statement with "invalid
 * input value for enum resource_type". Measured against a real pre-migration
 * database, that took down GET /users/company-users-detailed: an existing
 * screen, broken by a column added for a new one.
 *
 * Casting to text compares as text and matches nothing until the migration
 * lands, which is the degradation we want — legacy user_type-7 admins keep
 * working, capability admins start working the moment the value exists.
 *
 * These are source-level assertions on purpose. The models take their own
 * connection from the pool, so a test that renamed the enum inside a
 * transaction would never be seen by the code under test — it would assert its
 * own setup and pass against the bug. A grep is blunt, but it is the thing
 * that actually bites.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, closeDb } from "../setup/db.js";
import { isCompanyAdmin } from "../../app/middleware/companyAdmin.js";
import { IDS } from "../fixtures/ids.js";

const ADMIN = IDS.users.companyA_admin;
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app");

/** Every .js under app/, so a new call site cannot be added unguarded. */
const sourceFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
  });

afterAll(async () => {
  await closeDb();
});

describe("code deployed before its migration", () => {
  it("never compares against the new enum value directly", async () => {
    // The inverse grep: not "the fix is present somewhere" but "the bug is
    // absent everywhere", which is the only form that survives someone adding
    // a fifth call site next month.
    const offenders = [];
    for (const file of sourceFiles(APP_DIR)) {
      const src = fs.readFileSync(file, "utf8");
      // A bare comparison, i.e. not already cast with ::text.
      const re = /\b(?:p|p_a|perm|permissions)?\.?(resource|action)\s*=\s*'(company|admin)'/g;
      for (const m of src.matchAll(re)) {
        const before = src.slice(Math.max(0, m.index - 12), m.index);
        if (!before.includes("::text")) {
          offenders.push(`${path.relative(APP_DIR, file)}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still recognises a legacy administrator while the capability cannot resolve", async () => {
    // During the window the capability query matches nothing, so the legacy
    // user_type is the only thing keeping an administrator working. If this
    // breaks, nobody can administer anything until the SQL is run.
    expect(await isCompanyAdmin({ id: ADMIN, user_type: 7 })).toBe(true);
  });

  it("resolves the capability normally once the value exists", async () => {
    // The other half: the text comparison must not have broken the working
    // case. Granted through the ordinary role flow, then read back.
    const role = await db.one(
      "SELECT id FROM tbl_roles WHERE title = 'Company Administrator'"
    );
    const scope = await db.oneOrNone(
      `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
      [IDS.users.a1_proc_buyer, role.id, IDS.hospitality.A]
    );
    try {
      expect(await isCompanyAdmin({ id: IDS.users.a1_proc_buyer, user_type: 2 })).toBe(true);
    } finally {
      if (scope) {
        await db.none("DELETE FROM tbl_user_role_scopes WHERE id = $1", [scope.id]);
      }
    }
  });
});
