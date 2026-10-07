-- Reverts 20261006100000_vendor_networks.sql.
-- Any tbl_vendor_payments row with payment_type = 'network_seat' must be removed first or the restored CHECK fails.
-- Left behind on purpose (pre-existing tables, no network column): the passwordless entity
-- accounts created by the org admin (tbl_users user_type 3) and the network persons
-- (tbl_users user_type 11). Pre-network code ignores type 11; the entity accounts become
-- ordinary standalone vendors.

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

ALTER TABLE tbl_vendor_payments DROP CONSTRAINT IF EXISTS tbl_vendor_payments_payment_type_check;
ALTER TABLE tbl_vendor_payments ADD CONSTRAINT tbl_vendor_payments_payment_type_check
  CHECK (payment_type IN ('hospitality','tender'));
