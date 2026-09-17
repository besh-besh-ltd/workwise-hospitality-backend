// Group rate contract approval workflow fixtures.
//
// Kept apart from arcGroupSeed.js on purpose: arcApproverPerms.js registers an
// afterAll cleanup hook when it is imported, and arcGroupSeed.js is imported by
// suites that must not inherit that hook.

import { db } from "../setup/db.js";
import { ensureArcApprovable } from "./arcApproverPerms.js";

/**
 * A company-wide group rate contract approval workflow (policy type
 * ARC_GROUP by default) whose single USER step is `approver`. When the
 * approver is also the person publishing, the engine auto-approves and
 * publish floats in the same request. Returns the policy id.
 */
export async function seedGroupArcPolicy({ companyId, approver, createdBy, entityType = "ARC_GROUP" }, runner = db) {
  const policy = await runner.one(
    `INSERT INTO tbl_approval_policies
       (entity_type, hospitality_company_id, hotel_id, department_id, is_active, created_by,
        process_id, is_master, is_department_scoped, version)
     VALUES ($1, $2, NULL, NULL, true, $3, NULL, true, false, 1)
     RETURNING id`,
    [entityType, companyId, createdBy]
  );
  await runner.none(
    `INSERT INTO tbl_approval_policy_steps
       (approval_policy_id, step_order, decision_rule, approver_source_type, approver_source_id)
     VALUES ($1, 1, 'ALL', 'USER', $2)`,
    [policy.id, approver]
  );
  await ensureArcApprovable(runner, approver, companyId);
  return Number(policy.id);
}

/** Remove group workflow policies and the approval instances they spawned. */
export async function cleanupGroupArcPolicies(policyIds, runner = db) {
  const ids = (policyIds || []).map(Number).filter(Boolean);
  if (!ids.length) return;
  const insts = (await runner.any(
    `SELECT id FROM tbl_approval_instances WHERE approval_policy_id = ANY($1::int[])`, [ids]
  )).map((r) => r.id);
  if (insts.length) {
    await runner.none(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = ANY($1::int[])`, [insts]);
    await runner.none(
      `DELETE FROM tbl_approval_step_approvers
        WHERE approval_instance_step_id IN (SELECT id FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[]))`,
      [insts]
    );
    await runner.none(`DELETE FROM tbl_approval_instance_steps WHERE approval_instance_id = ANY($1::int[])`, [insts]);
    await runner.none(`DELETE FROM tbl_approval_instances WHERE id = ANY($1::int[])`, [insts]);
  }
  await runner.none(`DELETE FROM tbl_approval_policy_steps WHERE approval_policy_id = ANY($1::int[])`, [ids]);
  await runner.none(`DELETE FROM tbl_approval_policies WHERE id = ANY($1::int[])`, [ids]);
}
