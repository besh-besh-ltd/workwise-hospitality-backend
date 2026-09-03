/**
 * Backfilling the trail from history that predates it.
 *
 * The trail is new, but the system has recorded fragments of what happened
 * since go-live in seven different tables. An admin's first visit should not
 * be an empty page, so those fragments are projected into the feed.
 *
 * The two properties that make this safe are tested here rather than assumed:
 * running it twice must add nothing, and a reconstructed row must never
 * present an inferred actor as a recorded one.
 */
import { db, closeDb } from "../setup/db.js";
import { SOURCES } from "../../app/services/activity/backfillSources.js";
import { IDS } from "../fixtures/ids.js";

const runSource = async (name) => {
  const source = SOURCES.find((s) => s.name === name);
  if (!source) throw new Error(`no such backfill source: ${name}`);
  return (await db.result(source.sql)).rowCount;
};

const runAll = async () => {
  let total = 0;
  for (const source of SOURCES) total += (await db.result(source.sql)).rowCount;
  return total;
};

const RFQ_ID = 970001;
const INSTANCE_ID = 970002;
const SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
const BUYER = IDS.users.a1_proc_buyer;

/**
 * The fixtures carry structure but no history — every suite makes its own and
 * rolls it back. So the source rows the backfill reads have to be created
 * here, otherwise these tests would only prove the SQL parses.
 */
