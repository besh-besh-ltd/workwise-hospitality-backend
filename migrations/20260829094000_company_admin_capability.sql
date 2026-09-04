-- Make "company administrator" a capability rather than a user type.
--
-- Today the admin module is gated by `acl([7])`, which compares the single
-- scalar `tbl_users.user_type`. That makes admin and buyer mutually exclusive,
-- with two consequences that block handing the module to clients:
--
--   1. Promoting a buyer to admin would silently revoke their transactional
--      access. There are 33 numeric `user_type` branches across the RFQ and PO
--      read paths, one of them carrying the comment "[Modified to include
--      user_type 2, 3, 8, 9, 10]" and simply not listing 7.
--   2. Admins have no tenant scope. Visibility is decided far below the route
--      by `resolveHospitalityCompanyScope` (hospitality mappings) and
--      `buildScopeExistsClause` (role scopes, 17 call sites) — and all three
--      production admin accounts hold zero of each, so every scoped query
--      returns nothing.
--
-- Modelling the capability as a permission means an administrator is an
-- ordinary buyer who happens to hold `company.admin`: scoped like any buyer,
-- visible in every listing, and promotable without moving `user_type` at all.
--
-- Additive and reversible. Nothing is gated on this yet — the middleware that
-- reads it accepts the existing user_type 7 as well, so no account changes
-- behaviour when this lands.

-- Two transactions, deliberately. Postgres refuses to use a new enum value in
-- the transaction that added it ("New enum values must be committed before
-- they can be used"), so the seed below cannot share a block with the ALTER.
BEGIN;
ALTER TYPE public.resource_type ADD VALUE IF NOT EXISTS 'company';
COMMIT;

BEGIN;

-- The action already exists on permission_action_type; only the resource is new.
INSERT INTO public.tbl_permissions (resource, action, ordering)
SELECT 'company'::public.resource_type, 'admin'::public.permission_action_type,
       COALESCE((SELECT MAX(ordering) FROM public.tbl_permissions), 0) + 1
WHERE NOT EXISTS (
  SELECT 1 FROM public.tbl_permissions
   WHERE resource = 'company'::public.resource_type
     AND action = 'admin'::public.permission_action_type
);

-- A system role, so `created_by IS NULL` keeps it out of the custom-role
-- editor and out of reach of the "system roles cannot be modified" path.
INSERT INTO public.tbl_roles (title, description, created_by)
SELECT 'Company Administrator',
       'Administers the company: business units, people, access, approval workflows and the activity trail.',
       NULL
WHERE NOT EXISTS (SELECT 1 FROM public.tbl_roles WHERE title = 'Company Administrator');

INSERT INTO public.tbl_role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.tbl_roles r
  CROSS JOIN public.tbl_permissions p
 WHERE r.title = 'Company Administrator'
   AND p.resource = 'company'::public.resource_type
   AND p.action = 'admin'::public.permission_action_type
   AND NOT EXISTS (
     SELECT 1 FROM public.tbl_role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id
   );

COMMIT;
