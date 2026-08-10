-- ===========================================================================
--  AUDIT — does the approval engine agree with RBAC visibility?
-- ===========================================================================
--
--  READ-ONLY. Safe against production. Run it after any RBAC or approval
--  change, and periodically.
--
--  WHAT IT IS FOR
--  Approver resolution and entity visibility are two independent answers to
--  "may this user act on this entity". When they disagree the symptom is
--  invisible from every admin screen: the workflow simply stops, and the
--  person it is waiting on sees nothing at all. Production incident
--  2026-08-10 (RFQ 791) took a live debugging session to explain because
--  every screen an admin could open said the configuration was fine.
--
--  Each section answers one question. A healthy platform returns ZERO rows
--  from sections A, B and C. Section D is historical and may be non-zero.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  SECTION A — blind approvers.
--  Someone is blocking a workflow on an entity they cannot see.
--
--  This reproduces the read predicate the RFQ list applies. An approver whose
--  permission-bearing scope row does not cover the entity's
--  (hotel x department x process) tuple appears here.
--
--  Expected after the approver-read exemption ships: still lists them (the
--  underlying RBAC gap is real and worth fixing per user), but they are no
--  longer BLOCKED by it — the exemption lets them see and act. Treat rows here
--  as "this person's role grants are probably wrong", not as an outage.
-- ---------------------------------------------------------------------------

WITH res AS (
  SELECT * FROM (VALUES
    ('RFQ','rfq'), ('TENDER','boq'), ('TECHNICAL','te'),
    ('NEGOTIATION','negotiation'), ('NEGOTIATION_QUOTE','quote-compare'),
    ('PO','awarding'), ('MR','awarding'),
    ('ARC','arc'), ('ARC_PUBLISH','arc'), ('ARC_TECH','arc-tech'),
    ('ARC_NEGOTIATION','arc-comm'), ('ARC_COMMITTEE','arc-committee'),
    ('ARC_AMENDMENT','arc')
  ) AS v(entity_type, resource)
),
pending_slots AS (
  SELECT i.id AS instance_id, i.entity_type, i.entity_id,
         i.hospitality_company_id AS co, i.hotel_id, i.department_id AS dept, i.process_id AS proc,
         s.step_order, a.approver_user_id AS uid
    FROM tbl_approval_instances i
    JOIN tbl_approval_instance_steps s ON s.approval_instance_id = i.id
    JOIN tbl_approval_step_approvers a ON a.approval_instance_step_id = s.id
   WHERE i.status = 'PENDING' AND s.status = 'PENDING'
     AND a.status = 'PENDING' AND a.removed_at IS NULL
)
SELECT 'A. BLIND APPROVER' AS finding,
       p.entity_type, p.entity_id, p.step_order,
       u.employee_code, u.name AS approver,
       p.co, p.hotel_id, p.dept, p.proc,
       (p.step_order = (SELECT current_step FROM tbl_approval_instances WHERE id = p.instance_id))
         AS is_blocking_now
  FROM pending_slots p
  JOIN tbl_users u ON u.id = p.uid
  JOIN res r ON r.entity_type = p.entity_type
 WHERE NOT EXISTS (
   SELECT 1 FROM tbl_user_role_scopes urs
     JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
     JOIN tbl_permissions pm ON pm.id = rp.permission_id
    WHERE urs.user_id = p.uid
      AND pm.resource::text = r.resource AND pm.action = 'read'
      AND urs.company_id = p.co
      AND (urs.hotel_id IS NULL OR urs.hotel_id = p.hotel_id)
      AND (p.dept IS NULL OR urs.department_id = p.dept OR urs.department_id IS NULL)
      AND (urs.process_id IS NULL OR urs.process_id = p.proc)
 )
 ORDER BY is_blocking_now DESC, p.entity_type, p.entity_id;


-- ---------------------------------------------------------------------------
--  SECTION B — unsatisfiable approval resources.
--  A resource the approval gate names that cannot possibly pass it, because
--  the permission catalogue has no `read` and/or no `approve` row for it.
--
--  This is what made every TENDER approval a no-op: 'tender' carried only
--  `approve`, so roleHasReadAndApprovePermission (which needs BOTH) could
--  never return true, so every ROLE step of every tender policy was dropped.
--  MUST return zero rows.
-- ---------------------------------------------------------------------------

