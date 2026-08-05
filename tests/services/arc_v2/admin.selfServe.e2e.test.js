// SINGLE SOURCE OF TRUTH — admin self-serve config → live workflow, end-to-end.
//
// Proves the claim: an admin can configure a COMPLETE ARC approval workflow
// (role + permissions + user assignment + approval policy) entirely through the
// HTTP APIs the company-admin UI calls — with NO process and NO manual DB
// insertion for tenant config — and that workflow then resolves the correct
// approver when an ARC needs approval.
//
// What is legitimately pre-seeded (product data, NOT tenant config):
//   - base identity: companies / hotels / users (fixtures)
//   - the PERMISSION CATALOG (which permission keys exist) — shipped by
//     migration 20260608100800; the test DB's dump predates it, so we seed the
//     two ARC catalog rows this test needs in beforeAll. Admins PICK from the
//     catalog; they never invent keys.
//
// Everything under test — the ROLE, its permission grants, the USER→role
// assignment, and the APPROVAL POLICY — is created ONLY via HTTP endpoints.
// The suite performs zero `INSERT INTO tbl_role_permissions / tbl_user_role_scopes
// / tbl_approval_policies` for those entities.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { db, closeDb } from "../../setup/db.js";
import { httpClient } from "../../helpers/http.js";
import { IDS } from "../../fixtures/ids.js";
import { createApprovalInstance, findBestMatchingPolicyTx } from "../../../app/models/generalModel.js";

const HC = IDS.hospitality.A;
const HOTEL = IDS.hotels.A1;
const DEPT = IDS.departments.proc;
const RFQ_PROC = IDS.processes.A_P1;          // a real process for the RFQ (process-based) leg
const HOTEL_CLEAN = IDS.hotels.A3;            // deliberately under-configured hotel — no fixture policies
const ADMIN = IDS.users.a1_proc_buyer;        // gets user_type=7 (isAdmin + acl gates)
const APPROVER = IDS.users.a1_proc_techApp;   // gets the ARC role via API; has hospitality mapping A/A1
const ARC_ENTITY_ID = 991414;

let client;
let arcReadId, arcApproveId;
let createdRoleId;
const createdPolicyIds = [];

async function ensurePermission(resource, action) {
  const existing = await db.oneOrNone(`SELECT id FROM tbl_permissions WHERE resource=$1 AND action=$2`, [resource, action]);
  if (existing) return existing.id;
  const ins = await db.one(`INSERT INTO tbl_permissions (resource, action) VALUES ($1, $2) RETURNING id`, [resource, action]);
  return ins.id;
}

beforeAll(async () => {
  // Product-catalog setup (represents migration 20260608100800). resource_type
  // enum already has 'arc'; seed the two rows this test's role needs.
  arcReadId = await ensurePermission("arc", "read");
  arcApproveId = await ensurePermission("arc", "approve");
  await db.none(`UPDATE tbl_users SET user_type = 7, status = 1 WHERE id = $1`, [ADMIN]);
  await db.none(`UPDATE tbl_users SET status = 1 WHERE id = $1`, [APPROVER]);
  client = await httpClient(ADMIN);
});

