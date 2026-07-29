-- Revert: drop original_name from tech-evidence files table.
ALTER TABLE public.tbl_arc_item_tech_evaluation_vendors_response_files
  DROP COLUMN IF EXISTS original_name;
