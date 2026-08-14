-- Quote charges — backfill slugs + migrate legacy freight/package into other_charges.
--
-- Two one-time data migrations for the "other_charges / global_charges" JSONB
-- model on quotes:
--
--   Part A: every charge object must carry a `slug` (the frontend matches
--           charges by slug, not display name). Older rows stored charges with
--           only a `name`. This derives slug = lower(name with non-alphanumeric
--           runs collapsed to '_', and leading/trailing '_' stripped).
--
--   Part B: legacy quotes stored freight/package as flat columns
--           (freight_price/freight_mode, package_price/package_mode). The new
--           model represents them as entries in other_charges[]. This folds any
--           remaining flat freight/package values into other_charges.
--
-- SLUG REGEX: the strip step is '^_|_$' (remove a leading OR trailing
-- underscore). This matches what is already live on staging — verified: staging
-- has 0 slugs with an edge underscore. Do NOT use '^|$' (a zero-width no-op that
-- leaves trailing underscores like 'freight_', which would break slug matching).
--
-- Idempotent: Part A only touches rows that still have a NULL-slug element;
-- Part B only touches rows whose other_charges is NULL/empty. Safe to re-run.
--
-- Apply with:
--   psql "$DATABASE_URL" -f migrations/20260624100200_backfill_quote_charges_slugs.sql

BEGIN;

-- ── Part A: slug backfill ────────────────────────────────────────────────────

-- A1. tbl_quote_items.other_charges
UPDATE tbl_quote_items qi
SET other_charges = (
  SELECT jsonb_agg(
    CASE
      WHEN charge->>'slug' IS NOT NULL THEN charge
      ELSE charge || jsonb_build_object(
        'slug',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(TRIM(charge->>'name'), '[^a-zA-Z0-9]+', '_', 'g'),
          '^_|_$', '', 'g'
        ))
      )
    END
  )
  FROM jsonb_array_elements(qi.other_charges) AS charge
)
WHERE other_charges IS NOT NULL
  AND other_charges != '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(other_charges) AS c
    WHERE c->>'slug' IS NULL
  );

-- A2. tbl_quote_item_history.other_charges
UPDATE tbl_quote_item_history qh
SET other_charges = (
  SELECT jsonb_agg(
    CASE
      WHEN charge->>'slug' IS NOT NULL THEN charge
      ELSE charge || jsonb_build_object(
        'slug',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(TRIM(charge->>'name'), '[^a-zA-Z0-9]+', '_', 'g'),
          '^_|_$', '', 'g'
        ))
      )
    END
  )
  FROM jsonb_array_elements(qh.other_charges) AS charge
)
WHERE other_charges IS NOT NULL
  AND other_charges != '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(other_charges) AS c
    WHERE c->>'slug' IS NULL
  );

-- A3. tbl_quotes.global_charges
UPDATE tbl_quotes q
SET global_charges = (
  SELECT jsonb_agg(
    CASE
      WHEN charge->>'slug' IS NOT NULL THEN charge
      ELSE charge || jsonb_build_object(
        'slug',
        LOWER(REGEXP_REPLACE(
          REGEXP_REPLACE(TRIM(charge->>'name'), '[^a-zA-Z0-9]+', '_', 'g'),
          '^_|_$', '', 'g'
        ))
      )
    END
  )
  FROM jsonb_array_elements(q.global_charges) AS charge
)
WHERE global_charges IS NOT NULL
  AND global_charges != '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(global_charges) AS c
    WHERE c->>'slug' IS NULL
  );

-- ── Part B: fold legacy freight/package flat columns into other_charges ──────

-- B1. tbl_quote_items
UPDATE tbl_quote_items
SET other_charges = COALESCE(other_charges, '[]'::jsonb)
  || CASE WHEN freight_price > 0 THEN jsonb_build_array(jsonb_build_object(
       'name', 'Freight',
       'slug', 'freight',
       'amount', freight_price,
       'amount_mode', COALESCE(freight_mode, 'percentage'),
       'tax', 0,
       'tax_mode', 'percentage'
     )) ELSE '[]'::jsonb END
  || CASE WHEN package_price > 0 THEN jsonb_build_array(jsonb_build_object(
       'name', 'Packaging',
       'slug', 'packaging',
       'amount', package_price,
       'amount_mode', COALESCE(package_mode, 'percentage'),
       'tax', 0,
       'tax_mode', 'percentage'
     )) ELSE '[]'::jsonb END
WHERE (freight_price > 0 OR package_price > 0)
  AND (other_charges IS NULL OR other_charges = '[]'::jsonb);

-- B2. tbl_quote_item_history
UPDATE tbl_quote_item_history
SET other_charges = COALESCE(other_charges, '[]'::jsonb)
  || CASE WHEN freight_price > 0 THEN jsonb_build_array(jsonb_build_object(
       'name', 'Freight',
       'slug', 'freight',
       'amount', freight_price,
       'amount_mode', COALESCE(freight_mode, 'percentage'),
       'tax', 0,
       'tax_mode', 'percentage'
     )) ELSE '[]'::jsonb END
  || CASE WHEN package_price > 0 THEN jsonb_build_array(jsonb_build_object(
       'name', 'Packaging',
       'slug', 'packaging',
       'amount', package_price,
       'amount_mode', COALESCE(package_mode, 'percentage'),
       'tax', 0,
       'tax_mode', 'percentage'
     )) ELSE '[]'::jsonb END
WHERE (freight_price > 0 OR package_price > 0)
  AND (other_charges IS NULL OR other_charges = '[]'::jsonb);

COMMIT;
