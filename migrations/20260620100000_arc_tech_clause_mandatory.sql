-- ARC v2 two-envelope tech eval — per-clause mandatory pass/fail flag.
-- A mandatory clause acts as a hard gate (fail OR not-yet-judged → vendor
-- not_qualified for that item) AND may still carry weight (counts in the 100).
-- `clause_type` stays a descriptive label; mandatory is an orthogonal boolean.
ALTER TABLE public.tbl_arc_item_tech_evaluation_clauses
  ADD COLUMN IF NOT EXISTS is_mandatory BOOLEAN NOT NULL DEFAULT FALSE;
