-- Sr 51 — one-time DATA CLEANUP: historical tbl_arc_item_tech_evaluation rows
-- written BEFORE Group C capped minimum_passing_score at 100 (buyer create.js
-- Math.min(100,n) + BE setupTechEval rejects >100) can hold stale values up to
-- 999.99 (NUMERIC(5,2) max) — the vendor tech stage rendered these verbatim
-- (e.g. "500%"). New writes are already capped at the write path; this
-- corrects PRE-CAP rows so buyer + vendor + scoring all agree. The FE
-- additionally clamps display defensively (belt + suspenders) — see
-- Math.min(100, …) in VendorTechnicalStage.js and VendorQuote.js.
--
-- Not run automatically against prod by this pipeline — apply manually.
UPDATE public.tbl_arc_item_tech_evaluation
   SET minimum_passing_score = 100
 WHERE minimum_passing_score > 100;
