-- ═══════════════════════════════════════════════════════════════════════════
-- Snapshot of every IN-FLIGHT approval of the buyer, one row per approver
-- slot (steps with no approver rows still appear, with NULL approver columns).
--
--   \set pending_snapshot _pending_before
--   \ir lib/pending_state.sql
--
-- Every step takes one before its change and one after, and
-- lib/assert_pending_unchanged.sql refuses to commit unless the two are
-- identical. None of these changes is allowed to move a live approval: not a
-- status, not a current step, not an approver, and not a policy_step_id — the
-- link must still name the same policy-step ROW (ids are preserved by every
-- change in this suite).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE :pending_snapshot AS
SELECT i.id                      AS instance_id,
       i.entity_type,
       i.entity_id,
       i.approval_policy_id,
       i.status                  AS instance_status,
       i.current_step,
       i.policy_version,
       i.hospitality_company_id,
       i.hotel_id,
       i.department_id,
       i.process_id,
       i.completed_at            AS instance_completed_at,
       s.id                      AS step_id,
       s.step_order,
       s.status                  AS step_status,
       s.decision_rule,
       s.policy_step_id,
       s.added_mid_flight        AS step_added_mid_flight,
       s.removed_mid_flight      AS step_removed_mid_flight,
       s.completed_at            AS step_completed_at,
       a.id                      AS approver_row_id,
       a.approver_user_id,
       a.status                  AS approver_status,
       a.acted_at,
       a.removed_at,
       a.removal_reason,
       a.added_mid_flight        AS approver_added_mid_flight
  FROM tbl_approval_instances i
  JOIN tbl_hospitality_companies hc ON hc.id = i.hospitality_company_id
  LEFT JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
  LEFT JOIN tbl_approval_step_approvers a ON a.approval_instance_step_id = s.id
 WHERE i.status = 'PENDING'
   AND hc.buyer_company_id = (SELECT buyer_company_id FROM _params);
