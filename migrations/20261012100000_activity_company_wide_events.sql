-- Lets the activity trail hold events that belong to the whole buyer company,
-- and widens the row-level audit to the governance tables it missed.
--
-- Why. Every event row had to name a hospitality company (one legal entity
-- under the buyer), because that is how the feed is scoped. Some of what a
-- company administrator does has no such entity: a custom role, an approval
-- workflow, the company's own profile — they belong to the buyer company as a
-- whole. The capture middleware fell back to the ACTING user's hospitality
-- mapping for those, and production's administrators (users 150 and 402,
-- user_type 7) have no mapping at all. So every one of those events resolved to
-- no company and was silently dropped: measured on production between
-- 2026-09-04 and 2026-10-12, 3 of 3 business-unit removals and 2 of 2 approval
-- workflow creations never reached the trail, and 32 user/role edits before the
-- 22 Sep fix were lost the same way.
--
-- What.
--   1. buyer_company_id on tbl_activity_events, backfilled for every existing
--      row from its hospitality company. A row may now name only the buyer
--      company (a company-wide event) — hospitality_company_id becomes
--      nullable, with a CHECK that at least one of the two is present, so a row
--      nobody could ever be shown still cannot be written.
--   2. The existing row-level audit trigger (log_changes_direct) attached to
--      governance tables it never covered: the buyer company itself (where the
--      dashboard switch lives — nobody can say when it was flipped on
--      production), approval delegations, project mappings and the permission
--      catalogue. tbl_company_buyer_account_limit is deliberately NOT included:
--      it has no `id` column and the trigger records COALESCE(NEW.id, OLD.id),
--      so attaching it would make every write to that table fail.
--
-- Idempotent: every step is guarded, so re-running is a no-op. If the down
-- migration ran before this one is re-applied, the company-wide rows it parked
-- are restored (see the .down.sql).

BEGIN;

-- 1a. The column, its foreign key and the backfill.
ALTER TABLE public.tbl_activity_events
  ADD COLUMN IF NOT EXISTS buyer_company_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_activity_buyer_company'
  ) THEN
    ALTER TABLE public.tbl_activity_events
      ADD CONSTRAINT fk_activity_buyer_company
      FOREIGN KEY (buyer_company_id) REFERENCES public.tbl_company (id);
  END IF;
END $$;

UPDATE public.tbl_activity_events e
   SET buyer_company_id = hc.buyer_company_id
  FROM public.tbl_hospitality_companies hc
 WHERE hc.id = e.hospitality_company_id
   AND e.buyer_company_id IS NULL
   AND hc.buyer_company_id IS NOT NULL;

-- 1b. A row may name only the buyer company — but it must name something.
ALTER TABLE public.tbl_activity_events
  ALTER COLUMN hospitality_company_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_activity_company_scope'
  ) THEN
    ALTER TABLE public.tbl_activity_events
      ADD CONSTRAINT chk_activity_company_scope
      CHECK (hospitality_company_id IS NOT NULL OR buyer_company_id IS NOT NULL);
  END IF;
END $$;

-- Every writer gets buyer_company_id for free. Live capture already sets it,
-- but the backfill sources, system events and anything written later by hand
-- would otherwise leave it NULL on hospitality-scoped rows. When a hospitality
-- company is named, its buyer company is the authority and wins.
CREATE OR REPLACE FUNCTION public.activity_fill_buyer_company()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.hospitality_company_id IS NOT NULL THEN
    NEW.buyer_company_id := COALESCE(
      (SELECT buyer_company_id FROM public.tbl_hospitality_companies
        WHERE id = NEW.hospitality_company_id),
      NEW.buyer_company_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tbl_activity_events_fill_buyer ON public.tbl_activity_events;
CREATE TRIGGER tbl_activity_events_fill_buyer
  BEFORE INSERT ON public.tbl_activity_events
  FOR EACH ROW EXECUTE FUNCTION public.activity_fill_buyer_company();

-- Partial: the reads only ever reach for buyer_company_id to find the
-- company-wide rows; everything else is still found through the existing
-- hospitality-company indexes.
CREATE INDEX IF NOT EXISTS idx_activity_buyer_company_wide
  ON public.tbl_activity_events (buyer_company_id, occurred_at DESC)
  WHERE hospitality_company_id IS NULL;

-- 1c. Bring back company-wide rows the down migration parked, if it ever ran.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public'
                AND table_name = 'tbl_activity_events_company_wide_parked') THEN
    INSERT INTO public.tbl_activity_events
    SELECT * FROM public.tbl_activity_events_company_wide_parked
    ON CONFLICT (id) DO NOTHING;
    DROP TABLE public.tbl_activity_events_company_wide_parked;
  END IF;
END $$;

-- 2. Row-level audit on the governance tables the original curation missed.
-- Named <table>_audit to match every other audited table, created only where
-- the table exists, has an `id` column (the trigger needs it) and is not
-- already covered.
DO $$
DECLARE
  t TEXT;
  added TEXT[] := ARRAY[
    'tbl_company',
    'tbl_approval_delegations',
    'tbl_hospitality_project_mappings',
    'tbl_permissions'
  ];
BEGIN
  FOREACH t IN ARRAY added LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = t AND column_name = 'id')
       AND NOT EXISTS (
         SELECT 1 FROM pg_trigger tg
           JOIN pg_class c ON c.oid = tg.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = t
            AND NOT tg.tgisinternal
            AND tg.tgfoid = 'public.log_changes_direct'::regproc)
    THEN
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I '
        'FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct()',
        t || '_audit', t);
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN public.tbl_activity_events.buyer_company_id IS
  'The buyer company (tbl_company) the event belongs to. Set on every row. When hospitality_company_id is NULL the event is company-wide — a role, an approval workflow, the company profile — and is shown to every administrator of that buyer company.';

COMMIT;
