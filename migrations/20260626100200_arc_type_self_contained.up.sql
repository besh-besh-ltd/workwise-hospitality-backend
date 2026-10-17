-- Up: 20260626100200_arc_type_self_contained.sql
-- Self-contained add of tbl_arc.type for the Manual ARC Entry feature.
-- The feature's createBackdatedDraft INSERTs tbl_arc.type (product|service). The only other DDL that
-- adds that column (migrations/20260625100000_arc_type_column.sql) is base-branch WIP that is NOT part
-- of this feature's commit set, so a fresh DB applying only the feature migrations would fail draft
-- creation with: column "type" of relation "tbl_arc" does not exist.
-- Because of ADD COLUMN IF NOT EXISTS this is a harmless no-op if the base 20260625 migration already
-- ran (and vice versa); definition is kept byte-for-byte identical to the base WIP so the two never
-- diverge: VARCHAR(20) DEFAULT 'product', nullable, no NOT NULL, no CHECK.
-- Apply with: psql $DATABASE_URL -f migrations/20260626100200_arc_type_self_contained.sql
BEGIN;

ALTER TABLE public.tbl_arc
  ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'product';

COMMIT;
