-- Down: 20260626100200_arc_type_self_contained.down.sql
-- Intentional NO-OP. tbl_arc.type may also be created by the base-branch migration
-- 20260625100000_arc_type_column.sql and is read by the create-wizard resume path, so dropping it here
-- could destroy a column this feature does not exclusively own. Rolling back this feature must NOT
-- remove tbl_arc.type. If you truly need to drop it, roll back 20260625100000_arc_type_column instead.
BEGIN;

-- (no-op: see comment above; do NOT drop tbl_arc.type)

COMMIT;
