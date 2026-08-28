-- Audit trail for vendor subscriptions.
--
-- tbl_vendor_hotel_category_subscription decides which vendors can be reached
-- for which hotel and which category — that is, whether a vendor sees an RFQ at
-- all. Twenty-three less consequential tables carried an audit trigger; this
-- one did not.
--
-- The cost showed up on RFQ 536445 (The Orchid Manali). The buyer reported: "I
-- removed the Engineering category and Manali unit and added the same again,
-- and it is still not showing." No row had been created for that vendor since
-- May, but with no trail there was no way to distinguish an edit that was never
-- made, one that silently failed, one applied to a different vendor account,
-- and one abandoned before payment. Those four have four different fixes, and
-- the ticket could not be closed on evidence.
--
-- Two changes, in order:
--
--  1. log_changes_direct() gains an INSERT branch. A re-add IS an insert, and
--     the function previously recorded INSERTs with both payloads NULL — "a row
--     appeared" without saying which hotel or category. No existing trigger
--     fires on INSERT (all twenty-three are AFTER DELETE OR UPDATE), so this is
--     inert for every other audited table until someone opts in.
--
--  2. The trigger itself, on INSERT OR UPDATE OR DELETE.
--
-- Safe to re-run: CREATE OR REPLACE plus DROP TRIGGER IF EXISTS.
--
-- NOTE for whoever reads this next: audit_log_temp is UNLOGGED, so this trail
-- does not survive a crash and is not replicated. That is the existing platform
-- convention and is deliberately left alone here; if subscription history needs
-- to be durable, that is a separate change to the audit table itself.

CREATE OR REPLACE FUNCTION public.log_changes_direct() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_old JSONB := NULL;
    v_new JSONB := NULL;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD);
    ELSIF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
    ELSIF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW);
    END IF;

    INSERT INTO audit_log_temp (
        table_name, operation, record_id, old_data, new_data, changed_by, changed_at
    ) VALUES (
                 TG_TABLE_NAME, TG_OP, COALESCE(NEW.id, OLD.id),
                 v_old, v_new, current_user, now()
             );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbl_vendor_hotel_category_subscription_audit
  ON public.tbl_vendor_hotel_category_subscription;

CREATE TRIGGER tbl_vendor_hotel_category_subscription_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.tbl_vendor_hotel_category_subscription
  FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct();
