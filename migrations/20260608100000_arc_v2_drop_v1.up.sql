-- ARC v2 — Migration 1 of 10: drop the v1 ARC table family.
--
-- The v1 ARC module shipped but was rejected by users. The v1 backend
-- (controllers/arc, routes/arc, helper/arcAwardTemplate.hbs) and frontend
-- (pages/dashboard/buyer/arc-committee, components/dashboard/buyer/arc-committee,
-- services/arc.js) have been moved into _deprecated/arc_v1/. The post-approval
-- hook for entity_type='ARC' has been removed from both
-- approvalActionService.js and approvalPropagationService.js.
--
-- The live DB held trivial data (1 ARC row, 2 items, 2 releases, 0 vendor
-- signatures) — all test/scaffolding artefacts. The test harness schema
-- (tests/setup/schema.sql) never included these tables, so this migration is
-- effectively a no-op for tests; it only affects staging/prod.
--
-- v2 will create a parallel new schema (tbl_arc, tbl_arc_item, tbl_arc_contract,
-- etc.) in a subsequent migration. The v2 design is in
-- /Users/apple/.claude/plans/okay-we-are-implementing-rosy-clover.md §4.
--
-- DROP order respects FK relationships: leaves and link tables first, then
-- parents. CASCADE is used as a belt-and-braces in case a stray FK exists.

DROP TABLE IF EXISTS public.tbl_arc_vendor_signing CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_release_items CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_release CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_item CASCADE;
DROP TABLE IF EXISTS public.tbl_arc_hotels CASCADE;
DROP TABLE IF EXISTS public.tbl_arc CASCADE;
