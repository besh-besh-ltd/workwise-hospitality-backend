-- Purchase Requisitions: the `pr` RBAC resource, a new `convert` action, and four system roles.
-- Two transactions: Postgres refuses to use an enum value in the transaction that added it.
BEGIN;
ALTER TYPE public.resource_type ADD VALUE IF NOT EXISTS 'pr';
ALTER TYPE public.permission_action_type ADD VALUE IF NOT EXISTS 'convert';
COMMIT;

BEGIN;
INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT 'pr'::public.resource_type, v.action::public.permission_action_type, v.ordering
  FROM (VALUES ('read',200),('create',201),('evaluate',202),('approve',203),('convert',204)) AS v(action, ordering)
 WHERE NOT EXISTS (SELECT 1 FROM public.tbl_permissions p
                    WHERE p.resource = 'pr'::public.resource_type
                      AND p.action = v.action::public.permission_action_type);

INSERT INTO public.tbl_roles (title, description, created_by)
SELECT v.title, v.descr, NULL
  FROM (VALUES
    ('PR Requester',          'Raise purchase requisitions for a hotel/department'),
    ('PR Technical Reviewer', 'Technical review of purchase requisition lines for a department'),
    ('PR Approver',           'Approve purchase requisitions'),
    ('PR Buyer',              'Purchase team: purchase requisition queue, mapping and conversion to RFQ')
  ) AS v(title, descr)
 WHERE NOT EXISTS (SELECT 1 FROM public.tbl_roles r WHERE r.title = v.title AND r.created_by IS NULL);

INSERT INTO public.tbl_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM (VALUES
    ('PR Requester','read'),('PR Requester','create'),
    ('PR Technical Reviewer','read'),('PR Technical Reviewer','evaluate'),
    ('PR Approver','read'),('PR Approver','approve'),
    ('PR Buyer','read'),('PR Buyer','convert'),
    -- Company Administrator: oversight only (R40). In production it is a
    -- non-operational admin role (company.admin, dashboard.*, reports.*), and
    -- every PR audience is resolved from pr.* permissions — with
    -- create/evaluate/approve/convert it would become an eligible reviewer of
    -- every department, an assignable buyer and the recipient of every review
    -- task and approved-PR mail. An admin who also works PRs gets the PR role.
    ('Company Administrator','read')
  ) AS g(title, action)
  JOIN public.tbl_roles r ON r.title = g.title AND r.created_by IS NULL
  JOIN public.tbl_permissions p ON p.resource = 'pr'::public.resource_type
                               AND p.action = g.action::public.permission_action_type
 WHERE NOT EXISTS (SELECT 1 FROM public.tbl_role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);
COMMIT;
