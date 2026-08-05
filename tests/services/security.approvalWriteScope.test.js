// SECURITY — cross-tenant WRITES in the approval cluster (P0).
// ----------------------------------------------------------------------------
// Commit 92604b60 closed the *read* IDORs in this cluster and deliberately left
// the writes for explicit authorization. The writes are strictly worse than the
// reads: they let a caller in tenant A rewrite who approves tenant B's spend.
//
//  (1) POST /general/hospitality/approval/policies (upsert)
//      The update branch accepted a policy `id` and rewrote the row + ALL of its
//      steps with no tenant check whatsoever — redirecting another company's
//      approval chain to approvers of the attacker's choosing. It also snapshot
//      the victim's steps and enumerated their PENDING instances (leaking RFQ /
//      PO numbers) before any write.
//      The create branch took `hospitality_company_id` straight from the body,
//      so a policy could be planted inside another tenant.
//
//  (2) POST /general/hospitality/approval/submit
//      hospitality_company_id came from the body, never from req.user, so an
//      approval instance could be opened inside another tenant.
//
//  (3) POST /general/hospitality/approval/cancel
//      Route had NO acl() and the model had no tenant column: any authenticated
//      user could CANCEL any PENDING approval instance by sequential id
//      (3,846 live instances / 361 pending in production).
//
//  (4) PUT|DELETE /general/hospitality/approval/processes/:id
//      Mutated tbl_approval_processes by id with no tenant check.
//
// Scope must derive from req.user, never from the body. 404 (not 403) on a
// cross-tenant id, mirroring the read fixes, so existence is not leaked.

import { describe, it, expect, afterAll, beforeAll, afterEach } from "@jest/globals";
import { db, closeDb } from "../setup/db.js";
import { IDS } from "../fixtures/ids.js";
import { httpClient } from "../helpers/http.js";

// The policy routes are acl([7]) (hospitality admin) / acl([7, 2]).
// Fixture users have user_type NULL; stamp them for the suite and restore after.
const prevUserTypes = {};
const AS_ADMIN = [IDS.users.companyA_admin, IDS.users.companyB_admin];

const A_POLICY = IDS.policies.A1_P1_RFQ;
const B_POLICY = IDS.policies.B1_P1_RFQ;

// The happy-path tests below deliberately mutate two AMBIENT fixture rows
// (policy A1_P1_RFQ and process A_P2) because that is what the real endpoint
// does. Snapshot them up front and put them back afterwards — the fixture
// population is shared with every other suite in the worker.
let policyBaseline = null;
let processBaseline = null;

beforeAll(async () => {
  for (const uid of AS_ADMIN) {
    const row = await db.one(`SELECT user_type FROM tbl_users WHERE id=$1`, [uid]);
    prevUserTypes[uid] = row.user_type;
    await db.none(`UPDATE tbl_users SET user_type = 7 WHERE id=$1`, [uid]);
  }

  policyBaseline = {
    row: await db.one(
      `SELECT entity_type, hospitality_company_id, hotel_id, department_id,
              process_id, is_active, is_master
         FROM tbl_approval_policies WHERE id = $1`,
      [A_POLICY]
    ),
    steps: await db.any(
      `SELECT step_order, decision_rule, approver_source_type, approver_source_id
         FROM tbl_approval_policy_steps
        WHERE approval_policy_id = $1 ORDER BY step_order`,
      [A_POLICY]
    ),
  };
  processBaseline = await db.one(
    `SELECT name, description, is_active, process_type
       FROM tbl_approval_processes WHERE id = $1`,
    [IDS.processes.A_P2]
  );
});

