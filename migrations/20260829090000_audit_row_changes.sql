-- Turn audit_log_temp into a usable row-level audit log.
--
-- The table and its trigger have existed in production since go-live and have
-- accumulated 105,000 rows across 81 MB, growing ~900 rows a day. Nothing has
-- ever read them, for four reasons, all fixed here:
--
--   1. changed_by was `current_user`, the Postgres role. Because the whole
--      application connects through one pooled credential, every row on record
--      says 'postgres'. The table could name the table and the row that
--      changed but never the person, which is the only question anyone asks of
--      an audit log. It now reads a per-transaction setting the application
--      sets from its request context.
--   2. The trigger fired AFTER DELETE OR UPDATE only, so nothing that was ever
--      created was recorded. Creations are now captured too.
--   3. UNLOGGED. Not WAL-logged, not crash-safe, not replicated — the one kind
--      of table an audit trail must never be. Now LOGGED.
--   4. No index beyond the primary key, so any question ("what happened to
--      RFQ 536445?") was a sequential scan of 81 MB.
--
-- The name goes with it: `_temp` is why nobody trusted it.
--
-- Existing rows are kept. They cannot be attributed to anyone, so they are not
-- projected into the activity feed, but they are still the only record of what
-- changed in those rows and deleting them would destroy that.

BEGIN;

ALTER TABLE IF EXISTS public.audit_log_temp RENAME TO tbl_audit_row_changes;

ALTER TABLE IF EXISTS public.tbl_audit_row_changes SET LOGGED;

-- The actor, resolved by the application. Kept alongside the legacy
-- `changed_by` text rather than replacing it: old rows genuinely were written
-- by 'postgres' and rewriting history to claim otherwise would be a lie.
ALTER TABLE public.tbl_audit_row_changes
  ADD COLUMN IF NOT EXISTS actor_user_id integer,
  ADD COLUMN IF NOT EXISTS request_id    uuid;

-- "What happened to this row?" — the question the table exists to answer.
CREATE INDEX IF NOT EXISTS idx_audit_row_changes_record
  ON public.tbl_audit_row_changes (table_name, record_id, changed_at DESC);

-- "What happened in the last hour?" — the feed query.
CREATE INDEX IF NOT EXISTS idx_audit_row_changes_changed_at
  ON public.tbl_audit_row_changes (changed_at DESC);

-- Joins a business event to the row changes it caused. Partial because rows
-- written before this migration, and anything outside a request, have none.
CREATE INDEX IF NOT EXISTS idx_audit_row_changes_request
  ON public.tbl_audit_row_changes (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_row_changes_actor
  ON public.tbl_audit_row_changes (actor_user_id, changed_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- The rewritten trigger.
--
-- `current_setting(..., true)` returns NULL rather than raising when the
-- setting is absent, which is what happens for a migration, a psql session or
-- a cron job that runs outside an HTTP request. Those writes are still
-- recorded; they simply have no actor, and saying so is more honest than
-- inventing one.
CREATE OR REPLACE FUNCTION public.log_changes_direct()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_old      JSONB := NULL;
    v_new      JSONB := NULL;
    v_actor    INTEGER := NULL;
    v_request  UUID := NULL;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD);
    ELSIF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
    ELSIF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW);
    END IF;

    BEGIN
        v_actor := NULLIF(current_setting('app.actor_id', true), '')::INTEGER;
    EXCEPTION WHEN OTHERS THEN
        v_actor := NULL;
    END;

    BEGIN
        v_request := NULLIF(current_setting('app.request_id', true), '')::UUID;
    EXCEPTION WHEN OTHERS THEN
        v_request := NULL;
    END;

    INSERT INTO public.tbl_audit_row_changes (
        table_name, operation, record_id, old_data, new_data,
        changed_by, changed_at, actor_user_id, request_id
    ) VALUES (
        TG_TABLE_NAME, TG_OP, COALESCE(NEW.id, OLD.id),
        v_old, v_new, current_user, now(), v_actor, v_request
    );

    RETURN NULL;  -- AFTER triggers ignore the return value.
END;
$function$;

-- Re-curate what is covered.
--
-- Dropped by FUNCTION, not by name. The triggers in production are called
-- <table>_audit, not log_changes_direct, so dropping them by the function
-- name would silently no-op and leave every retained table with two audit
-- triggers writing every change twice. Enumerating pg_trigger by tgfoid is
-- the only way to be sure we caught them all, whatever they were called.
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

-- Recreate over the curated set, named <table>_audit to match the convention
-- already in production.
--
-- Left out: churn that produces volume without answering a question anyone
-- asks. tbl_rfq_product_vendors alone is 82,119 of the 105,178 rows on record
-- — the vendor-mapping recalculation that runs every time an RFQ's products
-- change. "The vendor pool was refreshed" is one business event and is
-- captured as one; two hundred mapping rows are not two hundred things that
-- happened. File-attachment tables go for the same reason: the upload is the
-- event. tbl_quote_item_history is itself a history table, so auditing it is
-- circular.
--
-- Added: governance. Who exists, what they may do, which units exist and who
-- approves spend — none of which was covered at all, and all of which is what
-- a company admin is accountable for and what a dispute is settled from.
-- Purchase orders join them, for the same reason: money.
DO $$
DECLARE
    t TEXT;
    covered TEXT[] := ARRAY[
        -- Governance (new)
        'tbl_users',
        'tbl_roles',
        'tbl_role_permissions',
        'tbl_user_role_scopes',
        'tbl_user_department',
        'tbl_department',
        'tbl_hospitality_companies',
        'tbl_hospitality_company_hotels',
        'tbl_hospitality_user_mappings',
        'tbl_approval_policies',
        'tbl_approval_policy_steps',
        'tbl_approval_processes',
        'tbl_rfq_purchase_order',
        -- Retained from the original coverage
        'tbl_rfq',
        'tbl_rfq_products',
        'tbl_rfq_products_specs',
        'tbl_rfq_product_target_price',
        'tbl_rfq_product_tech_evaluation',
        'tbl_rfq_product_tech_evaluation_clauses',
        'tbl_rfq_product_tech_evaluation_cleared_vendors',
        'tbl_rfq_product_tech_evaluation_comments',
        'tbl_rfq_product_tech_evaluation_vendors_response',
        'tbl_quotes',
        'tbl_quote_items',
        'tbl_quote_finalization'
    ];
BEGIN
    FOREACH t IN ARRAY covered LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = t) THEN
            EXECUTE format(
                'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                'FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct()',
                t || '_audit', t);
        END IF;
    END LOOP;
END $$;

-- The primary key kept its old name through the rename, which would leave a
-- tbl_audit_row_changes carrying an audit_log_temp_pkey for the next person
-- to puzzle over.
ALTER INDEX IF EXISTS public.audit_log_temp_pkey RENAME TO tbl_audit_row_changes_pkey;

COMMENT ON TABLE public.tbl_audit_row_changes IS
  'Row-level before/after audit written by the log_changes_direct trigger. The layer nothing can bypass: it fires for cron jobs, scripts and manual SQL as well as HTTP requests. actor_user_id comes from the application via SET LOCAL app.actor_id and is NULL when there was no request. Rows predating 2026-08-29 have no actor at all.';

COMMIT;
