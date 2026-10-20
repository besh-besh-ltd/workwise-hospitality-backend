-- ═══════════════════════════════════════════════════════════════════════════
-- RECONCILE REPORT · policies vs in-flight approvals, for one buyer
--
-- READ-ONLY (SELECTs only; no temp objects, so it also runs inside a
-- default_transaction_read_only session). Buyer-scoped and quick, so run.sh
-- runs it before and after every step INSIDE the step's own transaction (the
-- after-report of a DRY run shows exactly what the step would change) and
-- prints the diff. The platform-wide scripts/audit_approval_rbac_coherence.sql
-- is heavy and runs only in separate read-only sessions (never while the
-- step holds row locks).
--
--   ./run.sh reconcile                                  # whole buyer
--   ./run.sh reconcile -v target_policies='{1001,1003}' # only these policies
--
-- psql variables (defaults from data.sql): buyer_company_id, resource_map,
-- target_policies ('' = every policy of the buyer).
--
-- Diff-friendly: unaligned output, every query fully ORDERed, no clocks.
--   R0  policy shape (steps with ids, role titles, rules; version)
--   R1  PENDING instances per policy
--   R2  in-flight state: every step + approver of every PENDING instance
--       — must be IDENTICAL before/after every step in this suite
--   R3  link anomalies: policy_step_id NULL / another policy's step / missing
--   R4  order offsets: instance step_order ≠ linked policy step's step_order
--       (informational: the engine renumbers instance steps from 1 after
--        dropping a dead level, so these are expected where dead levels exist)
--   R5  PENDING instances whose current step has 0 PENDING approvers
--   R6  PENDING approvers without read+approve on the stage resource at their scope
--   R7  instance step count vs effective policy step count (mismatches only)
--   R8  summary counts
-- ═══════════════════════════════════════════════════════════════════════════
\if :{?resource_map} \else
  \echo 'reconcile_report.sql: load data.sql first (run it through run.sh)'
  SELECT 1/0 AS data_sql_not_loaded;
\endif

\pset format unaligned
\pset fieldsep ' | '
\pset footer on
\pset null '∅'

\qecho '════ RECONCILE REPORT · buyer' :buyer_company_id '· policies' :'target_policies'

-- ─────────────────────────────────────────────────────────────────────────────
\qecho ''
\qecho '── R0 policy shape'
WITH bp AS (
  SELECT p.* FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = :buyer_company_id
     AND (NULLIF(:'target_policies', '') IS NULL OR p.id = ANY (NULLIF(:'target_policies', '')::int[]))
)
SELECT bp.id AS policy, bp.entity_type, bp.hospitality_company_id AS co, bp.hotel_id, bp.process_id,
       bp.is_active AS active, bp.version,
       COALESCE((SELECT string_agg(format('%s:%s %s%s %s #%s', s.step_order, s.approver_source_type, s.approver_source_id,
                                          COALESCE(' (' || r.title || ')', ''), s.decision_rule, s.id),
                                   ' > ' ORDER BY s.step_order, s.id)
                   FROM tbl_approval_policy_steps s
                   LEFT JOIN tbl_roles r ON s.approver_source_type = 'ROLE' AND r.id = s.approver_source_id
                  WHERE s.approval_policy_id = bp.id), '(no steps)') AS steps
  FROM bp
 ORDER BY bp.id;

-- ─────────────────────────────────────────────────────────────────────────────
\qecho ''
\qecho '── R1 PENDING instances per policy'
WITH bp AS (
  SELECT p.* FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = :buyer_company_id
     AND (NULLIF(:'target_policies', '') IS NULL OR p.id = ANY (NULLIF(:'target_policies', '')::int[]))
)
SELECT bp.id AS policy, bp.entity_type, bp.is_active AS active, count(i.id) AS pending
  FROM bp JOIN tbl_approval_instances i ON i.approval_policy_id = bp.id AND i.status = 'PENDING'
 GROUP BY bp.id, bp.entity_type, bp.is_active
 ORDER BY bp.id;

-- ─────────────────────────────────────────────────────────────────────────────
\qecho ''
\qecho '── R2 in-flight state (one row per instance step; approvers as user:status)'
WITH bp AS (
  SELECT p.* FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = :buyer_company_id
     AND (NULLIF(:'target_policies', '') IS NULL OR p.id = ANY (NULLIF(:'target_policies', '')::int[]))
)
SELECT i.id AS instance, i.entity_type, i.entity_id, i.approval_policy_id AS policy, i.current_step,
       s.id AS step, s.step_order, s.status AS step_status, s.decision_rule AS rule,
       s.policy_step_id AS link, s.added_mid_flight AS added, s.removed_mid_flight AS removed,
       (SELECT string_agg(a.approver_user_id || ':' || a.status || CASE WHEN a.removed_at IS NOT NULL THEN ':removed' ELSE '' END,
                          ',' ORDER BY a.approver_user_id, a.id)
          FROM tbl_approval_step_approvers a WHERE a.approval_instance_step_id = s.id) AS approvers
  FROM bp
  JOIN tbl_approval_instances i ON i.approval_policy_id = bp.id AND i.status = 'PENDING'
  LEFT JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
 ORDER BY i.id, s.step_order, s.id;

