-- One grant per user per company or business unit.
--
-- Why. tbl_hospitality_user_mappings is UNIQUE on (user_id, mapping_type,
-- hospitality_company_id, hospitality_hotel_id), but a company-level grant
-- stores hospitality_hotel_id as NULL and Postgres treats NULLs as distinct.
-- So the key never stopped the same company being granted twice, and the
-- ON CONFLICT upsert in hospitalityModel.insertUserMappings never fired for a
-- company-level grant. Production held 14 extra rows: 10 grants duplicated
-- two to five times across 4 buyers (verified 2026-10-24). The RFQ access
-- check read the grant with a single-row query, so a duplicated grant 500'd
-- every draft save for that company (RFQ 1527, "Multiple rows were not
-- expected.") and 400'd the Negotiations listing with it selected.
--
-- What.
--   1. Collapse each duplicated grant to its oldest row (lowest id). The
--      survivor keeps auto_map_projects if any copy had it. No foreign key
--      references these rows, and the row-audit trigger records each delete.
--   2. Re-create the key as UNIQUE NULLS NOT DISTINCT (PostgreSQL 15+) under
--      the same name, so ON CONFLICT (those four columns) keeps inferring it
--      and now also fires for company-level grants.
--   3. tbl_hospitality_project_mappings has the same key and the same gap
--      (no duplicates on production today) and gets the same treatment.
--
-- Idempotent: a clean table deletes nothing, and a key that is already
-- NULLS NOT DISTINCT is left alone. Both tables are small (under 1,000 rows),
-- so rebuilding the key's index is brief.
--
-- Locking. Rebuilding a key takes an exclusive lock, and nearly every request
-- reads tbl_hospitality_user_mappings. lock_timeout makes the migration give
-- up (rolling back whole) if a long transaction holds either table, instead of
-- holding one table locked while it queues for the other. Just re-run it.

BEGIN;

SET LOCAL lock_timeout = '5s';

UPDATE public.tbl_hospitality_user_mappings m
   SET auto_map_projects = true
  FROM (
        SELECT min(id) AS keep_id
          FROM public.tbl_hospitality_user_mappings
         GROUP BY user_id, mapping_type, hospitality_company_id, hospitality_hotel_id
        HAVING count(*) > 1
           AND bool_or(auto_map_projects)
       ) d
 WHERE m.id = d.keep_id
   AND m.auto_map_projects IS DISTINCT FROM true;

DELETE FROM public.tbl_hospitality_user_mappings m
 USING (
        SELECT id,
               row_number() OVER (
                 PARTITION BY user_id, mapping_type, hospitality_company_id, hospitality_hotel_id
                 ORDER BY id
               ) AS copy_no
          FROM public.tbl_hospitality_user_mappings
       ) d
 WHERE m.id = d.id
   AND d.copy_no > 1;

DELETE FROM public.tbl_hospitality_project_mappings m
 USING (
        SELECT id,
               row_number() OVER (
                 PARTITION BY project_id, mapping_type, hospitality_company_id, hospitality_hotel_id
                 ORDER BY id
               ) AS copy_no
          FROM public.tbl_hospitality_project_mappings
       ) d
 WHERE m.id = d.id
   AND d.copy_no > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tbl_hospitality_user_mappings'::regclass
       AND conname = 'uq_hospitality_user_mapping'
       AND pg_get_constraintdef(oid) LIKE '%NULLS NOT DISTINCT%'
  ) THEN
    ALTER TABLE public.tbl_hospitality_user_mappings
      DROP CONSTRAINT IF EXISTS uq_hospitality_user_mapping;
    ALTER TABLE public.tbl_hospitality_user_mappings
      ADD CONSTRAINT uq_hospitality_user_mapping
      UNIQUE NULLS NOT DISTINCT (user_id, mapping_type, hospitality_company_id, hospitality_hotel_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tbl_hospitality_project_mappings'::regclass
       AND conname = 'uq_hospitality_project_mapping'
       AND pg_get_constraintdef(oid) LIKE '%NULLS NOT DISTINCT%'
  ) THEN
    ALTER TABLE public.tbl_hospitality_project_mappings
      DROP CONSTRAINT IF EXISTS uq_hospitality_project_mapping;
    ALTER TABLE public.tbl_hospitality_project_mappings
      ADD CONSTRAINT uq_hospitality_project_mapping
      UNIQUE NULLS NOT DISTINCT (project_id, mapping_type, hospitality_company_id, hospitality_hotel_id);
  END IF;
END $$;

COMMIT;