afterAll(async () => {
  if (policyBaseline) {
    await db.none(
      `UPDATE tbl_approval_policies
          SET entity_type = $2, hospitality_company_id = $3, hotel_id = $4,
              department_id = $5, process_id = $6, is_active = $7, is_master = $8
        WHERE id = $1`,
      [
        A_POLICY, policyBaseline.row.entity_type, policyBaseline.row.hospitality_company_id,
        policyBaseline.row.hotel_id, policyBaseline.row.department_id,
        policyBaseline.row.process_id, policyBaseline.row.is_active, policyBaseline.row.is_master,
      ]
    );
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [A_POLICY]);
    for (const s of policyBaseline.steps) {
      await db.none(
        `INSERT INTO tbl_approval_policy_steps
           (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [A_POLICY, s.step_order, s.decision_rule, s.approver_source_type, s.approver_source_id]
      );
    }
  }
  if (processBaseline) {
    await db.none(
      `UPDATE tbl_approval_processes
          SET name = $2, description = $3, is_active = $4, process_type = $5
        WHERE id = $1`,
      [
        IDS.processes.A_P2, processBaseline.name, processBaseline.description,
        processBaseline.is_active, processBaseline.process_type,
      ]
    );
  }

  for (const uid of AS_ADMIN) {
    await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id=$1`, [uid, prevUserTypes[uid]]);
  }
  await closeDb();
});

// Rows created by the tests themselves, torn down after each one.
const made = { policyIds: [], instanceIds: [] };

afterEach(async () => {
  if (made.policyIds.length) {
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [made.policyIds]);
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [made.policyIds]);
  }
  if (made.instanceIds.length) {
    await db.none(
      `DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [made.instanceIds]);
    await db.none(
      `DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id IN
         (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [made.instanceIds]
    );
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [made.instanceIds]);
    await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [made.instanceIds]);
  }
  made.policyIds = [];
  made.instanceIds = [];
});

/** Full fingerprint of a policy row + its steps, for before/after comparison. */
async function policySnapshot(policyId) {
  const policy = await db.oneOrNone(
    `SELECT id, entity_type, hospitality_company_id, hotel_id, department_id,
            process_id, is_active, is_master
       FROM tbl_approval_policies WHERE id = $1`,
    [policyId]
  );
  const steps = await db.any(
    `SELECT step_order, decision_rule, approver_source_type, approver_source_id
       FROM tbl_approval_policy_steps
      WHERE approval_policy_id = $1 ORDER BY step_order`,
    [policyId]
  );
  return { policy, steps };
}

async function makeInstance({ hospitality, hotel, policyId, entityId }) {
  const inst = await db.one(
    `INSERT INTO tbl_approval_instances
       (entity_type, entity_id, approval_policy_id, status, current_step,
        hospitality_company_id, hotel_id, department_id, initiated_by)
     VALUES ('RFQ', $1, $2, 'PENDING', 1, $3, $4, NULL, $5)
     RETURNING id`,
    [entityId, policyId, hospitality, hotel, IDS.users.companyB_admin]
  );
  made.instanceIds.push(inst.id);
  const step = await db.one(
    `INSERT INTO tbl_approval_instance_steps
       (approval_instance_id, step_order, decision_rule, status)
     VALUES ($1, 1, 'ANY', 'PENDING') RETURNING id`,
    [inst.id]
  );
  await db.none(
    `INSERT INTO tbl_approval_step_approvers
       (approval_instance_step_id, approver_user_id, status)
     VALUES ($1, $2, 'PENDING')`,
    [step.id, IDS.users.companyB_admin]
  );
  return inst.id;
}

