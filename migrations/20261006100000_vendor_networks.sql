-- Vendor Networks (spec 2026-10-06-vendor-networks-design.md, section 3).
-- Idempotent: every statement is safe to re-run.

CREATE TABLE IF NOT EXISTS tbl_vendor_orgs (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  principal_vendor_id INT NOT NULL UNIQUE REFERENCES tbl_users(id),
  routing_mode TEXT NOT NULL DEFAULT 'ADMIN_ROUTES'
    CHECK (routing_mode IN ('ADMIN_ROUTES','AUTO_SINGLE_MATCH')),
  routing_timeout_hours INT NOT NULL DEFAULT 24
    CHECK (routing_timeout_hours BETWEEN 1 AND 168),
  created_by INT REFERENCES tbl_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tbl_vendor_org_entities (
  id SERIAL PRIMARY KEY,
  org_id INT NOT NULL REFERENCES tbl_vendor_orgs(id),
  vendor_id INT NOT NULL REFERENCES tbl_users(id),
  relationship TEXT NOT NULL CHECK (relationship IN ('PRINCIPAL','BRANCH','DISTRIBUTOR','DEALER')),
  status TEXT NOT NULL CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','REMOVED')),
  preference_rank INT NOT NULL DEFAULT 100,
  invited_by INT,
  linked_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- an entity is live in at most one org at a time
CREATE UNIQUE INDEX IF NOT EXISTS ix_vn_entities_live_vendor
  ON tbl_vendor_org_entities (vendor_id) WHERE status <> 'REMOVED';
-- exactly one principal per org
CREATE UNIQUE INDEX IF NOT EXISTS ix_vn_entities_one_principal
  ON tbl_vendor_org_entities (org_id) WHERE relationship = 'PRINCIPAL' AND status <> 'REMOVED';
CREATE INDEX IF NOT EXISTS ix_vn_entities_org ON tbl_vendor_org_entities (org_id);

CREATE TABLE IF NOT EXISTS tbl_vendor_org_link_invites (
  id SERIAL PRIMARY KEY,
  org_id INT NOT NULL REFERENCES tbl_vendor_orgs(id),
  target_vendor_id INT NOT NULL REFERENCES tbl_users(id),
  relationship TEXT NOT NULL,
  -- how the admin addressed the target: by EMAIL it typed, or by ID from its PAN suggestions
  addressed_by TEXT NOT NULL DEFAULT 'ID' CHECK (addressed_by IN ('ID','EMAIL')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACCEPTED','DECLINED','EXPIRED','CANCELLED')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_by INT NOT NULL,
  acted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_vn_link_invites_org ON tbl_vendor_org_link_invites (org_id);
CREATE INDEX IF NOT EXISTS ix_vn_link_invites_target ON tbl_vendor_org_link_invites (target_vendor_id);
-- at most one PENDING invite per org and target
CREATE UNIQUE INDEX IF NOT EXISTS ix_vn_link_invites_one_pending
  ON tbl_vendor_org_link_invites (org_id, target_vendor_id) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS tbl_vendor_org_members (
  id SERIAL PRIMARY KEY,
  org_id INT NOT NULL REFERENCES tbl_vendor_orgs(id),
  person_user_id INT NOT NULL REFERENCES tbl_users(id),
  entity_vendor_id INT NULL REFERENCES tbl_users(id),
  role TEXT NOT NULL CHECK (role IN ('ORG_ADMIN','ENTITY_MEMBER')),
  status TEXT NOT NULL CHECK (status IN ('INVITED','ACTIVE','DISABLED')),
  invite_token_hash TEXT UNIQUE,
  invite_expires_at TIMESTAMPTZ,
  invited_by INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_vn_members_role_entity CHECK ((role = 'ORG_ADMIN') = (entity_vendor_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_vn_members_live_person_entity
  ON tbl_vendor_org_members (person_user_id, COALESCE(entity_vendor_id, 0)) WHERE status <> 'DISABLED';
CREATE INDEX IF NOT EXISTS ix_vn_members_org ON tbl_vendor_org_members (org_id);

CREATE TABLE IF NOT EXISTS tbl_vendor_coverage_rules (
  id SERIAL PRIMARY KEY,
  entity_vendor_id INT NOT NULL REFERENCES tbl_users(id),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('STATE','CITY','HOTEL')),
  scope_id INT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('INCLUDE','EXCLUDE')),
  category_id INT NULL,
  created_by INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_vn_coverage_unique
  ON tbl_vendor_coverage_rules (entity_vendor_id, scope_type, scope_id, COALESCE(category_id, 0));

CREATE TABLE IF NOT EXISTS tbl_vendor_routing_assignments (
  id SERIAL PRIMARY KEY,
  org_id INT NOT NULL REFERENCES tbl_vendor_orgs(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('RFQ','ARC_HOTEL')),
  subject_id INT NOT NULL,
  hotel_id INT NULL,
  assigned_vendor_id INT NOT NULL REFERENCES tbl_users(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACCEPTED','DECLINED','TIMED_OUT','REVOKED','SUPERSEDED')),
  decline_reason TEXT CHECK (decline_reason IN ('NO_STOCK','CANNOT_MEET_DEADLINE','OUT_OF_AREA','OTHER')),
  decline_note TEXT,
  due_at TIMESTAMPTZ,
  auto_routed BOOLEAN NOT NULL DEFAULT false,
  assigned_by_user_id INT,
  acted_by_user_id INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acted_at TIMESTAMPTZ
);
-- at most one PENDING and at most one ACCEPTED per org + subject + hotel: several orgs
-- may each route the same RFQ (every org's principal is invited separately).
-- The org-less first draft of these indexes is dropped on any database that ran it.
DROP INDEX IF EXISTS ix_vn_assign_one_pending;
DROP INDEX IF EXISTS ix_vn_assign_one_accepted;
CREATE UNIQUE INDEX IF NOT EXISTS ix_vn_assign_org_one_pending
  ON tbl_vendor_routing_assignments (org_id, subject_type, subject_id, COALESCE(hotel_id, 0)) WHERE status = 'PENDING';
CREATE UNIQUE INDEX IF NOT EXISTS ix_vn_assign_org_one_accepted
  ON tbl_vendor_routing_assignments (org_id, subject_type, subject_id, COALESCE(hotel_id, 0)) WHERE status = 'ACCEPTED';
CREATE INDEX IF NOT EXISTS ix_vn_assign_org ON tbl_vendor_routing_assignments (org_id);
CREATE INDEX IF NOT EXISTS ix_vn_assign_vendor ON tbl_vendor_routing_assignments (assigned_vendor_id);
-- live assignments of one subject across orgs (RFQ routed-copy propagation on every RFQ edit)
CREATE INDEX IF NOT EXISTS ix_vn_assign_live_subject
  ON tbl_vendor_routing_assignments (subject_type, subject_id) WHERE status IN ('PENDING', 'ACCEPTED');

ALTER TABLE tbl_hospitality_company_hotels
  ADD COLUMN IF NOT EXISTS state_id INT NULL REFERENCES tbl_location_states(id),
  ADD COLUMN IF NOT EXISTS city_id  INT NULL REFERENCES tbl_location_cities(id);

ALTER TABLE tbl_rfq_product_vendors ADD COLUMN IF NOT EXISTS routed_from_vendor_id INT NULL;

CREATE TABLE IF NOT EXISTS tbl_vendor_network_seats (
  id SERIAL PRIMARY KEY,
  org_id INT NOT NULL REFERENCES tbl_vendor_orgs(id),
  entity_vendor_id INT NOT NULL REFERENCES tbl_users(id),
  fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','expired','cancelled')),
  payment_id INT NULL REFERENCES tbl_vendor_payments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_vn_seats_live
  ON tbl_vendor_network_seats (entity_vendor_id, end_date) WHERE status IN ('pending','active');
CREATE INDEX IF NOT EXISTS ix_vn_seats_org ON tbl_vendor_network_seats (org_id);

-- payment type
ALTER TABLE tbl_vendor_payments DROP CONSTRAINT IF EXISTS tbl_vendor_payments_payment_type_check;
ALTER TABLE tbl_vendor_payments ADD CONSTRAINT tbl_vendor_payments_payment_type_check
  CHECK (payment_type IN ('hospitality','tender','network_seat'));

-- hotel location backfill (India = country_id 1 in tbl_location_states).
-- Only unambiguous names match: tbl_location_states/cities have no unique name
-- constraint (prod has duplicate cities inside one state), so a duplicated
-- name stays NULL rather than receiving an arbitrary id.
CREATE OR REPLACE FUNCTION vn_backfill_hotel_location_ids() RETURNS void
LANGUAGE sql AS $fn$
  UPDATE tbl_hospitality_company_hotels h SET state_id = s.id
    FROM (SELECT min(id) AS id, lower(trim(state_name)) AS nm
            FROM tbl_location_states WHERE country_id = 1
           GROUP BY lower(trim(state_name)) HAVING count(*) = 1) s
   WHERE h.state_id IS NULL AND s.nm = lower(trim(h.state));

  UPDATE tbl_hospitality_company_hotels h SET city_id = c.id
    FROM (SELECT min(id) AS id, state_id, lower(trim(city_name)) AS nm
            FROM tbl_location_cities
           GROUP BY state_id, lower(trim(city_name)) HAVING count(*) = 1) c
   WHERE h.city_id IS NULL AND h.state_id IS NOT NULL
     AND c.state_id = h.state_id AND c.nm = lower(trim(h.city));
$fn$;

SELECT vn_backfill_hotel_location_ids();

-- Row-level audit (spec §10.10): every admin action on the network tables (suspend,
-- reactivate, remove, org and member PATCHes, invite cancel, coverage edits) is recorded
-- with the PERSON who did it. log_changes_direct() (20260829090000_audit_row_changes)
-- reads app.actor_id, which the request context sets to the person acting for an entity
-- (requestContext resolveActor, spec §4.3). Named <table>_audit like every audited table.
-- Skipped where that function does not exist; re-running drops and recreates.
DO $$
DECLARE
  t TEXT;
BEGIN
  IF to_regprocedure('public.log_changes_direct()') IS NULL THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY[
    'tbl_vendor_orgs',
    'tbl_vendor_org_entities',
    'tbl_vendor_org_members',
    'tbl_vendor_org_link_invites',
    'tbl_vendor_coverage_rules'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_audit', t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.log_changes_direct()',
      t || '_audit', t);
  END LOOP;
END $$;
