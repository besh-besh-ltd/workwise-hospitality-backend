-- ARC v2 two-envelope tech eval — per-clause mandatory pass/fail verdict on
-- the vendor-response row. NULL = clause not mandatory, or mandatory but not
-- yet judged. The scoring math (computeItemScores) reads this for the gate:
-- a mandatory clause whose response is FALSE or NULL disqualifies the vendor
-- for the item regardless of the weighted score.
ALTER TABLE public.tbl_arc_item_tech_evaluation_vendors_response
  ADD COLUMN IF NOT EXISTS mandatory_passed BOOLEAN;
