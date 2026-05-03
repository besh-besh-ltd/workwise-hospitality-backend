-- Migration: rewrite per-charge tax: 0 → tax: null in JSONB charge arrays.
--
-- Why: the pricing engine's tri-state tax semantics changed.
--   Before — tax: 0 meant "no value, inherit base rate" (the engine required
--            tax > 0 to count as explicit).
--   After  — tax: 0 means "explicit no tax". null/undefined/'' mean inherit.
--
-- Existing rows were saved with the old semantics; their persisted
-- total_price values were computed assuming tax: 0 → inherit. Without this
-- migration, any later re-save would silently drop the previously-inherited
-- tax and produce a different total. We rewrite all in-place tax: 0 entries
-- to tax: null so the engine continues to inherit on those charges.
--
-- Idempotent: running twice is a no-op.
-- Run order: ideally before the new code goes live (any time pre-deploy is
-- safe; old engine treats both 0 and null as "inherit", so the rewrite is a
-- functional no-op until the new rule activates).

BEGIN;

-- 1. tbl_quote_items.other_charges — top-level JSONB array
UPDATE tbl_quote_items
SET other_charges = (
  SELECT jsonb_agg(
    CASE
      WHEN charge ? 'tax' AND (charge->>'tax')::text = '0'
        THEN charge - 'tax' || jsonb_build_object('tax', null)
      ELSE charge
    END
  )
  FROM jsonb_array_elements(other_charges) AS charge
)
WHERE other_charges IS NOT NULL
  AND jsonb_typeof(other_charges) = 'array'
  AND other_charges::text LIKE '%"tax":0%';

-- 2. tbl_purchase_order_product.charges_meta.other_charges — nested under charges_meta
UPDATE tbl_purchase_order_product
SET charges_meta = jsonb_set(
  charges_meta,
  '{other_charges}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN charge ? 'tax' AND (charge->>'tax')::text = '0'
          THEN charge - 'tax' || jsonb_build_object('tax', null)
        ELSE charge
      END
    )
    FROM jsonb_array_elements(charges_meta->'other_charges') AS charge
  )
)
WHERE charges_meta IS NOT NULL
  AND charges_meta ? 'other_charges'
  AND jsonb_typeof(charges_meta->'other_charges') = 'array'
  AND (charges_meta->'other_charges')::text LIKE '%"tax":0%';

-- Verification: expect 0 remaining rows containing `"tax":0` in either
-- charge array. If non-zero, do not commit — investigate the offending rows
-- (they may have a literal "0" string the JSON regex didn't catch, or a
-- nested escape). Inspect with:
--   SELECT id, other_charges FROM tbl_quote_items WHERE other_charges::text LIKE '%"tax":0%';
SELECT 'tbl_quote_items' AS tbl,
       COUNT(*) FILTER (WHERE other_charges::text LIKE '%"tax":0%') AS remaining
FROM tbl_quote_items
UNION ALL
SELECT 'tbl_purchase_order_product',
       COUNT(*) FILTER (WHERE (charges_meta->'other_charges')::text LIKE '%"tax":0%')
FROM tbl_purchase_order_product;

COMMIT;