beforeAll(async () => {
  await db.none(
    `INSERT INTO tbl_rfq (id, rfq_no, comment, company_name, response_email,
                          contact_name, contact_number, bid_end_date, location,
                          created_by, updated_by, hospitality_company_id, hotel_id)
     VALUES ($1, 970001, 'backfill fixture', 'Company A', 'a@b.c', 'Contact',
             '9999999999', '2026-12-31 12:00:00', 'Mumbai', $2, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [RFQ_ID, BUYER, IDS.hospitality.A, IDS.hotels.A1]
  );

  await db.none(
    `INSERT INTO tbl_lifecycle_history (entity_id, entity_type, stage, action, performed_by, metadata)
     VALUES ($1, 'RFQ', 'PUBLISHED', 'AUTO_PUBLISH', $2, '{}'::jsonb),
            ($1, 'RFQ', 'SUBMITTED', 'SUBMIT', $2, '{}'::jsonb)`,
    [RFQ_ID, BUYER]
  );

  // One edit session spanning three fields — the case that must collapse.
  await db.none(
    `INSERT INTO tbl_rfq_change_history
       (rfq_id, edit_session_id, entity_type, field_name, change_type, old_value, new_value, is_material, changed_by)
     VALUES ($1, $2, 'RFQ', 'bid_end_date', 'UPDATE', '"a"'::json, '"b"'::json, true, $3),
            ($1, $2, 'RFQ', 'location', 'UPDATE', '"a"'::json, '"b"'::json, false, $3),
            ($1, $2, 'RFQ', 'comment', 'UPDATE', '"a"'::json, '"b"'::json, false, $3)`,
    [RFQ_ID, SESSION, BUYER]
  );

  await db.none(
    `INSERT INTO tbl_quote_activity (rfq_id, current_status, prev_status, created_by)
     VALUES ($1, 'RECEIVED', 'PUBLISHED', $2)`,
    [RFQ_ID, BUYER]
  );

  // An actor whose account no longer exists. tbl_quote_activity.created_by
  // carries no foreign key, so this really does occur — and the row must not
  // then claim to know who did it.
  await db.none(
    `INSERT INTO tbl_quote_activity (rfq_id, current_status, prev_status, created_by)
     VALUES ($1, 'CLOSED', 'RECEIVED', $2)`,
    [RFQ_ID, 9799999]
  );

  await db.none(
    `INSERT INTO tbl_login_log (user_id, user_type, date, user_agent)
     VALUES ($1, 2, now(), 'jest')`,
    [IDS.users.companyA_admin]
  );

  await db.none(
    `INSERT INTO tbl_approval_instances
       (id, entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, initiated_by)
     VALUES ($1, 'RFQ', $2, $6, 'APPROVED', 1, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [INSTANCE_ID, RFQ_ID, IDS.hospitality.A, IDS.hotels.A1, BUYER, IDS.policies.A1_P1_RFQ]
  );
  await db.none(
    `INSERT INTO tbl_approval_actions (approval_instance_id, approver_user_id, action, comment)
     VALUES ($1, $2, 'APPROVE', 'looks fine')`,
    [INSTANCE_ID, BUYER]
  );
});

beforeEach(() => db.none("DELETE FROM tbl_activity_events"));

afterAll(async () => {
  await db.none("DELETE FROM tbl_activity_events");
  await db.none("DELETE FROM tbl_approval_actions WHERE approval_instance_id = $1", [INSTANCE_ID]);
  await db.none("DELETE FROM tbl_approval_instances WHERE id = $1", [INSTANCE_ID]);
  await db.none("DELETE FROM tbl_login_log WHERE user_agent = 'jest'");
  await db.none("DELETE FROM tbl_quote_activity WHERE rfq_id = $1", [RFQ_ID]);
  await db.none("DELETE FROM tbl_rfq_change_history WHERE rfq_id = $1", [RFQ_ID]);
  await db.none("DELETE FROM tbl_lifecycle_history WHERE entity_id = $1", [RFQ_ID]);
  await db.none("DELETE FROM tbl_rfq WHERE id = $1", [RFQ_ID]);
  await db.none("DELETE FROM tbl_audit_row_changes WHERE table_name IN ('tbl_rfq','tbl_approval_policies')");
  await closeDb();
});

describe("backfill queries", () => {
  it("every source runs against the real schema", async () => {
    // Each of these is a hand-written join across tables whose column names
    // were wrong twice already during this work. Running them is the only way
    // to know they are right.
    for (const source of SOURCES) {
      await expect(db.result(source.sql)).resolves.toBeDefined();
    }
  });

  it("projects history that the fixtures contain", async () => {
    const written = await runAll();
    expect(written).toBeGreaterThan(0);

    const rows = await db.any(
      "SELECT DISTINCT source, is_reconstructed FROM tbl_activity_events"
    );
    // Everything this produces is reconstructed, and says so.
    expect(rows.every((r) => r.source === "BACKFILL" && r.is_reconstructed)).toBe(true);
  });

  it("adds nothing on a second run", async () => {
    const first = await runAll();
    expect(first).toBeGreaterThan(0);

    const second = await runAll();
    expect(second).toBe(0);

    const { n } = await db.one("SELECT count(*)::int AS n FROM tbl_activity_events");
    expect(n).toBe(first);
  });

  it("can be interrupted and restarted without duplicating", async () => {
    // Half the sources, then all of them: the overlap must not double up.
    await runSource("lifecycle");
    await runSource("approvals");
    const partial = await db.one("SELECT count(*)::int AS n FROM tbl_activity_events");

    await runAll();
    const full = await db.one("SELECT count(*)::int AS n FROM tbl_activity_events");
    expect(full.n).toBeGreaterThanOrEqual(partial.n);

    const dupes = await db.any(
      `SELECT metadata->>'source_table' AS t, metadata->>'source_id' AS i, count(*)
         FROM tbl_activity_events WHERE is_reconstructed
        GROUP BY 1, 2 HAVING count(*) > 1`
    );
    expect(dupes).toEqual([]);
  });

  it("records where every reconstructed row came from", async () => {
    await runAll();
    const orphans = await db.any(
      `SELECT id FROM tbl_activity_events
        WHERE is_reconstructed
          AND (metadata->>'source_table' IS NULL OR metadata->>'source_id' IS NULL)`
    );
    // Without provenance a row could not be de-duplicated, corrected or
    // explained. There is no reason for one to exist.
    expect(orphans).toEqual([]);
  });

  it("never invents an actor it does not have", async () => {
    await runAll();
    const lying = await db.any(
      `SELECT id, actor_type, actor_user_id FROM tbl_activity_events
        WHERE is_reconstructed AND actor_type = 'USER' AND actor_user_id IS NULL`
    );
    expect(lying).toEqual([]);

    // The deleted-account case: an id is recorded, but the row says plainly
    // that it cannot name the person rather than showing a blank or a guess.
    const orphaned = await db.one(
      `SELECT actor_type, actor_label FROM tbl_activity_events
        WHERE metadata->>'source_table' = 'tbl_quote_activity'
          AND summary LIKE '%closed%'`
    );
    expect(orphaned.actor_type).toBe("UNKNOWN");
    expect(orphaned.actor_label).toBe("Someone");
  });

  it("scopes every projected row to a company", async () => {
    await runAll();
    // A row with no company could never be shown to anybody. The queries drop
    // those rather than writing rows that only grow the table.
    const unscoped = await db.any(
      "SELECT id FROM tbl_activity_events WHERE hospitality_company_id IS NULL"
    );
    expect(unscoped).toEqual([]);
  });

  it("writes a readable sentence, not a row dump", async () => {
    await runAll();
    const rows = await db.any(
      "SELECT summary FROM tbl_activity_events WHERE is_reconstructed LIMIT 50"
    );
    for (const row of rows) {
      expect(row.summary).toBeTruthy();
      expect(row.summary.length).toBeGreaterThan(5);
      // No unresolved template fragments or raw nulls leaking into the feed.
      expect(row.summary).not.toMatch(/undefined|null|\[object/i);
    }
  });

  it("reads as English, not as a log line", async () => {
    // The raw values are enum-ish shouts — AUTO_PUBLISH, SUBMIT_FOR_APPROVAL —
    // and a naive lowercase produces "auto publish rfq 536445", which is a log
    // line. An admin should be able to read the feed without decoding it.
    await runSource("lifecycle");
    const summaries = await db.map(
      "SELECT summary FROM tbl_activity_events WHERE event_key LIKE 'rfq_%'",
      [],
      (r) => r.summary
    );
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringContaining("auto-published RFQ"),
        expect.stringContaining("submitted RFQ"),
      ])
    );
    // Never the raw enum, and never a lowercased acronym.
    for (const line of summaries) {
      expect(line).not.toMatch(/AUTO_PUBLISH|SUBMIT_FOR_APPROVAL/);
      expect(line).not.toMatch(/\brfq\b/);
    }
  });

  it("collapses one RFQ edit session into one line, not one per field", async () => {
    // A save that touched fourteen fields was one thing the buyer did.
    // Fourteen lines would bury everything around it.
    const sessions = await db.oneOrNone(
      `SELECT count(DISTINCT ch.edit_session_id)::int AS n
         FROM tbl_rfq_change_history ch
         JOIN tbl_rfq r ON r.id = ch.rfq_id
        WHERE r.hospitality_company_id IS NOT NULL AND ch.edit_session_id IS NOT NULL`
    );
    await runSource("rfq_edits");

    const rows = await db.any(
      "SELECT summary FROM tbl_activity_events WHERE event_key = 'rfq_edited'"
    );
    expect(rows).toHaveLength(sessions.n);
    // Counting rows alone would not prove the grouping: the idempotency index
    // would collapse per-field rows anyway, since they share an edit session.
    // The rendered count is what actually distinguishes the two.
    expect(rows[0].summary).toMatch(/\(3 fields\)/);
  });
});