-- ─────────────────────────────────────────────────────────────────────────────
\qecho ''
\qecho '── R3 link anomalies on PENDING instances'
WITH bp AS (
  SELECT p.* FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = :buyer_company_id
     AND (NULLIF(:'target_policies', '') IS NULL OR p.id = ANY (NULLIF(:'target_policies', '')::int[]))
)
SELECT i.id AS instance, i.approval_policy_id AS policy, s.id AS step, s.step_order, s.status,
       s.policy_step_id AS link,
       CASE WHEN s.policy_step_id IS NULL THEN 'NULL link'
            WHEN ps.id IS NULL THEN 'link to a missing step'
            ELSE 'link to policy ' || ps.approval_policy_id END AS anomaly
  FROM bp
  JOIN tbl_approval_instances i ON i.approval_policy_id = bp.id AND i.status = 'PENDING'
  JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
  LEFT JOIN tbl_approval_policy_steps ps ON ps.id = s.policy_step_id
 WHERE s.policy_step_id IS NULL OR ps.id IS NULL OR ps.approval_policy_id <> i.approval_policy_id
 ORDER BY i.id, s.step_order, s.id;

-- ─────────────────────────────────────────────────────────────────────────────
\qecho ''
\qecho '── R4 order offsets on PENDING instances (instance step_order ≠ linked policy step_order)'
WITH bp AS (
  SELECT p.* FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = :buyer_company_id
     AND (NULLIF(:'target_policies', '') IS NULL OR p.id = ANY (NULLIF(:'target_policies', '')::int[]))
)
SELECT i.id AS instance, i.approval_policy_id AS policy, s.id AS step, s.step_order AS instance_order,
       ps.id AS link, ps.step_order AS policy_order
  FROM bp
  JOIN tbl_approval_instances i ON i.approval_policy_id = bp.id AND i.status = 'PENDING'
  JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
  JOIN tbl_approval_policy_steps ps ON ps.id = s.policy_step_id AND ps.approval_policy_id = i.approval_policy_id
 WHERE ps.step_order <> s.step_order
 ORDER BY i.id, s.step_order, s.id;

-- ─────────────────────────────────────────────────────────────────────────────
\qecho ''
\qecho '── R5 PENDING instances whose current step has no PENDING approver'
WITH bp AS (
  SELECT p.* FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = :buyer_company_id
     AND (NULLIF(:'target_policies', '') IS NULL OR p.id = ANY (NULLIF(:'target_policies', '')::int[]))
)
SELECT i.id AS instance, i.approval_policy_id AS policy, i.current_step,
       COALESCE(s.status, '(no step at current_step)') AS step_status,
       (SELECT count(*) FROM tbl_approval_step_approvers a
         WHERE a.approval_instance_step_id = s.id AND a.status = 'PENDING' AND a.removed_at IS NULL) AS pending_approvers
  FROM bp
  JOIN tbl_approval_instances i ON i.approval_policy_id = bp.id AND i.status = 'PENDING'
  LEFT JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id AND s.step_order = i.current_step
 WHERE s.id IS NULL
    OR NOT EXISTS (SELECT 1 FROM tbl_approval_step_approvers a
                    WHERE a.approval_instance_step_id = s.id AND a.status = 'PENDING' AND a.removed_at IS NULL)
 ORDER BY i.id;

-- ─────────────────────────────────────────────────────────────────────────────
\qecho ''
\qecho '── R6 PENDING approvers without read+approve on the stage resource at their scope'
WITH bp AS (
  SELECT p.* FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = :buyer_company_id
     AND (NULLIF(:'target_policies', '') IS NULL OR p.id = ANY (NULLIF(:'target_policies', '')::int[]))
),
map AS (SELECT * FROM (VALUES :resource_map) AS v(entity_type, resource))
SELECT i.id AS instance, i.entity_type, i.approval_policy_id AS policy, s.step_order,
       a.approver_user_id AS user_id, COALESCE(m.resource, '(unmapped)') AS needs,
       i.hospitality_company_id AS co, i.hotel_id, i.department_id AS dept, i.process_id AS proc
  FROM bp
  JOIN tbl_approval_instances i ON i.approval_policy_id = bp.id AND i.status = 'PENDING'
  JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id AND s.status = 'PENDING'
  JOIN tbl_approval_step_approvers a ON a.approval_instance_step_id = s.id AND a.status = 'PENDING' AND a.removed_at IS NULL
  LEFT JOIN map m ON m.entity_type = bp.entity_type
 WHERE NOT EXISTS (
   -- mirrors policyStepApproverEligibility (USER branch), generalModel.js
   SELECT 1
     FROM tbl_user_role_scopes urs
     JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
     JOIN tbl_permissions pm ON pm.id = rp.permission_id
    WHERE urs.user_id = a.approver_user_id
      AND pm.resource::text = m.resource
      AND pm.action IN ('read', 'approve')
      AND urs.company_id = i.hospitality_company_id
      AND (urs.hotel_id IS NULL OR urs.hotel_id = i.hotel_id)
      AND (i.department_id IS NULL OR urs.department_id IS NULL OR urs.department_id = i.department_id)
      AND (urs.process_id IS NULL OR urs.process_id = i.process_id)
    GROUP BY urs.user_id
   HAVING count(DISTINCT pm.action) = 2)
 ORDER BY i.id, s.step_order, a.approver_user_id;

