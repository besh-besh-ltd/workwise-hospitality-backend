/**
 * The company-wide migration must reverse exactly and re-apply cleanly.
 *
 * The down cannot simply restore NOT NULL: company-wide rows (no hospitality
 * company) would block it, and deleting them would silently destroy part of
 * an audit trail. They are parked instead, and re-applying the up puts them
 * back. These run the real files against the test database, in order.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { resetActivitySchemaCache } from "../../app/models/activityModel.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UP = fs.readFileSync(path.join(ROOT, "migrations/20261012100000_activity_company_wide_events.sql"), "utf8");
const DOWN = fs.readFileSync(path.join(ROOT, "migrations/20261012100000_activity_company_wide_events.down.sql"), "utf8");

const ADDED_TRIGGERS = [
  "tbl_company_audit",
  "tbl_approval_delegations_audit",
  "tbl_hospitality_project_mappings_audit",
  "tbl_permissions_audit",
  "tbl_activity_events_fill_buyer",
];

const hasColumn = async () =>
  Boolean(await db.oneOrNone(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'tbl_activity_events' AND column_name = 'buyer_company_id'`
  ));

const triggers = () =>
  db.map(
    `SELECT tgname FROM pg_trigger WHERE tgname = ANY($1) ORDER BY tgname`,
    [ADDED_TRIGGERS],
    (r) => r.tgname
  );

let wideId;

beforeAll(async () => {
  ({ id: wideId } = await db.one(
    `INSERT INTO tbl_activity_events (source, event_key, category, severity, actor_type, actor_label,
                                      buyer_company_id, summary)
     VALUES ('HTTP', 'migration_probe', 'Roles & Access', 'critical', 'USER', 'Probe', $1, 'company-wide probe')
     RETURNING id`,
    [IDS.companies.A]
  ));
});

afterAll(async () => {
  // Whatever happened above, leave the schema migrated for the suites after.
  await db.none(UP);
  resetActivitySchemaCache();
  await db.none(`DELETE FROM tbl_activity_events WHERE event_key = 'migration_probe'`);
  await closeDb();
});

describe("20261012100000_activity_company_wide_events", () => {
  it("reverses: parks company-wide rows, restores NOT NULL, drops what it added", async () => {
    await db.none(DOWN);
    resetActivitySchemaCache();

    expect(await hasColumn()).toBe(false);
    const nullable = await db.one(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'tbl_activity_events' AND column_name = 'hospitality_company_id'`
    );
    expect(nullable.is_nullable).toBe("NO");
    expect(await triggers()).toEqual([]);

    // Moved, not lost.
    const live = await db.oneOrNone(`SELECT id FROM tbl_activity_events WHERE id = $1`, [wideId]);
    expect(live).toBeNull();
    const parked = await db.oneOrNone(
      `SELECT summary FROM tbl_activity_events_company_wide_parked WHERE id = $1`, [wideId]
    );
    expect(parked?.summary).toBe("company-wide probe");
  });

  it("re-applies: restores the parked rows and everything it adds", async () => {
    await db.none(UP);
    resetActivitySchemaCache();

    expect(await hasColumn()).toBe(true);
    expect(await triggers()).toEqual([...ADDED_TRIGGERS].sort());
    const back = await db.one(`SELECT summary, buyer_company_id FROM tbl_activity_events WHERE id = $1`, [wideId]);
    expect(back).toEqual({ summary: "company-wide probe", buyer_company_id: IDS.companies.A });
    const parkingTable = await db.oneOrNone(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'tbl_activity_events_company_wide_parked'`
    );
    expect(parkingTable).toBeNull();
  });

  it("is a no-op when applied twice", async () => {
    const before = await db.one(`SELECT count(*)::int AS n FROM tbl_activity_events`);
    await db.none(UP);
    const after = await db.one(`SELECT count(*)::int AS n FROM tbl_activity_events`);
    expect(after.n).toBe(before.n);
    expect(await triggers()).toEqual([...ADDED_TRIGGERS].sort());
  });

  it("audits the buyer company table it now covers", async () => {
    const { company_name: name } = await db.one(`SELECT company_name FROM tbl_company WHERE id = $1`, [IDS.companies.A]);
    await db.none(`UPDATE tbl_company SET company_name = company_name WHERE id = $1`, [IDS.companies.A]);
    const row = await db.oneOrNone(
      `SELECT operation FROM tbl_audit_row_changes
        WHERE table_name = 'tbl_company' AND record_id = $1 ORDER BY id DESC LIMIT 1`,
      [IDS.companies.A]
    );
    expect(row?.operation).toBe("UPDATE");
    expect(name).toBeDefined();
  });
});