afterAll(async () => {
  // Tear down everything the APIs created (config under test).
  for (const id of createdPolicyIds) {
    await db.none(`DELETE FROM tbl_approval_step_approvers asa USING tbl_approval_instance_steps ais WHERE ais.id = asa.approval_instance_step_id AND ais.approval_instance_id IN (SELECT id FROM tbl_approval_instances WHERE approval_policy_id = $1)`, [id]).catch(() => {});
    await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id IN (SELECT id FROM tbl_approval_instances WHERE approval_policy_id = $1)`, [id]).catch(() => {});
    await db.none(`DELETE FROM tbl_approval_instances WHERE approval_policy_id = $1`, [id]).catch(() => {});
    await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [id]).catch(() => {});
    await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [id]).catch(() => {});
  }
  if (createdRoleId) {
    await db.none(`DELETE FROM tbl_user_role_scopes WHERE role_id = $1`, [createdRoleId]).catch(() => {});
    await db.none(`DELETE FROM tbl_role_permissions WHERE role_id = $1`, [createdRoleId]).catch(() => {});
    await db.none(`DELETE FROM tbl_roles WHERE id = $1`, [createdRoleId]).catch(() => {});
  }
  // Restore the approver's original scope (fixture: TECH_APPROVER at A/A1/proc, process-free).
  await db.none(`DELETE FROM tbl_user_role_scopes WHERE user_id = $1`, [APPROVER]).catch(() => {});
  await db.none(`INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id) VALUES ($1, 7, $2, $3, $4)`, [APPROVER, HC, HOTEL, DEPT]).catch(() => {});
  await db.none(`UPDATE tbl_users SET user_type = NULL WHERE id = $1`, [ADMIN]).catch(() => {});
  await closeDb();
});

describe("Admin self-serve config → live workflow (single source of truth)", () => {
  it("STEP 1 — creates a custom ARC role with arc.read + arc.approve via POST /rbac/roles (no manual insert)", async () => {
    const res = await client.post("/api/v1/rbac/roles").send({
      title: "E2E ARC Committee",
      description: "Created via admin API in the self-serve E2E",
      permission_ids: [arcReadId, arcApproveId],
    });
    expect([200, 201]).toContain(res.status);
    createdRoleId = res.body?.data?.role_id;
    expect(createdRoleId).toBeTruthy();
    // The role really carries the two ARC permissions (via the API, not a direct insert).
    const perms = await db.any(
      `SELECT p.resource, p.action FROM tbl_role_permissions rp JOIN tbl_permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1`,
      [createdRoleId]);
    const keys = perms.map((p) => `${p.resource}.${p.action}`);
    expect(keys).toEqual(expect.arrayContaining(["arc.read", "arc.approve"]));
  });

  it("STEP 2 — assigns the ARC role to a user PROCESS-FREE via PUT /users/update-user-detail", async () => {
    const res = await client.put("/api/v1/users/update-user-detail").send({
      user_id: APPROVER,
      confirmed_approval_impact: true,
      roles: [
        // Keep the approver's own tech role, ADD the new ARC role — both process-free.
        { role_id: 7, company_id: HC, hotel_id: HOTEL, department_id: DEPT },
        { role_id: createdRoleId, company_id: HC, hotel_id: HOTEL, department_id: DEPT },
      ],
    });
    expect([200, 201]).toContain(res.status);
    const scope = await db.oneOrNone(
      `SELECT process_id FROM tbl_user_role_scopes WHERE user_id = $1 AND role_id = $2`,
      [APPROVER, createdRoleId]);
    expect(scope).toBeTruthy();
    expect(scope.process_id == null).toBe(true); // ARC grant is process-free
  });

  it("STEP 3 — creates a PROCESS-FREE ARC approval policy with a ROLE step via POST /general/.../policies", async () => {
    const res = await client.post("/api/v1/general/hospitality/approval/policies").send({
      entity_type: "ARC",
      hospitality_company_id: HC, hotel_id: HOTEL, department_id: null,
      process_id: RFQ_PROC,            // sent — must be coerced to NULL for ARC
      is_master: true, is_active: true,
      steps: [{ approver_source_type: "ROLE", approver_source_id: createdRoleId, decision_rule: "ANY", approval_type: "STANDARD", step_order: 1 }],
    });
    expect([200, 201]).toContain(res.status);
    const policy = res.body?.data;
    expect(policy?.id).toBeTruthy();
    createdPolicyIds.push(policy.id);
    expect(policy.process_id == null).toBe(true);       // coerced
    expect(policy.entity_type).toBe("ARC");
    expect(Number(policy.created_by)).toBe(ADMIN);       // proves it came through the API, not a raw insert
  });

  it("STEP 4 ⭐ — an ARC approval instance resolves the API-configured approver (the full chain works)", async () => {
    const result = await createApprovalInstance({
      entity_type: "ARC",
      entity_id: ARC_ENTITY_ID,
      hospitality_company_id: HC, hotel_id: HOTEL, department_id: null,
      process_id: null,           // ARC is process-free
      initiated_by: ADMIN,        // ≠ approver, so it doesn't auto-approve
      metadata: { e2e: true },
    });
    expect(result?.instance?.id).toBeTruthy();
    const approvers = await db.any(
      `SELECT asa.approver_user_id
         FROM tbl_approval_step_approvers asa
         JOIN tbl_approval_instance_steps ais ON ais.id = asa.approval_instance_step_id
        WHERE ais.approval_instance_id = $1`, [result.instance.id]);
    // The user we assigned the API-created ARC role to resolves as the approver —
    // role (API) + permissions (API) + user assignment (API) + policy (API) all
    // wired together with zero manual insertion.
    expect(approvers.map((a) => Number(a.approver_user_id))).toContain(APPROVER);
  });

  it("STEP 5 — process-BASED config is also UI-driven: an RFQ policy on a process persists process_id (not coerced)", async () => {
    // Department-scoped RFQ policy at an under-configured hotel — a scope the
    // fixtures (all dept-NULL master policies) don't occupy, so no collision.
    const res = await client.post("/api/v1/general/hospitality/approval/policies").send({
      entity_type: "RFQ",
      hospitality_company_id: HC, hotel_id: HOTEL_CLEAN, department_id: DEPT,
      process_id: RFQ_PROC,        // RFQ IS process-based — must be kept
      is_master: false, is_active: true,
      steps: [{ approver_source_type: "USER", approver_source_id: APPROVER, decision_rule: "ANY", approval_type: "STANDARD", step_order: 1 }],
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body?.data?.id).toBeTruthy();
    createdPolicyIds.push(res.body.data.id);
    expect(Number(res.body.data.process_id)).toBe(RFQ_PROC);   // NOT coerced — RFQ keeps its process
  });

  it("STEP 6 — the API-created ARC policy is the one that resolves (matcher confirms it, process-free)", async () => {
    const match = await db.task((t) =>
      findBestMatchingPolicyTx({ entity_type: "ARC", hospitality_company_id: HC, hotel_id: HOTEL, department_id: null, process_id: null }, t));
    expect(match).toBeTruthy();
    expect(createdPolicyIds).toContain(match.id);
    expect(match.process_id == null).toBe(true);
  });
});