-- ─────────────────────────────────────────────────────────────────────────────
\qecho ''
\qecho '── R7 PENDING instances whose step count ≠ the policy''s effective step count'
\qecho '      (effective = ROLE steps holding read+approve on the resource, plus USER/DEPARTMENT steps;'
\qecho '       a level can also be dropped for having nobody to resolve, so rows here are leads, not faults)'
WITH bp AS (
  SELECT p.* FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = :buyer_company_id
     AND (NULLIF(:'target_policies', '') IS NULL OR p.id = ANY (NULLIF(:'target_policies', '')::int[]))
),
map AS (SELECT * FROM (VALUES :resource_map) AS v(entity_type, resource)),
eff AS (
  SELECT bp.id AS policy_id,
         count(s.id) AS policy_steps,
         count(s.id) FILTER (WHERE s.approver_source_type <> 'ROLE' OR (
           SELECT count(DISTINCT pm.action) FROM tbl_role_permissions rp JOIN tbl_permissions pm ON pm.id = rp.permission_id
            WHERE rp.role_id = s.approver_source_id AND pm.resource::text = m.resource
              AND pm.action IN ('read', 'approve')) = 2) AS effective_steps
    FROM bp
    LEFT JOIN map m ON m.entity_type = bp.entity_type
    LEFT JOIN tbl_approval_policy_steps s ON s.approval_policy_id = bp.id
   GROUP BY bp.id
)
SELECT i.id AS instance, i.approval_policy_id AS policy,
       (SELECT count(*) FROM tbl_approval_instance_steps s
         WHERE s.approval_instance_id = i.id AND s.status <> 'REMOVED') AS instance_steps,
       e.policy_steps, e.effective_steps
  FROM bp
  JOIN tbl_approval_instances i ON i.approval_policy_id = bp.id AND i.status = 'PENDING'
  JOIN eff e ON e.policy_id = bp.id
 WHERE (SELECT count(*) FROM tbl_approval_instance_steps s
         WHERE s.approval_instance_id = i.id AND s.status <> 'REMOVED') <> e.effective_steps
 ORDER BY i.id;

-- ─────────────────────────────────────────────────────────────────────────────
\qecho ''
\qecho '── R8 summary'
WITH bp AS (
  SELECT p.* FROM tbl_approval_policies p
    JOIN tbl_hospitality_companies hc ON hc.id = p.hospitality_company_id
   WHERE hc.buyer_company_id = :buyer_company_id
     AND (NULLIF(:'target_policies', '') IS NULL OR p.id = ANY (NULLIF(:'target_policies', '')::int[]))
),
pi AS (SELECT i.* FROM bp JOIN tbl_approval_instances i ON i.approval_policy_id = bp.id AND i.status = 'PENDING'),
ps AS (SELECT s.*, i.approval_policy_id AS inst_policy FROM pi i JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id)
SELECT metric, value FROM (
            SELECT 1 AS o, 'policies (active)'      AS metric, count(*) FILTER (WHERE is_active)     AS value FROM bp
  UNION ALL SELECT 2, 'policies (inactive)',          count(*) FILTER (WHERE NOT is_active)       FROM bp
  UNION ALL SELECT 3, 'policy steps',                 count(*) FROM tbl_approval_policy_steps s WHERE s.approval_policy_id IN (SELECT id FROM bp)
  UNION ALL SELECT 4, 'PENDING instances',            count(*) FROM pi
  UNION ALL SELECT 5, 'PENDING instance steps',       count(*) FROM ps
  UNION ALL SELECT 6, '  … with a NULL link',         count(*) FROM ps WHERE policy_step_id IS NULL
  UNION ALL SELECT 7, '  … linked to another policy / a missing step',
                      count(*) FROM ps LEFT JOIN tbl_approval_policy_steps x ON x.id = ps.policy_step_id
                       WHERE ps.policy_step_id IS NOT NULL AND (x.id IS NULL OR x.approval_policy_id <> ps.inst_policy)
  UNION ALL SELECT 8, '  … order offset vs linked step',
                      count(*) FROM ps JOIN tbl_approval_policy_steps x ON x.id = ps.policy_step_id
                       WHERE x.approval_policy_id = ps.inst_policy AND x.step_order <> ps.step_order
) t ORDER BY o;

-- Output stays unaligned on purpose: aligned columns would re-flow whole
-- tables in a diff whenever one value's width changes.
\qecho ''
