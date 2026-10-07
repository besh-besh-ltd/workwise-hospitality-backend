-- Performance indexes (portal perf plan 2026-10, Phase 0.6).
--
-- Supersedes the never-merged 20260818200000_perf_indexes.sql from
-- perf/db-latency-pass: its plain (rfq_product_id) index is replaced by the
-- covering form below, its (purchase_order_id) index is kept as-is.
--
-- tbl_purchase_order_product
--   Production had nothing but the primary key while the RFQ listing, the PO
--   flags and every spend widget join it by rfq_product_id and read
--   purchase_order_id: 123,616,890 sequential scans vs 40,881 index scans in
--   pg_stat_user_tables (2026-10-03). The INCLUDE column lets the
--   "is there a PO for this product" probes run as index-only scans.
--
-- tbl_notifications
--   Every bell query (getByRecipient, getCounts, getCategoryCounts,
--   getUnreadCount, markDelivered, markAllRead, dismiss, markUnread) filters
--   on COALESCE(recipient_user_id, sender_user_id) = $1 AND dismissed_at IS NULL.
--   The existing idx_notif_recipient_* indexes are on the bare
--   recipient_user_id column, which that expression cannot use, so the 30 s
--   unread-count poll was a seq scan (560k seq scans, ~10 ms x 653k calls).
--   The expression and predicate here match the queries verbatim; INCLUDE
--   makes getCounts/getUnreadCount index-only.
--
-- tbl_company_location
--   Joined on company_id from vendor/RFQ/PO detail queries; only the PK
--   existed (11,008,482 seq scans vs 4 index scans).
--
-- Plain CREATE INDEX so this file runs inside the transactional runner and the
-- test-schema bootstrap (tests/setup/pendingMigrations.json). On a LIVE
-- database run scripts/perf_indexes_concurrently.sh FIRST — it creates the
-- same names CONCURRENTLY, after which this file is a no-op.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_pop_rfq_product_id_inc
  ON public.tbl_purchase_order_product (rfq_product_id) INCLUDE (purchase_order_id);

CREATE INDEX IF NOT EXISTS idx_pop_purchase_order_id
  ON public.tbl_purchase_order_product (purchase_order_id);

CREATE INDEX IF NOT EXISTS idx_notif_owner_active
  ON public.tbl_notifications ((COALESCE(recipient_user_id, sender_user_id)), created_at DESC)
  INCLUDE (delivered_at, is_read)
  WHERE dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_company_location_company_id
  ON public.tbl_company_location (company_id);

COMMIT;