SELECT 'B. UNSATISFIABLE RESOURCE' AS finding,
       v.entity_type, v.resource,
       EXISTS(SELECT 1 FROM tbl_permissions p WHERE p.resource::text=v.resource AND p.action='read')    AS has_read,
       EXISTS(SELECT 1 FROM tbl_permissions p WHERE p.resource::text=v.resource AND p.action='approve') AS has_approve
  FROM (VALUES
    ('RFQ','rfq'), ('TENDER','boq'), ('TECHNICAL','te'),
    ('NEGOTIATION','negotiation'), ('NEGOTIATION_QUOTE','quote-compare'),
    ('PO','awarding'), ('MR','awarding'),
    ('ARC','arc'), ('ARC_PUBLISH','arc'), ('ARC_TECH','arc-tech'),
    ('ARC_NEGOTIATION','arc-comm'), ('ARC_COMMITTEE','arc-committee'),
    ('ARC_AMENDMENT','arc')
  ) AS v(entity_type, resource)
 WHERE NOT (
   EXISTS(SELECT 1 FROM tbl_permissions p WHERE p.resource::text=v.resource AND p.action='read')
   AND EXISTS(SELECT 1 FROM tbl_permissions p WHERE p.resource::text=v.resource AND p.action='approve')
 );


-- ---------------------------------------------------------------------------
--  SECTION C — active policies that would resolve to nobody.
--  Every ROLE step names a role that cannot pass the read+approve gate, so at
--  creation time every step is dropped.
--
--  Before the fail-closed change this produced an instance born APPROVED with
--  nobody having approved it. It now REFUSES, which means each row here is an
--  entity type that CANNOT BE SUBMITTED in that scope until the policy is
--  fixed. Both outcomes are bad; this is the one you want to find first.
--
--  NOTE: USER- and DEPARTMENT-source steps are treated as surviving, because
--  the engine does not gate them on permissions at all. That is itself a gap
--  (see the report), but modelling it here would produce false positives.
-- ---------------------------------------------------------------------------

WITH map AS (
  SELECT * FROM (VALUES
    ('RFQ','rfq'), ('TENDER','boq'), ('TECHNICAL','te'),
    ('NEGOTIATION','negotiation'), ('NEGOTIATION_QUOTE','quote-compare'),
    ('PO','awarding'), ('MR','awarding'),
    ('ARC','arc'), ('ARC_PUBLISH','arc'), ('ARC_TECH','arc-tech'),
    ('ARC_NEGOTIATION','arc-comm'), ('ARC_COMMITTEE','arc-committee'),
    ('ARC_AMENDMENT','arc')
  ) AS v(entity_type, resource)
),
step_survives AS (
  SELECT p.id AS policy_id, p.entity_type, p.hospitality_company_id AS co,
         p.hotel_id, p.process_id, s.step_order,
         CASE
           WHEN s.approver_source_type <> 'ROLE' THEN true
           WHEN m.resource IS NULL THEN false
           ELSE (SELECT count(DISTINCT pm.action)
                   FROM tbl_role_permissions rp
                   JOIN tbl_permissions pm ON pm.id = rp.permission_id
                  WHERE rp.role_id = s.approver_source_id
                    AND pm.resource::text = m.resource
                    AND pm.action IN ('read','approve')) = 2
         END AS survives
    FROM tbl_approval_policies p
    JOIN tbl_approval_policy_steps s ON s.approval_policy_id = p.id
    LEFT JOIN map m ON m.entity_type = p.entity_type
   WHERE p.is_active
)
SELECT 'C. POLICY RESOLVES TO NOBODY' AS finding,
       policy_id, entity_type, co, hotel_id, process_id,
       count(*) AS steps
  FROM step_survives
 GROUP BY 1,2,3,4,5,6
HAVING bool_or(survives) IS NOT TRUE
 ORDER BY entity_type, policy_id;


