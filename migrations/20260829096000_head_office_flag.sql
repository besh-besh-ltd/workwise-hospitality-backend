-- Which business unit is the Head Office.
--
-- Nothing marked one. `createHOFromCompany` copies the company's name, address,
-- GST and bank details onto a new hotel row and leaves it otherwise identical
-- to any other unit -- so "is this the HO?" could only be answered by reading
-- the name, and it had no duplicate guard either: calling it twice produced a
-- second Head Office for the same company, silently.
--
-- The backfill is wider than the naming convention suggests. Exactly one row in
-- production carries the "- HO" suffix (id 31), but four more were created by
-- createHOFromCompany and therefore carry the company's name verbatim:
-- Phileein (8), SLPD (9), Zaffiro (27) and Chandi (35). Backfilling only the
-- suffix would have left four companies able to mint a second HO.

BEGIN;

ALTER TABLE public.tbl_hospitality_company_hotels
    ADD COLUMN IF NOT EXISTS is_head_office boolean NOT NULL DEFAULT false;

-- Both shapes: the "- HO" suffix, and a unit named exactly after its company,
-- which is what createHOFromCompany produces.
UPDATE public.tbl_hospitality_company_hotels h
   SET is_head_office = true
  FROM public.tbl_hospitality_companies c
 WHERE c.id = h.hospitality_company_id
   AND COALESCE(h.is_deleted, 0) = 0
   AND (h.name ILIKE '%- HO' OR h.name = c.name);

-- One live Head Office per company, enforced by the database rather than by a
-- check somebody has to remember. Partial on is_deleted so archiving an HO
-- frees the slot -- otherwise a company that archived a mis-created one could
-- never make another.
--
-- Verified before adding: no company currently holds two rows matching either
-- shape, so this cannot fail on existing data.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_head_office_per_company
    ON public.tbl_hospitality_company_hotels (hospitality_company_id)
    WHERE is_head_office AND COALESCE(is_deleted, 0) = 0;

COMMIT;
