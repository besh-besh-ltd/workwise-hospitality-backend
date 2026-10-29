-- Purchase Requisitions tables (spec 2026-10-13, section 5). Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS public.tbl_purchase_requisition (
  id                      SERIAL PRIMARY KEY,
  pr_number               VARCHAR(32) NOT NULL UNIQUE,
  title                   VARCHAR(200) NOT NULL,
  pr_type                 VARCHAR(16) NOT NULL DEFAULT 'goods' CHECK (pr_type IN ('goods','service','capex')),
  hospitality_company_id  INTEGER NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  hotel_id                INTEGER NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id),
  department_id           INTEGER NOT NULL REFERENCES public.tbl_department(id),
  process_id              INTEGER NULL,
  urgency                 VARCHAR(8) NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','urgent')),
  required_by_date        DATE NOT NULL,
  justification           TEXT NOT NULL CHECK (length(btrim(justification)) > 0),
  delivery_location       TEXT,
  status                  VARCHAR(20) NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','in_review','pending_approval','returned','approved','rejected','cancelled')),
  revision                INTEGER NOT NULL DEFAULT 0,
  estimated_total         NUMERIC(18,2),
  raised_by               INTEGER NOT NULL REFERENCES public.tbl_users(id),
  submitted_at            TIMESTAMPTZ,
  approved_at             TIMESTAMPTZ,
  approval_instance_id    INTEGER,
  assigned_buyer_id       INTEGER REFERENCES public.tbl_users(id),
  assigned_at             TIMESTAMPTZ,
  returned_note           TEXT,
  cancelled_reason        TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_company_status ON public.tbl_purchase_requisition (hospitality_company_id, status);
CREATE INDEX IF NOT EXISTS idx_pr_hotel_dept ON public.tbl_purchase_requisition (hotel_id, department_id);
CREATE INDEX IF NOT EXISTS idx_pr_raised_by ON public.tbl_purchase_requisition (raised_by);

CREATE TABLE IF NOT EXISTS public.tbl_purchase_requisition_line (
  id                    SERIAL PRIMARY KEY,
  pr_id                 INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition(id) ON DELETE CASCADE,
  line_no               INTEGER NOT NULL,
  line_kind             VARCHAR(10) NOT NULL CHECK (line_kind IN ('catalog','free_text')),
  product_variant_id    INTEGER REFERENCES public.tbl_product_variant(id),
  free_text_name        VARCHAR(300),
  category_id           INTEGER NOT NULL REFERENCES public.tbl_category(id),
  quantity              NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
  uom                   VARCHAR(50) NOT NULL CHECK (length(btrim(uom)) > 0),
  estimated_unit_price  NUMERIC(18,2) NOT NULL CHECK (estimated_unit_price > 0),
  specification         TEXT,
  suggested_vendor_note TEXT,
  status                VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','closed')),
  close_reason          TEXT,
  closed_by             INTEGER REFERENCES public.tbl_users(id),
  closed_at             TIMESTAMPTZ,
  mapped_variant_id     INTEGER REFERENCES public.tbl_product_variant(id),
  mapped_by             INTEGER REFERENCES public.tbl_users(id),
  mapped_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pr_id, line_no),
  CONSTRAINT chk_pr_line_kind_shape CHECK (
    (line_kind = 'catalog'   AND product_variant_id IS NOT NULL AND free_text_name IS NULL AND mapped_variant_id IS NULL) OR
    (line_kind = 'free_text' AND product_variant_id IS NULL AND free_text_name IS NOT NULL AND length(btrim(free_text_name)) > 0)
  ),
  CONSTRAINT chk_pr_line_closed_reason CHECK (status <> 'closed' OR (close_reason IS NOT NULL AND length(btrim(close_reason)) > 0))
);
CREATE INDEX IF NOT EXISTS idx_pr_line_pr ON public.tbl_purchase_requisition_line (pr_id);
CREATE INDEX IF NOT EXISTS idx_pr_line_variant ON public.tbl_purchase_requisition_line (COALESCE(product_variant_id, mapped_variant_id));

