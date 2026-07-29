-- Rollback for 20260624100200_backfill_quote_charges_slugs.sql
--
-- ⚠️  This reverses a DATA migration. It is best-effort and lossy by nature:
-- there is no marker distinguishing charge data the migration wrote from data
-- the application has written since. It is only safe to run IMMEDIATELY after
-- the up migration, BEFORE the app resumes writing slug-bearing charges — once
-- live traffic writes new charges (all of which carry slugs), this rollback
-- would strip those legitimate slugs too. If in doubt, do NOT run it.
--
-- Reverses in the opposite order: undo Part B (injected freight/package
-- entries), then Part A (slug keys).

BEGIN;

-- ── Undo Part B: remove freight/package entries that were folded in ──────────
-- The up added freight/package ONLY to rows whose other_charges was NULL/empty,
-- so a row touched by Part B contains ONLY those injected entries. Remove any
-- element whose slug is freight/packaging AND whose amount matches the still-
-- present flat column, then normalise the result back to '[]'.

-- B1. tbl_quote_items
UPDATE tbl_quote_items
SET other_charges = COALESCE((
  SELECT jsonb_agg(c)
  FROM jsonb_array_elements(other_charges) AS c
  WHERE NOT (
    (c->>'slug' = 'freight'   AND (c->>'amount')::numeric = freight_price) OR
    (c->>'slug' = 'packaging' AND (c->>'amount')::numeric = package_price)
  )
), '[]'::jsonb)
WHERE (freight_price > 0 OR package_price > 0)
  AND jsonb_typeof(other_charges) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(other_charges) c
    WHERE (c->>'slug' = 'freight'   AND (c->>'amount')::numeric = freight_price)
       OR (c->>'slug' = 'packaging' AND (c->>'amount')::numeric = package_price)
  );

-- B2. tbl_quote_item_history
UPDATE tbl_quote_item_history
SET other_charges = COALESCE((
  SELECT jsonb_agg(c)
  FROM jsonb_array_elements(other_charges) AS c
  WHERE NOT (
    (c->>'slug' = 'freight'   AND (c->>'amount')::numeric = freight_price) OR
    (c->>'slug' = 'packaging' AND (c->>'amount')::numeric = package_price)
  )
), '[]'::jsonb)
WHERE (freight_price > 0 OR package_price > 0)
  AND jsonb_typeof(other_charges) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(other_charges) c
    WHERE (c->>'slug' = 'freight'   AND (c->>'amount')::numeric = freight_price)
       OR (c->>'slug' = 'packaging' AND (c->>'amount')::numeric = package_price)
  );

-- ── Undo Part A: strip the slug key from every charge element ────────────────

-- A1. tbl_quote_items.other_charges
UPDATE tbl_quote_items
SET other_charges = (
  SELECT jsonb_agg(charge - 'slug')
  FROM jsonb_array_elements(other_charges) AS charge
)
WHERE jsonb_typeof(other_charges) = 'array'
  AND other_charges != '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(other_charges) c WHERE c ? 'slug'
  );

-- A2. tbl_quote_item_history.other_charges
UPDATE tbl_quote_item_history
SET other_charges = (
  SELECT jsonb_agg(charge - 'slug')
  FROM jsonb_array_elements(other_charges) AS charge
)
WHERE jsonb_typeof(other_charges) = 'array'
  AND other_charges != '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(other_charges) c WHERE c ? 'slug'
  );

-- A3. tbl_quotes.global_charges
UPDATE tbl_quotes
SET global_charges = (
  SELECT jsonb_agg(charge - 'slug')
  FROM jsonb_array_elements(global_charges) AS charge
)
WHERE jsonb_typeof(global_charges) = 'array'
  AND global_charges != '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(global_charges) c WHERE c ? 'slug'
  );

COMMIT;
