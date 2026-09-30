-- ARC: persist the wizard's `type` (product vs service) on the contract row.
-- The create wizard collects a product/service `type` but it had no column on
-- tbl_arc, so a resumed draft (?c=<id>) couldn't restore it. Add a nullable
-- varchar defaulting to 'product' so existing rows read back sensibly and the
-- resume path can rehydrate the Basics step.
-- Apply with: psql $DATABASE_URL -f migrations/20260625100000_arc_type_column.sql

BEGIN;

ALTER TABLE public.tbl_arc
  ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'product';

COMMIT;