CREATE TABLE IF NOT EXISTS public.tbl_pr_line_clause (
  id          SERIAL PRIMARY KEY,
  pr_line_id  INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition_line(id) ON DELETE CASCADE,
  clause_text TEXT NOT NULL CHECK (length(btrim(clause_text)) > 0),
  clause_type VARCHAR(30) NOT NULL DEFAULT 'mandatory',
  weightage   NUMERIC(6,2),
  added_by    INTEGER NOT NULL REFERENCES public.tbl_users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.tbl_pr_attachment (
  id          SERIAL PRIMARY KEY,
  pr_id       INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition(id) ON DELETE CASCADE,
  pr_line_id  INTEGER REFERENCES public.tbl_purchase_requisition_line(id) ON DELETE CASCADE,
  kind        VARCHAR(10) NOT NULL CHECK (kind IN ('spec','datasheet','qap','other')),
  file_url    TEXT NOT NULL,
  file_name   VARCHAR(300),
  uploaded_by INTEGER NOT NULL REFERENCES public.tbl_users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.tbl_pr_review_category_map (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INTEGER NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  category_id            INTEGER NOT NULL REFERENCES public.tbl_category(id),
  department_id          INTEGER NOT NULL REFERENCES public.tbl_department(id),
  created_by             INTEGER NOT NULL REFERENCES public.tbl_users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hospitality_company_id, category_id)
);

CREATE TABLE IF NOT EXISTS public.tbl_pr_review (
  id             SERIAL PRIMARY KEY,
  pr_id          INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition(id) ON DELETE CASCADE,
  revision       INTEGER NOT NULL,
  department_id  INTEGER NOT NULL REFERENCES public.tbl_department(id),
  status         VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','sent_back','superseded')),
  acted_by       INTEGER REFERENCES public.tbl_users(id),
  acted_at       TIMESTAMPTZ,
  note           TEXT,
  self_reviewed  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pr_id, revision, department_id),
  CONSTRAINT chk_pr_review_sendback_note CHECK (status <> 'sent_back' OR (note IS NOT NULL AND length(btrim(note)) > 0))
);

CREATE TABLE IF NOT EXISTS public.tbl_pr_review_line (
  review_id  INTEGER NOT NULL REFERENCES public.tbl_pr_review(id) ON DELETE CASCADE,
  pr_line_id INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition_line(id) ON DELETE CASCADE,
  PRIMARY KEY (review_id, pr_line_id)
);

CREATE TABLE IF NOT EXISTS public.tbl_pr_line_rfq (
  id             SERIAL PRIMARY KEY,
  pr_line_id     INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition_line(id) ON DELETE CASCADE,
  rfq_id         INTEGER NOT NULL REFERENCES public.tbl_rfq(id) ON DELETE CASCADE,
  rfq_product_id INTEGER NOT NULL REFERENCES public.tbl_rfq_products(id) ON DELETE CASCADE,
  quantity       NUMERIC(18,3) NOT NULL CHECK (quantity > 0),
  converted_by   INTEGER NOT NULL REFERENCES public.tbl_users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_line_rfq_line ON public.tbl_pr_line_rfq (pr_line_id);
CREATE INDEX IF NOT EXISTS idx_pr_line_rfq_rfq ON public.tbl_pr_line_rfq (rfq_id);

CREATE TABLE IF NOT EXISTS public.tbl_pr_catalog_request (
  id                     SERIAL PRIMARY KEY,
  hospitality_company_id INTEGER NOT NULL REFERENCES public.tbl_hospitality_companies(id),
  pr_line_id             INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition_line(id) ON DELETE CASCADE,
  requested_name         VARCHAR(300) NOT NULL,
  description            TEXT,
  category_id            INTEGER REFERENCES public.tbl_category(id),
  status                 VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','fulfilled','rejected')),
  requested_by           INTEGER NOT NULL REFERENCES public.tbl_users(id),
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by            INTEGER,
  resolved_at            TIMESTAMPTZ,
  resolution_note        TEXT,
  resolved_variant_id    INTEGER REFERENCES public.tbl_product_variant(id),
  CONSTRAINT chk_pr_catreq_resolution CHECK (
    (status = 'open') OR (status = 'fulfilled' AND resolved_variant_id IS NOT NULL) OR
    (status = 'rejected' AND resolution_note IS NOT NULL AND length(btrim(resolution_note)) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pr_catreq_open_per_line ON public.tbl_pr_catalog_request (pr_line_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS public.tbl_pr_comment (
  id         SERIAL PRIMARY KEY,
  pr_id      INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES public.tbl_users(id),
  body       TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_comment_pr ON public.tbl_pr_comment (pr_id, created_at);

CREATE TABLE IF NOT EXISTS public.tbl_pr_event (
  id          BIGSERIAL PRIMARY KEY,
  pr_id       INTEGER NOT NULL REFERENCES public.tbl_purchase_requisition(id) ON DELETE CASCADE,
  pr_line_id  INTEGER,
  revision    INTEGER NOT NULL DEFAULT 0,
  actor_id    INTEGER,
  event_type  VARCHAR(40) NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_event_pr ON public.tbl_pr_event (pr_id, id);

ALTER TABLE public.tbl_approval_policy_steps ADD COLUMN IF NOT EXISTS min_amount NUMERIC(18,2) NULL;

COMMIT;
