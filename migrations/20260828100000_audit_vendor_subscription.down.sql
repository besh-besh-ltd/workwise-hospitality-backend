DROP TRIGGER IF EXISTS tbl_vendor_hotel_category_subscription_audit
  ON public.tbl_vendor_hotel_category_subscription;

-- Restore the function without the INSERT branch.
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
