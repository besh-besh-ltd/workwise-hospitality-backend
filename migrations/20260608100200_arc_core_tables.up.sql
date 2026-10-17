-- ARC v2 — Migration 4 of 10: core ARC tables + tech evaluation family.
--
-- Implements plan §4.1 (root + items + invitation + event log),
-- §4.2 (past-3y consumption snapshot), and §4.3 (tech eval — mirrors RFQ
-- tech-eval shape).
--
-- Single-BU release: tbl_arc.hotel_id is scalar (not a link table). When
-- multi-BU lands, hotel_id is migrated out into tbl_arc_bu.
--
-- Department lives on tbl_arc (per stakeholder direction overriding PRD §7.1)
-- — not per-item. Resolution: see plan §5.3 "Create draft (category →
-- department resolution)".

-- ====================================================================
-- §4.1 — Core ARC
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.tbl_arc (
  id                              BIGSERIAL PRIMARY KEY,
  arc_number                      VARCHAR(40)  NOT NULL UNIQUE,
  title                           VARCHAR(255) NOT NULL,
  description                     TEXT,
  category_id                     INTEGER NOT NULL REFERENCES public.tbl_category(id) ON DELETE RESTRICT,
  sub_category_ids                JSONB DEFAULT '[]'::jsonb,
  hospitality_company_id          INTEGER NOT NULL REFERENCES public.tbl_hospitality_companies(id) ON DELETE RESTRICT,
  hotel_id                        INTEGER NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE RESTRICT,
  department_id                   INTEGER NOT NULL REFERENCES public.tbl_department(id) ON DELETE RESTRICT,
  process_id                      INTEGER NOT NULL REFERENCES public.tbl_approval_processes(id) ON DELETE RESTRICT,
  status                          VARCHAR(40) NOT NULL DEFAULT 'draft',
  submission_start_at             TIMESTAMP WITHOUT TIME ZONE,
  submission_end_at               TIMESTAMP WITHOUT TIME ZONE,
  contract_start_at               TIMESTAMP WITHOUT TIME ZONE,
  contract_end_at                 TIMESTAMP WITHOUT TIME ZONE,
  technical_response_required     BOOLEAN NOT NULL DEFAULT FALSE,
  sample_required                 BOOLEAN NOT NULL DEFAULT FALSE,
  eligibility_type                VARCHAR(20) NOT NULL DEFAULT 'open',
  escalation_clause_json          JSONB DEFAULT '{}'::jsonb,
  payment_terms_expected          VARCHAR(255),
  delivery_expected               VARCHAR(255),
  penalty_clause                  TEXT,
  created_by                      INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  closed_reason                   TEXT,
  created_at                      TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at                      TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tbl_arc_status_chk           CHECK (status IN (
    'draft','floated','submission_closed',
    'tech_eval_in_progress','tech_eval_approved','tech_eval_rejected',
    'comm_eval_in_progress','comm_eval_finalized',
    'committee_review','committee_approved','committee_sent_back','committee_rejected',
    'contract_generated','awaiting_vendor_acceptance','contract_active',
    'expiring_soon','expired','terminated','closed_no_award'
  )),
  CONSTRAINT tbl_arc_eligibility_chk      CHECK (eligibility_type IN ('open','invitation'))
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_hotel       ON public.tbl_arc (hotel_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_department  ON public.tbl_arc (department_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_category    ON public.tbl_arc (category_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_status      ON public.tbl_arc (status);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_created_by  ON public.tbl_arc (created_by);

CREATE TABLE IF NOT EXISTS public.tbl_arc_item (
  id                  BIGSERIAL PRIMARY KEY,
  arc_id              BIGINT NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  product_variant_id  INTEGER NOT NULL REFERENCES public.tbl_product_variant(id) ON DELETE RESTRICT,
  spec_text           TEXT,
  target_price        NUMERIC(15,2),
  indicative_qty      NUMERIC(15,2) NOT NULL,
  uom                 VARCHAR(50),
  spec_attachment_id  INTEGER,
  created_at          TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_id, product_variant_id)
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_item_arc      ON public.tbl_arc_item (arc_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_item_variant  ON public.tbl_arc_item (product_variant_id);

CREATE TABLE IF NOT EXISTS public.tbl_arc_invitation (
  id            BIGSERIAL PRIMARY KEY,
  arc_id        BIGINT  NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  vendor_id     INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  status        VARCHAR(20) NOT NULL DEFAULT 'invited',
  invited_at    TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  responded_at  TIMESTAMP WITHOUT TIME ZONE,
  UNIQUE (arc_id, vendor_id),
  CONSTRAINT tbl_arc_invitation_status_chk CHECK (status IN ('invited','viewed','submitted','declined'))
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_invitation_arc     ON public.tbl_arc_invitation (arc_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_invitation_vendor  ON public.tbl_arc_invitation (vendor_id);

CREATE TABLE IF NOT EXISTS public.tbl_arc_event_log (
  id          BIGSERIAL PRIMARY KEY,
  arc_id      BIGINT NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  event_type  VARCHAR(60) NOT NULL,
  actor_id    INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  payload     JSONB DEFAULT '{}'::jsonb,
  at          TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_event_log_arc       ON public.tbl_arc_event_log (arc_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_event_log_event_at  ON public.tbl_arc_event_log (event_type, at DESC);

-- ====================================================================
-- §4.2 — Past 3y consumption snapshot
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.tbl_arc_item_history_snapshot (
  id              BIGSERIAL PRIMARY KEY,
  arc_item_id     BIGINT NOT NULL REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE,
  year_offset     SMALLINT NOT NULL,
  consumed_qty    NUMERIC(15,2) NOT NULL DEFAULT 0,
  last_rate       NUMERIC(15,2),
  last_vendor_id  INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_item_id, year_offset),
  CONSTRAINT tbl_arc_item_history_snapshot_year_chk CHECK (year_offset BETWEEN 1 AND 5)
);

-- ====================================================================
-- §4.3 — Technical evaluation (per-item)
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.tbl_arc_item_tech_evaluation (
  id                       BIGSERIAL PRIMARY KEY,
  arc_item_id              BIGINT NOT NULL UNIQUE REFERENCES public.tbl_arc_item(id) ON DELETE CASCADE,
  minimum_passing_score    NUMERIC(5,2) NOT NULL DEFAULT 0,
  is_complete              BOOLEAN NOT NULL DEFAULT FALSE,
  current_round            INTEGER NOT NULL DEFAULT 1,
  approval_instance_id     INTEGER,
  created_at               TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_item_tech_evaluation_clauses (
  id                              BIGSERIAL PRIMARY KEY,
  arc_item_tech_evaluation_id     BIGINT NOT NULL REFERENCES public.tbl_arc_item_tech_evaluation(id) ON DELETE CASCADE,
  clause_text                     TEXT NOT NULL,
  weightage                       NUMERIC(5,2) NOT NULL,
  clause_type                     VARCHAR(40),
  created_at                      TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_item_tech_evaluation_clauses_eval
  ON public.tbl_arc_item_tech_evaluation_clauses (arc_item_tech_evaluation_id);

CREATE TABLE IF NOT EXISTS public.tbl_arc_item_tech_evaluation_clauses_files (
  id                                       BIGSERIAL PRIMARY KEY,
  arc_item_tech_evaluation_clauses_id      BIGINT NOT NULL REFERENCES public.tbl_arc_item_tech_evaluation_clauses(id) ON DELETE CASCADE,
  file_url                                 TEXT NOT NULL,
  created_at                               TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_item_tech_evaluation_vendors_response (
  id                                       BIGSERIAL PRIMARY KEY,
  arc_item_tech_evaluation_clauses_id      BIGINT  NOT NULL REFERENCES public.tbl_arc_item_tech_evaluation_clauses(id) ON DELETE CASCADE,
  vendor_id                                INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  vendor_response                          TEXT,
  buyer_id                                 INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  buyer_marks                              NUMERIC(5,2),
  buyer_remark                             TEXT,
  score_timestamp                          TIMESTAMP WITHOUT TIME ZONE,
  created_at                               TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_item_tech_evaluation_clauses_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_te_vendor_response_vendor
  ON public.tbl_arc_item_tech_evaluation_vendors_response (vendor_id);

CREATE TABLE IF NOT EXISTS public.tbl_arc_item_tech_evaluation_vendors_response_files (
  id                                                  BIGSERIAL PRIMARY KEY,
  arc_item_tech_evaluation_vendors_response_id        BIGINT NOT NULL REFERENCES public.tbl_arc_item_tech_evaluation_vendors_response(id) ON DELETE CASCADE,
  file_url                                            TEXT NOT NULL,
  created_at                                          TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_item_tech_evaluation_cleared_vendors (
  id                            BIGSERIAL PRIMARY KEY,
  arc_item_tech_evaluation_id   BIGINT  NOT NULL REFERENCES public.tbl_arc_item_tech_evaluation(id) ON DELETE CASCADE,
  vendor_id                     INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  calculated_score              NUMERIC(5,2),
  is_verified                   BOOLEAN NOT NULL DEFAULT FALSE,
  status                        VARCHAR(20) NOT NULL DEFAULT 'qualified',
  evaluation_round              INTEGER NOT NULL DEFAULT 1,
  approval_instance_id          INTEGER,
  reject_message                TEXT,
  created_by                    INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  created_at                    TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_item_tech_evaluation_id, vendor_id, evaluation_round),
  CONSTRAINT tbl_arc_item_te_cleared_status_chk CHECK (status IN ('qualified','not_qualified'))
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_tech_evaluation_rounds (
  id            BIGSERIAL PRIMARY KEY,
  arc_id        BIGINT NOT NULL REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  round_number  INTEGER NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'open',
  opened_at     TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  closed_at     TIMESTAMP WITHOUT TIME ZONE,
  opened_by     INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  UNIQUE (arc_id, round_number)
);
