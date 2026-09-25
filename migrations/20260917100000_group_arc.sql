-- Group ARC: one rate contract covering several hotels of the same company.
--
-- tbl_arc.hotel_id stays NOT NULL and becomes the LEAD hotel (the HO unit when
-- the company has one). Everything below is written ONLY for group ARCs
-- (is_group = true). A single-hotel ARC writes none of it, so its behaviour and
-- every single-ARC write path (wizard, manual entry, raw-SQL test factories)
-- are unchanged and cannot drift out of step with these tables.
--
--   visibility → the lead hotel OR any tbl_arc_hotel_mappings row
--   authority  → the lead hotel only (evaluation, approvals, editing)
--
-- The original ARC v2 migration (20260608100200_arc_core_tables.sql:7-8)
-- anticipated this: "When multi-BU lands, hotel_id is migrated out into
-- tbl_arc_bu." It is kept as the lead hotel instead, because three RBAC scope
-- builders, the permission middleware and the approval engine all key on one
-- scalar hotel per ARC, and a group ARC's evaluation and approval really are
-- run by one lead unit.

BEGIN;

ALTER TABLE public.tbl_arc
  ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;

-- Hotels a group ARC covers, the lead hotel included. Frozen once the ARC
-- leaves draft (updateDraft only edits drafts).
CREATE TABLE IF NOT EXISTS public.tbl_arc_hotel_mappings (
  id          BIGSERIAL PRIMARY KEY,
  arc_id      BIGINT  NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  hotel_id    INTEGER NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE RESTRICT,
  created_by  INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_arc_hotel_mapping UNIQUE (arc_id, hotel_id)
);
CREATE INDEX IF NOT EXISTS idx_arc_hotel_mappings_hotel
  ON public.tbl_arc_hotel_mappings (hotel_id);

-- Expected quantity of an item at each hotel. The server writes these and
-- tbl_arc_item.indicative_qty (= their sum) in one transaction.
CREATE TABLE IF NOT EXISTS public.tbl_arc_item_hotel_qty (
  id              BIGSERIAL PRIMARY KEY,
  arc_item_id     BIGINT  NOT NULL REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE,
  hotel_id        INTEGER NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE RESTRICT,
  indicative_qty  NUMERIC(15,2) NOT NULL CHECK (indicative_qty >= 0),
  created_at      TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_arc_item_hotel_qty UNIQUE (arc_item_id, hotel_id)
);

-- The covered hotels an invited vendor may quote for and win. Snapshotted when
-- the ARC floats, from the vendor's hotel subscriptions at that moment.
CREATE TABLE IF NOT EXISTS public.tbl_arc_invitation_hotel (
  id                 BIGSERIAL PRIMARY KEY,
  arc_invitation_id  BIGINT  NOT NULL REFERENCES public.tbl_arc_invitation(id) ON DELETE CASCADE,
  hotel_id           INTEGER NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE RESTRICT,
  created_at         TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_arc_invitation_hotel UNIQUE (arc_invitation_id, hotel_id)
);

-- How one award (item × vendor) splits across hotels. SUM(allocated_qty) here
-- equals the parent award's allocated_qty. The award row itself keeps its
-- (comm_eval, item, vendor) key, so clarifications and contract generation
-- address it exactly as they do for a single-hotel ARC.
CREATE TABLE IF NOT EXISTS public.tbl_arc_comm_evaluation_award_hotel (
  id                            BIGSERIAL PRIMARY KEY,
  arc_comm_evaluation_award_id  BIGINT  NOT NULL REFERENCES public.tbl_arc_comm_evaluation_award(id) ON DELETE CASCADE,
  hotel_id                      INTEGER NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE RESTRICT,
  allocated_qty                 NUMERIC(15,2) NOT NULL CHECK (allocated_qty > 0),
  CONSTRAINT uq_arc_award_hotel UNIQUE (arc_comm_evaluation_award_id, hotel_id)
);

-- Per-hotel release ledger of a contract line.
--
-- The parent tbl_arc_contract_line.committed_qty / consumed_qty stay the HARD
-- cap for the whole group. These rows are each hotel's share (a SOFT allocation:
-- a hotel may order past its share while the group total has room, and HO is
-- told) and each hotel's usage record.
--
--   unit_rate_override / charges_override
--       a commercial override for one hotel; NULL = the group rate.
--   fulfilling_vendor_id
--       the vendor account that delivers to and bills this hotel; NULL = the
--       contract vendor. Reserved for vendor distributor networks.
--   is_suspended
--       HO paused ordering for this hotel.
CREATE TABLE IF NOT EXISTS public.tbl_arc_contract_line_hotel (
  id                    BIGSERIAL PRIMARY KEY,
  arc_contract_line_id  BIGINT  NOT NULL REFERENCES public.tbl_arc_contract_line(id) ON DELETE CASCADE,
  hotel_id              INTEGER NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE RESTRICT,
  committed_qty         NUMERIC(15,2) NOT NULL CHECK (committed_qty >= 0),
  consumed_qty          NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (consumed_qty >= 0),
  unit_rate_override    NUMERIC(15,2),
  charges_override      JSONB,
  fulfilling_vendor_id  INTEGER REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  is_suspended          BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_arc_contract_line_hotel UNIQUE (arc_contract_line_id, hotel_id)
);
CREATE INDEX IF NOT EXISTS idx_arc_contract_line_hotel_hotel
  ON public.tbl_arc_contract_line_hotel (hotel_id);

COMMIT;
