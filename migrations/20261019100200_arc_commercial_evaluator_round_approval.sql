-- ARC mirrors RFQ: Commercial Evaluators approve their colleagues' negotiation
-- rounds.
--
-- In RFQ, role 8 (Commercial Evaluator) holds negotiation.approve, so evaluators
-- approve each other's rounds (the creator's own slot is auto-approved). ARC kept
-- a hard separation: 'ARC Commercial Evaluator' held arc-comm.read + .evaluate but
-- not arc-comm.approve, so only 'ARC Commercial Approver' could approve a round.
-- The product decision is parity with RFQ, so grant arc-comm.approve here.
-- arc-tech is unchanged: 'ARC Technical Evaluator' still has no arc-tech.approve.
--
-- Keyed on title + created_by IS NULL, never on role id: ids differ per
-- environment (prod 29 / stage 25 / test 24). The permission row is created when
-- missing (stage has none), with NOT EXISTS because tbl_permissions has no unique
-- key. Fully idempotent.

INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT 'arc-comm'::public.resource_type, 'approve'::public.permission_action_type, 0
WHERE NOT EXISTS (
  SELECT 1 FROM public.tbl_permissions p
  WHERE p.resource::text = 'arc-comm' AND p.action::text = 'approve'
);

INSERT INTO public.tbl_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.tbl_roles r
JOIN LATERAL (
  SELECT id FROM public.tbl_permissions
  WHERE resource::text = 'arc-comm' AND action::text = 'approve'
  ORDER BY id LIMIT 1
) p ON TRUE
WHERE r.created_by IS NULL
  AND r.title = 'ARC Commercial Evaluator'
  AND NOT EXISTS (
    SELECT 1 FROM public.tbl_role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