// ---------------------------------------------------------------------------
describe("SECURITY: POST /approval/policies — cross-tenant UPDATE", () => {
  it("a company-A admin cannot rewrite company B's policy (404, row untouched)", async () => {
    const before = await policySnapshot(B_POLICY);

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post("/api/v1/general/hospitality/approval/policies").send({
      id: B_POLICY,
      entity_type: "RFQ",
      hospitality_company_id: IDS.hospitality.B,
      hotel_id: IDS.hotels.B1,
      process_id: IDS.processes.B_P1,
      is_active: true,
      confirmed_approval_impact: true,
      steps: [
        {
          step_order: 1,
          decision_rule: "ANY",
          approver_source_type: "USER",
          approver_source_id: IDS.users.companyA_admin, // attacker inserts themselves
        },
      ],
    });

    expect(res.status).toBe(404);
    expect(res.body.status).not.toBe(1);

    const after = await policySnapshot(B_POLICY);
    expect(after).toEqual(before);
    // The attacker must NOT have become an approver on B's chain.
    expect(after.steps.map((s) => s.approver_source_id)).not.toContain(IDS.users.companyA_admin);
  });

  it("cannot hijack B's policy even by claiming its own company id in the body", async () => {
    const before = await policySnapshot(B_POLICY);

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post("/api/v1/general/hospitality/approval/policies").send({
      id: B_POLICY,
      entity_type: "RFQ",
      hospitality_company_id: IDS.hospitality.A, // lie: pretend it is A's
      hotel_id: IDS.hotels.A1,
      is_active: true,
      confirmed_approval_impact: true,
      steps: [
        { step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: IDS.users.companyA_admin },
      ],
    });

    expect(res.status).toBe(404);
    const after = await policySnapshot(B_POLICY);
    expect(after).toEqual(before);
    expect(after.policy.hospitality_company_id).toBe(IDS.hospitality.B);
  });

  it("the same-tenant update path still works", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post("/api/v1/general/hospitality/approval/policies").send({
      id: A_POLICY,
      entity_type: "RFQ",
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      process_id: IDS.processes.A_P1,
      is_active: true,
      confirmed_approval_impact: true,
      steps: [
        { step_order: 1, decision_rule: "ALL", approver_source_type: "USER", approver_source_id: IDS.users.a1_proc_techApp },
        { step_order: 2, decision_rule: "ALL", approver_source_type: "USER", approver_source_id: IDS.users.a1_proc_finance },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
    expect(res.body.data.id).toBe(A_POLICY);
    expect(res.body.data.hospitality_company_id).toBe(IDS.hospitality.A);
    expect(res.body.data.steps.length).toBe(2);
  });

  it("an update that omits hospitality_company_id does not NULL the tenant column", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post("/api/v1/general/hospitality/approval/policies").send({
      id: A_POLICY,
      entity_type: "RFQ",
      hotel_id: IDS.hotels.A1,
      is_active: true,
      confirmed_approval_impact: true,
    });

    expect(res.status).toBe(200);
    const row = await db.one(
      `SELECT hospitality_company_id FROM tbl_approval_policies WHERE id=$1`, [A_POLICY]);
    expect(row.hospitality_company_id).toBe(IDS.hospitality.A);
  });
});

// ---------------------------------------------------------------------------
describe("SECURITY: POST /approval/policies — cross-tenant CREATE", () => {
  it("a company-A admin cannot plant a policy inside company B", async () => {
    const bBefore = await db.one(
      `SELECT count(*)::int AS c FROM tbl_approval_policies WHERE hospitality_company_id = $1`,
      [IDS.hospitality.B]
    );

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post("/api/v1/general/hospitality/approval/policies").send({
      entity_type: "TECHNICAL",
      hospitality_company_id: IDS.hospitality.B,
      hotel_id: IDS.hotels.B2,
      is_active: true,
      steps: [
        { step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: IDS.users.companyA_admin },
      ],
    });

    // Whatever the shape of the refusal, no row may land in B.
    expect(res.status).not.toBe(201);
    const bAfter = await db.one(
      `SELECT count(*)::int AS c FROM tbl_approval_policies WHERE hospitality_company_id = $1`,
      [IDS.hospitality.B]
    );
    expect(bAfter.c).toBe(bBefore.c);
  });

  it("the same-tenant create path still works", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post("/api/v1/general/hospitality/approval/policies").send({
      entity_type: "INDENT",
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A3,
      is_active: true,
      steps: [
        { step_order: 1, decision_rule: "ANY", approver_source_type: "USER", approver_source_id: IDS.users.a1_proc_finance },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.hospitality_company_id).toBe(IDS.hospitality.A);
    made.policyIds.push(res.body.data.id);
  });
});

// ---------------------------------------------------------------------------
describe("SECURITY: POST /approval/submit — company from req.user, not the body", () => {
  it("a body-supplied company outside the caller's scope is refused", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post("/api/v1/general/hospitality/approval/submit").send({
      entity_type: "RFQ",
      entity_id: 998801,
      hospitality_company_id: IDS.hospitality.B,
      hotel_id: IDS.hotels.B1,
      process_id: IDS.processes.B_P1,
    });

    expect(res.status).not.toBe(201);

    const leaked = await db.oneOrNone(
      `SELECT id FROM tbl_approval_instances
        WHERE entity_type='RFQ' AND entity_id = 998801`
    );
    if (leaked) made.instanceIds.push(leaked.id);
    expect(leaked).toBeNull();
  });

  it("the same-tenant submit still creates the instance in the caller's company", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post("/api/v1/general/hospitality/approval/submit").send({
      entity_type: "RFQ",
      entity_id: 998802,
      hospitality_company_id: IDS.hospitality.A,
      hotel_id: IDS.hotels.A1,
      process_id: IDS.processes.A_P1,
    });

    const row = await db.oneOrNone(
      `SELECT id, hospitality_company_id FROM tbl_approval_instances
        WHERE entity_type='RFQ' AND entity_id = 998802`
    );
    if (row) made.instanceIds.push(row.id);

    expect(res.status).toBe(201);
    expect(row).not.toBeNull();
    expect(row.hospitality_company_id).toBe(IDS.hospitality.A);
  });

  it("the super-admin (user_type 8) bypass is preserved", async () => {
    const prev = await db.one(`SELECT user_type FROM tbl_users WHERE id=$1`, [IDS.users.superAdmin]);
    await db.none(`UPDATE tbl_users SET user_type = 8 WHERE id=$1`, [IDS.users.superAdmin]);
    try {
      const client = await httpClient(IDS.users.superAdmin);
      const res = await client.post("/api/v1/general/hospitality/approval/submit").send({
        entity_type: "RFQ",
        entity_id: 998803,
        hospitality_company_id: IDS.hospitality.B,
        hotel_id: IDS.hotels.B1,
        process_id: IDS.processes.B_P1,
      });

      const row = await db.oneOrNone(
        `SELECT id, hospitality_company_id FROM tbl_approval_instances
          WHERE entity_type='RFQ' AND entity_id = 998803`
      );
      if (row) made.instanceIds.push(row.id);

      expect(res.status).toBe(201);
      expect(row.hospitality_company_id).toBe(IDS.hospitality.B);
    } finally {
      await db.none(`UPDATE tbl_users SET user_type = $2 WHERE id=$1`, [IDS.users.superAdmin, prev.user_type]);
    }
  });
});

