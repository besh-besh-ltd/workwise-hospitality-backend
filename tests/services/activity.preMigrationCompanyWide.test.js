/**
 * The company-wide change must survive being deployed before its migration.
 *
 * Deploys land ahead of migrations here. For that window the new code runs
 * against a tbl_activity_events with no buyer_company_id, and if any read or
 * write named the column, the Activity page and every captured event would
 * fail with "column does not exist" — an outage caused by an audit feature.
 *
 * This rehearses the window for real: the column is renamed out of sight (and
 * the trigger that fills it disabled) so the code under test, which takes its
 * own pool connections, genuinely sees the old schema. A source-level grep
 * would only prove the column is named somewhere sensible.
 */
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import {
  recordActivityEvent,
  resetActivitySchemaCache,
  hasBuyerCompanyColumn,
} from "../../app/models/activityModel.js";

const ADMIN = 80061; // company A administrator, no mapping
const HOSPITALITY_A = IDS.hospitality.A;

const hideColumn = async () => {
  await db.none(`ALTER TABLE tbl_activity_events DISABLE TRIGGER tbl_activity_events_fill_buyer`);
  await db.none(`ALTER TABLE tbl_activity_events RENAME COLUMN buyer_company_id TO buyer_company_id_premigration`);
  resetActivitySchemaCache();
};

const restoreColumn = async () => {
  await db.none(`ALTER TABLE tbl_activity_events RENAME COLUMN buyer_company_id_premigration TO buyer_company_id`);
  await db.none(`ALTER TABLE tbl_activity_events ENABLE TRIGGER tbl_activity_events_fill_buyer`);
  resetActivitySchemaCache();
};

beforeAll(async () => {
  await db.none(`DELETE FROM tbl_users WHERE id = $1`, [ADMIN]);
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'Premigration Admin', 'premig.admin@capture.test', 1, 7, $2, now(), now())`,
    [ADMIN, IDS.companies.A]
  );
  await hideColumn();
});

afterAll(async () => {
  try {
    await restoreColumn();
  } finally {
    await db.none(`DELETE FROM tbl_approval_processes WHERE created_by = $1`, [ADMIN]);
    await db.none(`DELETE FROM tbl_activity_events WHERE actor_user_id = $1 OR event_key = 'premig_probe'`, [ADMIN]);
    await db.none(`DELETE FROM tbl_users WHERE id = $1`, [ADMIN]);
    await closeDb();
  }
});

describe("before the company-wide migration is applied", () => {
  it("knows the column is not there", async () => {
    expect(await hasBuyerCompanyColumn()).toBe(false);
  });

  it("still writes unit-scoped events, and quietly drops company-wide ones", async () => {
    const unit = await recordActivityEvent({
      eventKey: "premig_probe", category: "System", actorLabel: "Probe",
      hospitalityCompanyId: HOSPITALITY_A, summary: "unit event before migration",
    });
    expect(unit).not.toBeNull();

    // The old schema cannot hold it; returning null (and logging) is exactly
    // today's behaviour, not an error.
    const companyWide = await recordActivityEvent({
      eventKey: "premig_probe", category: "System", actorLabel: "Probe",
      buyerCompanyId: IDS.companies.A, summary: "company-wide event before migration",
    });
    expect(companyWide).toBeNull();
  });

  it("keeps the Activity page, its filters and its detail working", async () => {
    const client = await httpClient(ADMIN);
    const list = await client.get("/api/v1/activity");
    expect(list.status).toBe(200);
    const facets = await client.get("/api/v1/activity/facets");
    expect(facets.status).toBe(200);

    const row = list.body.data.rows.find((r) => r.event_key === "premig_probe");
    expect(row).toBeDefined();
    const detail = await client.get(`/api/v1/activity/${row.id}/changes`);
    expect(detail.status).toBe(200);
  });

  it("lets the admin action itself succeed even though its event cannot be stored", async () => {
    const client = await httpClient(ADMIN);
    const res = await client.post("/api/v1/general/hospitality/approval/processes")
      .send({ name: "Premigration Workflow", process_type: "RFQ" });
    expect(res.status).toBe(201);
  });

  it("recovers on its own when the column disappears after it was detected", async () => {
    // A schema rollback while the new code keeps running: the process has
    // already cached "the column exists". Without a self-heal every list,
    // facet and detail call would throw until somebody restarted it, and every
    // captured event would be lost. The rollback is rehearsed the way the down
    // migration does it — trigger off, column gone — but the cache is NOT
    // reset, which is exactly what a running process would see.
    await restoreColumn();
    expect(await hasBuyerCompanyColumn()).toBe(true);
    await db.none(`ALTER TABLE tbl_activity_events DISABLE TRIGGER tbl_activity_events_fill_buyer`);
    await db.none(`ALTER TABLE tbl_activity_events RENAME COLUMN buyer_company_id TO buyer_company_id_premigration`);

    const client = await httpClient(ADMIN);
    const list = await client.get("/api/v1/activity");
    expect(list.status).toBe(200);
    const facets = await client.get("/api/v1/activity/facets");
    expect(facets.status).toBe(200);

    const unit = await recordActivityEvent({
      eventKey: "premig_probe", category: "System", actorLabel: "Probe",
      hospitalityCompanyId: HOSPITALITY_A, summary: "unit event after a rollback",
    });
    expect(unit).not.toBeNull();
    expect(await hasBuyerCompanyColumn()).toBe(false);

    const row = (await client.get("/api/v1/activity")).body.data.rows.find((r) => r.id === unit);
    expect(row).toBeDefined();
    const detail = await client.get(`/api/v1/activity/${unit}/changes`);
    expect(detail.status).toBe(200);
  });

  it("starts recording company-wide events as soon as the migration lands", async () => {
    await restoreColumn();
    try {
      expect(await hasBuyerCompanyColumn()).toBe(true);
      const id = await recordActivityEvent({
        eventKey: "premig_probe", category: "System", actorLabel: "Probe",
        buyerCompanyId: IDS.companies.A, summary: "company-wide event after migration",
      });
      expect(id).not.toBeNull();
    } finally {
      await hideColumn();
    }
  });
});
