-- ARC v2: persist the original filename of vendor tech-evidence uploads.
-- Additive nullable column — safe to apply on existing data (rows get NULL).
ALTER TABLE public.tbl_arc_item_tech_evaluation_vendors_response_files
  ADD COLUMN IF NOT EXISTS original_name TEXT;