// ---------------------------------------------------------------------------
describe("SECURITY: POST /approval/cancel — cross-tenant instance", () => {
  it("a company-A admin cannot cancel company B's pending approval", async () => {
    const instId = await makeInstance({
      hospitality: IDS.hospitality.B, hotel: IDS.hotels.B1, policyId: B_POLICY, entityId: 998811,
    });

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post("/api/v1/general/hospitality/approval/cancel").send({
      instance_id: instId, reason: "not mine",
    });

    expect(res.status).toBe(404);
    const after = await db.one(`SELECT status FROM tbl_approval_instances WHERE id=$1`, [instId]);
    expect(after.status).toBe("PENDING");
  });

  it("cancelling the caller's OWN pending approval still works", async () => {
    const instId = await makeInstance({
      hospitality: IDS.hospitality.A, hotel: IDS.hotels.A1, policyId: A_POLICY, entityId: 998812,
    });

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.post("/api/v1/general/hospitality/approval/cancel").send({
      instance_id: instId, reason: "superseded",
    });

    expect(res.status).toBe(200);
    const after = await db.one(`SELECT status FROM tbl_approval_instances WHERE id=$1`, [instId]);
    expect(after.status).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
describe("SECURITY: approval PROCESS mutations", () => {
  it("PUT /processes/:id 404s across tenants and leaves the row unchanged", async () => {
    const before = await db.one(
      `SELECT name, description, is_active, process_type, company_id
         FROM tbl_approval_processes WHERE id=$1`, [IDS.processes.B_P1]);

    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client
      .put(`/api/v1/general/hospitality/approval/processes/${IDS.processes.B_P1}`)
      .send({ name: "Pwned Process", is_active: false });

    expect(res.status).toBe(404);
    const after = await db.one(
      `SELECT name, description, is_active, process_type, company_id
         FROM tbl_approval_processes WHERE id=$1`, [IDS.processes.B_P1]);
    expect(after).toEqual(before);
  });

  it("DELETE /processes/:id 404s across tenants and leaves the process active", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client.delete(
      `/api/v1/general/hospitality/approval/processes/${IDS.processes.B_P1}`);

    expect(res.status).toBe(404);
    const after = await db.one(
      `SELECT is_active FROM tbl_approval_processes WHERE id=$1`, [IDS.processes.B_P1]);
    expect(after.is_active).toBe(true);
  });

  it("the same-tenant process update still works", async () => {
    const client = await httpClient(IDS.users.companyA_admin);
    const res = await client
      .put(`/api/v1/general/hospitality/approval/processes/${IDS.processes.A_P2}`)
      .send({ description: "Fast-track procurement — renamed by its own admin" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("SECURITY: hospitality admins keep their own tenant's scope", () => {
  // All 3 production user_type=7 admins carry ZERO tbl_hospitality_user_mappings
  // and ZERO tbl_user_role_scopes rows — their tenancy is tbl_users.company_id
  // -> tbl_hospitality_companies.buyer_company_id, exactly as
  // hospitalityController.js enforces it. Without that union the whole Approval
  // Wizard resolves to an empty scope for the only role allowed to use it.
  it("a mapping-less admin still sees (only) their own company's policies", async () => {
    const uid = IDS.users.companyA_admin;
    const maps = await db.any(
      `SELECT id FROM tbl_hospitality_user_mappings WHERE user_id=$1`, [uid]);
    const scopes = await db.any(
      `SELECT id FROM tbl_user_role_scopes WHERE user_id=$1`, [uid]);

    // Temporarily strip both, reproducing the production admin shape.
    await db.none(`DELETE FROM tbl_hospitality_user_mappings WHERE user_id=$1`, [uid]);
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id=$1`, [uid]);
    try {
      const client = await httpClient(uid);
      const res = await client.get("/api/v1/general/hospitality/approval/policies");

      expect(res.status).toBe(200);
      const rows = res.body.data || [];
      expect(rows.length).toBeGreaterThan(0);
      expect([...new Set(rows.map((r) => r.hospitality_company_id))]).toEqual([IDS.hospitality.A]);
      expect(rows.map((r) => r.id)).not.toContain(B_POLICY);
    } finally {
      await db.none(
        `INSERT INTO tbl_hospitality_user_mappings
           (user_id, hospitality_company_id, hospitality_hotel_id, mapping_type, created_by)
         VALUES ($1, $2, NULL, 0, $3)
         ON CONFLICT ON CONSTRAINT uq_hospitality_user_mapping DO NOTHING`,
        [uid, IDS.hospitality.A, IDS.users.superAdmin]
      );
      await db.none(
        `INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
         VALUES ($1, 1, $2, NULL, NULL)`,
        [uid, IDS.hospitality.A]
      );
      void maps; void scopes;
    }
  });
});
