-- Reverts 20261006100000_vendor_networks.sql. Idempotent: safe to re-run.
-- Left behind on purpose (pre-existing table, no network column): the passwordless entity
-- accounts created by the org admin (tbl_users user_type 3). They become ordinary
-- standalone vendors.

-- 0. Network persons (tbl_users user_type 11) are deactivated, not deleted (they are
--    referenced as actors). Pre-network code does NOT ignore them: the admin console's
--    old gate admits user_type NOT IN (2,3,4), so a live type-11 login would reach it.
UPDATE tbl_users SET status = 0, is_deleted = 1
 WHERE user_type = 11 AND (status IS DISTINCT FROM 0 OR is_deleted IS DISTINCT FROM 1);

-- 1. Routed RFQ invite copies. Without routed_from_vendor_id, pre-network code would read
--    each copy as a real invite (counted, emailed, shown to the member). A copy whose
--    member never quoted (no tbl_quotes row on the RFQ, regret included) is deleted. A
--    copy whose member did quote is KEPT as a plain invite row: the buyer must still see
--    who quoted, and the quote rows reference it by (rfq_id, user_id).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'tbl_rfq_product_vendors'
                AND column_name = 'routed_from_vendor_id') THEN
    DELETE FROM tbl_rfq_product_vendors p
     WHERE p.routed_from_vendor_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tbl_quotes q WHERE q.rfq_id = p.rfq_id AND q.created_by = p.user_id);
  END IF;
END $$;

-- 2. Call-off fulfilment routed to member entities. Only vendor-network code ever writes
--    tbl_arc_contract_line_hotel.fulfilling_vendor_id (ARC_HOTEL routing and the line-hotel
--    sync that inherits it), and pre-network code releases call-offs to
--    COALESCE(fulfilling_vendor_id, contract vendor) with no network check. Reset it so
--    call-offs go back to the contract vendor. POs already issued keep their vendor.
UPDATE tbl_arc_contract_line_hotel SET fulfilling_vendor_id = NULL, updated_at = CURRENT_TIMESTAMP
 WHERE fulfilling_vendor_id IS NOT NULL;

-- The row-audit triggers go with their tables (DROP TABLE drops them); nothing else to undo.
DROP FUNCTION IF EXISTS vn_backfill_hotel_location_ids();
DROP TABLE IF EXISTS tbl_vendor_network_seats;
DROP TABLE IF EXISTS tbl_vendor_routing_assignments; -- also drops ix_vn_assign_org_one_pending / _one_accepted
DROP TABLE IF EXISTS tbl_vendor_coverage_rules;
DROP TABLE IF EXISTS tbl_vendor_org_members;
DROP TABLE IF EXISTS tbl_vendor_org_link_invites; -- also drops addressed_by and ix_vn_link_invites_one_pending
DROP TABLE IF EXISTS tbl_vendor_org_entities;
DROP TABLE IF EXISTS tbl_vendor_orgs;

ALTER TABLE tbl_rfq_product_vendors DROP COLUMN IF EXISTS routed_from_vendor_id;
ALTER TABLE tbl_hospitality_company_hotels DROP COLUMN IF EXISTS city_id, DROP COLUMN IF EXISTS state_id;

-- Seat payments go before the CHECK is restored: one 'network_seat' row would make the
-- ADD CONSTRAINT fail after the DROP had run, half-applying the swap. (Seat rows that
-- referenced them were dropped with tbl_vendor_network_seats above; any other reference
-- is ON DELETE SET NULL.)
DELETE FROM tbl_vendor_payments WHERE payment_type = 'network_seat';
ALTER TABLE tbl_vendor_payments DROP CONSTRAINT IF EXISTS tbl_vendor_payments_payment_type_check;
ALTER TABLE tbl_vendor_payments ADD CONSTRAINT tbl_vendor_payments_payment_type_check
  CHECK (payment_type IN ('hospitality','tender'));
