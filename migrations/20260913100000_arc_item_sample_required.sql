-- Per-item sampling requirement for ARC.
--
-- `tbl_arc.sample_required` is a single contract-wide Yes/No with exactly one
-- reader in the product (the ARC detail key-value panel). A rate contract
-- routinely mixes items where a physical sample is meaningful with items where
-- it is not, so the buyer could only answer the question for the whole basket.
--
-- Deliberately NOT modelled as a tech-eval clause of clause_type 'sample':
-- per-item clause weights must total exactly 100, and a sampling requirement
-- that is not score-bearing has no natural weight. The RFQ side solved that by
-- excluding 'sampling' from ~15 separate count predicates; duplicating that
-- for ARC would be a large change for a boolean.
--
-- `tbl_arc.sample_required` is kept and is now a rollup — true when any item
-- requires a sample — so its one existing reader keeps working.
ALTER TABLE public.tbl_arc_item
  ADD COLUMN IF NOT EXISTS sample_required BOOLEAN NOT NULL DEFAULT FALSE;

-- Carry the existing contract-level answer down to its items, so no ARC
-- silently loses a sampling requirement it had already recorded.
UPDATE public.tbl_arc_item i
   SET sample_required = TRUE
  FROM public.tbl_arc a
 WHERE a.id = i.arc_id
   AND a.sample_required = TRUE
   AND i.sample_required = FALSE;
