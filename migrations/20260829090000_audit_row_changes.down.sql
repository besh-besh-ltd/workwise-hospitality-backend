-- Reverses 20260829090000_audit_row_changes.
--
-- Restores the original trigger (UPDATE/DELETE only, changed_by = current_user)
-- and the original table name and coverage. The rows written while the new
-- trigger was live are kept — down-migrating should not destroy an audit
-- record — so audit_log_temp will afterwards contain some rows carrying an
-- actor_user_id, and some INSERT operations, that the old code never wrote.
-- Those columns are dropped last, which does discard the attribution; if that
-- matters, copy the table before running this.

BEGIN;

CREATE OR REPLACE FUNCTION public.log_changes_direct()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- Drop every trigger using this function, by function rather than by name,
-- then restore exactly the original set with the original names.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT c.relname AS tbl, t.tgname AS trg
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal
          AND n.nspname = 'public'
          AND t.tgfoid = 'public.log_changes_direct'::regproc
    LOOP
        EXECUTE format('DROP TRIGGER %I ON public.%I', r.trg, r.tbl);
    END LOOP;
END $$;

DO $$
DECLARE
    t TEXT;
    original TEXT[] := ARRAY[
        'tbl_quote_finalization', 'tbl_quote_item_files', 'tbl_quote_item_history',
        'tbl_quote_items', 'tbl_quotes', 'tbl_quotes_files', 'tbl_rfq',
        'tbl_rfq_files', 'tbl_rfq_product_files', 'tbl_rfq_product_target_price',
        'tbl_rfq_product_tech_evaluation', 'tbl_rfq_product_tech_evaluation_clauses',
        'tbl_rfq_product_tech_evaluation_clauses_files',
        'tbl_rfq_product_tech_evaluation_cleared_vendors',
        'tbl_rfq_product_tech_evaluation_comments',
        'tbl_rfq_product_tech_evaluation_comments_files',
        'tbl_rfq_product_tech_evaluation_vendors_response',
        'tbl_rfq_product_tech_evaluation_vendors_response_files',
        'tbl_rfq_product_vendors', 'tbl_rfq_products', 'tbl_rfq_products_specs'
    ];
BEGIN
    FOREACH t IN ARRAY original LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = t) THEN
            EXECUTE format(
                'CREATE TRIGGER %I AFTER DELETE OR UPDATE ON public.%I '
                'FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct()',
                t || '_audit', t);
        END IF;
    END LOOP;
END $$;

ALTER INDEX IF EXISTS public.tbl_audit_row_changes_pkey RENAME TO audit_log_temp_pkey;

DROP INDEX IF EXISTS public.idx_audit_row_changes_record;
DROP INDEX IF EXISTS public.idx_audit_row_changes_changed_at;
DROP INDEX IF EXISTS public.idx_audit_row_changes_request;
DROP INDEX IF EXISTS public.idx_audit_row_changes_actor;

ALTER TABLE IF EXISTS public.tbl_audit_row_changes
  DROP COLUMN IF EXISTS actor_user_id,
  DROP COLUMN IF EXISTS request_id;

ALTER TABLE IF EXISTS public.tbl_audit_row_changes SET UNLOGGED;
ALTER TABLE IF EXISTS public.tbl_audit_row_changes RENAME TO audit_log_temp;

COMMIT;
