/**
 * The row-level audit trigger — the layer nothing can bypass.
 *
 * This trigger has existed in production since go-live and written 105,000
 * rows nobody could use. It recorded `current_user`, the Postgres role, so
 * every row on record says 'postgres': it could name the table and the row
 * that changed but never the person, which is the only question anyone asks
 * of an audit log. It also never fired on INSERT, so nothing that was ever
 * created was recorded, and it lived on an UNLOGGED table — the one kind a
 * durable audit trail must never be.
 *
 * These tests pin the fixed behaviour, including the part that makes it worth
 * having: it fires for cron jobs, scripts and manual SQL as well as for HTTP
 * requests, and when there is no actor it says so rather than inventing one.
 */
import { db, withTx } from "../setup/db.js";

const PROBE_ID = 990111;
const ACTOR = 467;
const REQUEST = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const auditRows = (t, tableName, recordId) =>
  t.any(
    `SELECT operation, record_id, actor_user_id, request_id, changed_by,
            old_data, new_data
       FROM tbl_audit_row_changes
      WHERE table_name = $1 AND record_id = $2
      ORDER BY id`,
    [tableName, recordId]
  );

describe("row-level audit trigger", () => {
  it("records who did it, from the request context", () =>
    withTx(async (t) => {
      await t.none(`SET LOCAL app.actor_id = '${ACTOR}'`);
      await t.none(`SET LOCAL app.request_id = '${REQUEST}'`);
      await t.none("INSERT INTO tbl_department (id, title) VALUES ($1, $2)", [
        PROBE_ID,
        "Probe",
      ]);

      const [row] = await auditRows(t, "tbl_department", PROBE_ID);
      expect(row.actor_user_id).toBe(ACTOR);
      expect(row.request_id).toBe(REQUEST);
    }));

  it("captures creations, which it never used to", () =>
    withTx(async (t) => {
      await t.none("INSERT INTO tbl_department (id, title) VALUES ($1, $2)", [
        PROBE_ID,
        "Probe",
      ]);

      const rows = await auditRows(t, "tbl_department", PROBE_ID);
      expect(rows.map((r) => r.operation)).toEqual(["INSERT"]);
      expect(rows[0].new_data.title).toBe("Probe");
      expect(rows[0].old_data).toBeNull();
    }));

  it("records the before and after of a change", () =>
    withTx(async (t) => {
      await t.none("INSERT INTO tbl_department (id, title) VALUES ($1, $2)", [
        PROBE_ID,
        "Before",
      ]);
      await t.none("UPDATE tbl_department SET title = $2 WHERE id = $1", [
        PROBE_ID,
        "After",
      ]);
      await t.none("DELETE FROM tbl_department WHERE id = $1", [PROBE_ID]);

      const rows = await auditRows(t, "tbl_department", PROBE_ID);
      expect(rows.map((r) => r.operation)).toEqual(["INSERT", "UPDATE", "DELETE"]);
      expect(rows[1].old_data.title).toBe("Before");
      expect(rows[1].new_data.title).toBe("After");
      expect(rows[2].old_data.title).toBe("After");
      expect(rows[2].new_data).toBeNull();
    }));

  it("still records a change made with no request context at all", () =>
    // A cron tick, a migration, someone in psql. This is the whole reason the
    // trigger exists rather than trusting the application to report itself.
    withTx(async (t) => {
      await t.none("INSERT INTO tbl_department (id, title) VALUES ($1, $2)", [
        PROBE_ID,
        "Unattributed",
      ]);

      const [row] = await auditRows(t, "tbl_department", PROBE_ID);
      expect(row.actor_user_id).toBeNull();
      expect(row.request_id).toBeNull();
      expect(row.new_data.title).toBe("Unattributed");
    }));

  it("writes one row per change, not two", () =>
    // The triggers in production are named <table>_audit. A migration that
    // dropped them by function name would silently no-op and leave a second
    // trigger behind, doubling every row in the log.
    withTx(async (t) => {
      await t.none("INSERT INTO tbl_department (id, title) VALUES ($1, $2)", [
        PROBE_ID,
        "Once",
      ]);
      expect(await auditRows(t, "tbl_department", PROBE_ID)).toHaveLength(1);
    }));
});

describe("audit trigger coverage", () => {
  const coveredTables = () =>
    db.map(
      `SELECT c.relname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal
          AND n.nspname = 'public'
          AND t.tgfoid = 'public.log_changes_direct'::regproc`,
      [],
      (r) => r.relname
    );

  it("covers the governance tables an admin is accountable for", async () => {
    // None of these were covered before. They are what a dispute about who
    // was allowed to do what gets settled from.
    const covered = await coveredTables();
    for (const table of [
      "tbl_users",
      "tbl_roles",
      "tbl_role_permissions",
      "tbl_user_role_scopes",
      "tbl_user_department",
      "tbl_hospitality_companies",
      "tbl_hospitality_company_hotels",
      "tbl_hospitality_user_mappings",
      "tbl_approval_policies",
      "tbl_approval_policy_steps",
      "tbl_rfq_purchase_order",
    ]) {
      expect(covered).toContain(table);
    }
  });

  it("no longer covers the churn tables that produced most of the volume", async () => {
    // tbl_rfq_product_vendors alone was 82,119 of the 105,178 rows on record.
    // "The vendor pool was refreshed" is one event, not two hundred rows.
    const covered = await coveredTables();
    for (const table of [
      "tbl_rfq_product_vendors",
      "tbl_quote_item_history",
      "tbl_rfq_files",
      "tbl_quotes_files",
    ]) {
      expect(covered).not.toContain(table);
    }
  });

  it("has exactly one trigger per covered table", async () => {
    const dupes = await db.any(
      `SELECT c.relname, count(*) AS n
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal
          AND t.tgfoid = 'public.log_changes_direct'::regproc
        GROUP BY c.relname HAVING count(*) > 1`
    );
    expect(dupes).toEqual([]);
  });

  it("keeps the audit table durable", async () => {
    // 'u' is UNLOGGED: not WAL-logged, not crash-safe, not replicated.
    const { relpersistence } = await db.one(
      "SELECT relpersistence FROM pg_class WHERE relname = 'tbl_audit_row_changes'"
    );
    expect(relpersistence).toBe("p");
  });

  it("is indexed for the questions it exists to answer", async () => {
    const indexes = await db.map(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'tbl_audit_row_changes'",
      [],
      (r) => r.indexname
    );
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_audit_row_changes_record",
        "idx_audit_row_changes_changed_at",
        "idx_audit_row_changes_request",
      ])
    );
  });
});
