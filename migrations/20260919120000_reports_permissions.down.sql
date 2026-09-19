-- Revert the reports permission catalogue.
--
-- The enum values stay. Postgres cannot drop an enum label, and recreating
-- resource_type / permission_action_type would mean rewriting every column
-- that uses them across ~20 tables. Unused labels are inert, so the rows are
-- what actually need removing: with the tbl_permissions rows gone nothing
-- resolves a `reports.*` grant and the catalogue endpoint returns empty.

BEGIN;

DELETE FROM public.tbl_role_permissions rp
 USING public.tbl_permissions p
 WHERE rp.permission_id = p.id
   AND p.resource = 'reports'::public.resource_type;

DELETE FROM public.tbl_permissions
 WHERE resource = 'reports'::public.resource_type;

COMMIT;
