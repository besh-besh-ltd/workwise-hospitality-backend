-- "Tender Creator" becomes "RFQ Creator" (UM-10).
--
-- The role governs RFQ creation. Tenders are a variant of an RFQ
-- (tbl_rfq.is_tender), not a separate thing with its own creator, so the name
-- described the narrower case and read as an unrelated permission to anyone
-- looking for who may raise an RFQ.
--
-- Safe to rename: nothing in the application joins roles on title. Every
-- lookup is by role_id through tbl_user_role_scopes and tbl_role_permissions.
-- The only title comparisons are the idempotency guards inside the permission
-- seed migrations, and they concern roles 22-30, not this one.
--
-- Guarded on the current title so re-running is a no-op and so this cannot
-- silently rename a role somebody has since repurposed.

BEGIN;

UPDATE public.tbl_roles
   SET title = 'RFQ Creator'
 WHERE id = 2
   AND title = 'Tender Creator';

COMMIT;