-- ---------------------------------------------------------------------------
--  SECTION D — historical: instances that were born APPROVED with no steps.
--  Nobody approved these. Informational — the fail-closed change prevents new
--  ones, it cannot retro-explain old ones. Rows predating the diagnostics
--  carry no metadata and their cause is unknowable from the row alone.
-- ---------------------------------------------------------------------------

SELECT 'D. BORN APPROVED, NO STEPS' AS finding,
       i.entity_type,
       COALESCE(i.metadata->'auto_approval'->>'case', '(no diagnostics — pre-dates them)') AS case,
       count(*) AS instances,
       min(i.created_at)::date AS first_seen,
       max(i.created_at)::date AS last_seen
  FROM tbl_approval_instances i
 WHERE i.status = 'APPROVED' AND i.current_step = 0
   AND NOT EXISTS (SELECT 1 FROM tbl_approval_instance_steps s WHERE s.approval_instance_id = i.id)
 GROUP BY 1,2,3
 ORDER BY instances DESC;


-- ---------------------------------------------------------------------------
--  SECTION E — USER-source approvers who hold no permission on what they approve.
--
--  ROLE-source steps are gated at instance creation: a role without
--  read+approve on the entity's resource has its step dropped. USER-source
--  steps are gated NOWHERE — not at policy save, not at resolution, not
--  mid-flight, and not at act time. Naming a user directly therefore grants
--  binding approval authority to someone who may hold no permission on the
--  entity at all, and until now nothing anywhere said so.
--
--  This is the condition createApprovalInstance now records on the instance as
--  `approval_diagnostics.unqualified_user_approvers`. It is deliberately NOT
--  enforced yet: enforcing it today would leave several active policies
--  resolving to nobody, which blocks entity creation in those scopes. Clean
--  the rows this returns, re-run until it is empty, and enforcement becomes a
--  one-line change with no blast radius.
--
--  Rows here are NOT currently breaking anything. They are the list of
--  approver assignments that would stop working the day the gate is turned on.
-- ---------------------------------------------------------------------------

WITH map AS (
  SELECT * FROM (VALUES
    ('RFQ','rfq'), ('TENDER','boq'), ('TECHNICAL','te'),
    ('NEGOTIATION','negotiation'), ('NEGOTIATION_QUOTE','quote-compare'),
    ('PO','awarding'), ('MR','awarding'),
    ('ARC','arc'), ('ARC_PUBLISH','arc'), ('ARC_TECH','arc-tech'),
    ('ARC_NEGOTIATION','arc-comm'), ('ARC_COMMITTEE','arc-committee'),
    ('ARC_AMENDMENT','arc')
  ) AS v(entity_type, resource)
)
SELECT 'E. USER APPROVER WITHOUT PERMISSION' AS finding,
       p.id AS policy_id, p.entity_type, s.step_order,
       p.hospitality_company_id AS co, p.hotel_id, p.process_id,
       u.id AS user_id, u.employee_code, u.name,
       m.resource AS needs
  FROM tbl_approval_policies p
  JOIN tbl_approval_policy_steps s ON s.approval_policy_id = p.id
  JOIN map m ON m.entity_type = p.entity_type
  JOIN tbl_users u ON u.id = s.approver_source_id
 WHERE p.is_active
   AND s.approver_source_type = 'USER'
   AND NOT EXISTS (
     SELECT 1 FROM tbl_user_role_scopes urs
       JOIN tbl_role_permissions rp ON rp.role_id = urs.role_id
       JOIN tbl_permissions pm ON pm.id = rp.permission_id
      WHERE urs.user_id = u.id
        AND pm.resource::text = m.resource
        AND pm.action IN ('read','approve')
        AND urs.company_id = p.hospitality_company_id
        AND (urs.hotel_id IS NULL OR urs.hotel_id = p.hotel_id)
        AND (urs.process_id IS NULL OR urs.process_id = p.process_id)
      GROUP BY urs.user_id
     HAVING count(DISTINCT pm.action) = 2
   )
 ORDER BY p.entity_type, p.id, s.step_order;
