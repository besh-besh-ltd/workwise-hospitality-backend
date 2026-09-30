-- ARC v2 — Migration 7 of 10: MR (Material Requisition) tables + the call-off
-- link table that pairs a call-off PO with its ARC contract line + MR.
--
-- Implements plan §4.8. Contracted-items-only in this phase:
-- tbl_material_requisition_item.arc_contract_id and arc_contract_line_id are NOT NULL. The MR
-- raise UI gates the picker to only show contracted items for the user's
-- hotel + department; the controller revalidates at submit time.
--
-- MR approval reuses the existing approval engine via entity_type='MR'
-- (registered in migration 9). The MR's coarse `status` column reflects the
-- overall instance state; step-level granularity lives in
-- tbl_approval_instance_steps.

CREATE TABLE IF NOT EXISTS public.tbl_material_requisition (
  id                          BIGSERIAL PRIMARY KEY,
  mr_number                   VARCHAR(40)  NOT NULL UNIQUE,
  title                       VARCHAR(255) NOT NULL,
  hospitality_company_id      INTEGER NOT NULL REFERENCES public.tbl_hospitality_companies(id) ON DELETE RESTRICT,
  hotel_id                    INTEGER NOT NULL REFERENCES public.tbl_hospitality_company_hotels(id) ON DELETE RESTRICT,
  department_id               INTEGER NOT NULL REFERENCES public.tbl_department(id) ON DELETE RESTRICT,
  cost_center                 VARCHAR(120),
  urgency                     VARCHAR(20) NOT NULL DEFAULT 'normal',
  required_by_date            DATE,
  justification               TEXT,
  delivery_location           TEXT,
  status                      VARCHAR(40) NOT NULL DEFAULT 'draft',
  raised_by                   INTEGER NOT NULL REFERENCES public.tbl_users(id) ON DELETE RESTRICT,
  submitted_at                TIMESTAMP WITHOUT TIME ZONE,
  approval_instance_id        INTEGER,
  created_at                  TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tbl_material_requisition_urgency_chk CHECK (urgency IN ('low','normal','urgent')),
  CONSTRAINT tbl_material_requisition_status_chk  CHECK (status IN ('draft','pending_approval','approved','po_released','rejected','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_tbl_material_requisition_hotel        ON public.tbl_material_requisition (hotel_id);
CREATE INDEX IF NOT EXISTS idx_tbl_material_requisition_department   ON public.tbl_material_requisition (department_id);
CREATE INDEX IF NOT EXISTS idx_tbl_material_requisition_status       ON public.tbl_material_requisition (status);
CREATE INDEX IF NOT EXISTS idx_tbl_material_requisition_raised_by    ON public.tbl_material_requisition (raised_by);

CREATE TABLE IF NOT EXISTS public.tbl_material_requisition_item (
  id                    BIGSERIAL PRIMARY KEY,
  mr_id                 BIGINT  NOT NULL REFERENCES public.tbl_material_requisition(id) ON DELETE CASCADE,
  product_variant_id    INTEGER NOT NULL REFERENCES public.tbl_product_variant(id) ON DELETE RESTRICT,
  quantity              NUMERIC(15,2) NOT NULL,
  uom                   VARCHAR(50),
  arc_contract_id       BIGINT  NOT NULL REFERENCES public.tbl_arc_contract(id) ON DELETE RESTRICT,
  arc_contract_line_id  BIGINT  NOT NULL REFERENCES public.tbl_arc_contract_line(id) ON DELETE RESTRICT,
  matched_unit_rate     NUMERIC(15,2),
  created_at            TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tbl_material_requisition_item_mr               ON public.tbl_material_requisition_item (mr_id);
CREATE INDEX IF NOT EXISTS idx_tbl_material_requisition_item_contract         ON public.tbl_material_requisition_item (arc_contract_id);
CREATE INDEX IF NOT EXISTS idx_tbl_material_requisition_item_contract_line    ON public.tbl_material_requisition_item (arc_contract_line_id);
CREATE INDEX IF NOT EXISTS idx_tbl_material_requisition_item_variant          ON public.tbl_material_requisition_item (product_variant_id);

-- Link table populated by callOffPoService.releaseForMr (plan §5.4).
-- One row per (po, contract_line) pairing; a single MR with items across two
-- vendors' contracts produces two POs and two link rows.
CREATE TABLE IF NOT EXISTS public.tbl_arc_callof_po (
  id                       BIGSERIAL PRIMARY KEY,
  po_id                    INTEGER NOT NULL,
  mr_id                    BIGINT  NOT NULL REFERENCES public.tbl_material_requisition(id) ON DELETE RESTRICT,
  arc_contract_id          BIGINT  NOT NULL REFERENCES public.tbl_arc_contract(id) ON DELETE RESTRICT,
  arc_contract_line_id     BIGINT  NOT NULL REFERENCES public.tbl_arc_contract_line(id) ON DELETE RESTRICT,
  quantity                 NUMERIC(15,2) NOT NULL,
  applied_amendment_id     BIGINT,
  price_applied            NUMERIC(15,2) NOT NULL,
  released_at              TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (po_id, arc_contract_line_id)
);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_callof_po_mr           ON public.tbl_arc_callof_po (mr_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_callof_po_contract     ON public.tbl_arc_callof_po (arc_contract_id);
CREATE INDEX IF NOT EXISTS idx_tbl_arc_callof_po_po_id        ON public.tbl_arc_callof_po (po_id);
