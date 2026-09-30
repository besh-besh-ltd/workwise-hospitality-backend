-- ARC v2 — Universal (ARC-wide) technical evaluation.
--
-- A SECOND, separate technical-clause configurator alongside the existing
-- per-item family (tbl_arc_item_tech_evaluation*). Universal clauses apply to
-- the WHOLE ARC (keyed on arc_id, not an item). A vendor who FAILS the
-- universal clauses is knocked out of the ENTIRE ARC. Per-item clauses keep
-- working exactly as today; universal is purely additive.
--
-- Scoring model mirrors the per-item model exactly: weighted clauses summing to
-- 100, an ARC-level minimum_passing_score, and the same is_mandatory hard-gate.
-- Approval rides the EXISTING single ARC_TECH approval instance (no separate
-- entity/stage) — submitTechEval records BOTH item and universal cleared rows.

-- ARC-level "universal" technical evaluation. ONE owner row per ARC (arc_id UNIQUE),
-- parallels tbl_arc_item_tech_evaluation but keyed on the ARC, not an item.
CREATE TABLE IF NOT EXISTS public.tbl_arc_universal_tech_evaluation (
  id                     BIGSERIAL PRIMARY KEY,
  arc_id                 BIGINT NOT NULL UNIQUE REFERENCES public.tbl_arc(id) ON DELETE CASCADE,
  minimum_passing_score  NUMERIC(5,2) NOT NULL DEFAULT 0,
  is_complete            BOOLEAN NOT NULL DEFAULT FALSE,
  current_round          INTEGER NOT NULL DEFAULT 1,
  approval_instance_id   INTEGER,
  created_at             TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_universal_tech_evaluation_clauses (
  id                                   BIGSERIAL PRIMARY KEY,
  arc_universal_tech_evaluation_id     BIGINT NOT NULL REFERENCES public.tbl_arc_universal_tech_evaluation(id) ON DELETE CASCADE,
  clause_text                          TEXT NOT NULL,
  weightage                            NUMERIC(5,2) NOT NULL,
  clause_type                          VARCHAR(40),
  is_mandatory                         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                           TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_universal_te_clauses_eval
  ON public.tbl_arc_universal_tech_evaluation_clauses (arc_universal_tech_evaluation_id);

CREATE TABLE IF NOT EXISTS public.tbl_arc_universal_tech_evaluation_clauses_files (
  id                                        BIGSERIAL PRIMARY KEY,
  arc_universal_tech_evaluation_clauses_id  BIGINT NOT NULL REFERENCES public.tbl_arc_universal_tech_evaluation_clauses(id) ON DELETE CASCADE,
  file_url                                  TEXT NOT NULL,
  created_at                                TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_universal_tech_evaluation_vendors_response (
  id                                        BIGSERIAL PRIMARY KEY,
  arc_universal_tech_evaluation_clauses_id  BIGINT  NOT NULL REFERENCES public.tbl_arc_universal_tech_evaluation_clauses(id) ON DELETE CASCADE,
  vendor_id                                 INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  vendor_response                           TEXT,
  buyer_id                                  INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  buyer_marks                               NUMERIC(5,2),
  buyer_remark                              TEXT,
  mandatory_passed                          BOOLEAN,
  score_timestamp                           TIMESTAMP WITHOUT TIME ZONE,
  created_at                                TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_universal_tech_evaluation_clauses_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_univ_te_vendor_response_vendor
  ON public.tbl_arc_universal_tech_evaluation_vendors_response (vendor_id);

CREATE TABLE IF NOT EXISTS public.tbl_arc_universal_tech_evaluation_vendors_response_files (
  id                                                       BIGSERIAL PRIMARY KEY,
  arc_universal_tech_evaluation_vendors_response_id        BIGINT NOT NULL REFERENCES public.tbl_arc_universal_tech_evaluation_vendors_response(id) ON DELETE CASCADE,
  file_url                                                 TEXT NOT NULL,
  original_name                                            TEXT,
  created_at                                               TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tbl_arc_universal_tech_evaluation_cleared_vendors (
  id                                 BIGSERIAL PRIMARY KEY,
  arc_universal_tech_evaluation_id   BIGINT  NOT NULL REFERENCES public.tbl_arc_universal_tech_evaluation(id) ON DELETE CASCADE,
  vendor_id                          INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  calculated_score                   NUMERIC(5,2),
  is_verified                        BOOLEAN NOT NULL DEFAULT FALSE,
  status                             VARCHAR(20) NOT NULL DEFAULT 'qualified',
  evaluation_round                   INTEGER NOT NULL DEFAULT 1,
  approval_instance_id               INTEGER,
  reject_message                     TEXT,
  created_by                         INTEGER REFERENCES public.tbl_users(id) ON DELETE SET NULL,
  created_at                         TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (arc_universal_tech_evaluation_id, vendor_id, evaluation_round),
  CONSTRAINT tbl_arc_univ_te_cleared_status_chk CHECK (status IN ('qualified','not_qualified'))
);
