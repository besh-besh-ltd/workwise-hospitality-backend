-- Delegation: "while I am away, X covers my approvals."
--
-- The platform ships a system role literally titled "Proxy Approver"
-- (tbl_roles.id = 5) with five distinct permissions, zero holders, and zero
-- policy steps referencing it. Nothing anywhere in the codebase gives it
-- delegation semantics -- it is a name that promises cover the system does not
-- provide. This table provides it for real; what to do with the dormant role is
-- a separate decision and is deliberately not taken here.
--
-- Time-boxed and forward-only by construction: delegation is applied when
-- approvers are RESOLVED, which happens as an approval instance is created. An
-- approval that already exists keeps the approvers it was created with, and
-- moving one of those is what reassignment is for.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tbl_approval_delegations (
    id                  serial PRIMARY KEY,

    delegator_user_id   integer NOT NULL REFERENCES public.tbl_users(id),
    delegate_user_id    integer NOT NULL REFERENCES public.tbl_users(id),

    -- Half-open [starts_at, ends_at). An delegation with no end would be a
    -- permanent transfer of authority wearing the word "temporary".
    starts_at           timestamptz NOT NULL,
    ends_at             timestamptz NOT NULL,

    reason              text,

    created_by          integer NOT NULL REFERENCES public.tbl_users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),

    -- Ended early rather than deleted, for the same reason approver rows are
    -- tombstoned: "who was covering on the 14th" has to stay answerable after
    -- somebody comes back sooner than planned.
    revoked_at          timestamptz,
    revoked_by          integer REFERENCES public.tbl_users(id),

    CONSTRAINT chk_delegation_window CHECK (ends_at > starts_at),
    CONSTRAINT chk_delegation_not_self CHECK (delegator_user_id <> delegate_user_id)
);

-- The resolver's only query: is anyone covering for this person right now.
CREATE INDEX IF NOT EXISTS idx_delegation_active
    ON public.tbl_approval_delegations (delegator_user_id, starts_at, ends_at)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_delegation_delegate
    ON public.tbl_approval_delegations (delegate_user_id, starts_at, ends_at)
    WHERE revoked_at IS NULL;

-- Overlapping windows for one delegator would make "who is covering" ambiguous
-- at resolve time, and the resolver must never have to pick. Postgres would
-- enforce this with an exclusion constraint, but that needs btree_gist and
-- neither database has it installed -- so the create path checks for an
-- overlap and refuses, and this comment records why the constraint is absent
-- rather than forgotten.

COMMIT;
