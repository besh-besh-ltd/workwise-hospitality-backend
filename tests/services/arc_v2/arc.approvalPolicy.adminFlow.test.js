// ARC approval policies from the admin UI — process-free, end-to-end.
//
// The bug this closes: the process-first Approval Wizard stamps every policy
// with a non-NULL process_id, but ARC entities are created with process_id =
// NULL, so findBestMatchingPolicyTx (which reduces to `process_id IS NULL` for
// them) can never match a wizard-made ARC policy → publish/eval hard-400s, and
// ARC policies could only be seeded via scripts/seed_arc_publish_policy.js.
//
// This suite proves the admin endpoint now (a) coerces ARC policies to
// process_id = NULL, (b) accepts the ARC v2 per-stage entity types, and (c)
// that such a policy actually resolves for an ARC approval instance — no
// manual insertion required.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { createApprovalInstance, findBestMatchingPolicyTx } from "../../../app/models/generalModel.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const PROC = IDS.processes.A_P1;            // a real process — must be stripped for ARC
const ADMIN = IDS.users.a1_proc_buyer;      // gets user_type=7 for acl([7])
const APPROVER = IDS.users.a1_proc_techApp; // USER-step approver (hospitality mapping A/A1)
const ARC_ENTITY_ID = 990111;               // synthetic ARC id for instance resolution

const createdPolicyIds = [];
let client;

async function createPolicy(body) {
  return client.post("/api/v1/general/hospitality/approval/policies").send(body);
}

beforeAll(async () => {
  await db.none(`UPDATE tbl_users SET user_type = 7, status = 1 WHERE id = $1`, [ADMIN]);
  client = await httpClient(ADMIN);
});

afterAll(async () => {
  for (const id of createdPolicyIds) {
    await db.none(`DELETE FROM tbl_approval_step_approvers asa USING tbl_approval_instance_steps ais WHERE ais.id = asa.approval_instance_step_id AND ais.approval_instance_id IN (SELECT id FROM tbl_approval_instances WHERE approval_policy_id = $1)`, [id]).catch(() => {});
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (SELECT id FROM tbl_approval_instances WHERE approval_policy_id = $1)`, [id]).catch(() => {});
    await db.none(`DELETE FROM tbl_approval_instances WHERE approval_policy_id = $1`, [id]).catch(() => {});
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [id]).catch(() => {});
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [id]).catch(() => {});
  }
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [ADMIN]).catch(() => {});
  await closeDb();
});

describe("ARC approval policy — admin flow (process-free)", () => {
  it("creates an ARC base policy and COERCES process_id to NULL even when a process is sent", async () => {
    const res = await createPolicy({
      entity_type: "ARC",
      hospitality_company_id: HC, hotel_id: HOTEL, department_id: null,
      process_id: PROC,            // sent by the client — must be stripped
      is_master: true, is_active: true,
      steps: [{ approver_source_type: "USER", approver_source_id: APPROVER, decision_rule: "ANY", approval_type: "STANDARD", step_order: 1 }],
    });
    expect([200, 201]).toContain(res.status);
    const policy = res.body?.data;
    expect(policy?.id).toBeTruthy();
    createdPolicyIds.push(policy.id);
    expect(policy.process_id == null).toBe(true);
    const row = await db.one(`SELECT process_id FROM tbl_approval_policies WHERE id = $1`, [policy.id]);
    expect(row.process_id == null).toBe(true);
  });

  it("accepts the ARC v2 per-stage entity types (not 'Invalid entity_type') and stores them process-free", async () => {
    for (const et of ["ARC_TECH", "ARC_COMMITTEE", "ARC_NEGOTIATION", "ARC_AMENDMENT"]) {
      const res = await createPolicy({
        entity_type: et, hospitality_company_id: HC, hotel_id: HOTEL, department_id: null,
        process_id: PROC, is_master: true, is_active: true,
        steps: [{ approver_source_type: "USER", approver_source_id: APPROVER, decision_rule: "ANY", approval_type: "STANDARD", step_order: 1 }],
      });
      expect([200, 201]).toContain(res.status);
      expect(res.body?.data?.id).toBeTruthy();
      createdPolicyIds.push(res.body.data.id);
      expect(res.body.data.process_id == null).toBe(true);
    }
  });

  it("a process-NULL ARC policy created via the admin flow RESOLVES for an ARC instance (no manual seeding)", async () => {
    // The base ARC policy created in test 1 (process-NULL) must satisfy an ARC
    // approval instance whose process_id is NULL (ARC is process-free).
    const result = await createApprovalInstance({
      entity_type: "ARC",
      entity_id: ARC_ENTITY_ID,
      hospitality_company_id: HC, hotel_id: HOTEL, department_id: null,
      process_id: null,
      initiated_by: ADMIN,
      metadata: { test: true },
    });
    expect(result?.instance?.id).toBeTruthy();
    const approvers = await db.any(
      `SELECT asa.approver_user_id
         FROM tbl_approval_step_approvers asa
         JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
        WHERE ais.approval_instance_id = $1`, [result.instance.id]);
    expect(approvers.map((a) => Number(a.approver_user_id))).toContain(APPROVER);
  });

  it("NEGATIVE: a process-NON-NULL ARC policy does NOT match an ARC (process-NULL) instance — why coercion matters", async () => {
    // Seed a "bad" ARC policy WITH a process (as the old process-first wizard
    // did) at a DIFFERENT hotel so it's the only candidate there.
    const bad = await db.one(
      `INSERT INTO tbl_approval_policies
         (entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by, process_id, is_master, version)
       VALUES ('ARC', $1, $2, NULL, true, $4, $5, true, 1) RETURNING id`,
      [HC, IDS.hotels.A2, DEPT, ADMIN, PROC]);
    createdPolicyIds.push(bad.id);
    await db.none(
      `INSERT INTO tbl_approval_policy_steps (approval_policy_id, step_order, approval_type, decision_rule, approver_source_type, approver_source_id)
       VALUES ($1, 1, 'STANDARD', 'ANY', 'USER', $2)`, [bad.id, APPROVER]);

    const match = await db.task((t) =>
      findBestMatchingPolicyTx({ entity_type: "ARC", hospitality_company_id: HC, hotel_id: IDS.hotels.A2, department_id: DEPT, process_id: null }, t));
    expect(match == null).toBe(true);
  });
});
