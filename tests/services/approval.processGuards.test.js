/**
 * Process API hardening + policy coverage (client role/terminology feedback).
 *
 * - DELETE and PUT {is_active:false} refuse (409 PROCESS_IN_USE) while a process
 *   still has active policies, pending approvals, open RFQs/ARCs or role grants.
 * - PUT can no longer change process_type.
 * - GET policy-coverage reports which entity types have an ACTIVE matching
 *   policy per process at a hotel (scope-checked).
 *
 * Product-level: real HTTP + Postgres.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { httpClient } from "../helpers/http.js";
import { IDS } from "../fixtures/ids.js";
import { makeRFQ } from "../factories/rfq.js";
import { grantRoleScope } from "../helpers/roleScope.js";

const ADMIN = 80981; // company A administrator (created below)
const OTHER_ADMIN = 80982; // company B administrator (created below)
const PROC_URL = "/api/v1/general/hospitality/approval/processes";
const COVERAGE_URL = "/api/v1/general/hospitality/approval/policy-coverage";

let processId;
const rfqIds = [];
const policyIds = [];
const grantIds = [];

async function newProcess(name = "Guard Probe") {
  const { id } = await db.one(
    `INSERT INTO tbl_approval_processes (company_id, name, created_by, process_type, is_active)
     VALUES ($1, $2, $3, 'RFQ', true) RETURNING id`,
    [IDS.companies.A, `${name} ${Date.now()}${Math.random()}`, ADMIN]
  );
  return Number(id);
}

async function newPolicy(entityType, proc, hotel = IDS.hotels.A1, active = true) {
  const { id } = await db.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by,
        process_id, is_master, is_department_scoped, version)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, false, false, 1) RETURNING id`,
    [entityType, IDS.hospitality.A, hotel, active, ADMIN, proc]
  );
  policyIds.push(Number(id));
  return Number(id);
}

beforeAll(async () => {
  await db.none(`DELETE FROM tbl_users WHERE id IN ($1, $2)`, [ADMIN, OTHER_ADMIN]);
  await db.none(
    `INSERT INTO tbl_users (id, name, email, status, user_type, company_id, created_at, updated_at)
     VALUES ($1, 'Guard Admin A', 'guard.admin.a@guards.test', 1, 7, $3, now(), now()),
            ($2, 'Guard Admin B', 'guard.admin.b@guards.test', 1, 7, $4, now(), now())`,
    [ADMIN, OTHER_ADMIN, IDS.companies.A, IDS.companies.B]
  );
});

beforeEach(async () => {
  processId = await newProcess();
});

afterEach(async () => {
  if (rfqIds.length) await db.none(`DELETE FROM tbl_rfq WHERE id = ANY($1::int[])`, [rfqIds.splice(0)]);
  if (grantIds.length) await db.none(`DELETE FROM tbl_user_role_scopes WHERE id = ANY($1::int[])`, [grantIds.splice(0)]);
  if (policyIds.length) await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [policyIds.splice(0)]);
  await db.none(`DELETE FROM tbl_approval_processes WHERE id = $1`, [processId]);
});

afterAll(async () => {
  await db.none(`DELETE FROM tbl_users WHERE id IN ($1, $2)`, [ADMIN, OTHER_ADMIN]);
  await closeDb();
});

describe("DELETE process refuses while in use", () => {
  it("an open draft RFQ blocks it with the RFQ listed", async () => {
    const { rfq_id, rfq_no } = await makeRFQ(db, { createdBy: ADMIN, process: processId, status: 0 });
    rfqIds.push(rfq_id);
    const client = await httpClient(ADMIN);
    const res = await client.delete(`${PROC_URL}/${processId}`);
    expect(res.status).toBe(409);
    expect(res.body.status).toBe(0);
    expect(res.body.code).toBe("PROCESS_IN_USE");
    expect(res.body.message).toBe("This process is still in use");
    const b = res.body.data.blockers;
    expect(b.open_rfqs[0]).toEqual({ id: Number(rfq_id), rfq_no: Number(rfq_no) });
    expect(b.open_rfq_count).toBe(1);
    expect(b.policies).toEqual([]);
    expect(b.pending_instances).toBe(0);
    expect(b.open_arcs).toBe(0);
    expect(b.role_grants).toBe(0);
    const row = await db.one(`SELECT is_active FROM tbl_approval_processes WHERE id=$1`, [processId]);
    expect(row.is_active).toBe(true);
  });

  it("a closed RFQ does not block", async () => {
    const { rfq_id } = await makeRFQ(db, { createdBy: ADMIN, process: processId, status: 2 });
    rfqIds.push(rfq_id);
    const client = await httpClient(ADMIN);
    const res = await client.delete(`${PROC_URL}/${processId}`);
    expect(res.status).toBe(200);
  });

  it("an ARC in a terminal status (committee_rejected) does not block; a non-terminal one (tech_eval_rejected) does", async () => {
    const arc = async (status) => {
      const base = await db.one(`SELECT category_id, department_id FROM tbl_arc LIMIT 1`).catch(() => null);
      const cat = base?.category_id ?? (await db.one(`SELECT id AS category_id FROM tbl_category LIMIT 1`)).category_id;
      const dept = base?.department_id ?? (await db.one(`SELECT id AS department_id FROM tbl_department LIMIT 1`)).department_id;
      const { id } = await db.one(
        `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id, department_id,
                              process_id, status, created_by)
         VALUES ($1, 'guard arc', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [`GUARD-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, cat, IDS.hospitality.A, IDS.hotels.A1, dept, processId, status, ADMIN]
      );
      return Number(id);
    };
    const client = await httpClient(ADMIN);
    const terminal = await arc("committee_rejected");
    try {
      const ok = await client.put(`${PROC_URL}/${processId}`).send({ is_active: false });
      expect(ok.status).toBe(200);
      await db.none(`UPDATE tbl_approval_processes SET is_active = true WHERE id=$1`, [processId]);
      const open = await arc("tech_eval_rejected");
      try {
        const res = await client.delete(`${PROC_URL}/${processId}`);
        expect(res.status).toBe(409);
        expect(res.body.data.blockers.open_arcs).toBe(1);
      } finally {
        await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [open]);
      }
    } finally {
      await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [terminal]);
    }
  });

  it("a role grant blocks it", async () => {
    grantIds.push(await grantRoleScope(db, {
      userId: IDS.users.a1_proc_buyer, roleId: 2, companyId: IDS.hospitality.A, processId,
    }));
    const client = await httpClient(ADMIN);
    const res = await client.delete(`${PROC_URL}/${processId}`);
    expect(res.status).toBe(409);
    expect(res.body.data.blockers.role_grants).toBe(1);
  });

  it("an active policy blocks it and names the hotel", async () => {
    const pid = await newPolicy("RFQ", processId);
    const client = await httpClient(ADMIN);
    const res = await client.delete(`${PROC_URL}/${processId}`);
    expect(res.status).toBe(409);
    const [p] = res.body.data.blockers.policies;
    expect(p.id).toBe(pid);
    expect(p.entity_type).toBe("RFQ");
    expect(typeof p.hotel_name).toBe("string");
  });

  it("an unused process deactivates", async () => {
    const client = await httpClient(ADMIN);
    const res = await client.delete(`${PROC_URL}/${processId}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Process deactivated successfully");
    const row = await db.one(`SELECT is_active FROM tbl_approval_processes WHERE id=$1`, [processId]);
    expect(row.is_active).toBe(false);
  });
});

describe("PUT process", () => {
  it("is_active:false on an in-use process is refused with 409", async () => {
    const { rfq_id } = await makeRFQ(db, { createdBy: ADMIN, process: processId, status: 3 });
    rfqIds.push(rfq_id);
    const client = await httpClient(ADMIN);
    const res = await client.put(`${PROC_URL}/${processId}`).send({ is_active: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PROCESS_IN_USE");
    const row = await db.one(`SELECT is_active FROM tbl_approval_processes WHERE id=$1`, [processId]);
    expect(row.is_active).toBe(true);
  });

  it("is_active:false then true on an unused process still works", async () => {
    const client = await httpClient(ADMIN);
    expect((await client.put(`${PROC_URL}/${processId}`).send({ is_active: false })).status).toBe(200);
    const res = await client.put(`${PROC_URL}/${processId}`).send({ is_active: true });
    expect(res.status).toBe(200);
    expect(res.body.data.is_active).toBe(true);
  });

  it("ignores process_type", async () => {
    const client = await httpClient(ADMIN);
    const res = await client.put(`${PROC_URL}/${processId}`).send({ process_type: "ARC", description: "x" });
    expect(res.status).toBe(200);
    const row = await db.one(`SELECT process_type, description FROM tbl_approval_processes WHERE id=$1`, [processId]);
    expect(row.process_type).toBe("RFQ");
    expect(row.description).toBe("x");
  });
});

describe("GET policy-coverage", () => {
  it("reports entity types per process for a hotel, and process-free policies", async () => {
    await newPolicy("RFQ", processId);
    await newPolicy("PO", processId, IDS.hotels.A1, false); // inactive: ignored
    await newPolicy("TENDER", null);
    const client = await httpClient(ADMIN);
    const res = await client.get(`${COVERAGE_URL}?hotel_id=${IDS.hotels.A1}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.hotel_id).toBe(IDS.hotels.A1);
    const types = res.body.data.by_process[String(processId)];
    expect(types).toContain("RFQ");
    expect(types).toContain("TENDER"); // process-free policy matches every process
    expect(types).not.toContain("PO"); // inactive policy ignored
    expect(res.body.data.process_free).toContain("TENDER");
  });

  it("a policy at another hotel does not count for this hotel", async () => {
    await newPolicy("RFQ", processId, IDS.hotels.A2);
    const client = await httpClient(ADMIN);
    const res = await client.get(`${COVERAGE_URL}?hotel_id=${IDS.hotels.A1}`);
    expect(res.status).toBe(200);
    expect(res.body.data.by_process[String(processId)] || []).not.toContain("RFQ");
  });

  it("without hotel_id returns the union over the caller's scope", async () => {
    await newPolicy("RFQ", processId, IDS.hotels.A2);
    const client = await httpClient(ADMIN);
    const res = await client.get(COVERAGE_URL);
    expect(res.status).toBe(200);
    expect(res.body.data.hotel_id).toBeNull();
    expect(res.body.data.by_process[String(processId)]).toContain("RFQ");
  });

  it("404s for another tenant's hotel", async () => {
    const client = await httpClient(OTHER_ADMIN);
    const res = await client.get(`${COVERAGE_URL}?hotel_id=${IDS.hotels.A1}`);
    expect(res.status).toBe(404);
  });
});
