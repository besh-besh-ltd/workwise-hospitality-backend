// The reports permission catalogue, as the migrations leave it.
// ----------------------------------------------------------------------------
// These assert the SEEDED STATE rather than any code path, because the seed is
// what decides who can open the module at all — and the first cut of it got
// that wrong: 20260919120000 granted the catalogue to Company Administrator,
// a role with zero assignments, while a system role literally called "Report
// Download" (183 users on staging) held nothing report-related. The module
// shipped invisible.
//
// The assertion that matters most is the NEGATIVE one. reports.approval_audit_
// trail must not be on the broad role: that report names individuals, the
// decisions they took and flags self-approvals, which is a different class of
// disclosure from commercial spend. If somebody later widens the grant, this
// test is what should stop them and make them say why.

import { describe, it, expect, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { allReports } from "../../app/services/reports/definitions/index.js";

afterAll(async () => {
  await closeDb();
});

/** Permission strings carried by a role, by title. */
async function permissionsOf(roleTitle) {
  const rows = await db.any(
    `SELECT p.action::text AS action
       FROM tbl_roles r
       JOIN tbl_role_permissions rp ON rp.role_id = r.id
       JOIN tbl_permissions p ON p.id = rp.permission_id
      WHERE r.title = $1
        AND p.resource::text = 'reports'`,
    [roleTitle]
  );
  return new Set(rows.map((r) => r.action));
}

describe("reports permission catalogue", () => {
  it("seeds exactly one permission per report in the registry", async () => {
    const seeded = await db.any(
      `SELECT action::text AS action FROM tbl_permissions WHERE resource::text = 'reports'`
    );
    const seededKeys = new Set(seeded.map((r) => r.action));
    const registryKeys = new Set(allReports().map((d) => d.key));

    // A report in the registry with no permission can never be granted; a
    // permission with no report is an orphan in the admin picker.
    expect([...registryKeys].filter((k) => !seededKeys.has(k))).toEqual([]);
    expect([...seededKeys].filter((k) => !registryKeys.has(k))).toEqual([]);
    expect(seededKeys.size).toBe(16);
  });

  it("matches each report's declared permission string", async () => {
    for (const def of allReports()) {
      expect(def.permission).toBe(`reports.${def.key}`);
    }
  });
});

describe("who the migrations grant it to", () => {
  it("gives Company Administrator the whole catalogue", async () => {
    const held = await permissionsOf("Company Administrator");
    expect(held.size).toBe(16);
    expect(held.has("approval_audit_trail")).toBe(true);
  });

  it("gives the Report Download role everything EXCEPT the approval audit trail", async () => {
    const held = await permissionsOf("Report Download");

    // The role exists in the seeded schema; if this ever comes back empty the
    // grant migration silently did nothing.
    expect(held.size).toBeGreaterThan(0);
    expect(held.size).toBe(15);

    // The negative assertion this file exists for.
    expect(held.has("approval_audit_trail")).toBe(false);
    expect(held.has("spend_by_vendor")).toBe(true);
    expect(held.has("po_aging_by_approver")).toBe(true);
  });

  it("does not hand the catalogue to every role on the way past", async () => {
    const rows = await db.any(
      `SELECT r.title, count(*)::int AS n
         FROM tbl_roles r
         JOIN tbl_role_permissions rp ON rp.role_id = r.id
         JOIN tbl_permissions p ON p.id = rp.permission_id
        WHERE p.resource::text = 'reports'
        GROUP BY r.title
        ORDER BY r.title`
    );
    // Precisely two roles, and nothing acquired reports by accident.
    expect(rows.map((r) => r.title).sort()).toEqual(["Company Administrator", "Report Download"]);
  });
});
