-- Restores the NULL-distinct keys. The duplicate grants the up migration
-- removed are NOT restored: they were the defect, and nothing referenced them.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tbl_hospitality_user_mappings'::regclass
       AND conname = 'uq_hospitality_user_mapping'
       AND pg_get_constraintdef(oid) LIKE '%NULLS NOT DISTINCT%'
  ) THEN
    ALTER TABLE public.tbl_hospitality_user_mappings
      DROP CONSTRAINT uq_hospitality_user_mapping;
    ALTER TABLE public.tbl_hospitality_user_mappings
      ADD CONSTRAINT uq_hospitality_user_mapping
      UNIQUE (user_id, mapping_type, hospitality_company_id, hospitality_hotel_id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tbl_hospitality_project_mappings'::regclass
       AND conname = 'uq_hospitality_project_mapping'
       AND pg_get_constraintdef(oid) LIKE '%NULLS NOT DISTINCT%'
  ) THEN
    ALTER TABLE public.tbl_hospitality_project_mappings
      DROP CONSTRAINT uq_hospitality_project_mapping;
    ALTER TABLE public.tbl_hospitality_project_mappings
      ADD CONSTRAINT uq_hospitality_project_mapping
      UNIQUE (project_id, mapping_type, hospitality_company_id, hospitality_hotel_id);
  END IF;
END $$;

COMMIT;
