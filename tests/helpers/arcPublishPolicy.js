// Test helper — ARC publish-approval policy seeding.
//
// The publish-approval gate makes POST /arc-v2/:id/publish require a matching
// ARC approval policy (entity_type 'ARC') for the ARC's scope; otherwise it
// 400s and the ARC stays draft. Suites that assert the OLD "publish floats
// immediately" behaviour seed an AUTO-APPROVE policy: the publisher is the sole
// approver, so the engine births the instance APPROVED and publish auto-floats
// in the same request (status → 'floated'), preserving those suites' intent.
//
// Mirrors arc.publishApproval.test.js's pointPolicyAt(): company+hotel+process
// scope, NULL department (matches any dept under the hotel), single ANY/ALL
// step pointed at the approver. Idempotent by policyId. maxWorkers:1 makes a
// fixed id + shared scope safe (only one policy per scope alive at a time).

import { db } from "../setup/db.js";
import { ensureArcApprovable } from "./arcApproverPerms.js";


export async function seedAutoApproveArcPolicy({
  policyId,
  hospitalityCompanyId,
  hotelId,
  departmentId = null,
  processId = null,
  createdBy,
  approver,          // the user who will publish → sole approver → auto-float
}) {
  await db.none(
    `INSERT INTO tbl_approval_policies
       (id, entity_type, hospitality_company_id, hotel_id, department_id,
        is_active, created_by, process_id, is_master, is_department_scoped, version)
     VALUES ($1, 'ARC', $2, $3, $4, true, $5, $6, false, false, 1)
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
    [policyId, hospitalityCompanyId, hotelId, departmentId, createdBy, processId]
  );
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [policyId]);
  await db.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ALL', 'USER', $2)`,
    [policyId, approver]
  );
  // USER-source steps are permission-gated; the named approver must qualify.
  await ensureArcApprovable(db, approver, hospitalityCompanyId);
}

// Tear down the policy + any ARC_PUBLISH approval instances it spawned for the
// given arc ids (instances reference the policy via FK, so they go first).
export async function cleanupArcPublishPolicy({ policyId, arcIds = [] }) {
  const ids = Array.isArray(arcIds) ? arcIds.filter(Boolean).map(Number) : [];
  if (ids.length) {
    const insts = (await db.any(
      `SELECT id FROM tbl_approval_instances WHERE entity_type = 'ARC_PUBLISH' AND entity_id = ANY($1::int[])`,
      [ids]
    )).map((r) => r.id);
    if (insts.length) {
      await db.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [insts]);
      await db.none(`DELETE FROM tbl_approval_step_approvers
                      WHERE approval_instance_step_id IN
                        (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`, [insts]);
      await db.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [insts]);
      await db.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [insts]);
    }
  }
  await db.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = $1`, [policyId]);
  await db.none(`DELETE FROM tbl_approval_policies WHERE id = $1`, [policyId]);
}
