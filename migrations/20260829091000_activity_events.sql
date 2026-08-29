-- The company activity trail.
--
-- One row per thing that happened, in the words an admin would use for it,
-- scoped to a company and — where it is knowable — a business unit.
--
-- This sits above tbl_audit_row_changes rather than replacing it. That table
-- answers "which columns moved"; this one answers "what happened and who did
-- it", which is the question an admin actually opens the page with. They are
-- joined by request_id, so a reader can expand "Priya published RFQ 536445 to
-- 209 vendors" and see the rows underneath it.
--
-- Labels and the rendered sentence are stored, not joined. Two reasons. A feed
-- that resolves names at read time needs a join per entity type per row, which
-- is slow at the only scale that matters — a long page of mixed events. And it
-- is dishonest: renaming a user or archiving a unit would silently rewrite
-- what the trail says happened last March. A trail should report what was true
-- when it happened.
--
-- Not partitioned. At the measured rate — roughly 1,000 to 1,500 rows a day
-- across ten companies — this reaches about half a million rows a year in a
-- 509 MB database. Monthly partitions would be real operational work for no
-- present benefit. occurred_at is the natural partition key when tenancy grows
-- and pg_partman is already available to install; nothing here precludes it.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tbl_activity_events (
    id                      bigserial PRIMARY KEY,
    occurred_at             timestamptz  NOT NULL DEFAULT now(),

    -- Ties a business event to the row changes it caused, and lets a single
    -- request that emits several events (a user edit that changes a role AND
    -- a status, say) be recognised as one action.
    request_id              uuid,

    source                  text         NOT NULL,   -- HTTP | CRON | WEBHOOK | BACKFILL
    event_key               text,                    -- registry key; NULL = not yet named
    category                text         NOT NULL,
    severity                text         NOT NULL,   -- routine | notable | critical

    -- Seven kinds of actor, not two. A vendor is a counterparty, the scheduler
    -- is not a person, and the site representative who signs for goods is a
    -- real human without an account. Collapsing them makes the feed lie.
    actor_type              text         NOT NULL,   -- USER|VENDOR|WORKWISE_STAFF|GUEST_TOKEN|SYSTEM|PUBLIC|UNKNOWN
    -- Deliberately no foreign key: an actor must outlive their account. If a
    -- user row is ever hard-deleted, the trail still has to say what they did.
    actor_user_id           integer,
    actor_label             text         NOT NULL,

    hospitality_company_id  integer      NOT NULL,   -- the scoping key
    hotel_id                integer,
    department_id           integer,

    entity_type             text,
    entity_id               bigint,
    entity_label            text,

    summary                 text         NOT NULL,
    metadata                jsonb        NOT NULL DEFAULT '{}'::jsonb,

    http_method             text,
    route_pattern           text,
    status_code             integer,

    -- Reconstructed from history that predates the trail. Shown as such, so
    -- an inferred actor is never mistaken for a recorded one.
    is_reconstructed        boolean      NOT NULL DEFAULT false,

    CONSTRAINT chk_activity_severity
        CHECK (severity IN ('routine', 'notable', 'critical')),
    CONSTRAINT chk_activity_source
        CHECK (source IN ('HTTP', 'CRON', 'WEBHOOK', 'BACKFILL')),
    CONSTRAINT chk_activity_actor_type
        CHECK (actor_type IN ('USER', 'VENDOR', 'WORKWISE_STAFF', 'GUEST_TOKEN',
                              'SYSTEM', 'PUBLIC', 'UNKNOWN'))
);

-- The feed itself: one company, newest first. Every other query narrows this.
CREATE INDEX IF NOT EXISTS idx_activity_company_time
    ON public.tbl_activity_events (hospitality_company_id, occurred_at DESC);

-- Filtered to one business unit.
CREATE INDEX IF NOT EXISTS idx_activity_company_hotel_time
    ON public.tbl_activity_events (hospitality_company_id, hotel_id, occurred_at DESC)
    WHERE hotel_id IS NOT NULL;

-- "What has happened to this RFQ?" — also what an entity page would embed.
CREATE INDEX IF NOT EXISTS idx_activity_entity
    ON public.tbl_activity_events (entity_type, entity_id, occurred_at DESC)
    WHERE entity_id IS NOT NULL;

-- "What has this person been doing?"
CREATE INDEX IF NOT EXISTS idx_activity_actor
    ON public.tbl_activity_events (actor_user_id, occurred_at DESC)
    WHERE actor_user_id IS NOT NULL;

-- The Monday-morning view: awards, approvals, access grants, deactivations.
-- Partial, because critical events are a small fraction of the table.
CREATE INDEX IF NOT EXISTS idx_activity_critical
    ON public.tbl_activity_events (hospitality_company_id, occurred_at DESC)
    WHERE severity = 'critical';

CREATE INDEX IF NOT EXISTS idx_activity_category
    ON public.tbl_activity_events (hospitality_company_id, category, occurred_at DESC);

-- Joins an event to the row-level changes it produced.
CREATE INDEX IF NOT EXISTS idx_activity_request
    ON public.tbl_activity_events (request_id)
    WHERE request_id IS NOT NULL;

-- Free-text search over the rendered sentence. pg_trgm is already installed in
-- both environments, so this needs no new extension.
CREATE INDEX IF NOT EXISTS idx_activity_summary_trgm
    ON public.tbl_activity_events USING gin (summary public.gin_trgm_ops);

COMMENT ON TABLE public.tbl_activity_events IS
  'The company activity trail: one row per business event, in the words an admin would use. Labels and summary are snapshotted at write time so the trail reports what was true when it happened and a page of events needs no joins. Joined to tbl_audit_row_changes by request_id for the column-level detail.';

COMMENT ON COLUMN public.tbl_activity_events.event_key IS
  'Key from the event registry. NULL means a mutating route ran that the registry does not name yet — recorded anyway, and reported so the gap can be closed.';

COMMIT;
