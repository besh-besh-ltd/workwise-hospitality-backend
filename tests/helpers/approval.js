// Approver-acting helper for tests. Drives the **production** approval engine
// — every call flows through `executeApprovalAction` (the same path
// controllers use), so the engine's full step-advance, instance-completion,
// and post-action dispatch logic runs verbatim.
//
// Why this helper exists: many tests need to "fully approve" or "reject mid-
// flight" a multi-step approval instance. Rolling that loop in every test
// file is verbose and error-prone. This module gives:
//
//   - approveStep(instanceId, approverUserId, opts?)  — 1 step, by 1 user
//   - rejectStep(instanceId, approverUserId, opts?)
//   - approveFully(instanceId)                         — runs to APPROVED
//   - getInstanceState(instanceId)                     — full state for asserts
//
// All helpers return Promise<{instance_status, ...}> shaped from the engine.

import { db } from "../setup/db.js";
import { executeApprovalAction } from "../../app/services/approvalActionService.js";

/**
 * Approve a single step on an instance, acting as `approverUserId`.
 * Returns the engine result: `{instance_status, step_status, ...}`.
 */
export async function approveStep(instanceId, approverUserId, { comment = "test approval" } = {}) {
  return executeApprovalAction({
    approval_instance_id: instanceId,
    approver_user_id: approverUserId,
    action: "APPROVE",
    comment,
  });
}

/**
 * Reject the current step on an instance. The engine immediately marks the
 * instance REJECTED and dispatches the rejection post-handler.
 */
export async function rejectStep(instanceId, approverUserId, { comment = "test rejection" } = {}) {
  return executeApprovalAction({
    approval_instance_id: instanceId,
    approver_user_id: approverUserId,
    action: "REJECT",
    comment,
  });
}

/**
 * Walk every PENDING step on the instance and approve it through ONE eligible
 * approver per step (chosen by `pickApprover`). Stops when the instance
 * reaches APPROVED, REJECTED, or CANCELLED. Throws if the loop can't make
 * progress (no eligible approver, or the engine returns an unexpected state).
 *
 * `pickApprover(approverUserIds, stepRow) -> userId`. Defaults to picking the
 * first eligible approver returned by the engine.
 *
 * Returns the final instance state.
 */
export async function approveFully(instanceId, { pickApprover, maxIterations = 20 } = {}) {
  const pick = pickApprover || ((ids) => ids[0]);
  for (let i = 0; i < maxIterations; i++) {
    const state = await getInstanceState(instanceId);
    if (state.instance.status === "APPROVED" || state.instance.status === "REJECTED" || state.instance.status === "CANCELLED") {
      return state;
    }
    const currentStep = state.steps.find((s) => s.status === "PENDING");
    if (!currentStep) {
      throw new Error(
        `approveFully: instance ${instanceId} has status=${state.instance.status} but no PENDING step found`
      );
    }
    const approverIds = currentStep.approvers
      .filter((a) => a.status === "PENDING")
      .map((a) => a.approver_user_id);
    if (approverIds.length === 0) {
      throw new Error(
        `approveFully: instance ${instanceId} step ${currentStep.id} has no PENDING approvers`
      );
    }
    const userId = pick(approverIds, currentStep);
    await approveStep(instanceId, userId);
  }
  throw new Error(
    `approveFully: instance ${instanceId} did not terminate within ${maxIterations} iterations`
  );
}

/**
 * Snapshot of an instance + its steps + each step's approvers. Tests assert
 * on this shape — it mirrors the production schema 1:1.
 *
 * Returns `null` if the instance does not exist.
 */
export async function getInstanceState(instanceId) {
  const instance = await db.oneOrNone(
    `SELECT * FROM tbl_approval_instances WHERE id = $1`,
    [instanceId]
  );
  if (!instance) return null;
  const steps = await db.any(
    `SELECT * FROM tbl_approval_instance_steps
     WHERE approval_instance_id = $1
     ORDER BY step_order ASC`,
    [instanceId]
  );
  const stepIds = steps.map((s) => s.id);
  const approvers = stepIds.length
    ? await db.any(
        `SELECT * FROM tbl_approval_step_approvers
         WHERE approval_instance_step_id = ANY($1::int[])`,
        [stepIds]
      )
    : [];
  const stepsWithApprovers = steps.map((s) => ({
    ...s,
    approvers: approvers.filter((a) => a.approval_instance_step_id === s.id),
  }));
  return { instance, steps: stepsWithApprovers };
}

/**
 * Convenience: fetch the latest action row for an instance — useful to
 * assert "the engine logged this APPROVE / REJECT".
 */
export async function getLatestAction(instanceId) {
  return db.oneOrNone(
    `SELECT * FROM tbl_approval_actions
     WHERE approval_instance_id = $1
     ORDER BY id DESC LIMIT 1`,
    [instanceId]
  );
}
