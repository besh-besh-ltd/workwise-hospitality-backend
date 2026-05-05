-- ============================================================================
-- Migration 002 — Global Group ARC approval hierarchy
-- ----------------------------------------------------------------------------
-- Adds a per-stage, per-parent-company "global" approval policy slot used
-- exclusively by Group ARC tenders. Confirmed by product on 2026-05-04:
--
--   * Single ARC: per-hotel/per-BU approval matrix (existing model).
--   * Group ARC: ONE global hierarchy per parent company per tender stage,
--                configured by the Hospitality Network admin once and
--                applied to every Group ARC across all BUs and hotels under
--                that parent company.
--
-- Schema changes:
--   1. Make tbl_approval_policies.hospitality_company_id NULLABLE so global
--      rows can omit BU/hotel scoping.
--   2. Add tbl_approval_policies.company_id (FK to tbl_company) — denormalised
--      parent-company reference. Required for global rows; for non-global
--      rows it must equal tbl_hospitality_companies.buyer_company_id.
--   3. Add tbl_approval_policies.is_global SMALLINT DEFAULT 0.
--   4. CHECK constraint: is_global=1 implies hospitality_company_id, hotel_id,
--      department_id, process_id are all NULL — globals have no narrower
--      scope. They are matched purely by (entity_type, company_id).
--   5. Partial UNIQUE index: at most one active global policy per
--      (entity_type, company_id). Per-stage means TENDER, TECHNICAL,
--      NEGOTIATION_QUOTE, ARC each get their own row, but no entity_type
--      can have two competing globals.
--
-- Lookup (implemented in code, not schema):
--   * tender_scope='GROUP' + tender-chain entity_type → resolve by
--     (is_global=1, company_id, entity_type). No fallback to non-global.
--   * tender_scope='SINGLE' or non-tender → resolve by existing precedence
--     (process_id + hospitality_company_id + hotel_id + department_id).
--     is_global=0 always.
-- ============================================================================

BEGIN;

-- 2.1 Make hospitality_company_id nullable so global rows can omit it.
ALTER TABLE public.tbl_approval_policies
  ALTER COLUMN hospitality_company_id DROP NOT NULL;

-- 2.2 Add parent-company column. Initially nullable so the backfill below
-- can populate it; we then enforce a CHECK that scopes when it must be set.
ALTER TABLE public.tbl_approval_policies
  ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES public.tbl_company(id);

-- 2.3 Add is_global flag.
ALTER TABLE public.tbl_approval_policies
  ADD COLUMN IF NOT EXISTS is_global SMALLINT NOT NULL DEFAULT 0;

-- 2.4 Backfill company_id on existing rows from the BU's parent company.
--     Existing rows are all is_global=0 by definition, so they must have a
--     hospitality_company_id and we can resolve company_id deterministically.
UPDATE public.tbl_approval_policies p
SET company_id = hc.buyer_company_id
FROM public.tbl_hospitality_companies hc
WHERE p.hospitality_company_id IS NOT NULL
  AND p.hospitality_company_id = hc.id
  AND p.company_id IS NULL;

-- 2.5 Constraints. is_global=1 must have NO narrower scope (no hospitality
-- company, no hotel, no department, no process); is_global=0 must have a
-- hospitality_company_id (non-global rows are always BU-scoped).
ALTER TABLE public.tbl_approval_policies
  DROP CONSTRAINT IF EXISTS chk_arc_policy_global_scope;
ALTER TABLE public.tbl_approval_policies
  ADD CONSTRAINT chk_arc_policy_global_scope
  CHECK (
    (is_global = 1
       AND hospitality_company_id IS NULL
       AND hotel_id IS NULL
       AND department_id IS NULL
       AND process_id IS NULL
       AND company_id IS NOT NULL)
    OR
    (is_global = 0
       AND hospitality_company_id IS NOT NULL
       AND company_id IS NOT NULL)
  );

-- 2.6 At most one active global policy per (entity_type, company_id).
--     Per-stage (entity_type) means each of TENDER, TECHNICAL,
--     NEGOTIATION_QUOTE, ARC can have its own global row, but no entity_type
--     ends up with two competing globals for the same parent company.
--     entity_type values match the existing approval engine. Tender chain
--     stages governed by the global hierarchy when tender_scope='GROUP':
--       TENDER, TECHNICAL, NEGOTIATION, NEGOTIATION_QUOTE, ARC.
--     process_id discrimination remains the mechanism for tender vs RFQ
--     separation for non-global rows (Single ARC, ad-hoc RFQ).
DROP INDEX IF EXISTS public.uq_global_policy_per_entity_company;
CREATE UNIQUE INDEX uq_global_policy_per_entity_company
  ON public.tbl_approval_policies (entity_type, company_id)
  WHERE is_global = 1 AND is_active = true;

-- 2.7 Helpful lookup index for the Group ARC fast path.
CREATE INDEX IF NOT EXISTS idx_arc_policy_global_lookup
  ON public.tbl_approval_policies (entity_type, company_id)
  WHERE is_global = 1 AND is_active = true;

-- 2.8 tbl_approval_instances.hospitality_company_id must allow NULL so a
--     Group ARC instance (which has no single BU scope) can be inserted.
--     Single ARC and RFQ continue to populate it.
ALTER TABLE public.tbl_approval_instances
  ALTER COLUMN hospitality_company_id DROP NOT NULL;

COMMIT;
