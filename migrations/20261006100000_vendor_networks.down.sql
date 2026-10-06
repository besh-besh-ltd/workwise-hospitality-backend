-- Reverts 20261006100000_vendor_networks.sql.
-- Any tbl_vendor_payments row with payment_type = 'network_seat' must be removed first or the restored CHECK fails.
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
